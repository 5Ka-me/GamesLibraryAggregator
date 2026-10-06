import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { normalizeTitle } from '@app/shared';
import { assistantChat, type AssistantGame, type AssistantReply, type ChatTurn, type ContextGame } from './assistant';
import { DEFAULT_AI_MODEL, aiStatus, estimateUsd } from './aiClient';
import { getAiModel, getAiUsage } from '../config';
import { getProfiles, type GameProfile } from './enrichment';
import { epicTagsCached } from './epicStore';
import { usdRate } from './fxRates';
import { getFactCard, type FactCard } from './gameFacts';
import { libraryView, type LibGame } from './libraryIndex';
import { appDetails, findSteamAppId, itemsMeta, type StoreItem } from './steamStore';

// Assistant eval harness (`npm run ai:eval`, i.e. `electron . --ai-eval`).
// Runs realistic chat turns through the real assistantChat — the user's key,
// library, profiles and semantic index, no window — and checks each reply
// against PROPERTIES rather than exact titles: tags carried by every game
// card, ownership, tools used, answer language, length/modes from the AI
// profile. Model output varies run to run, so a check that names exact games
// would fail for good answers; properties stay meaningful across libraries
// and models. Every failed check says precisely which game broke which rule.
// The one title check, requireAnyOf, asks for any ONE game of a long list of
// well-known examples, for concepts no tag expresses (anomaly hunting, gacha).
// Every answer is also checked for talk about the app's internals (tags,
// tools, filters, the index): the user reads it, so it must be about games.
//
// Cost: every case is one paid assistant turn on the stored key. The report
// records per-case tokens and the app's own usage-counter delta (which also
// covers intent parsing and embeddings). Nothing that identifies the account
// is printed or written; the key is never touched here (only aiStatus()).

/** One scripted turn and the properties its reply must have. */
export interface EvalCase {
  id: string;
  /** Earlier turns (optional) + the message under test. */
  history?: { role: 'user' | 'assistant'; content: string; games?: string[] }[];
  message: string;
  /** UI language passed to assistantChat (default from message script). */
  lang?: 'en' | 'ru';
  context?: { title: string; origin: 'library' | 'wishlist' | 'store' }[];
  expect: {
    answerLang?: 'en' | 'ru';
    /** Each entry must appear in toolsUsed; "a|b" is satisfied by either tool. */
    toolsInclude?: string[];
    toolsExclude?: string[];
    minGames?: number;
    maxGames?: number;
    /** Every game card owned (true) / none owned (false). */
    owned?: boolean;
    /** Every game carries ≥ 1 of these Steam/EGS tags (see tagMatches for the equivalences). */
    haveTagAny?: string[];
    /** No game carries any of these. */
    lackTags?: string[];
    /** Every owned game's profile modes ∩ these ≠ ∅. */
    haveModeAny?: string[];
    /** Every owned game's profile lengthHours ≤ n and not endless. */
    maxLengthHours?: number;
    /** Regex (i flag) over the answer text plus every game note. */
    answerMatches?: string;
    answerNotMatches?: string;
    /** No game from history turns' games. */
    noRepeat?: boolean;
    excludeTitles?: string[];
    maxLatencyMs?: number;
    /**
     * Every non-owned game costs ≤ n US dollars ("under $10"); the regional store price is converted
     * at the daily rate. Free passes; a price whose currency has no known rate is noted, not failed.
     */
    maxPrice?: number;
    /** Soft metric, not pass/fail: share of games found in this list. */
    expectAnyOf?: string[];
    /**
     * At least one game card is one of these titles (see titleMatchesEntry: same normalized title, or
     * the card title starts with the entry — "I'm on Observation Duty 5" for "I'm on Observation Duty").
     * For concepts no Steam tag expresses; list many well-known games so any good answer passes.
     */
    requireAnyOf?: string[];
  };
}

/** What one case produced; the JSON report is a list of these. */
interface CaseResult {
  id: string;
  message: string;
  lang: 'en' | 'ru';
  pass: boolean;
  /** One line per failed check. */
  failures: string[];
  /** Observations that are not failures (unverifiable checks, corrected context origins). */
  notes: string[];
  error: string | null;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  usd: number | null;
  /** Tokens per model, when the assistant reports the split; null = `usd` priced every token at `model`. */
  byModel: ModelUsage | null;
  model: string;
  toolsUsed: string[];
  answer: string;
  /** `store`: where a not-owned card is from ('epic' cards have no appid); null for owned games. */
  games: { title: string; owned: boolean; appid: number | null; store: 'steam' | 'epic' | null; note: string | null }[];
  /** expectAnyOf share (0..1); null when the case has no list or no games. */
  anyOf: number | null;
}

/** Facts the checks read for one game card. `tags` null = unknown (not owned and no store data). */
interface CardFacts {
  game: AssistantGame;
  lib: LibGame | null;
  profile: GameProfile | null;
  tags: string[] | null;
  item: StoreItem | null;
}

/** Tokens one turn spent per model id. */
type ModelUsage = Record<string, { in: number; out: number }>;

/** A turn can take one intent call, the explanation, and a tool-loop fallback; beyond this something hangs. */
const CASE_TIMEOUT_MS = 360_000;
/**
 * How long a timed-out turn may keep running before the next case starts anyway. Nothing can abort a
 * turn and every model call is time-capped, so it ends on its own; this bound only guards a real hang.
 */
const DRAIN_TIMEOUT_MS = 300_000;
const ANSWER_KEEP_CHARS = 600;
/** Errors that make every later case fail the same way: stop spending and mark the rest skipped. */
const FATAL = /^(AI_NO_KEY|AI_AUTH|AI_BALANCE)\b/;

// Cyrillic letters, matched by Unicode script: used to tell the language of
// user input and of the model's answer.
const CYRILLIC = /\p{Script=Cyrillic}/u;
const CYRILLIC_G = /\p{Script=Cyrillic}/gu;
/** A Russian answer still carries Latin game titles and tag names; above this Cyrillic share it reads as Russian. */
const RU_SHARE = 0.3;

const EXPECT_KEYS = new Set([
  'answerLang', 'toolsInclude', 'toolsExclude', 'minGames', 'maxGames', 'owned', 'haveTagAny', 'lackTags',
  'haveModeAny', 'maxLengthHours', 'answerMatches', 'answerNotMatches', 'noRepeat', 'excludeTitles',
  'maxLatencyMs', 'maxPrice', 'expectAnyOf', 'requireAnyOf',
]);
const STRING_LISTS = ['toolsInclude', 'toolsExclude', 'haveTagAny', 'lackTags', 'haveModeAny', 'excludeTitles', 'expectAnyOf', 'requireAnyOf'];
const NUMBERS = ['minGames', 'maxGames', 'maxLengthHours', 'maxLatencyMs', 'maxPrice'];
const BOOLEANS = ['owned', 'noRepeat'];
const REGEXES = ['answerMatches', 'answerNotMatches'];

// ---------- tag equivalence ----------

/**
 * Umbrella names whose spellings vary between Steam user tags, Steam
 * platform flags, Steam categories (fact cards) and EGS tags. A wanted tag
 * listed here matches every tag the predicate accepts; any other wanted tag
 * needs case-insensitive equality, so a case can still demand "VR Only" alone.
 *   VR        → "VR", "VR Only", "VR Supported"
 *   Co-op     → any tag containing "co-op" or "coop" ("Online Co-Op", "Local Co-Op", "LAN Co-op")
 *   Horror    → any tag containing "horror" ("Psychological Horror", "Survival Horror")
 *   Roguelike → any tag containing "rogue" ("Roguelite", "Action Roguelike", EGS "Rogue-Lite")
 */
const TAG_FAMILIES: Record<string, (have: string) => boolean> = {
  vr: (t) => t === 'vr' || t === 'vr only' || t === 'vr supported',
  'co-op': (t) => t.includes('co-op') || t.includes('coop'),
  coop: (t) => t.includes('co-op') || t.includes('coop'),
  horror: (t) => t.includes('horror'),
  roguelike: (t) => t.includes('rogue'),
};

/** Does the game tag `have` satisfy the wanted tag `want`? Case-insensitive, widened by TAG_FAMILIES. */
export function tagMatches(want: string, have: string): boolean {
  const w = want.toLowerCase().trim();
  const h = have.toLowerCase().trim();
  if (!w || !h) return false;
  const family = TAG_FAMILIES[w];
  return family ? family(h) : w === h;
}

// ---------- helpers ----------

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const trim = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const list = (xs: string[], max = 12): string => (xs.length ? `${xs.slice(0, max).join(', ')}${xs.length > max ? `, … (+${xs.length - max})` : ''}` : 'none');
const dedupe = (xs: string[]): string[] => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Language of a reply: bold spans (game titles, Latin in either language) are left out of the count. */
function detectLang(text: string): { lang: 'en' | 'ru'; share: number } {
  const plain = text.replace(/\*\*[^*]+\*\*/g, ' ');
  const cyr = (plain.match(CYRILLIC_G) ?? []).length;
  const lat = (plain.match(/[A-Za-z]/g) ?? []).length;
  const share = cyr + lat ? cyr / (cyr + lat) : 0;
  // Game and collection titles are Latin even in a Russian answer ("140 games: Half-Life, Portal, Dota 2…"), so the
  // letter share alone misreads a list-heavy Russian reply; a few Russian words of prose settle it. An English
  // reply has no Russian words outside bold titles.
  const ruWords = plain.split(/[^\p{L}]+/u).filter((w) => w.length >= 2 && /^\p{Script=Cyrillic}+$/u.test(w)).length;
  return { lang: share >= RU_SHARE || ruWords >= 4 ? 'ru' : 'en', share };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`EVAL_TIMEOUT: no reply within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// ---------- titles and internals ----------

/** Title as lower-case words: apostrophes dropped ("I'm" → "im"), every other non-letter run → one space. */
const titleWords = (s: string): string =>
  s
    .toLowerCase()
    .replace(/['’ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Does a card title satisfy a requireAnyOf entry? The same normalized title, or a title that starts
 * with the entry as whole words, so a numbered series entry counts ("I'm on Observation Duty 5" for
 * "I'm on Observation Duty") while "Exit 80" does not count for "Exit 8". A leading label in brackets
 * and an alternate-language " | …" tail, as in "[Chilla's Art] Shinkansen 0 | <Japanese title>" on
 * Steam, are ignored.
 */
export function titleMatchesEntry(entry: string, title: string): boolean {
  const key = normalizeTitle(entry);
  const words = titleWords(entry);
  if (!key || !words) return false;
  const core = title.replace(/^\s*\[[^\]]*\]\s*/, '').split(/\s+\|\s+/)[0];
  return [title, core].some((t) => normalizeTitle(t) === key || titleWords(t).startsWith(`${words} `));
}

/**
 * Phrases in which an answer describes the app's machinery instead of games; the live bug was
 * "the Steam tag «Gacha» does not exist (searched literally)". Every pattern pairs a machinery word
 * with its context (a tag that "does not exist", "searched literally", a tool name, a tag filter,
 * "in one call"), so ordinary game prose stays clean: "literally addictive", "upgrade your tools",
 * "photo filters", "filter the water", Russian "strategies on Steam" (the Russian word for strategy
 * contains the one for tag — hence the letter lookbehind). The Cyrillic alternatives match model
 * output, user-facing text treated like user input; a lookbehind for "not a Cyrillic letter" stands
 * in for \b, which does not see Cyrillic letters.
 */
const LEAKS: { what: string; res: RegExp[] }[] = [
  {
    what: 'Steam tags',
    res: [
      // Naming a game's store tag ("tagged Sexual Content on Steam") is a fact, not machinery: only talk of the
      // search counts — a tag that does not exist, "no such tag", nothing found by a tag.
      /\btags?\b[^.\n]{0,60}\b(does not|doesn't|do not|don't|did not|didn't) exist|\bno such tag\b|\bnot an? (steam |real |existing )?tag\b/i,
      // "Steam has no "Gacha" tag", "the tag is not on Steam".
      /\bno\b[^.\n]{0,25}\btags?\b|\btags?\b[^.\n]{0,40}\bnot (on|in) steam\b/i,
      /(?<![а-яё])тег\S*[^.\n]{0,60}не существу|(?<![а-яё])так\S* тег\S* нет|(?<![а-яё])нет так\S* тег/i,
      // The same in Russian: "there is no tag X", "nothing was found by tag X", "the tag is missing / not on Steam".
      /(?<![а-яё])(нет|без|по)\s+тег(а|у|ам|ов)?(?![а-яё])/i,
      /(?<![а-яё])тег\S*[^.\n]{0,60}(отсутству|нет в steam)/i,
    ],
  },
  {
    what: 'literal matching',
    res: [
      /\bliteral (match(es|ing)?|search(es|ing)?|tags?|filters?|phrases?|text|query)\b/i,
      /\b(searched|search|matched|match|looked up|treated|interpreted|parsed) (it |that |them |this )?literally\b/i,
      /(?<![а-яё])(искал\S*|поиск\S*|совпад\S*|сопостав\S*|трактова\S*) буквально|(?<![а-яё])буквальн\S* (поиск|совпаден|сопоставлен|запрос|фильтр|тег)/i,
    ],
  },
  {
    what: 'tools and calls',
    res: [
      /\b(library|store|wishlist|collections?|inventory|fit)_[a-z_]+\b/i,
      /\btool (calls?|results?|output|returned)\b|\b(my|lookup|library|store) tools?\b/i,
      /\b(in|with) (one|a single) (tool )?(call|request)\b(?! of| to)|\bper (tool )?(call|request)\b/i,
      /(?<![а-яё])(одним|одного|за один|за одним|за несколько) (запрос|вызов)|(?<![а-яё])(вызов|вызвал)\S* инструмент|(?<![а-яё])инструмент\S* (библиотеки|магазина|поиска по)/i,
      /(?<![a-z_а-яё])limit\s*(до|=|:)\s*\d/i,
    ],
  },
  {
    what: 'the index',
    res: [
      /\b(semantic|search|library|vector|embeddings?) index\b|\b(in|from|to|into) (the|my|our) index\b|\bindexed\b/i,
      /(?<![а-яё])(семантическ\S*|поисков\S*|векторн\S*) индекс|(?<![а-яё])(в|из|по) индекс(е|а|у)?(?![а-яё])|(?<![а-яё])индекс\S* (библиотеки|игр)/i,
    ],
  },
  {
    what: 'filters',
    res: [
      // A report of filtering ("filtered by genre") is machinery; an offer to the user ("I can filter by
      // genre") is not, so the bare verb does not count.
      /\b(tag|hard|soft|price|genre|mode|strict|search) filters?\b|\bfilter(ed|ing) (out )?(by|on) (tags?|genres?|price|modes?)\b|\bfiltered out\b/i,
      /\b(pass(ed|es|ing)?|fail(ed|s|ing)?|survived?|matched|match(es)?) (through )?(the |a |any |all |my |these |those |your )?filters?\b/i,
      /(?<![а-яё])(жёстк|жестк|тегов|поисков|ценов|жанров|строг)\S* фильтр|(?<![а-яё])фильтр\S* (по (тег|жанр|цен|режим)|не прош|отсе)/i,
      /(?<![а-яё])(прош\S*|проход\S*|не прош\S*) (через )?(\S+ )?фильтр|(?<![а-яё])отфильтровал|(?<![а-яё])отфильтрован\S* по (тег|жанр|цен|режим)/i,
    ],
  },
];

/** Regex metacharacters escaped, to remove a title as literal text. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What the answer says about the app's internals, one entry per kind with the phrase that matched
 * (`Steam tags ("<phrase>")`);
 * empty when it talks about games only. Reads the answer text alone (notes are per-game blurbs), with
 * bold spans and the card titles taken out, so a game named after a machinery word never counts.
 */
export function internalsLeaks(answer: string, titles: string[]): string[] {
  let text = answer.replace(/\*\*[^*]+\*\*/g, ' ');
  // Case-sensitive: a title keeps its casing in the answer, and "passed the filter" must still
  // count in a reply that recommends a game called "Filter".
  for (const t of titles) if (t.trim()) text = text.replace(new RegExp(escapeRe(t), 'g'), ' ');
  const out: string[] = [];
  for (const leak of LEAKS) {
    const m = leak.res.map((re) => re.exec(text)).find((x) => x !== null);
    if (m) out.push(`${leak.what} ("${trim(m[0], 60)}")`);
  }
  return out;
}

// ---------- loading ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
function loadCases(path: string): EvalCase[] {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read cases from ${path}: ${errMsg(e)}`);
  }
  const arr: any[] | null = Array.isArray(raw) ? raw : Array.isArray(raw?.cases) ? raw.cases : null;
  if (!arr) throw new Error(`${path}: expected an array of cases or { "cases": [...] }`);
  const seen = new Set<string>();
  return arr.map((c, i) => {
    if (!c || typeof c.id !== 'string' || !c.id.trim()) throw new Error(`${path}: case #${i + 1} has no id`);
    if (seen.has(c.id)) throw new Error(`${path}: duplicate case id "${c.id}"`);
    seen.add(c.id);
    if (typeof c.message !== 'string' || !c.message.trim()) throw new Error(`${path}: case "${c.id}" has no message`);
    return { ...c, expect: c.expect && typeof c.expect === 'object' ? c.expect : {} } as EvalCase;
  });
}

/** Problems in a case definition (typos in keys, wrong value types) — reported as failures, the case is not run. */
function caseProblems(c: EvalCase): string[] {
  const out: string[] = [];
  const e = c.expect as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!EXPECT_KEYS.has(k)) out.push(`unknown expectation key "${k}"`);
  for (const k of STRING_LISTS) if (e[k] !== undefined && !(Array.isArray(e[k]) && (e[k] as unknown[]).every((x) => typeof x === 'string'))) out.push(`expect.${k} must be an array of strings`);
  for (const k of NUMBERS) if (e[k] !== undefined && !(typeof e[k] === 'number' && Number.isFinite(e[k]))) out.push(`expect.${k} must be a number`);
  for (const k of BOOLEANS) if (e[k] !== undefined && typeof e[k] !== 'boolean') out.push(`expect.${k} must be true or false`);
  // An empty list could never be satisfied: the case would fail on every run for no reason in the reply.
  if (Array.isArray(e.requireAnyOf) && !(e.requireAnyOf as unknown[]).some((x) => typeof x === 'string' && normalizeTitle(x))) out.push('expect.requireAnyOf must name at least one title');
  for (const k of REGEXES) {
    if (e[k] === undefined) continue;
    if (typeof e[k] !== 'string') out.push(`expect.${k} must be a string`);
    else {
      try {
        new RegExp(e[k] as string, 'i');
      } catch (err) {
        out.push(`expect.${k} is not a valid regex: ${errMsg(err)}`);
      }
    }
  }
  if (e.answerLang !== undefined && e.answerLang !== 'en' && e.answerLang !== 'ru') out.push('expect.answerLang must be "en" or "ru"');
  if (c.lang !== undefined && c.lang !== 'en' && c.lang !== 'ru') out.push('lang must be "en" or "ru"');
  if (c.history !== undefined && !(Array.isArray(c.history) && c.history.every((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string'))) out.push('history must be a list of { role: "user"|"assistant", content }');
  if (c.context !== undefined && !(Array.isArray(c.context) && c.context.every((g) => g && typeof g.title === 'string' && ['library', 'wishlist', 'store'].includes(g.origin)))) out.push('context must be a list of { title, origin: "library"|"wishlist"|"store" }');
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Attached games as the renderer would send them. The origin is corrected to
 * 'library' when the title is owned, so a case written with "store" stays
 * truthful on a library that happens to contain the game.
 */
async function resolveContext(ctx: NonNullable<EvalCase['context']>, libByKey: Map<string, LibGame>, lang: string, notes: string[]): Promise<ContextGame[]> {
  const out: ContextGame[] = [];
  for (const g of ctx) {
    const owned = libByKey.get(normalizeTitle(g.title));
    if (owned) {
      if (g.origin !== 'library') notes.push(`context "${g.title}" is owned: origin ${g.origin} → library`);
      out.push({ title: owned.title, origin: 'library', appid: owned.appid });
      continue;
    }
    const appid = await findSteamAppId(g.title, lang).catch(() => null);
    out.push({ title: g.title, origin: g.origin === 'library' ? 'store' : g.origin, appid });
    if (g.origin === 'library') notes.push(`context "${g.title}" is not owned: origin library → store`);
  }
  return out;
}

// ---------- checks ----------

/** Tags (owned: library store tags + fact-card tags/categories; store: itemsMeta) and profile per game card. */
async function cardFacts(games: AssistantGame[], libByKey: Map<string, LibGame>): Promise<CardFacts[]> {
  const storeIds = [...new Set(games.filter((g) => !libByKey.has(normalizeTitle(g.title)) && g.appid).map((g) => g.appid as number))];
  const meta: Record<number, StoreItem> = storeIds.length ? await itemsMeta(storeIds, 'en').catch(() => ({})) : {};
  return games.map((game) => {
    const lib = libByKey.get(normalizeTitle(game.title)) ?? null;
    if (lib) {
      // EGS-only games carry only EGS genres in the library view; their fact card (Steam twin or EGS
      // offer) adds Steam tags and categories such as "VR Only" or "Online Co-op".
      let card: FactCard | null = null;
      try {
        card = getFactCard(lib.key);
      } catch {
        /* no fact cards yet */
      }
      // The library snapshot is taken once, while EGS tags may still be warming; read what is known now.
      const egs = !lib.appid && lib.epicNamespace ? epicTagsCached(lib.epicNamespace) ?? [] : [];
      const tags = dedupe([...lib.storeTags, ...egs, ...(card?.storeTags ?? []), ...(card?.categories ?? [])]);
      return { game, lib, profile: lib.profile, tags, item: null };
    }
    const item = game.appid ? meta[game.appid] ?? null : null;
    return { game, lib: null, profile: null, tags: item ? item.tags ?? [] : null, item };
  });
}

/** ISO code of the Steam store currency, learned from the first priced game (one currency per region). */
let storeCurrency: string | null = null;

/**
 * A store price in US dollars at the daily rate (`usd` null when the currency or its rate is unknown).
 * Steam prices in the account's regional currency (UAH, RUB, KZT …), and itemsMeta prices carry no
 * currency code, so it is read once from the app details of a priced game.
 */
async function priceInUsd(it: StoreItem, cents: number): Promise<{ usd: number | null; currency: string | null }> {
  let currency = it.price?.currency?.trim().toUpperCase() || storeCurrency;
  if (!currency) {
    const d = await appDetails(it.appid, 'en').catch(() => null);
    currency = d?.price?.currency?.trim().toUpperCase() || null;
    if (currency) storeCurrency = currency;
  }
  if (!currency) return { usd: null, currency: null };
  const rate = await usdRate(currency);
  return { usd: rate ? cents / 100 / rate : null, currency };
}

async function checkReply(c: EvalCase, reply: AssistantReply, latencyMs: number, libByKey: Map<string, LibGame>, notes: string[]): Promise<{ failures: string[]; anyOf: number | null }> {
  const e = c.expect;
  const f: string[] = [];
  const games = reply.games;
  const titles = games.map((g) => g.title);
  const needFacts = !!(e.haveTagAny || e.lackTags || e.haveModeAny || e.maxLengthHours !== undefined || e.maxPrice !== undefined);
  const facts = needFacts && games.length ? await cardFacts(games, libByKey) : [];

  // Implicit: an empty bubble is never a good reply.
  if (!reply.answer.trim()) f.push('answer is empty');
  // Implicit: the answer talks about games, never about how the app searched (tags, tools, filters, the index).
  const leaks = internalsLeaks(reply.answer, titles);
  if (leaks.length) f.push(`answer describes the app's internals: ${leaks.join('; ')}`);
  // Implicit: games recommended without a single lookup are the model's memory, not the user's library.
  const attached = new Set((c.context ?? []).map((g) => normalizeTitle(g.title)));
  if (!reply.toolsUsed.length && games.some((g) => !attached.has(normalizeTitle(g.title)))) f.push(`games named without any tool call: ${list(titles)}`);

  if (e.answerLang) {
    const d = detectLang(reply.answer);
    if (d.lang !== e.answerLang) f.push(`answer language is ${d.lang} (Cyrillic share ${Math.round(d.share * 100)}%), expected ${e.answerLang}`);
  }

  for (const t of e.toolsInclude ?? []) {
    const alts = t.split('|').map((x) => x.trim()).filter(Boolean);
    if (!alts.some((a) => reply.toolsUsed.includes(a))) f.push(`tool ${alts.join(' or ')} not used (used: ${list(reply.toolsUsed)})`);
  }
  for (const t of e.toolsExclude ?? []) if (reply.toolsUsed.includes(t)) f.push(`tool ${t} was used but must not be`);

  if (e.minGames !== undefined && games.length < e.minGames) f.push(`${games.length} games (${list(titles)}), expected at least ${e.minGames}`);
  if (e.maxGames !== undefined && games.length > e.maxGames) f.push(`${games.length} games (${list(titles)}), expected at most ${e.maxGames}`);

  if (e.owned !== undefined) {
    for (const g of games) if (g.owned !== e.owned) f.push(`game '${g.title}' is ${g.owned ? 'owned' : 'not owned'}, expected ${e.owned ? 'owned' : 'not owned'} games only`);
  }

  if (e.haveTagAny?.length) {
    for (const x of facts) {
      if (x.tags === null) f.push(`game '${x.game.title}' has no known tags (not owned, no Steam store data), expected one of [${e.haveTagAny.join(', ')}]`);
      else if (!e.haveTagAny.some((w) => x.tags!.some((h) => tagMatches(w, h)))) f.push(`game '${x.game.title}' lacks tags [${e.haveTagAny.join(', ')}] (has: ${list(x.tags)})`);
    }
  }

  if (e.lackTags?.length) {
    for (const x of facts) {
      if (x.tags === null) {
        notes.push(`lackTags: tags of '${x.game.title}' unknown, not checked`);
        continue;
      }
      const bad = x.tags.filter((h) => e.lackTags!.some((w) => tagMatches(w, h)));
      if (bad.length) f.push(`game '${x.game.title}' carries excluded tags [${bad.join(', ')}]`);
    }
  }

  if (e.haveModeAny?.length) {
    const want = e.haveModeAny.map((m) => m.toLowerCase());
    let skipped = 0;
    for (const x of facts) {
      if (!x.lib) {
        skipped++;
        continue;
      }
      if (!x.profile) f.push(`game '${x.game.title}' has no AI profile (modes unknown), expected one of [${want.join(', ')}]`);
      else if (!x.profile.modes.some((m) => want.includes(m))) f.push(`game '${x.game.title}' modes [${x.profile.modes.join(', ') || 'none'}] share nothing with [${want.join(', ')}]`);
    }
    if (skipped) notes.push(`haveModeAny: ${skipped} store game(s) not checked (no profile)`);
  }

  if (e.maxLengthHours !== undefined) {
    let skipped = 0;
    for (const x of facts) {
      if (!x.lib) {
        skipped++;
        continue;
      }
      const p = x.profile;
      if (!p) f.push(`game '${x.game.title}' has no AI profile (length unknown), expected ≤ ${e.maxLengthHours} h`);
      else if (p.endless) f.push(`game '${x.game.title}' is endless, expected ≤ ${e.maxLengthHours} h`);
      else if (p.lengthHours === null) f.push(`game '${x.game.title}' has an unknown length, expected ≤ ${e.maxLengthHours} h`);
      else if (p.lengthHours > e.maxLengthHours) f.push(`game '${x.game.title}' takes ~${p.lengthHours} h, expected ≤ ${e.maxLengthHours} h`);
    }
    if (skipped) notes.push(`maxLengthHours: ${skipped} store game(s) not checked (no profile)`);
  }

  if (e.maxPrice !== undefined) {
    // The cap is in dollars, the store price in the region's currency: compare in dollars, or a
    // 389 UAH game (about $9) would fail a $10 cap read as 10 UAH.
    // Owned games cost nothing more; free games always pass.
    let paid = 0;
    let free = 0;
    for (const x of facts) {
      if (x.lib || x.game.owned) continue;
      const it = x.item;
      if (it?.isFree || it?.price?.final === 0) {
        free++;
        continue;
      }
      if (!it) f.push(`game '${x.game.title}' has no store data (price unknown), expected ≤ $${e.maxPrice}`);
      else if (typeof it.price?.final !== 'number') f.push(`game '${x.game.title}' has no known price, expected ≤ $${e.maxPrice}`);
      else {
        paid++;
        const shown = it.price.formattedFinal ?? (it.price.final / 100).toFixed(2);
        const p = await priceInUsd(it, it.price.final);
        if (p.usd === null) notes.push(`maxPrice: '${x.game.title}' costs ${shown}, not checked (no USD rate for store currency ${p.currency ?? 'unknown'})`);
        else if (p.usd > e.maxPrice) f.push(`game '${x.game.title}' costs ${shown} (≈ $${p.usd.toFixed(2)}), expected ≤ $${e.maxPrice}`);
      }
    }
    // Free games pass, so an app that reads "$10" as 10 units of a weak currency still passes; flag it.
    if (free && !paid) notes.push(`maxPrice: every store game is free; check that the cap was not read in the store currency instead of dollars`);
  }

  // Notes are part of what the user reads, so the text checks cover them too.
  const text = [reply.answer, ...games.map((g) => g.note ?? '')].join('\n');
  if (e.answerMatches && !new RegExp(e.answerMatches, 'i').test(text)) f.push(`answer does not match /${e.answerMatches}/i`);
  if (e.answerNotMatches) {
    const m = new RegExp(e.answerNotMatches, 'i').exec(text);
    if (m) f.push(`answer matches /${e.answerNotMatches}/i ("${trim(m[0], 40)}")`);
  }

  if (e.noRepeat) {
    const earlier = new Set((c.history ?? []).flatMap((h) => h.games ?? []).map(normalizeTitle));
    if (!earlier.size) notes.push('noRepeat: the history has no games to compare with');
    for (const g of games) if (earlier.has(normalizeTitle(g.title))) f.push(`game '${g.title}' was already recommended earlier in the conversation`);
  }

  if (e.excludeTitles?.length) {
    const banned = new Set(e.excludeTitles.map(normalizeTitle));
    for (const g of games) if (banned.has(normalizeTitle(g.title))) f.push(`game '${g.title}' is excluded for this case`);
  }

  if (e.requireAnyOf?.length) {
    const wanted = e.requireAnyOf;
    if (!games.some((g) => wanted.some((w) => titleMatchesEntry(w, g.title)))) f.push(`no game card is one of [${list(wanted, 6)}] (cards: ${list(titles)})`);
  }

  if (e.maxLatencyMs !== undefined && latencyMs > e.maxLatencyMs) f.push(`took ${(latencyMs / 1000).toFixed(1)} s, limit ${(e.maxLatencyMs / 1000).toFixed(1)} s`);

  let anyOf: number | null = null;
  if (e.expectAnyOf?.length && games.length) {
    const wanted = new Set(e.expectAnyOf.map(normalizeTitle));
    anyOf = games.filter((g) => wanted.has(normalizeTitle(g.title))).length / games.length;
  }
  return { failures: f, anyOf };
}

// ---------- running ----------

function emptyResult(c: EvalCase, lang: 'en' | 'ru'): CaseResult {
  return {
    id: c.id,
    message: c.message,
    lang,
    pass: false,
    failures: [],
    notes: [],
    error: null,
    latencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    usd: null,
    byModel: null,
    model: '',
    toolsUsed: [],
    answer: '',
    games: [],
    anyOf: null,
  };
}

/**
 * Tokens per model when the assistant reports the split (`usage.byModel`): one turn can parse the
 * intent on the cheap model, explain on the smart one and fall back to a third. Read through an `in`
 * check so the eval also builds and runs against an assistant that reports totals only.
 */
function usageByModel(reply: AssistantReply): ModelUsage | null {
  const u = reply.usage;
  const raw: unknown = 'byModel' in u ? u.byModel : undefined;
  if (!raw || typeof raw !== 'object') return null;
  const out: ModelUsage = {};
  for (const [model, v] of Object.entries(raw as Record<string, { in?: unknown; out?: unknown } | null>)) {
    const tin = Number(v?.in);
    const tout = Number(v?.out);
    if (model && Number.isFinite(tin) && Number.isFinite(tout) && tin + tout > 0) out[model] = { in: tin, out: tout };
  }
  return Object.keys(out).length ? out : null;
}

/** Which store a not-owned card is from ('epic' cards carry no appid); null for owned and text-only cards. */
function cardStore(g: AssistantGame): 'steam' | 'epic' | null {
  return g.store === 'steam' || g.store === 'epic' ? g.store : null;
}

/** Copies a reply's spend into the result; prices each model's tokens at that model's rate when the split is known. */
async function bookSpend(r: CaseResult, reply: AssistantReply): Promise<void> {
  r.promptTokens = reply.usage.promptTokens;
  r.completionTokens = reply.usage.completionTokens;
  r.model = reply.model;
  r.byModel = usageByModel(reply);
  const parts: { model: string | undefined; in: number; out: number }[] = r.byModel
    ? Object.entries(r.byModel).map(([model, t]) => ({ model, in: t.in, out: t.out }))
    : [{ model: reply.model || undefined, in: r.promptTokens, out: r.completionTokens }];
  const prices = await Promise.all(parts.map((p) => estimateUsd(p.in, p.out, p.model).catch(() => null)));
  r.usd = prices.every((p): p is number => p !== null) ? prices.reduce((s, p) => s + p, 0) : null;
}

/**
 * After EVAL_TIMEOUT: waits (bounded) for the turn to finish before the next case starts. Nothing can
 * abort a turn (assistantChat takes no signal), and a next case running beside it would double the
 * load on a provider that is already slow and time out as well. A late reply's spend is booked here.
 */
async function drainLateTurn(turn: Promise<AssistantReply>, t0: number, r: CaseResult): Promise<void> {
  const elapsed = (): string => `${Math.round((Date.now() - t0) / 1000)} s`;
  try {
    const late = await withTimeout(turn, DRAIN_TIMEOUT_MS);
    await bookSpend(r, late);
    r.notes.push(`the timed-out turn finished after ${elapsed()}; its tokens are counted in this case`);
  } catch (e) {
    const m = errMsg(e);
    if (m.startsWith('EVAL_TIMEOUT')) {
      r.notes.push(`the timed-out turn was still running after ${elapsed()}; the next case overlaps it`);
      return;
    }
    r.notes.push(`the timed-out turn then failed after ${elapsed()}: ${trim(m, 200)} (its tokens show only in the usage-counter delta)`);
    // A key/auth/balance error would fail every later case the same way: let the run stop.
    if (FATAL.test(m)) r.error = m;
  }
}

async function runCase(c: EvalCase, libByKey: Map<string, LibGame>): Promise<CaseResult> {
  const lang: 'en' | 'ru' = c.lang ?? (CYRILLIC.test(c.message) ? 'ru' : 'en');
  const r = emptyResult(c, lang);
  const problems = caseProblems(c);
  if (problems.length) {
    r.failures = problems.map((p) => `case definition: ${p}`);
    return r;
  }
  const turns: ChatTurn[] = [
    ...(c.history ?? []).map((h) => ({
      role: h.role,
      content: h.content,
      ...(h.role === 'assistant' && Array.isArray(h.games) && h.games.length ? { games: h.games.slice(0, 8) } : {}),
    })),
    { role: 'user', content: c.message },
  ];
  const context = await resolveContext(c.context ?? [], libByKey, lang, r.notes);
  const t0 = Date.now();
  const turn = assistantChat(turns, lang, context);
  let reply: AssistantReply;
  try {
    reply = await withTimeout(turn, CASE_TIMEOUT_MS);
  } catch (e) {
    r.latencyMs = Date.now() - t0;
    r.error = errMsg(e);
    r.failures = [`threw: ${r.error}`];
    if (r.error.startsWith('EVAL_TIMEOUT')) await drainLateTurn(turn, t0, r);
    return r;
  }
  r.latencyMs = Date.now() - t0;
  await bookSpend(r, reply);
  r.toolsUsed = [...reply.toolsUsed];
  r.answer = trim(reply.answer, ANSWER_KEEP_CHARS);
  r.games = reply.games.map((g) => ({ title: g.title, owned: g.owned, appid: g.appid, store: g.owned ? null : cardStore(g), note: g.note }));
  try {
    const checked = await checkReply(c, reply, r.latencyMs, libByKey, r.notes);
    r.failures = checked.failures;
    r.anyOf = checked.anyOf;
  } catch (e) {
    r.failures = [`checks threw: ${errMsg(e)}`];
  }
  r.pass = r.failures.length === 0;
  return r;
}

// ---------- output ----------

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const usd = (v: number | null): string => (v === null ? '?' : `$${v.toFixed(4)}`);
const status = (r: CaseResult): string => (r.pass ? 'pass' : r.error ? 'ERROR' : 'FAIL');

function printSummary(results: CaseResult[], totals: { passed: number; failed: number; tokens: number; usd: number | null; anyOf: number | null }, reportPath: string): void {
  const idW = Math.min(36, Math.max(4, ...results.map((r) => r.id.length)));
  const lines: string[] = [];
  lines.push('');
  lines.push(`${pad('id', idW)}  ${pad('result', 6)}  ${padL('latency', 8)}  ${padL('tokens in/out', 14)}  tools`);
  lines.push('-'.repeat(idW + 2 + 6 + 2 + 8 + 2 + 14 + 2 + 30));
  for (const r of results) {
    lines.push(`${pad(trim(r.id, idW), idW)}  ${pad(status(r), 6)}  ${padL(secs(r.latencyMs), 8)}  ${padL(`${r.promptTokens}/${r.completionTokens}`, 14)}  ${trim(r.toolsUsed.join(', ') || '-', 70)}`);
  }
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    lines.push('');
    lines.push('Failures:');
    for (const r of failed) for (const why of r.failures) lines.push(`  ${r.id}: ${why}`);
  }
  lines.push('');
  lines.push(
    `AI eval: ${totals.passed} passed, ${totals.failed} failed of ${results.length} · ${totals.tokens} tokens · ≈ ${usd(totals.usd)}` +
      (totals.anyOf !== null ? ` · expectAnyOf hit rate ${Math.round(totals.anyOf * 100)}%` : '')
  );
  lines.push(`Report: ${reportPath}`);
  console.log(lines.join('\n'));
}

const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function markdownReport(results: CaseResult[], header: string[]): string {
  const out: string[] = ['# AI eval report', '', ...header, ''];
  out.push('| id | result | latency | tokens in/out | model | tools | games | anyOf |');
  out.push('|---|---|---:|---:|---|---|---|---:|');
  for (const r of results) {
    out.push(
      `| ${mdCell(r.id)} | ${status(r)} | ${secs(r.latencyMs)} | ${r.promptTokens}/${r.completionTokens} | ${mdCell(r.model || '-')} | ${mdCell(r.toolsUsed.join(', ') || '-')} | ${mdCell(trim(r.games.map((g) => (g.store === 'epic' ? `${g.title} (Epic)` : g.title)).join(', ') || '-', 160))} | ${r.anyOf === null ? '' : `${Math.round(r.anyOf * 100)}%`} |`
    );
  }
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    out.push('', '## Failures', '');
    for (const r of failed) {
      out.push(`- **${mdCell(r.id)}** — ${mdCell(r.message)}`);
      for (const why of r.failures) out.push(`  - ${mdCell(why)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/**
 * Runs the cases in `casesPath` (all, or the ids in `only`) sequentially through assistantChat, checks
 * each reply, writes `userData/ai-eval/report-<ISO>.json` plus a Markdown table next to it, and prints
 * a summary with every failure reason. Throws when the cases cannot be loaded, an id in `only` is
 * unknown, or no AI key is stored; a case that throws is a failure, not an exception.
 */
export async function runAiEval(opts: { casesPath: string; only?: string[] }): Promise<{ passed: number; failed: number; reportPath: string }> {
  const all = loadCases(opts.casesPath);
  const only = (opts.only ?? []).map((s) => s.trim()).filter(Boolean);
  const unknown = only.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) throw new Error(`unknown case ids: ${unknown.join(', ')} (known: ${all.map((c) => c.id).join(', ')})`);
  const cases = only.length ? all.filter((c) => only.includes(c.id)) : all;
  if (!cases.length) throw new Error(`${opts.casesPath} has no cases`);
  if (!aiStatus().configured) throw new Error('AI_NO_KEY: no chutes.ai key is stored — add it in Settings → AI of the dev app (same userData) first');

  const lib = await libraryView(false, true);
  const libByKey = new Map(lib.map((g) => [g.key, g]));
  const profiled = Object.values(getProfiles()).filter((p) => p.known).length;
  if (!lib.length) console.warn('[ai-eval] the library is empty — library cases will fail; sync the dev app first');
  const model = getAiModel() ?? DEFAULT_AI_MODEL;
  console.log(`[ai-eval] ${cases.length} case(s) from ${opts.casesPath} · model ${model} · library ${lib.length} games, ${profiled} profiled`);

  const usageBefore = getAiUsage();
  const startedAt = new Date();
  const results: CaseResult[] = [];
  let stop: string | null = null;
  for (const [i, c] of cases.entries()) {
    if (stop) {
      const r = emptyResult(c, c.lang ?? (CYRILLIC.test(c.message) ? 'ru' : 'en'));
      r.error = stop;
      r.failures = [`skipped: ${stop}`];
      results.push(r);
      continue;
    }
    process.stdout.write(`[ai-eval] ${i + 1}/${cases.length} ${c.id} … `);
    const r = await runCase(c, libByKey);
    results.push(r);
    console.log(`${status(r)} ${secs(r.latencyMs)}`);
    if (r.error && FATAL.test(r.error)) stop = `${r.error.split(/\s/)[0]} in case ${c.id}`;
  }
  const usageAfter = getAiUsage();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const tokens = results.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0);
  const priced = results.filter((r) => r.usd !== null);
  const totalUsd = priced.length ? priced.reduce((s, r) => s + (r.usd ?? 0), 0) : null;
  // Cases priced without a per-model split: every token at the turn's last model, which over- or
  // under-states turns that mixed the cheap and the smart model.
  const lastModelPriced = priced.filter((r) => !r.byModel && r.promptTokens + r.completionTokens > 0).length;
  const shares = results.map((r) => r.anyOf).filter((x): x is number => x !== null);
  const anyOf = shares.length ? shares.reduce((s, x) => s + x, 0) / shares.length : null;

  const dir = join(app.getPath('userData'), 'ai-eval');
  mkdirSync(dir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const reportPath = join(dir, `report-${stamp}.json`);
  const report = {
    version: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    casesPath: opts.casesPath,
    only: only.length ? only : null,
    model,
    library: { games: lib.length, profiled },
    passed,
    failed,
    tokens,
    // Chat tokens only; embedding tokens are in usageCounterDelta but not priced.
    estimatedUsd: totalUsd,
    casesPricedAtLastModel: lastModelPriced,
    expectAnyOfHitRate: anyOf,
    // The app's own counter also covers intent parsing, fallbacks and embeddings.
    usageCounterDelta: {
      requests: usageAfter.requests - usageBefore.requests,
      promptTokens: usageAfter.promptTokens - usageBefore.promptTokens,
      completionTokens: usageAfter.completionTokens - usageBefore.completionTokens,
    },
    results,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  const header = [
    `- Started: ${report.startedAt}`,
    `- Model: ${model}`,
    `- Library: ${lib.length} games, ${profiled} profiled`,
    `- Result: **${passed} passed, ${failed} failed** of ${results.length}`,
    `- Tokens: ${tokens} (≈ ${usd(totalUsd)}); usage counter: +${report.usageCounterDelta.requests} requests, +${report.usageCounterDelta.promptTokens}/${report.usageCounterDelta.completionTokens} tokens`,
    ...(lastModelPriced ? [`- Cost note: ${lastModelPriced} case(s) priced every token at the turn's last model (no per-model split reported)`] : []),
    ...(anyOf !== null ? [`- expectAnyOf hit rate: ${Math.round(anyOf * 100)}%`] : []),
  ];
  writeFileSync(reportPath.replace(/\.json$/, '.md'), markdownReport(results, header), 'utf8');

  printSummary(results, { passed, failed, tokens, usd: totalUsd, anyOf }, reportPath);
  return { passed, failed, reportPath };
}
