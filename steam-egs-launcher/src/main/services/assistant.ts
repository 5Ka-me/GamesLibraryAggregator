import { normalizeTitle } from '@app/shared';
import { getChutesApiKey } from './secretStore';
import { DEFAULT_AI_MODEL, chatJson, modelForRole, modelRank, parseJson, type ChatMessage } from './aiClient';
import { getAiModel } from '../config';
import { getEntries, getSteamAccount } from './localData';
import { GENRES, MODES, MOODS, getProfiles } from './enrichment';
import { appDetails, appReviewsFacts, findSteamAppId, itemsMeta, storeBrowseByTags, storeSearch, wishlistEntries, type GameDetails, type StoreBrowseSort, type StoreItem } from './steamStore';
import { steamAchievements } from './steamSync';
import { PLATFORM_FLAG_RE, applyFind, cleanTags, droppedTagValues, factTags, hours1, libraryView, needsProgress, ownedSteamAppids, slug, strList, tagsEmpty, type FindArgs, type LibGame } from './libraryIndex';
import { addTitles, collectionSummaries, hiddenTitleKeys } from './collections';
import { inventoryToolFind, inventoryToolOverview } from './inventory';
import { emit } from './events';
import { resolveTagsWithin, semanticSearch, type TagResolution } from './embeddings';
import { ownedTitleKeys, ownsTitle, storeDiscover, type DiscoverArgs } from './similar';
import { epicStoreDetails, type EpicDetails } from './epicStore';
import {
  CLARIFY_BELOW,
  bulletTitles,
  capInStoreCurrency,
  epicCardInfo,
  explain,
  isEditionPair,
  isNoLibraryFitNote,
  judgeCandidates,
  looksLikeRecommendation,
  parseIntent,
  pickCandidates,
  selectCandidates,
  shownTitleKeys,
  storeCurrency,
  type Candidate,
  type Intent,
  type PickResult,
} from './aiPipeline';

// The "AI" page: a multi-turn assistant over the user's library, the Steam
// store and the local statistics. Same principle as the old search, now in a
// loop: the model asks for TOOLS (local functions), the launcher runs them and
// hands back the result, the model answers. Rules:
//   1. The model never sees raw data; tools return per-game facts the user
//      chose to share: title, stores, installed, hours played, last-played
//      date, achievement progress, and the AI profile the model itself wrote.
//      Nothing that identifies the account (Steam id, persona, e-mail) ever
//      leaves the machine.
//   2. Every game the answer names is resolved against the real library / the
//      store before the UI shows it as a card; unknown names stay plain text.
//   3. Bounded cost: at most 3 tool rounds per turn, results capped in size,
//      history trimmed, one JSON-mode call per round.
// Recommendation requests take a cheaper, steadier road first (aiPipeline.ts):
// one small call reads the request into structured constraints, the app picks
// candidates deterministically (hard filters + semantic ranking + well-known
// examples, Steam and Epic stores), one small call checks which of them really
// fit, and one streamed call explains the picks. Anything else — or a pipeline
// failure — goes through the tool loop above.

const MAX_ROUNDS = 3;
const MAX_CALLS_PER_ROUND = 4;
const MAX_HISTORY_TURNS = 10;
const MAX_TURN_CHARS = 1500;
const ANSWER_MAX_TOKENS = 1400;
const MAX_LIST = 40;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /** Titles the assistant showed as game cards in that turn (assistant turns only) — "more" must not repeat them. */
  games?: string[];
}

/** A game the user attached to the conversation through the picker (title + where it came from). */
export interface ContextGame {
  title: string;
  origin: 'library' | 'wishlist' | 'store';
  appid: number | null;
}
export const CONTEXT_LIMIT = 20;

export interface AssistantGame {
  title: string;
  note: string | null;
  owned: boolean;
  installed: boolean;
  appid: number | null;
  /** Epic app name (launch id) when the game is in the EGS library. */
  epicAppName: string | null;
  /** Library cover for games without a Steam header (EGS-only). */
  iconUrl: string | null;
  /** Which store a not-owned card is from ('steam' with appid, 'epic' with epicUrl); null for owned games. */
  store: 'steam' | 'epic' | null;
  /** Epic store product page for store === 'epic'. */
  epicUrl: string | null;
  /** Cover image for Epic store cards (Steam cards use the appid header). */
  image: string | null;
  /** Formatted price for Epic store cards ("Free", "2 990 ₸"); Steam cards read live store metadata instead. */
  price: string | null;
}

export interface AssistantReply {
  answer: string;
  games: AssistantGame[];
  /** Everything the library tools returned this turn (the "all results" section). */
  libraryResults: AssistantGame[];
  /** Store ids the store tools returned this turn. */
  storeResults: number[];
  suggestions: string[];
  toolsUsed: string[];
  model: string;
  /** `byModel`: the same tokens split by model id (a turn can parse on one model and explain on another). */
  usage: { promptTokens: number; completionTokens: number; byModel?: Record<string, { in: number; out: number }> };
}

export interface AssistantProgress {
  phase: 'thinking' | 'tools' | 'answer';
  tools: string[];
  round: number;
  /** The answer text decoded so far from the streamed JSON (only while the final answer is being written). */
  partial?: string;
  /** Set when the first model was busy or silent and another one is being tried. */
  switchedTo?: string;
}

/**
 * Pulls the value of "answer" out of a JSON object that is still being
 * streamed: decodes escapes up to the closing quote (or the end of what has
 * arrived). null until the key shows up — tool rounds never produce one.
 */
function partialAnswer(text: string): string | null {
  const m = /"answer"\s*:\s*"/.exec(text);
  if (!m) return null;
  const s = text.slice(m.index + m[0].length);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') break;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) break; // escape cut mid-way — wait for more
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'u') {
      const hex = s.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += n;
    i++;
  }
  return out;
}

/**
 * An onDelta handler for the pipeline's explanation call (which streams the
 * raw JSON, like chatJson): paints the answer as it is written, throttled
 * like the tool loop's final round.
 */
function answerStreamer(tools: string[], round: number): (soFar: string) => void {
  let lastEmit = 0;
  return (soFar) => {
    const now = Date.now();
    if (now - lastEmit < 80) return;
    const partial = partialAnswer(soFar);
    if (partial === null) return;
    lastEmit = now;
    emit('ai:progress', { phase: 'answer', tools, round, partial } satisfies AssistantProgress);
  };
}

/** What a tool says about one game: per-game facts, no account data. `want` = the Steam tag names a filter asked for. */
function describe(g: LibGame, want: string[] = []): Record<string, unknown> {
  const p = g.profile;
  return {
    title: g.title,
    on: g.sources.map((s) => (s === 'Epic' ? 'EGS' : s)),
    installed: g.installed,
    hoursPlayed: hours1(g.minutes),
    ...(g.lastPlayedAt ? { lastPlayed: g.lastPlayedAt.slice(0, 10) } : {}),
    ...(g.minutes2w > 0 ? { hoursLast2Weeks: hours1(g.minutes2w) } : {}),
    ...(g.progress && g.progress.total > 0 ? { achievements: `${g.progress.unlocked}/${g.progress.total} (${g.progress.percentage}%)` } : {}),
    ...(g.storeTags.length ? { steamTags: factTags(g.storeTags, want) } : {}),
    ...(p && p.known
      ? {
          length: p.endless ? 'endless' : p.lengthHours !== null ? `~${p.lengthHours}h` : null,
          genres: p.genres.slice(0, 4),
          moods: p.moods.slice(0, 4),
          modes: p.modes,
          ...(p.coopPlayers ? { coop: p.coopPlayers } : {}),
          ...(p.keywords?.length ? { keywords: p.keywords.slice(0, 6) } : {}),
        }
      : {}),
  };
}

const toRef = (g: LibGame, note: string | null = null): AssistantGame => ({
  title: g.title,
  note,
  owned: true,
  installed: g.installed,
  appid: g.appid,
  epicAppName: g.epicAppName,
  iconUrl: g.iconUrl,
  store: null,
  epicUrl: null,
  image: null,
  price: null,
});

/** A not-owned card: a Steam store game (appid), or a plain text card when no store knows the title. */
const storeCard = (title: string, note: string | null, appid: number | null): AssistantGame => ({
  title,
  note,
  owned: false,
  installed: false,
  appid,
  epicAppName: null,
  iconUrl: null,
  store: appid ? 'steam' : null,
  epicUrl: null,
  image: null,
  price: null,
});

/** A not-owned card for a game sold on the Epic store; the button opens its product page. */
const epicCard = (title: string, note: string | null, epic: NonNullable<Candidate['epic']>): AssistantGame => ({
  title,
  note,
  owned: false,
  installed: false,
  appid: null,
  epicAppName: null,
  iconUrl: null,
  store: 'epic',
  epicUrl: epic.url,
  image: epic.image,
  price: epic.price,
});

// ---------- tools ----------

async function storeItemsFor(appids: number[], lang: string): Promise<StoreItem[]> {
  if (!appids.length) return [];
  const meta = await itemsMeta(appids, lang).catch(() => ({} as Record<number, StoreItem>));
  return appids.map((id) => meta[id]).filter((x): x is StoreItem => !!x);
}

function describeStore(it: StoreItem, ownedKeys: Set<string>, ownedIds: Set<number>): Record<string, unknown> {
  return {
    title: it.name,
    appid: it.appid,
    kind: it.kind ?? 'unknown',
    price: it.price?.formattedFinal ?? (it.isFree ? 'free' : null),
    ...(it.price?.discountPct ? { discount: `-${it.price.discountPct}%` } : {}),
    ...(it.reviewPct != null ? { reviewPct: it.reviewPct } : {}),
    owned: ownedIds.has(it.appid) || ownsTitle(ownedKeys, normalizeTitle(it.name)),
  };
}

/**
 * Owned sets for the store tools' "owned" flag and excludeOwned (titles and Steam appids). The appids
 * include the Steam twins of Epic-only games: the store names a game in the UI language, so a title
 * match alone misses a game owned on Epic. The titles include their edition-less forms (look them up
 * with ownsTitle): Epic's "... GAME OF THE YEAR EDITION" is the store's plain title.
 */
async function ownedSets(): Promise<{ ownedKeys: Set<string>; ownedIds: Set<number> }> {
  const lib = await libraryView(false);
  return { ownedKeys: ownedTitleKeys(lib), ownedIds: ownedSteamAppids(lib) };
}

/** How long a tool waits for the resolver's embedding pass; a first-ever tag-index build can take minutes. */
const TAG_RESOLVE_WAIT_MS = 10_000;

/**
 * The resolver with a deadline for its embedding pass: past it exact names and synonyms still resolve,
 * a phrase that needed the tag index stays unresolved, and the tag-index build goes on detached.
 */
async function resolveTagsBounded(list: string[]): Promise<TagResolution[]> {
  try {
    return await resolveTagsWithin(list, TAG_RESOLVE_WAIT_MS, { top: 1 });
  } catch {
    return list.map((phrase) => ({ phrase, tags: [], exact: false }));
  }
}

/**
 * Platform flags as families, the way the pipeline's hard filter reads them: "Steam Deck" accepts
 * Verified or Playable (a single embedding pick would drop one class), a VR phrase accepts the user tag
 * and both official flags. "verified" / "only" narrow the family. null = not a platform phrase.
 */
function platformFamily(phrase: string, r: TagResolution | undefined): string[] | null {
  const p = phrase.toLowerCase();
  const t = (r?.tags[0]?.name ?? '').toLowerCase();
  // An exact hit on an ordinary tag is that tag, whatever its words ("deck builder" → Deckbuilding).
  if (r?.exact && t && t !== 'vr' && !PLATFORM_FLAG_RE.test(t)) return null;
  if (/unsupported/.test(p) || /unsupported/.test(t)) return null;
  if (/steam\s*deck|стим[\s-]*дек|\bdeck\b(?![\s-]*build)/.test(p) || t.startsWith('steam deck ')) {
    return /verified|провер/.test(p) ? ['Steam Deck Verified'] : ['Steam Deck Verified', 'Steam Deck Playable'];
  }
  if (/\bvr\b|virtual reality/.test(p) || t === 'vr only' || t === 'vr supported') {
    return /\bonly\b|только/.test(p) ? ['VR Only'] : ['VR', 'VR Supported', 'VR Only'];
  }
  return null;
}

/**
 * Maps the model's tag phrases ("coop", "pixel art", a word in the user's
 * language) to exact Steam tag names: one group per phrase, which a game
 * satisfies with ANY of its names (platform families have several, other
 * phrases the best match). A phrase nothing resolves is kept as given, so the
 * store side can still report it as unknown and the library's substring match
 * still gets its chance. `names` is every name of every group.
 */
async function resolveTagPhrases(phrases: string[]): Promise<{ groups: string[][]; names: string[]; resolved: Record<string, string> }> {
  const list = [...new Set(phrases.map((p) => p.trim()).filter(Boolean))];
  if (!list.length) return { groups: [], names: [], resolved: {} };
  const res = await resolveTagsBounded(list);
  const groups: string[][] = [];
  const resolved: Record<string, string> = {};
  list.forEach((phrase, i) => {
    const r = res.find((x) => x.phrase === phrase) ?? res[i];
    const top = r?.tags[0]?.name;
    const family = platformFamily(phrase, r);
    const names = family ?? [top ?? phrase];
    if (family || top) resolved[phrase] = names.join(' or ');
    // Two phrases for the same tag are one requirement.
    const id = names.map((n) => n.toLowerCase()).join('|');
    if (!groups.some((g) => g.map((n) => n.toLowerCase()).join('|') === id)) groups.push(names);
  });
  return { groups, names: [...new Set(groups.flat())], resolved };
}

/**
 * Platform flags are not Steam tag ids, so the store's tag search cannot browse by them: VR flags
 * browse by the "VR" user tag, Steam Deck flags not at all (null); the flag itself is then checked on
 * the results' metadata (flags are English in every UI language).
 */
const FLAG_BROWSE = new Map<string, string | null>([
  ['vr only', 'VR'],
  ['vr supported', 'VR'],
  ['steam deck verified', null],
  ['steam deck playable', null],
  ['steam deck unsupported', null],
]);

/** Phrases that resolved to a differently spelled tag — worth telling the model, identity mappings are noise. */
const renamed = (resolved: Record<string, string>): Record<string, string> | null => {
  const out = Object.fromEntries(Object.entries(resolved).filter(([p, t]) => p.toLowerCase() !== t.toLowerCase()));
  return Object.keys(out).length ? out : null;
};

/** Facts the "worth buying" prompt and the store tool both start from. Everything here is public store data. */
export interface GameFacts {
  appid: number;
  name: string;
  owned: boolean;
  price: string | null;
  discountPct: number | null;
  isFree: boolean;
  releaseDate: string | null;
  comingSoon: boolean;
  genres: string[];
  tags: string[];
  metacritic: number | null;
  reviewScoreDesc: string | null;
  reviewTotal: number | null;
  positivePct: number | null;
  recentTotal: number | null;
  recentPositivePct: number | null;
  currentPlayers: number | null;
  shortDescription: string | null;
  /** Similar games the user already owns (by AI-profile genres / store tags) and how much they played them. */
  similarOwned: { title: string; hoursPlayed: number; shared: string[] }[];
  snippets: { up: boolean; text: string }[];
}

async function gameFacts(appid: number, lang: string, withSnippets: boolean): Promise<GameFacts> {
  const [d, rev] = await Promise.all([appDetails(appid, lang), appReviewsFacts(appid, lang, withSnippets ? 8 : 0).catch(() => null)]);
  const lib = await libraryView(false);
  // The twin appids catch a game owned on Epic whose localized store name differs from the library title.
  const owned = ownedSteamAppids(lib).has(appid) || ownsTitle(ownedTitleKeys(lib), normalizeTitle(d.name));
  const similarOwned = similarInLibrary(d, lib);
  const pct = (pos: number | null | undefined, total: number | null | undefined) => (pos != null && total ? Math.round((pos / total) * 100) : null);
  return {
    appid,
    name: d.name,
    owned,
    price: d.price?.formattedFinal ?? (d.isFree ? 'free' : null),
    discountPct: d.price?.discountPct ?? null,
    isFree: !!d.isFree,
    releaseDate: d.releaseDate ?? null,
    comingSoon: !!d.comingSoon,
    genres: d.genres,
    tags: d.tags,
    metacritic: d.metacritic ?? null,
    reviewScoreDesc: d.reviewScoreDesc ?? null,
    reviewTotal: d.reviewTotal ?? null,
    positivePct: pct(d.reviewTotalPositive, d.reviewTotal),
    recentTotal: rev?.recentTotal ?? null,
    recentPositivePct: pct(rev?.recentPositive, rev?.recentTotal),
    currentPlayers: d.currentPlayers ?? null,
    shortDescription: d.shortDescription ?? null,
    similarOwned,
    snippets: rev?.snippets ?? [],
  };
}

/** Owned games that share genres with the store game — AI profile genres first, store genres/tags as a fallback. */
function similarInLibrary(d: GameDetails, lib: LibGame[]): GameFacts['similarOwned'] {
  const want = new Set([...d.genres, ...d.tags].map((s) => slug(s)));
  const scored = lib
    .map((g) => {
      const mine = new Set<string>([...(g.profile?.known ? g.profile.genres : []), ...(g.profile?.known ? g.profile.themes.map(slug) : [])]);
      const shared = [...mine].filter((x) => want.has(x) || [...want].some((w) => w.includes(x) || x.includes(w)));
      return { g, shared };
    })
    .filter((x) => x.shared.length >= 2 && x.g.key !== normalizeTitle(d.name))
    .sort((a, b) => b.shared.length - a.shared.length || b.g.minutes - a.g.minutes)
    .slice(0, 6);
  return scored.map(({ g, shared }) => ({ title: g.title, hoursPlayed: hours1(g.minutes), shared: shared.slice(0, 4) }));
}

interface ToolRun {
  name: string;
  result: unknown;
  libraryHits: LibGame[];
  storeIds: number[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

interface LibraryScope {
  lib: LibGame[];
  /** The caller's filters without steamTags — scopeFind applies those per phrase. */
  find: FindArgs;
  /** One group per Steam tag phrase: a game must carry ANY name of EVERY group. */
  tagGroups: string[][];
  /** Every resolved tag name, so the facts can show what matched (describe). */
  tagNames: string[];
  resolved: Record<string, string>;
}

/**
 * The library pool the library tools share: vocabulary validation (a made-up
 * value must not degrade into "every game"), hidden games out, Steam tag
 * phrases resolved to exact names (scopeFind applies them).
 */
async function libraryScope(f: any): Promise<{ error: string } | LibraryScope> {
  const dropped = droppedTagValues(f.tags);
  if (dropped.length) {
    return { error: `unknown tag values: ${dropped.join(', ')}. genres/moods/modes accept only the listed vocabulary; for Steam user tags such as "VR", "Anime" or "Pixel Graphics" use steamTags: [...]` };
  }
  // Hidden games stay out of the tools' view, like they stay out of the library list.
  const [hidden, all, tags] = await Promise.all([hiddenTitleKeys(), libraryView(needsProgress(f), true), resolveTagPhrases(strList(f.steamTags, 6))]);
  const lib = all.filter((g) => !hidden.has(g.key));
  // An ownership check names games as the stores spell them ("Control"), the library may hold an edition
  // ("CONTROL Ultimate Edition"): the titles filter accepts the owned edition too, so it is not called unowned.
  const titles: string[] | null = Array.isArray(f.titles) ? f.titles.filter((t: unknown): t is string => typeof t === 'string') : null;
  const wanted = titles ? titles.map(normalizeTitle).filter(Boolean) : [];
  const editions = lib.filter((g) => wanted.some((k) => isEditionPair(g.key, k))).map((g) => g.title);
  return {
    lib,
    find: { ...f, steamTags: undefined, ...(titles ? { titles: [...titles, ...editions] } : {}) },
    tagGroups: tags.groups,
    tagNames: tags.names,
    resolved: tags.resolved,
  };
}

/**
 * applyFind over the scope with every Steam tag phrase required: the prompt promises games matching
 * ALL conditions, while applyFind alone keeps a game carrying ANY of its steamTags (which dynamic
 * collections rely on). One applyFind per phrase, intersected, then the other filters.
 */
function scopeFind(scope: LibraryScope, extra: Partial<FindArgs> = {}): LibGame[] {
  let pool = scope.lib;
  for (const names of scope.tagGroups) {
    const keep = new Set(applyFind(pool, { steamTags: names }).map((g) => g.key));
    pool = pool.filter((g) => keep.has(g.key));
  }
  return applyFind(pool, { ...scope.find, ...extra });
}

/** "N games have no AI profile" — only when profile-based tag filters were asked for (they cannot match those games). */
const unprofiledNote = (lib: LibGame[], tags: unknown): Record<string, string> => {
  const n = !tagsEmpty(cleanTags(tags)) ? lib.filter((g) => !g.profile?.known).length : 0;
  return n ? { note: `${n} games have no AI profile and cannot match tag filters` } : {};
};

/** A price cap from model JSON: a number (or numeric string) ≥ 0; 0 means "free only" for storeDiscover. */
const priceCap = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
};

async function runTool(name: string, args: any, lang: string): Promise<ToolRun> {
  const a = args && typeof args === 'object' ? args : {};
  if (process.env.LAUNCHER_AI_DEBUG) console.log(`[ai] tool ${name} ${JSON.stringify(a).slice(0, 400)}`);
  const run: ToolRun = { name, result: null, libraryHits: [], storeIds: [] };
  switch (name) {
    case 'library_find':
    case 'random_pick': {
      const scope = await libraryScope(a);
      if ('error' in scope) {
        run.result = { error: scope.error, items: [] };
        return run;
      }
      const found = scopeFind(scope, name === 'random_pick' ? { sort: 'random' } : {});
      const limit = Math.min(MAX_LIST, Math.max(1, Number(a.limit) || (name === 'random_pick' ? 3 : 25)));
      const shown = found.slice(0, limit);
      run.libraryHits = shown;
      const tagRenames = renamed(scope.resolved);
      run.result = {
        total: found.length,
        shown: shown.length,
        ...unprofiledNote(scope.lib, a.tags),
        ...(tagRenames ? { steamTagsResolved: tagRenames } : {}),
        items: shown.map((g) => describe(g, scope.tagNames)),
      };
      return run;
    }
    case 'library_semantic': {
      const query = String(a.query ?? '').trim().slice(0, 300);
      if (!query) {
        run.result = { error: 'query is required (the wished feel or content in words)', items: [] };
        return run;
      }
      const filters = a.filters && typeof a.filters === 'object' ? a.filters : {};
      const scope = await libraryScope(filters);
      if ('error' in scope) {
        run.result = { error: scope.error, items: [] };
        return run;
      }
      // Hard filters first (every result satisfies them), then meaning ranks the survivors.
      const pool = scopeFind(scope, { sort: undefined, limit: undefined });
      const k = Math.min(MAX_LIST, Math.max(1, Number(a.k) || 12));
      let hits: { key: string; score: number }[];
      try {
        hits = pool.length ? await semanticSearch(query, { candidates: pool.map((g) => g.key), k }) : [];
      } catch (e) {
        if (e instanceof Error && e.message === 'INDEX_EMPTY') {
          run.result = { error: 'semantic index not built yet; use library_find with tags', items: [] };
          return run;
        }
        throw e;
      }
      const byKey = new Map(pool.map((g) => [g.key, g]));
      const ranked = hits.map((h) => ({ g: byKey.get(h.key), score: h.score })).filter((x): x is { g: LibGame; score: number } => !!x.g);
      // semanticSearch skips games without a vector (synced since the last index build, or left out by a
      // build that stopped early). When it returned fewer than it could, every pool game it left out is
      // such a game: they follow the ranked ones (playtime order, score null) instead of vanishing.
      const seen = new Set(ranked.map((x) => x.g.key));
      const unindexed = ranked.length < Math.min(k, pool.length) ? pool.filter((g) => !seen.has(g.key)) : [];
      const extra = unindexed.slice(0, k - ranked.length);
      run.libraryHits = [...ranked.map((x) => x.g), ...extra];
      const tagRenames = renamed(scope.resolved);
      const item = (g: LibGame, score: number | null) => ({
        ...describe(g, scope.tagNames),
        score: score === null ? null : Math.round(score * 100) / 100,
        ...(g.profile?.pitch ? { pitch: g.profile.pitch } : {}),
      });
      run.result = {
        total: pool.length,
        shown: ranked.length + extra.length,
        ...unprofiledNote(scope.lib, filters.tags),
        ...(tagRenames ? { steamTagsResolved: tagRenames } : {}),
        ...(unindexed.length ? { unindexed: unindexed.length, hint: 'items with score null have no semantic vector yet and are not ranked; judge them by their facts' } : {}),
        items: [...ranked.map(({ g, score }) => item(g, score)), ...extra.map((g) => item(g, null))],
      };
      return run;
    }
    case 'game_profile': {
      const lib = await libraryView(true, true);
      const key = normalizeTitle(String(a.title ?? ''));
      const g = lib.find((x) => x.key === key) ?? lib.find((x) => x.key.includes(key) || key.includes(x.key));
      if (!g) {
        run.result = { owned: false, note: 'not in the library; use store_game_info for store games' };
        return run;
      }
      run.libraryHits = [g];
      const p = g.profile;
      // v1 profiles carry no confidence: known ones count as medium, unknown ones as low.
      const confidence = p ? (p.confidence ?? (p.known ? 'medium' : 'low')) : null;
      run.result = {
        ...describe(g),
        owned: true,
        ...(p?.known
          ? {
              summary: p.summary,
              themes: p.themes,
              ...(p.pitch ? { pitch: p.pitch } : {}),
              ...(p.keywords?.length ? { keywords: p.keywords } : {}),
              confidence,
            }
          : p
            ? { confidence, note: 'little is known about this game; its AI profile is minimal' }
            : { note: 'no AI profile for this game yet' }),
      };
      return run;
    }
    case 'store_search': {
      const query = String(a.query ?? '').slice(0, 80);
      if (!query) {
        run.result = { error: 'query is required' };
        return run;
      }
      const hits = (await storeSearch(query, lang).catch(() => [] as StoreItem[])).slice(0, 12);
      const items = await storeItemsFor(hits.map((h) => h.appid), lang);
      const { ownedKeys, ownedIds } = await ownedSets();
      let list = items.filter((it) => !it.kind || it.kind === 'game').filter((it) => !it.comingSoon);
      if (a.onSaleOnly) list = list.filter((it) => (it.price?.discountPct ?? 0) > 0);
      list = list.slice(0, Math.min(12, Math.max(1, Number(a.limit) || 8)));
      run.storeIds = list.map((it) => it.appid);
      run.result = { items: list.map((it) => describeStore(it, ownedKeys, ownedIds)) };
      return run;
    }
    case 'store_browse': {
      const phrases = strList(a.tags, 6);
      if (!phrases.length) {
        run.result = { error: 'tags are required (Steam tag names, e.g. ["Anime","Roguelike"])' };
        return run;
      }
      // Loose phrases ("coop", "pixel art", a word in the user's language) become exact tag names first.
      const tags = await resolveTagPhrases(phrases);
      // One browse tag per phrase; a platform flag browses by its stand-in (or not at all) and is
      // checked on the results instead of being dropped as an unknown tag.
      const browse: string[] = [];
      const flagChecks: string[][] = [];
      for (const names of tags.groups) {
        const stand = FLAG_BROWSE.get(names[0].toLowerCase());
        if (stand === undefined) {
          browse.push(names[0]);
          continue;
        }
        if (stand) browse.push(stand);
        flagChecks.push(names);
      }
      if (!browse.length) {
        run.result = { error: 'the store tag search cannot browse by Steam Deck flags alone; add a kind of game (e.g. "Roguelike"), or use store_discover with requireTags', items: [] };
        return run;
      }
      const sort: StoreBrowseSort = a.sort === 'reviews' || a.sort === 'new' || a.sort === 'price' ? a.sort : 'relevance';
      const limit = Math.min(20, Math.max(1, Number(a.limit) || 12));
      // A flag check thins the list out, so browse deeper first.
      const r = await storeBrowseByTags([...new Set(browse)], lang, { onSaleOnly: !!a.onSaleOnly, sort, limit: flagChecks.length ? 50 : limit });
      const { ownedKeys, ownedIds } = await ownedSets();
      let list = r.items.filter((it) => flagChecks.every((names) => (it.tags ?? []).some((t) => names.some((n) => n.toLowerCase() === t.toLowerCase()))));
      if (a.excludeOwned !== false) list = list.filter((it) => !ownedIds.has(it.appid) && !ownsTitle(ownedKeys, normalizeTitle(it.name)));
      list = list.slice(0, limit);
      run.storeIds = list.map((it) => it.appid);
      run.result = {
        tagsUsed: r.tags,
        ...(flagChecks.length ? { platformFlagsRequired: flagChecks.map((n) => n.join(' or ')) } : {}),
        ...(Object.keys(tags.resolved).length ? { resolved: tags.resolved } : {}),
        ...(r.unknownTags.length ? { unknownTags: r.unknownTags, hint: 'use exact Steam tag names; nothing was filtered by the unknown ones' } : {}),
        total: list.length,
        // Tags (flags first) let the model check hard constraints (rule 3a).
        items: list.map((it) => ({ ...describeStore(it, ownedKeys, ownedIds), ...(it.tags?.length ? { tags: factTags(it.tags, tags.names) } : {}) })),
      };
      return run;
    }
    case 'store_discover': {
      const similarTo = strList(a.similarTo, 5).map((t) => t.trim().slice(0, 120)).filter(Boolean);
      let query = typeof a.query === 'string' ? a.query.trim().slice(0, 300) : '';
      const tags = strList(a.tags, 6);
      let requireTags = strList(a.requireTags, 4).map((t) => t.trim()).filter(Boolean);
      if (!similarTo.length && !tags.length && !requireTags.length && !query) {
        run.result = { error: 'give similarTo (reference games), tags or query', items: [] };
        return run;
      }
      // A required phrase no Steam tag matches names a kind of game ("gacha", "anomaly hunting"): as a hard tag
      // it would be matched literally and empty the list. It joins the free description instead, as the
      // pipeline moves it into its concept; only real tags stay required.
      if (requireTags.length) {
        const { resolved } = await resolveTagPhrases(requireTags);
        const kinds = requireTags.filter((p) => !resolved[p]);
        if (kinds.length) {
          requireTags = requireTags.filter((p) => resolved[p]);
          query = [query, kinds.join(', ')].filter(Boolean).join('; ').slice(0, 300);
        }
      }
      // A cap the user named in another currency ("under $10" in a hryvnia store) is converted at the
      // daily rate; without a rate it is not applied (the result says so) rather than misapplied.
      const asked = priceCap(a.maxPrice);
      const cap = asked === undefined ? undefined : await capInStoreCurrency(asked, a.maxPriceCurrency);
      const d: DiscoverArgs = {
        similarTo,
        tags,
        requireTags,
        excludeTags: strList(a.excludeTags, 6),
        ...(query ? { query } : {}),
        onSaleOnly: !!a.onSaleOnly,
        ...(cap != null ? { maxPrice: cap } : {}),
        excludeOwned: a.excludeOwned !== false,
        // The reference games themselves never come back as "games like them".
        excludeTitles: [...similarTo, ...strList(a.excludeTitles, 40)],
        limit: Math.min(20, Math.max(1, Number(a.limit) || 12)),
      };
      const [r, { ownedKeys, ownedIds }] = await Promise.all([storeDiscover(d, lang), ownedSets()]);
      // The references themselves never come back among the items, but well-known games of a kind (rule 12)
      // are often the best answer: their store facts come along (one cached metadata batch).
      const refItems = await storeItemsFor(r.refs.map((x) => x.appid), lang);
      run.storeIds = [...r.items.map((x) => x.item.appid), ...refItems.map((it) => it.appid)];
      run.result = {
        refs: r.refs,
        ...(refItems.length
          ? { refItems: refItems.map((it) => ({ ...describeStore(it, ownedKeys, ownedIds), ...(it.tags?.length ? { tags: factTags(it.tags, []) } : {}) })) }
          : {}),
        ...(r.unknownRefs.length ? { unknownRefs: r.unknownRefs } : {}),
        tagsUsed: r.tagsUsed,
        ...(r.unknownTags.length
          ? {
              unknownTags: r.unknownTags,
              unknownTagsHint:
                'these phrases are not Steam tags (a genre or mechanic): follow rule 12 — name 3–6 well-known games of that kind and call store_discover {similarTo: [those games]}; never mention tags in the answer',
            }
          : {}),
        ...(cap != null
          ? { maxPriceApplied: `${cap} ${storeCurrency()}` }
          : asked !== undefined
            ? { maxPriceNotApplied: `no exchange rate for ${String(a.maxPriceCurrency)}; the price cap was not applied` }
            : {}),
        total: r.items.length,
        // describeStore already carries reviewPct; tags (flags and required ones first) let the model check hard constraints (rule 3a).
        items: r.items.map((x) => ({
          ...describeStore(x.item, ownedKeys, ownedIds),
          ...(x.item.tags?.length ? { tags: factTags(x.item.tags, r.tagsUsed.required) } : {}),
          why: x.why,
        })),
      };
      return run;
    }
    case 'store_game_info': {
      let appid = Number(a.appid) || null;
      if (!appid && a.title) appid = await findSteamAppId(String(a.title), lang).catch(() => null);
      if (!appid && a.title) appid = (await storeSearch(String(a.title), lang).catch(() => []))[0]?.appid ?? null;
      if (!appid) {
        run.result = { error: 'game not found in the Steam store' };
        return run;
      }
      const f = await gameFacts(appid, lang, true);
      run.storeIds = [appid];
      run.result = f;
      return run;
    }
    case 'collections_list': {
      run.result = { collections: await collectionSummaries() };
      return run;
    }
    case 'collection_add': {
      const name = String(a.name ?? '').trim().slice(0, 60);
      const titles = strList(a.titles, 40);
      if (!name || !titles.length) {
        run.result = { error: 'name and titles are required' };
        return run;
      }
      const r = await addTitles(name, titles, a.create !== false);
      if (r.collection) {
        const lib = await libraryView(false);
        run.libraryHits = lib.filter((g) => r.added.some((t) => normalizeTitle(t) === g.key));
      }
      run.result = { collection: r.collection?.name ?? null, added: r.added, alreadyIn: r.alreadyIn, notFound: r.notFound };
      return run;
    }
    case 'inventory_overview': {
      run.result = await inventoryToolOverview(lang);
      return run;
    }
    case 'inventory_find': {
      run.result = await inventoryToolFind(a, lang);
      return run;
    }
    case 'wishlist': {
      const { steamId } = getSteamAccount();
      if (!steamId) {
        run.result = { error: 'Steam is not signed in; the wishlist is unavailable' };
        return run;
      }
      const entries = await wishlistEntries(steamId).catch(() => []);
      const sorted = [...entries].sort((x, y) => x.priority - y.priority).slice(0, 60);
      const items = await storeItemsFor(sorted.map((e) => e.appid), lang);
      let list = items;
      if (a.onSaleOnly) list = list.filter((it) => (it.price?.discountPct ?? 0) > 0);
      list = list.slice(0, MAX_LIST);
      run.storeIds = list.map((it) => it.appid);
      run.result = { total: entries.length, items: list.map((it) => describeStore(it, new Set(), new Set())) };
      return run;
    }
    case 'achievements': {
      const lib = await libraryView(false);
      const key = normalizeTitle(String(a.title ?? ''));
      const g = lib.find((x) => x.key === key) ?? lib.find((x) => x.key.includes(key));
      if (!g?.appid) {
        run.result = { error: g ? 'achievements are only known for Steam games' : 'not in the library' };
        return run;
      }
      const data = await steamAchievements(g.appid, lang).catch(() => null);
      if (!data?.available) {
        run.result = { error: data?.reason === 'auth' ? 'Steam sign-in needed for achievements' : 'Steam has no achievement data for this game' };
        return run;
      }
      run.libraryHits = [g];
      const locked = data.achievements.filter((x) => !x.unlocked);
      run.result = {
        title: g.title,
        total: data.total,
        unlocked: data.unlocked,
        pct: data.total ? Math.round((data.unlocked / data.total) * 100) : 0,
        hiddenLocked: locked.filter((x) => x.hidden).length,
        // Easiest first: the global unlock rate is the best public difficulty signal.
        remaining: locked
          .filter((x) => !x.hidden)
          .sort((x, y) => (y.globalPct ?? 0) - (x.globalPct ?? 0))
          .slice(0, 25)
          .map((x) => ({ name: x.displayName ?? x.name, description: x.description, globalPct: x.globalPct != null ? Math.round(x.globalPct) : null })),
      };
      return run;
    }
    default:
      run.result = { error: `unknown tool ${name}` };
      return run;
  }
}

// ---------- prompt ----------

const SYSTEM = `You are the assistant inside a desktop game-library manager (Steam + Epic Games Store). You help the user pick what to play, finish or drop, decide what to buy, and answer questions about their library — always from tool results, never from assumptions about what they own or played.

# How you see data
You have no direct access. You call TOOLS; the app runs them locally and returns facts. One turn = up to ${MAX_ROUNDS} tool rounds of up to ${MAX_CALLS_PER_ROUND} calls each, then a final answer.

# Tools
- library_find {sources?: ["Steam"|"EGS"], installed?: bool, played?: "never"|"<1h"|"1-10h"|"10-50h"|"50h+"|"any_played", achievements?: "none"|"started"|"half"|"almost"|"perfect"|"has_any", lastPlayed?: "last_2_weeks"|"last_90_days"|"over_180_days_ago"|"never", titleContains?: string, titles?: [exact titles], tags?: {genres?, moods?, modes?, themes?, maxLengthHours?, minLengthHours?}, steamTags?: ["VR", "Anime", …], sort?: "playtime"|"recent"|"alpha"|"random"|"achievements", limit?: n≤${MAX_LIST}} → owned games matching ALL conditions, each with: stores, installed, hours played, last played, hours last 2 weeks, achievements, store tags (Steam user tags; EGS genre/feature tags for Epic-only games), AI profile (length, genres, moods, modes).
- random_pick {same filters, limit?} → random owned games from the filtered pool.
- library_semantic {query: "the wished feel or content in words, e.g. 'tense space exploration with base building'", k?: n≤${MAX_LIST}, filters?: {any library_find filters: installed, played, sources, tags, steamTags, …}} → owned games ranked by MEANING (AI profiles + store descriptions), best first, each with the library_find facts plus score (0–1) and a one-line pitch. The filters are hard (every result satisfies them); the query only ranks. THE tool for "games like X", a mood, a feel or a setting in the library.
- game_profile {title} → one owned game: AI profile (summary, pitch, keywords, themes, length, modes, confidence) + the same facts.
- store_search {query, onSaleOnly?, limit?} → Steam store games by NAME (titles and franchises work, genre words do not): price, discount, review %, owned flag.
- store_browse {tags: [Steam tags or tag phrases, e.g. "Anime","Roguelike","Sexual Content","Co-op","VR"], onSaleOnly?, sort?: "relevance"|"reviews"|"new"|"price", limit?≤20, excludeOwned?: bool (default true)} → Steam store games carrying ALL the tags, with price, discount, review % and owned flag. THE tool for "find <kind of game> in the store" (genre, theme, feature, art style); store_search is for names only.
- store_discover {similarTo?: [game titles, owned or not], tags?: [soft tag wishes], requireTags?: [tags every game must carry], excludeTags?: [tags no game may carry], query?: "free description of the wish", onSaleOnly?, maxPrice?: number as the user said it, maxPriceCurrency?: ISO code of the currency the user named ("USD" for "$10"; omit when they named none, a bare number is in the store currency {{currency}}), limit?≤20, excludeOwned?: bool (default true)} → Steam store games from Steam's "more like this" lists of the reference games and/or the tags, ranked by fit, each with price, discount, review %, tags, owned flag and why it was picked (the reference games themselves are never among them); plus the references found (refs; refItems with their own price, review %, tags and owned flag; unknownRefs) and the exact tags used. THE tool for "something like X" in the store.
- store_game_info {title | appid} → one store game: price, discount, release, genres, tags, Metacritic, all-time review % and count, 30-day review sample %, current players, review snippets, similar games the user owns (with hours).
- wishlist {onSaleOnly?} → the user's Steam wishlist with prices and discounts.
- achievements {title} → progress and remaining achievements of one owned Steam game, easiest first.
- inventory_overview {} → the user's Steam inventory per game: item counts, tradable and marketable counts.
- inventory_find {game?: name or appid, query?: text in name/type/description, tags?: [tag values that must all match, e.g. "Arcana", "Covert", "Factory New", "Foil", "Pudge"], tradable?: bool, marketable?: bool, sort?: "rarity"|"price"|"name"|"quantity"|"newest", withPrices?: bool (loads Steam Market prices for up to 10 items), limit?: n≤40} → the user's items, identical ones stacked: game, type, rarity, quality, exterior, quantity, tradable, marketable, trade hold, price when known, main tags.
- collections_list {} → the user's collections (name, kind, count, sample titles).
- collection_add {name, titles: [exact titles from tool results], create?: bool} → adds owned games to a manual collection (creates it unless create is false). Use when asked to collect, group, save or "make a collection".

# Vocabularies (library_find.tags — ONLY these values; anything else is rejected, not ignored)
GENRES: {{genres}}
MOODS: {{moods}}
MODES: {{modes}}
Concepts outside them (VR, anime, pixel graphics, souls-like, deckbuilder, roguelike …) → steamTags. Tag phrases may be in any language or loose spelling ("coop", "pixel art", "rogue-like", "nsfw"): the app resolves them to exact Steam tags for steamTags, store_browse and store_discover. Official platform flags are tags too: "Steam Deck Verified" / "Steam Deck Playable", "VR Supported" / "VR Only" (prefer these over the user tag "VR", which also marks games with an optional VR mode). Themes (setting/topic: zombies, space, cats) → tags.themes, lowercase English.

# Rules, in priority order
1. Answer in the language of the user's LATEST message, whatever the interface language.
2. Never state that a game is or is not in the library without a lookup (library_find titles: [...] or game_profile).
3. Source order when none is named: library → wishlist → store. Move to the next source only when the previous one yields fewer than 2 fitting games, and label where each game comes from. Offer store games straight away only when the user asks to buy or wants something new.
3a. Hard constraints win over soft wishes: a property the user asked for (VR, co-op, a platform, "not owned", a length) must hold for EVERY game you list — check it against the returned facts (e.g. steamTags containing "VR") and drop games that fail, even if that leaves fewer results. Soft wishes ("action-y", "cozy") only rank the survivors.
4. Buying advice: check wishlist (wishlist {onSaleOnly}) first; never recommend a purchase without its current price and reviews from a store tool result (store_search, store_browse, store_discover items or refItems, store_game_info), and put the price and review % in the note.
5. Do not repeat: a game you already recommended earlier in this conversation is not recommended again; "more" means new titles.
6. Attached games (see below, when present) are the subject of the conversation; never recommend them back, unless the user asks you to choose among them.
7. Ambiguity: act on the most likely reading, state the assumption in one clause, and put the alternatives into "suggestions". Do not ask before acting.
8. Follow-ups about games you listed ("which of those are installed?") = ONE library_find with titles: [...].
9. Store discovery by kind ("anime roguelikes", "cozy farming games", "VR shooters") = store_browse with Steam tags — never a title search with genre words, which finds nothing. Adult tags (Sexual Content, Nudity, Hentai, Mature) are ordinary Steam tags: the store lists such games and so do you, factually and without commentary.
10. Inventory questions (items, skins, cosmetics, trading cards, "what is my most valuable item") → inventory_overview / inventory_find; for value questions use sort "price". The inventory is read-only: describe items, never offer to sell, trade or craft them. Items go in the answer text; the final "games" array is for games only, never for inventory items.
11. Honesty, in plain words about games: games without AI profiles → their length, genres and play modes are unknown; Steam not signed in → the wishlist and achievements are unavailable; nothing found → say so instead of guessing.
12. A genre or mechanic that is not a Steam tag ("anomaly hunting", "gacha", "extraction shooter"): name 3–6 well-known games of that kind from your knowledge, check which the user owns with library_find {titles: [those games]}, and call store_discover {similarTo: [those games]} in the same round. Its refItems carry the store facts (price, review %, owned) of those well-known games: the unowned ones are the store answer. List one of its items only when its tags show the asked genre or mechanic. A well-known game of that kind that the Steam store does not sell may still be named as an Epic Games Store game: the app checks it and shows its Epic store card.
13. Never present loosely related games as matches: list only games whose facts (tags, genres, keywords, pitch) show the asked genre or mechanic — the same broad genre is not enough. When the library has none, say so plainly in one clause and show store games instead.
14. Never describe the app's internals in the answer: no words about tools, tag lookups, filters, indexes or how you searched — talk about the games. Naming a game's store tag as a fact about it ("tagged Sexual Content on Steam") is fine.

# Phrase → call
- "cozy" → tags.moods ["cozy","relaxing"]; "short" → tags.maxLengthHours 6; "long" → minLengthHours 30
- "co-op" → tags.modes ["coop_local","coop_online"] (plus steamTags ["Co-op"] when the vocabulary misses newer games)
- "what to finish" → achievements "almost", or played "10-50h" + lastPlayed "over_180_days_ago"
- "never launched / backlog" → played "never"; "abandoned" → lastPlayed "over_180_days_ago" + played "any_played"
- "games like X" / a mood or feel ("something atmospheric", "a game about space") → library_semantic {query}; hard constraints (installed, co-op, length, VR) go into its filters
- "something like X in the store" / "what new game is like X" → store_discover {similarTo: ["X"]}; a fuzzy wish without a reference → store_discover {tags, query}
- "what games are there in genre X" / a kind with no Steam tag ("anomaly hunting", "gacha") → rule 12: well-known examples → library_find {titles} + store_discover {similarTo}
- "how many hours in total" → library_find sort "playtime" limit 40; say the sum covers "your N most-played games" (never mention limits or calls)
- "is X worth buying" → store_game_info; weigh all-time vs 30-day review %, review count, price and discount, current players (multiplayer only), age, similar unplayed games owned → one verdict: buy / wait for a sale / skip / you own similar unplayed games

# Style
- Concise: at most two short sentences before the games, then the games. No greetings, apologies, restating the question, praise of the question, or closing offers.
- 2–5 games unless a list is requested. Each note ≤ 10 words and built on a tool fact (hours, tag, price, review %).
- Markdown: **bold titles**, bullets when listing; no headers, no tables.
- Every number comes from a tool result.

# Output — JSON only, nothing outside it
Tool round: {"calls":[{"tool":"…","args":{…}}]}
Final: {"answer":"…", "games":[{"title":"exact title from tool results","note":"≤ 10 words, fact-based"}], "suggestions":["follow-up in the user's language", …]}
"games": 0–8 (the games you recommend or discuss); "suggestions": 0–3. Never both shapes at once.`;

const systemPrompt = (lang: string, libSize: number, profiled: number, steamSignedIn: boolean, context: ContextGame[]): string =>
  SYSTEM.replace('{{genres}}', GENRES.join(', ')).replace('{{moods}}', MOODS.join(', ')).replace('{{modes}}', MODES.join(', ')).replace('{{currency}}', storeCurrency()) +
  `\n\nContext: user language ${lang === 'ru' ? 'Russian' : 'English'}; today ${new Date().toISOString().slice(0, 10)}; library ≈ ${libSize} games, ${profiled} of them with AI profiles; Steam ${steamSignedIn ? 'signed in' : 'NOT signed in (wishlist/achievements unavailable)'}.` +
  (context.length
    ? `\n\nATTACHED GAMES — the user picked these as the subject of the conversation ("these", "them", "similar to these" refer to this list):\n` +
      context.map((g) => `- ${g.title} (${g.origin === 'library' ? 'in their library' : g.origin === 'wishlist' ? 'on their Steam wishlist' : 'from the Steam store, not owned'})`).join('\n') +
      `\nUse them as given; call game_profile/store_game_info only when you need facts about them. For "games like these", use store_discover {similarTo: [the attached titles]} for store games and library_semantic (a query describing what they share: genre, mood, mechanics) for owned ones; titles you propose from your own knowledge must be verified with store_search / library_find so every recommendation is real. Exclude the attached games themselves from recommendations, unless the user asks you to choose among them ("which of these ...").`
    : '');

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const compact = (v: unknown, max = 9000): string => trim(JSON.stringify(v), max);

// ---------- the turn ----------

/** Errors that end the turn wherever they happen: trying the other road cannot help. */
const FATAL_AI = /^AI_(NO_KEY|AUTH|BALANCE|CANCELLED)\b/;

/** A capacity error this far into one model call means most of the model chain timed out before it. */
const SILENT_CHAIN_MS = 60_000;
/** Pipeline errors marked by modelStep as the end of the turn. */
const endsTurn = new WeakSet<Error>();

/**
 * Runs one of the pipeline's model calls. chatJson walks every curated model before it gives up, so
 * AI_TIMEOUT means none of them answered, and a capacity error (AI_RATE, AI_HTTP_5xx — chatJson names
 * only the last model's failure) after a long wait means most of them stayed silent. The tool loop
 * would walk the same chain again for minutes before failing the same way, so such an error ends the
 * turn; a quick capacity error still falls back (cheap, and a model may have freed up).
 */
async function modelStep<T>(call: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await call();
  } catch (e) {
    if (e instanceof Error && (/^AI_TIMEOUT\b/.test(e.message) || (/^AI_(RATE|HTTP_5\d\d)\b/.test(e.message) && Date.now() - started > SILENT_CHAIN_MS))) {
      endsTurn.add(e);
    }
    throw e;
  }
}

/** What one turn spent across all its model calls (the pipeline attempt and, after a fallback, the tool loop). */
interface Spend {
  promptTokens: number;
  completionTokens: number;
  model: string;
  /** The same tokens per model id: the intent, the explanation and a fallback can run on different models. */
  byModel: Record<string, { in: number; out: number }>;
}

/** Books one model call's tokens; `model` (when known) also becomes the turn's reported model. */
function addSpend(spend: Spend, promptTokens: number, completionTokens: number, model: string | undefined): void {
  spend.promptTokens += promptTokens;
  spend.completionTokens += completionTokens;
  if (!model) return;
  spend.model = model;
  const m = (spend.byModel[model] ??= { in: 0, out: 0 });
  m.in += promptTokens;
  m.out += completionTokens;
}

const usageOf = (spend: Spend): AssistantReply['usage'] => ({
  promptTokens: spend.promptTokens,
  completionTokens: spend.completionTokens,
  byModel: Object.fromEntries(Object.entries(spend.byModel).map(([m, t]) => [m, { ...t }])),
});

const suggestionsOf = (final: any): string[] =>
  Array.isArray(final?.suggestions) ? final.suggestions.filter((s: unknown): s is string => typeof s === 'string').slice(0, 3).map((s: string) => trim(s, 100)) : [];

/** How long the cards wait for Epic store lookups of titles Steam does not sell (tool loop answers). */
const EPIC_CARD_WAIT_MS = 5_000;
const EPIC_CARD_LOOKUPS = 4;

/**
 * Epic store offers for titles Steam does not sell: in parallel, whatever arrived within EPIC_CARD_WAIT_MS,
 * keyed by normalized title. Only an offer of exactly that game (or an edition of it) with a product page counts.
 */
async function epicOffers(titles: string[], lang: string): Promise<Map<string, EpicDetails>> {
  const out = new Map<string, EpicDetails>();
  const all = Promise.all(
    titles.slice(0, EPIC_CARD_LOOKUPS).map(async (title) => {
      const d = await epicStoreDetails(title, null, lang).catch(() => null);
      const want = normalizeTitle(title);
      const got = d ? normalizeTitle(d.title) : '';
      if (d?.storeUrl && got && (got === want || isEditionPair(got, want))) out.set(want, d);
    })
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([all, new Promise<void>((resolve) => (timer = setTimeout(resolve, EPIC_CARD_WAIT_MS)))]);
  clearTimeout(timer);
  // A snapshot: a lookup that answers after the deadline must not change the cards.
  return new Map(out);
}

/** The card for a pipeline candidate: owned → library card, Steam store → appid card, Epic store → Epic card. */
function candidateCard(c: Candidate, note: string | null): AssistantGame | null {
  if (c.origin === 'library') return c.lib ? toRef(c.lib, note) : null;
  if (c.store === 'epic') return c.epic?.url ? epicCard(c.title, note, c.epic) : storeCard(c.title, note, null);
  return c.appid ? storeCard(c.title, note, c.appid) : null;
}

/**
 * Turns the games a final answer names into cards, in the answer's order: the pipeline's candidates first
 * (`known`: library, Steam store and Epic store games it checked); then an owned title becomes a library
 * card; anything else a Steam store card when the store knows it — among the ids this turn already saw
 * first, then by a title lookup — else an Epic store card when the Epic store sells exactly that game. A
 * name nothing knows keeps a plain card without a store. Shared by the tool loop and the pipeline.
 */
async function resolveGames(raw: unknown, storeIds: Iterable<number>, lang: string, known: Candidate[] = []): Promise<AssistantGame[]> {
  const rawGames: any[] = Array.isArray(raw) ? raw.slice(0, 8) : [];
  if (!rawGames.length) return [];
  const lib = await libraryView(false);
  const byKey = new Map(lib.map((g) => [g.key, g]));
  // A model names an owned "CONTROL Ultimate Edition" plainly "Control": still the owned copy, never a store
  // card offering to buy it again (on Epic, which sells the plain title).
  const ownedCopy = (key: string): LibGame | undefined => byKey.get(key) ?? lib.find((g) => isEditionPair(g.key, key));
  const candidateByKey = new Map(known.map((c) => [normalizeTitle(c.title), c]));
  const slots: (AssistantGame | null)[] = [];
  const lookups: { at: number; title: string; note: string | null }[] = [];
  for (const g of rawGames) {
    const title = typeof g?.title === 'string' ? g.title.trim() : '';
    if (!title) continue;
    const note = typeof g?.note === 'string' ? trim(g.note.trim(), 120) : null;
    const key = normalizeTitle(title);
    const c = candidateByKey.get(key);
    const card = c ? candidateCard(c, note) : null;
    const owned = card ? null : ownedCopy(key);
    if (card || owned) {
      slots.push(card ?? toRef(owned!, note));
      continue;
    }
    lookups.push({ at: slots.length, title, note });
    slots.push(null);
  }
  if (lookups.length) {
    const ids = [...new Set(storeIds)];
    const items = ids.length ? await storeItemsFor(ids, lang) : [];
    const steam = await Promise.all(
      lookups.map(async (s) => {
        const k = normalizeTitle(s.title);
        const hit = items.find((it) => normalizeTitle(it.name) === k) ?? null;
        return { name: hit?.name ?? s.title, appid: hit?.appid ?? (await findSteamAppId(s.title, lang).catch(() => null)) };
      })
    );
    // Not on Steam: an Epic-only game the tool loop named ("Honkai: Star Rail") gets its Epic store card.
    const notOnSteam = lookups.filter((_, i) => !steam[i].appid).map((s) => s.title);
    const epic = notOnSteam.length ? await epicOffers(notOnSteam, lang) : new Map<string, EpicDetails>();
    lookups.forEach((s, i) => {
      const d = steam[i].appid ? undefined : epic.get(normalizeTitle(s.title));
      slots[s.at] = d ? epicCard(d.title, s.note, epicCardInfo(d)) : storeCard(steam[i].name, s.note, steam[i].appid);
    });
  }
  return slots.filter((x): x is AssistantGame => !!x);
}

/**
 * Suggestions under a clarifying question: the intent's `readings` — concrete
 * requests in the user's language that a click sends as the next message. The
 * assumption is not one: it is a clause ("co-op = online or local"), odd as a
 * message, so a question without readings simply has no chips.
 */
function clarifyReadings(intent: Intent): string[] {
  const readings = (intent as Intent & { readings?: unknown }).readings;
  return [...new Set(strList(readings, 3).map((s) => trim(s.trim(), 100)).filter(Boolean))].slice(0, 3);
}

/**
 * A short reply to the pipeline's clarifying question ("co-op", "horror", in
 * any language) has no request words of its own, so the pre-check alone would
 * hand it to the tool loop. The question turn is recognizable: an assistant turn
 * without games that ends in a question mark, right after a message the
 * pre-check took as a request. A false positive costs one small intent call.
 */
function answersClarifyingQuestion(turns: ChatTurn[], context: ContextGame[]): boolean {
  const n = turns.length;
  if (n < 3) return false;
  const [req, question, reply] = turns.slice(-3);
  if (req.role !== 'user' || question.role !== 'assistant' || reply.role !== 'user') return false;
  if (reply.content.length > 120 || question.games?.length || !/\?\s*$/.test(question.content)) return false;
  return looksLikeRecommendation(req.content, turns.slice(0, n - 3), context);
}

/**
 * "Already shown" is a soft exclusion. The shown set also holds games an earlier
 * turn merely listed ("which games are installed?"), and a follow-up that
 * narrows to exactly those ("pick one of the installed ones for tonight") must
 * not come back empty. When too few new games pass the hard constraints, the
 * shown library games that pass are offered again after the new ones, marked so
 * the explanation says so. Attached, ruled-out and hidden games stay out
 * (selectCandidates applies those itself). When the new picks went through
 * the fit check, the games offered again do too (billed into `spend`): an
 * earlier listing's games come back only when they match this request. After
 * a fit check that failed they come back unverified, like the new picks,
 * rather than after a second wait for a check that would fail the same way.
 * A library game offered again makes "your library has no such games" untrue,
 * so that note goes.
 */
async function offerShownAgain(pick: PickResult, turns: ChatTurn[], intent: Intent, lang: string, context: ContextGame[], shown: Set<string>, spend: Spend): Promise<void> {
  if (!shown.size || !intent.sources.includes('library') || pick.candidates.length >= intent.count) return;
  // Library only: cheap (no store calls), and the listing turns this is about list owned games.
  const again = await selectCandidates({ ...intent, sources: ['library'] }, lang, { exclude: new Set(), context }).catch(() => null);
  if (!again) return;
  const keyOf = (c: Candidate): string => c.lib?.key ?? normalizeTitle(c.title);
  const have = new Set(pick.candidates.map(keyOf));
  let back = again.candidates.filter((c) => c.origin === 'library' && shown.has(keyOf(c)) && !have.has(keyOf(c))).slice(0, intent.count);
  if (!back.length) return;
  if (!pick.stages.includes('fit_check')) back = back.map((c) => ({ ...c, fit: 'yes' as const }));
  else if (!pick.fitFailed) {
    const fr = await judgeCandidates(turns, intent, back, lang).catch(() => null);
    if (!fr) return;
    if (fr.promptTokens || fr.completionTokens) addSpend(spend, fr.promptTokens, fr.completionTokens, fr.model);
    back = fr.kept;
  }
  if (!back.length) return;
  pick.candidates.push(...back.map((c) => ({ ...c, facts: { ...c.facts, shownEarlier: true } })));
  pick.notes = pick.notes.filter((n) => !isNoLibraryFitNote(n));
  pick.notes.push('candidates with shownEarlier: true already appeared earlier in this conversation; too few new games pass the constraints, so they are offered again after the new ones — say so in one short clause');
}

/**
 * The pipeline for recommendation requests: read the request into
 * constraints (one small call), pick candidates without the model, check
 * which of them really fit (one small call, pickCandidates), explain the
 * picks (one streamed call). Returns null when the request is not a
 * recommendation after all — the tool loop takes it. `history` is the whole
 * validated conversation (earlier picks beyond the trimmed window must not
 * come back either). Model spend goes into `spend` as it happens, so a
 * fallback still reports what the turn cost. `explainModel` writes the
 * answer (undefined = the user's model).
 */
async function recommendTurn(turns: ChatTurn[], history: ChatTurn[], lang: string, context: ContextGame[], explainModel: string | undefined, spend: Spend): Promise<AssistantReply | null> {
  emit('ai:progress', { phase: 'thinking', tools: [], round: 0 } satisfies AssistantProgress);
  const parsed = await modelStep(() => parseIntent(turns, lang, context));
  addSpend(spend, parsed.promptTokens, parsed.completionTokens, parsed.model);
  const intent = parsed.intent;
  if (process.env.LAUNCHER_AI_DEBUG) console.log(`[ai] intent ${JSON.stringify(intent).slice(0, 1000)}`);
  if (intent.kind !== 'recommend') return null;
  const usage = () => usageOf(spend);

  // Too vague to act on well: one question beats a confident wrong list.
  if (intent.confidence < CLARIFY_BELOW && intent.question) {
    return {
      answer: intent.question.trim(),
      games: [],
      libraryResults: [],
      storeResults: [],
      suggestions: clarifyReadings(intent),
      toolsUsed: ['parse_intent'],
      model: spend.model,
      usage: usage(),
    };
  }

  // Earlier picks (cards + **bold** titles) stay out so "more" means new games, softly (offerShownAgain);
  // selectCandidates adds the attached, ruled-out and hidden games, which always stay out.
  const shown = shownTitleKeys(history);
  const pick = await pickCandidates(turns, intent, lang, {
    exclude: shown,
    context,
    onStage: (tools) => emit('ai:progress', { phase: 'tools', tools, round: 1 } satisfies AssistantProgress),
  });
  for (const s of pick.spend) addSpend(spend, s.promptTokens, s.completionTokens, s.model);
  await offerShownAgain(pick, turns, intent, lang, context, shown, spend);
  const toolsUsed = [...new Set(['parse_intent', ...pick.stages])];
  if (process.env.LAUNCHER_AI_DEBUG) {
    const list = pick.candidates.map((c) => `${c.store === 'epic' ? 'epic' : c.origin}:${c.title}${c.fit ? `(${c.fit})` : ''}`).join(', ');
    console.log(`[ai] candidates: ${list.slice(0, 800)}${pick.notes.length ? ` · notes: ${pick.notes.join('; ')}` : ''}`);
  }

  emit('ai:progress', { phase: 'answer', tools: toolsUsed, round: 2 } satisfies AssistantProgress);
  const ex = await modelStep(() =>
    explain(turns, intent, pick.candidates, lang, {
      model: explainModel,
      notes: pick.notes,
      onDelta: answerStreamer(toolsUsed, 2),
      onAttempt: (m, attempt) => {
        if (attempt > 0) emit('ai:progress', { phase: 'thinking', tools: toolsUsed, round: 2, switchedTo: m } satisfies AssistantProgress);
      },
    })
  );
  addSpend(spend, ex.promptTokens, ex.completionTokens, ex.model);
  const final = ex.final;
  const answer = typeof final?.answer === 'string' ? final.answer.trim() : '';
  // An empty explanation would surface as an empty bubble; the tool loop gets the turn instead.
  if (!answer) throw new Error('PIPELINE_EMPTY_ANSWER');
  const storeIds = [...new Set(pick.candidates.flatMap((c) => (c.origin !== 'library' && c.appid ? [c.appid] : [])))];
  return {
    answer,
    games: await resolveGames(final.games, storeIds, lang, pick.candidates),
    // The games that passed the fit check: a dropped one was judged not to be what was asked.
    libraryResults: pick.candidates.flatMap((c) => (c.origin === 'library' && c.lib ? [toRef(c.lib)] : [])).slice(0, 60),
    storeResults: storeIds.slice(0, 24),
    suggestions: suggestionsOf(final),
    toolsUsed,
    model: spend.model,
    usage: usage(),
  };
}

/** The general road: the model asks for tools for up to MAX_ROUNDS rounds, then answers from their results. */
async function toolLoop(turns: ChatTurn[], lang: string, context: ContextGame[], escalateTo: string | undefined, spend: Spend): Promise<AssistantReply> {
  const libKeys = new Set(getEntries().map((e) => normalizeTitle(e.title)).filter(Boolean));
  const profiled = Object.values(getProfiles()).filter((p) => p.known).length;
  // The model sees role + text only; the card titles of earlier turns are for the pipeline's exclusions.
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(lang, libKeys.size, profiled, !!getSteamAccount().steamId, context) }, ...turns.map(({ role, content }) => ({ role, content }))];

  const toolsUsed: string[] = [];
  const libraryHits = new Map<string, LibGame>();
  const storeIds = new Set<number>();
  let final: any = null;
  let corrected = false;

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    emit('ai:progress', { phase: round === 0 ? 'thinking' : 'answer', tools: toolsUsed, round } satisfies AssistantProgress);
    const forced = round === MAX_ROUNDS;
    const msgs: ChatMessage[] = forced ? [...messages, { role: 'user', content: 'Tool budget exhausted — answer now with what you have, JSON final answer only.' }] : messages;
    // Stream every round: a tool round yields nothing visible, the final one paints the answer as it is written.
    let lastEmit = 0;
    const res = await chatJson(msgs, ANSWER_MAX_TOKENS, {
      model: toolsUsed.length > 0 ? escalateTo : undefined,
      onAttempt: (m, attempt) => {
        if (attempt > 0) emit('ai:progress', { phase: 'thinking', tools: toolsUsed, round, switchedTo: m } satisfies AssistantProgress);
      },
      onDelta: (soFar) => {
        const now = Date.now();
        if (now - lastEmit < 80) return;
        const partial = partialAnswer(soFar);
        if (partial === null) return;
        lastEmit = now;
        emit('ai:progress', { phase: 'answer', tools: toolsUsed, round, partial } satisfies AssistantProgress);
      },
    });
    addSpend(spend, res.promptTokens, res.completionTokens, res.model);
    const parsed = parseJson(res.text);
    if (process.env.LAUNCHER_AI_DEBUG) console.log(`[ai] ${res.model} round ${round}: ${res.text.replace(/\s+/g, ' ').slice(0, 300)}`);
    const calls: any[] = !forced && Array.isArray(parsed?.calls) ? parsed.calls.slice(0, MAX_CALLS_PER_ROUND) : [];
    if (!calls.length) {
      const hasAnswer = typeof parsed?.answer === 'string' && parsed.answer.trim().length > 0;
      // A reply with neither calls nor an answer (a model that ignored the contract, a truncated
      // thought) gets one correction round instead of surfacing as an empty bubble.
      if (!hasAnswer && !forced && !corrected) {
        corrected = true;
        messages.push({ role: 'assistant', content: res.text.slice(0, 2000) });
        messages.push({ role: 'user', content: 'That reply did not follow the contract. Reply with JSON only: either {"calls":[...]} to use tools, or the final answer object with a non-empty "answer" in the language of the user.' });
        continue;
      }
      // Games named before any lookup come from the model's memory: ownership, install state and hours
      // would be guesses (seen live: a one-word "bored" in Russian was answered at once with unowned games called installed).
      // Attached games are known without a lookup, so naming only those is fine.
      const attachedKeys = new Set(context.map((g) => normalizeTitle(g.title)));
      const namedUnknown = Array.isArray(parsed?.games)
        ? parsed.games.some((g: any) => typeof g?.title === 'string' && !attachedKeys.has(normalizeTitle(g.title)))
        : false;
      if (hasAnswer && namedUnknown && toolsUsed.length === 0 && !forced && !corrected) {
        corrected = true;
        messages.push({ role: 'assistant', content: res.text.slice(0, 2000) });
        messages.push({ role: 'user', content: 'You named games without looking anything up. Whether the user owns a game, has it installed or played it, and every price, must come from tool results. Call the tools first ({"calls":[...]}), then answer.' });
        continue;
      }
      // After lookups, a named game that no tool returned is still from memory — seen live: "what do I own that
      // plays like Hades" answered with two unowned games described as "also in your library". One correction
      // round: look them up or leave them out.
      if (hasAnswer && toolsUsed.length > 0 && !forced && !corrected) {
        const named = [
          ...(Array.isArray(parsed?.games) ? parsed.games.map((g: any) => g?.title).filter((t: unknown): t is string => typeof t === 'string') : []),
          ...bulletTitles(parsed.answer),
        ];
        const storeKeys = storeIds.size ? new Set((await storeItemsFor([...storeIds], lang)).map((it) => normalizeTitle(it.name))) : new Set<string>();
        const known = (k: string): boolean =>
          libKeys.has(k) || attachedKeys.has(k) || storeKeys.has(k) || [...libKeys].some((o) => isEditionPair(o, k)) || [...storeKeys].some((s) => isEditionPair(s, k));
        const unverified = [...new Set(named.map((t) => t.trim()).filter((t) => t && !known(normalizeTitle(t))))];
        if (unverified.length) {
          corrected = true;
          messages.push({ role: 'assistant', content: res.text.slice(0, 2000) });
          messages.push({
            role: 'user',
            content: `No tool returned these games this turn: ${unverified.slice(0, 8).join('; ')}. Look them up (library_find {titles}, store_search, store_game_info) or leave them out. Never call a game the user's own unless a library tool returned it.`,
          });
          continue;
        }
      }
      final = hasAnswer || !parsed ? (parsed ?? { answer: res.text }) : { ...parsed, answer: typeof parsed.answer === 'string' ? parsed.answer : res.text };
      // A model that listed games in the text but left "games" empty still gets their cards (as in explain()).
      if (final && typeof final === 'object' && (!Array.isArray(final.games) || !final.games.length) && typeof final.answer === 'string') {
        const listed = bulletTitles(final.answer);
        if (listed.length) final = { ...final, games: listed.slice(0, 8).map((title) => ({ title, note: null })) };
      }
      break;
    }
    const names = calls.map((c) => String(c?.tool ?? '')).filter(Boolean);
    for (const n of names) if (!toolsUsed.includes(n)) toolsUsed.push(n);
    emit('ai:progress', { phase: 'tools', tools: names, round } satisfies AssistantProgress);
    // Small models sometimes flatten {"tool","args":{…}} into {"tool", …args}; accept both shapes.
    const argsOf = (c: any): unknown => (c && typeof c === 'object' && c.args && typeof c.args === 'object' ? c.args : c && typeof c === 'object' ? Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'tool')) : {});
    const runs = await Promise.all(calls.map((c) => runTool(String(c?.tool ?? ''), argsOf(c), lang).catch((e) => ({ name: String(c?.tool), result: { error: e instanceof Error ? e.message : String(e) }, libraryHits: [], storeIds: [] }) as ToolRun)));
    for (const r of runs) {
      for (const g of r.libraryHits) libraryHits.set(g.key, g);
      for (const id of r.storeIds) storeIds.add(id);
    }
    messages.push({ role: 'assistant', content: JSON.stringify({ calls }) });
    messages.push({ role: 'user', content: `Tool results:\n${runs.map((r) => `${r.name}: ${compact(r.result)}`).join('\n')}` });
  }

  const answer = typeof final?.answer === 'string' ? final.answer.trim() : typeof final === 'string' ? final : '';
  return {
    answer,
    games: await resolveGames(final?.games, storeIds, lang),
    libraryResults: [...libraryHits.values()].slice(0, 60).map((g) => toRef(g)),
    storeResults: [...storeIds].slice(0, 24),
    suggestions: suggestionsOf(final),
    toolsUsed,
    model: spend.model,
    usage: usageOf(spend),
  };
}

export async function assistantChat(history: ChatTurn[], lang: string, context: ContextGame[] = []): Promise<AssistantReply> {
  if (!getChutesApiKey()) throw new Error('AI_NO_KEY');
  const valid: ChatTurn[] = history
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
    .map((t) => ({
      role: t.role,
      content: trim(t.content.trim(), MAX_TURN_CHARS),
      ...(t.role === 'assistant' && Array.isArray(t.games) ? { games: strList(t.games, 8).map((s) => trim(s.trim(), 200)) } : {}),
    }));
  const turns = valid.slice(-MAX_HISTORY_TURNS);
  if (!turns.length || turns[turns.length - 1].role !== 'user') throw new Error('AI_EMPTY');
  const ctx = context.slice(0, CONTEXT_LIMIT);

  // Advice is where model quality shows. Tool rounds (and the pipeline's
  // request parsing and fit check) run on the user's (cheap) model; once facts
  // are in, the answer is written on the "smart" model — unless the user
  // already picked something at least as capable. Every turn the pipeline
  // answers is advice ("what games are there in genre X", a bare "more"
  // included), so its explanation always escalates; the tool loop does only
  // for advisory wording, since its turns are mostly questions about the
  // library.
  const lastUser = turns[turns.length - 1].content;
  const advisory = /посовет|рекоменд|похож|поиграть|стоит ли|купить|пройти|recommend|suggest|similar|worth|what (should|to) play|buy|like these|for tonight|вечер/i.test(lastUser);
  const smart = modelForRole('smart');
  const chosen = getAiModel() ?? DEFAULT_AI_MODEL;
  const smartModel = smart && modelRank(chosen) < modelRank(smart) ? smart : undefined;
  const escalateTo = advisory ? smartModel : undefined;

  const spend: Spend = { promptTokens: 0, completionTokens: 0, model: '', byModel: {} };
  if (looksLikeRecommendation(lastUser, turns, ctx) || answersClarifyingQuestion(turns, ctx)) {
    try {
      const reply = await recommendTurn(turns, valid, lang, ctx, smartModel, spend);
      if (reply) return reply;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A reply that was billed but unusable (AI_BAD_INTENT, AI_BAD_ANSWER) carries its tokens: the turn paid for them.
      const billed = e as { promptTokens?: unknown; completionTokens?: unknown; model?: unknown } | null;
      if (typeof billed?.promptTokens === 'number' && typeof billed.completionTokens === 'number') {
        addSpend(spend, billed.promptTokens, billed.completionTokens, typeof billed.model === 'string' ? billed.model : undefined);
      }
      // A model chain that already stayed silent (modelStep) would only stay silent again in the tool loop.
      if (FATAL_AI.test(msg) || (e instanceof Error && endsTurn.has(e))) throw e;
      // Anything else (a malformed intent, a store hiccup, an empty explanation) is the tool loop's turn.
      if (process.env.LAUNCHER_AI_DEBUG) console.log(`[ai] pipeline failed, falling back to the tool loop: ${msg.slice(0, 300)}`);
    }
  }
  return toolLoop(turns, lang, ctx, escalateTo, spend);
}

// ---------- "worth buying" verdict for the game page ----------

export interface GameVerdict {
  facts: GameFacts;
  verdict: 'buy' | 'wait_for_sale' | 'skip' | 'own_similar' | 'already_owned';
  score: number;
  summary: string;
  pros: string[];
  cons: string[];
  recentTrend: 'improving' | 'stable' | 'declining' | null;
  forWhom: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
  at: string;
}

const VERDICT_SYSTEM = `You judge whether a Steam game is worth buying for one specific user, from the FACTS given (store data + which similar games the user already owns and how much they played them). Do not invent facts. Address the user directly as "you"; never say "the user". Be concise and concrete: no filler, no hedging phrases, every claim traceable to a fact given. Weigh: overall review % vs recent 30-day % (declining recent = risk, improving = good sign), review volume, price and discount (a deep discount tilts toward "buy", full price toward "wait"), current players (matters for multiplayer only), age. Similar owned-but-unplayed games are a secondary factor: mention them as a note; choose "own_similar" only when they are close substitutes (same genre AND similar mood) and the game itself is not clearly superior. If the user already owns the game, verdict is "already_owned" and the summary says whether it is worth playing now. Output JSON only:
{"verdict": "buy"|"wait_for_sale"|"skip"|"own_similar"|"already_owned",
 "score": 1-10,
 "summary": "2-3 sentences in {{language}}, concrete, neutral",
 "pros": ["≤ 8 words each", ...],   // 2-4
 "cons": ["≤ 8 words each", ...],   // 1-4
 "recentTrend": "improving"|"stable"|"declining"|null,
 "forWhom": "one sentence in {{language}}: who will enjoy it"}`;

const verdictCache = new Map<string, GameVerdict>();
const VERDICT_TTL_MS = 60 * 60_000;

export async function gameVerdict(appid: number, lang: string, force = false): Promise<GameVerdict> {
  if (!getChutesApiKey()) throw new Error('AI_NO_KEY');
  const key = `${appid}|${lang}`;
  const hit = verdictCache.get(key);
  if (hit && !force && Date.now() - new Date(hit.at).getTime() < VERDICT_TTL_MS) return hit;
  const facts = await gameFacts(appid, lang, true);
  const res = await chatJson(
    [
      { role: 'system', content: VERDICT_SYSTEM.replace(/\{\{language\}\}/g, lang === 'ru' ? 'Russian' : 'English') },
      { role: 'user', content: `FACTS:\n${compact({ ...facts, snippets: facts.snippets.map((s) => ({ up: s.up, text: trim(s.text, 350) })) }, 7000)}` },
    ],
    700
  );
  const p = parseJson(res.text) ?? {};
  const verdicts = ['buy', 'wait_for_sale', 'skip', 'own_similar', 'already_owned'] as const;
  const v: GameVerdict = {
    facts,
    verdict: verdicts.includes(p.verdict) ? p.verdict : facts.owned ? 'already_owned' : 'wait_for_sale',
    score: typeof p.score === 'number' ? Math.min(10, Math.max(1, Math.round(p.score))) : 5,
    summary: typeof p.summary === 'string' ? trim(p.summary.trim(), 800) : '',
    pros: strList(p.pros, 4).map((s) => trim(s, 80)),
    cons: strList(p.cons, 4).map((s) => trim(s, 80)),
    recentTrend: p.recentTrend === 'improving' || p.recentTrend === 'stable' || p.recentTrend === 'declining' ? p.recentTrend : null,
    forWhom: typeof p.forWhom === 'string' ? trim(p.forWhom.trim(), 300) : '',
    model: res.model,
    usage: { promptTokens: res.promptTokens, completionTokens: res.completionTokens },
    at: new Date().toISOString(),
  };
  verdictCache.set(key, v);
  return v;
}

/** Rough token estimate shown on the game page button before the paid call. */
export const VERDICT_ESTIMATE_TOKENS = 3200;

