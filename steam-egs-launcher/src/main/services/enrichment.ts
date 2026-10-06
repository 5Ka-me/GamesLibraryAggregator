import { app } from 'electron';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { normalizeTitle } from '@app/shared';
import { getEntries } from './localData';
import { emit } from './events';
import { DEFAULT_AI_MODEL, chatJson, estimateUsd, parseJson } from './aiClient';
import { getAiModel } from '../config';
import { ensureFactCards, factCardText, getFactCard, getFactCards, libraryFactTargets, missingFactCount, type FactCard, type FactsProgress } from './gameFacts';
import { EMBED_MODEL, buildIndex, clearIndex, indexStatus, type IndexStatus } from './embeddings';

// Library enrichment: a one-off (then incremental) pass that writes a
// structured profile of every library game — length, genres, moods, themes,
// play modes, search keywords, a one-line pitch and a short summary. The
// result is a local file; from then on meaning-based search, library/reel
// filters and the genre statistics work offline and for free.
//
// A run has three phases:
//   1. facts    — public store facts per title (gameFacts.ts: Steam page, the
//                 Steam twin of an Epic-only game, or the Epic offer);
//   2. profiles — the model annotates titles in batches, each title followed
//                 by its fact card, so the profile is grounded in store data
//                 instead of the model's memory of a name;
//   3. index    — the semantic index (embeddings.ts) is refreshed from the
//                 new profiles + facts.
//
// Facts vs estimates: store facts are authoritative (play modes are derived
// from Steam categories, not from the model); length, feel and keywords are
// the model's estimate. `confidence` says how much of each the profile rests
// on, and unknown titles are kept with `known: false` so they are never
// mistaken for real metadata.

export const GENRES = [
  'action', 'adventure', 'rpg', 'strategy', 'shooter', 'roguelike', 'platformer', 'puzzle', 'simulation',
  'survival', 'horror', 'racing', 'sports', 'fighting', 'visual_novel', 'metroidvania', 'souls_like', 'sandbox',
  'city_builder', 'card_game', 'rhythm', 'stealth', 'point_and_click', 'tower_defense', 'mmo', 'idle', 'party',
  'arcade', 'tactics', 'hack_and_slash', 'battle_royale', 'walking_sim', 'management', 'open_world', 'narrative',
] as const;
export const MOODS = [
  'cozy', 'relaxing', 'tense', 'scary', 'story_rich', 'funny', 'dark', 'competitive', 'challenging', 'atmospheric',
  'casual', 'epic', 'emotional', 'chaotic', 'creative', 'mysterious', 'nostalgic',
] as const;
export const MODES = ['single', 'coop_local', 'coop_online', 'pvp', 'mmo'] as const;

export type Genre = (typeof GENRES)[number];
export type Mood = (typeof MOODS)[number];
export type Mode = (typeof MODES)[number];

/** How much a profile rests on: store facts and/or the model's own knowledge of the game. */
export type Confidence = 'high' | 'medium' | 'low';

export interface GameProfile {
  /** normalizeTitle(title) — the join key with the library. */
  key: string;
  title: string;
  /** Derived: confidence !== 'low'. Kept for existing consumers (chips, stats, UI); false = everything below is a guess. */
  known: boolean;
  /** high = store facts given and the model knows the game; medium = only one of the two; low = neither. Absent in v1 profiles (see profileConfidence). */
  confidence?: Confidence;
  /** Typical hours to finish the main story; null when unknown or endless. */
  lengthHours: number | null;
  /** No defined ending (multiplayer, sandbox, idle, live service). */
  endless: boolean;
  genres: Genre[];
  moods: Mood[];
  /** Short lowercase English nouns: setting / topic ("space", "zombies", "cats") — the matching key. */
  themes: string[];
  /** The same themes in the UI language of the run (what the game page shows). Absent in old files. */
  themesLocal?: string[];
  modes: Mode[];
  coopPlayers: number | null;
  /** 10–15 lowercase English free descriptors: mechanics, structure, feel, perspective, session length,
   *  difficulty ("turn-based", "deckbuilding", "short runs", "base building", "first-person", "permadeath"). */
  keywords?: string[];
  /** One sentence in the run's UI language: for whom and when it fits ("A relaxed farming sim for slow
   *  evenings; plays fine in 30-minute sessions"). */
  pitch?: string;
  /** 2–3 sentences in the UI language of the run. */
  summary: string;
  /** Which facts grounded the profile; absent = v1 (title only). */
  grounded?: FactCard['source'];
  /** Profile layout version: 2 for grounded profiles; absent = 1. */
  v?: number;
  lang: string;
  model: string;
  at: string;
}

/** Current profile layout; profiles with another `v` count as outdated (built from titles only). */
export const PROFILE_VERSION = 2;

/** Confidence of any profile, including v1 ones that only carry `known`. */
export function profileConfidence(p: GameProfile): Confidence {
  return p.confidence ?? (p.known ? 'medium' : 'low');
}

// The file envelope is unchanged since v1 (profiles carry their own `v`), so
// an older app build can still read a file this one wrote.
interface EnrichmentFile {
  version: 1;
  profiles: Record<string, GameProfile>;
  lastRunAt?: string;
}

export interface EnrichProgress {
  running: boolean;
  /** Profiles written in this run (index-only build: games embedded). */
  done: number;
  /** Titles to profile (index-only build: games to embed). */
  total: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  cancelled: boolean;
  /**
   * Last error; a semantic-index failure is prefixed "INDEX:", a store-facts failure "FACTS:". Titles the
   * facts step got nothing for are reported as "FACTS: MISSED <n>/<total>" (the UI words it).
   */
  error?: string;
  phase?: 'facts' | 'profiles' | 'index';
  factsDone?: number;
  factsTotal?: number;
  indexDone?: number;
  indexTotal?: number;
}

export interface EnrichStatus {
  profiles: number;
  games: number;
  missing: number;
  lastRunAt: string | null;
  running: boolean;
  progress: EnrichProgress | null;
  estimate: Estimate;
  /** Profiles written in another UI language (their summaries read foreign) and what redoing them would cost. */
  otherLang: number;
  estimateOtherLang: Estimate;
  /** Library profiles with an older layout (v !== PROFILE_VERSION: built from titles only), whatever their language. */
  outdated: number;
  /** Cost of redoing missing + other-language + outdated profiles (deduped). */
  estimateOutdated: Estimate;
  /** Titles a redo 'outdated' run would profile: missing + other-language + outdated, deduped (what estimateOutdated covers). */
  todoOutdated: number;
  index: IndexStatus;
}

export interface Estimate {
  tokens: number;
  usd: number | null;
  requests: number;
  minutes: number;
  model: string;
}

/** Which existing profiles a run redoes on top of the missing ones. */
type Redo = 'none' | 'otherLang' | 'outdated';

interface TodoTitle {
  key: string;
  title: string;
}

/** What ensureFactCards takes per title. */
interface FactTarget {
  key: string;
  title: string;
  appid: number | null;
  epicNamespace: string | null;
}

interface BatchItem extends TodoTitle {
  /** Null when the facts step could not reach the stores for this title (not the same as a 'none' card). */
  card: FactCard | null;
}

const BATCH = 10;
/** Requests in flight at once; chutes serves each model from a pool, three keeps a 700-game run near 30 min. */
const CONCURRENCY = 3;
const MAX_TOKENS_PER_BATCH = 5000;
/** A batch answer is ~3k output tokens; slow moments on the provider need headroom. */
const BATCH_TIMEOUT_MS = 240_000;
/** Observed wall-clock per batch on the default model, for the estimate shown before the run. */
const SECONDS_PER_BATCH = 70;
/** Per-title token cost with a fact card in the prompt (~900 chars of facts in, keywords + pitch out). */
const IN_PER_TITLE = 320;
const OUT_PER_TITLE = 300;
/** The system prompt, sent once per batch. */
const IN_PER_BATCH = 900;
/** Wall-clock per title still lacking a fact card (Epic-only titles need a Steam search each, two in flight). */
const SECONDS_PER_FACT = 0.5;
/** Characters of fact card per title in the prompt. */
const FACT_CHARS = 900;
/** Progress events from the per-title phases are throttled; phase changes and batch ends always go out. */
const EMIT_EVERY_MS = 250;

const STOP_ERRORS = /AI_NO_KEY|AI_AUTH|AI_BALANCE/;

async function estimateFor(todo: TodoTitle[]): Promise<Estimate> {
  const titles = todo.length;
  const batches = Math.ceil(titles / BATCH);
  const tokens = titles * (IN_PER_TITLE + OUT_PER_TITLE) + batches * IN_PER_BATCH;
  const model = getAiModel() ?? DEFAULT_AI_MODEL;
  const usd = titles > 0 ? await estimateUsd(titles * IN_PER_TITLE + batches * IN_PER_BATCH, titles * OUT_PER_TITLE, model) : 0;
  let factSeconds = 0;
  if (titles > 0) {
    try {
      factSeconds = missingFactCount(todo.map((t) => t.key)) * SECONDS_PER_FACT;
    } catch {
      /* no facts file yet or unreadable — the estimate just leaves the facts step out */
    }
  }
  const seconds = (batches * SECONDS_PER_BATCH) / CONCURRENCY + factSeconds;
  return { tokens, usd, requests: batches, minutes: Math.max(1, Math.round(seconds / 60)), model };
}

const file = (): string => join(app.getPath('userData'), 'enrichment.json');
let cache: EnrichmentFile | null = null;

function load(): EnrichmentFile {
  if (cache) return cache;
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<EnrichmentFile>;
      if (parsed && parsed.profiles && typeof parsed.profiles === 'object') {
        // v1 profiles load as they are: missing confidence/keywords/pitch/grounded/v mean "title only".
        cache = { version: 1, profiles: parsed.profiles, lastRunAt: parsed.lastRunAt };
        return cache;
      }
    }
  } catch {
    /* corrupt → start over; it is derived data */
  }
  cache = { version: 1, profiles: {} };
  return cache;
}

function save(): void {
  const f = file();
  writeFileSync(`${f}.tmp`, JSON.stringify(cache), 'utf8');
  renameSync(`${f}.tmp`, f);
}

export function getProfiles(): Record<string, GameProfile> {
  return { ...load().profiles };
}

/** Deletes every profile and the semantic index built from them (store fact cards are kept — they are not AI output). */
export function clearProfiles(): void {
  cache = { version: 1, profiles: {} };
  try {
    if (existsSync(file())) unlinkSync(file());
  } catch {
    /* ignore */
  }
  try {
    clearIndex();
  } catch {
    /* ignore — a missing index file is the goal anyway */
  }
  emit('enrich:progress', { ...idleProgress(), done: 0 });
}

/** Unique library titles by normalized key (first spelling wins). */
function libraryTitles(): Map<string, string> {
  const seen = new Map<string, string>();
  for (const e of getEntries()) {
    const key = normalizeTitle(e.title);
    if (key && !seen.has(key)) seen.set(key, e.title.trim());
  }
  return seen;
}

/**
 * Unique library titles to (re)profile, alphabetically: those without a profile,
 * plus — for 'otherLang' — those whose profile was written in another UI language
 * (summary, pitch and local themes are language-bound; the rest is not), plus —
 * for 'outdated' — those also whose profile has an older layout (title-only v1).
 */
function todoTitles(lang: string, redo: Redo, titles = libraryTitles()): TodoTitle[] {
  const profiles = load().profiles;
  const out: TodoTitle[] = [];
  for (const [key, title] of titles) {
    const p = profiles[key];
    if (!p || (redo !== 'none' && p.lang !== lang) || (redo === 'outdated' && p.v !== PROFILE_VERSION)) out.push({ key, title });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** Profiles of library games matching a predicate. */
function libraryProfileCount(pred: (p: GameProfile) => boolean, titles = libraryTitles()): number {
  const profiles = load().profiles;
  let n = 0;
  for (const key of titles.keys()) if (profiles[key] && pred(profiles[key])) n++;
  return n;
}

// ---------- status / estimate ----------

let progress: EnrichProgress | null = null;
/** Stops new batch pulls; set by cancelEnrichment and by the auth/balance stop rule. */
let cancelRequested = false;
/** The stop came from an auth/balance error, not from the user — reported as an error, not as "cancelled". */
let stoppedByError = false;
let aborter: AbortController | null = null;
/** startIndexBuild takes no language; the status it returns uses the one the UI asked with last. */
let lastLang = 'en';
let lastEmitAt = 0;

const idleProgress = (): EnrichProgress => ({ running: false, done: 0, total: 0, failed: 0, promptTokens: 0, completionTokens: 0, cancelled: false });

function emitProgress(force = true): void {
  const now = Date.now();
  if (!force && now - lastEmitAt < EMIT_EVERY_MS) return;
  lastEmitAt = now;
  emit('enrich:progress', progress);
}

/** indexStatus() must never break the Settings page; a failure reads as an empty index with the reason. */
function safeIndexStatus(games: number): IndexStatus {
  try {
    return indexStatus();
  } catch (e) {
    return { indexed: 0, games, stale: games, building: false, tags: 0, model: EMBED_MODEL, lastError: e instanceof Error ? e.message : String(e) };
  }
}

export async function enrichStatus(lang = 'en'): Promise<EnrichStatus> {
  lastLang = lang;
  const titles = libraryTitles();
  const missing = todoTitles(lang, 'none', titles);
  const otherLangTodo = todoTitles(lang, 'otherLang', titles);
  const outdatedTodo = todoTitles(lang, 'outdated', titles);
  const games = titles.size;
  // Sequential on purpose: the first estimate warms the price catalog the others read.
  const estimate = await estimateFor(missing);
  const estimateOtherLang = await estimateFor(otherLangTodo);
  const estimateOutdated = await estimateFor(outdatedTodo);
  return {
    profiles: Object.keys(load().profiles).length,
    games,
    missing: missing.length,
    lastRunAt: load().lastRunAt ?? null,
    running: !!progress?.running,
    progress,
    estimate,
    otherLang: libraryProfileCount((p) => p.lang !== lang, titles),
    estimateOtherLang,
    outdated: libraryProfileCount((p) => p.v !== PROFILE_VERSION, titles),
    estimateOutdated,
    todoOutdated: outdatedTodo.length,
    index: safeIndexStatus(games),
  };
}

// ---------- the run ----------

const SYSTEM = `You annotate video games for a personal game-library app. You receive a numbered list of games. Most titles are followed by indented STORE FACTS from the game's public store page: year, developer, review score, store tags (Steam user tags in vote order, or "EGS tags" = Epic genres and features), "Features" (Steam categories such as Single-player, Online Co-op, Full controller support) and a description. For EVERY listed title return one object, in the same order, inside {"games": [...]}.

HOW TO USE THE FACTS
- Store facts are authoritative. Never contradict them: no co-op when the Features list no co-op, no "turn-based" when the description says real-time, no other developer, year or setting. "On EGS since" (Epic offers) is when the game was listed on the Epic store, not necessarily its release year.
- If the facts describe a different game than the one you remember under this name (a remake, a reboot, a namesake), describe the game in the facts.
- Use your own knowledge to fill what the facts leave open: how long it takes, how it feels, what you actually do minute to minute, its structure, pacing and difficulty.
- A title without facts: describe it only if you clearly recognise this exact game. Never guess a game from the words of its title.

FIELDS (every field in every object)
- "title": copied EXACTLY as listed, without the number — no translation, no corrections, no added year.
- "confidence": "high" = store facts are given AND you know this game yourself; "medium" = only one of the two (facts given but you do not know the game, or no facts but you know it well); "low" = no facts and you do not recognise the game. For "low" keep everything minimal and honest: empty lists, nulls, "endless": false, "pitch": "", and a one-sentence summary saying little is known about the game. Never invent mechanics, a plot or modes.
- "lengthHours": typical hours to finish the main story/campaign for an average player; null when unknown or when the game has no ending.
- "endless": true when there is no defined ending (multiplayer-only, sandbox, idle/clicker, live service, sports/racing seasons).
- "genres": 2-6 values from GENRES, most defining first.
- "moods": 1-5 values from MOODS describing how it feels to play.
- "themes": up to 6 short lowercase English nouns for setting and subject matter ("space", "zombies", "medieval", "cats", "cyberpunk", "ww2").
- "themesLocal": the same themes in the same order, translated into {{language}} (lowercase; identical to "themes" when the language is English).
- "modes": values from MODES. When Features are listed, they decide the modes:
    Single-player -> "single"
    Online Co-op -> "coop_online"
    LAN Co-op, Shared/Split Screen Co-op -> "coop_local"
    PvP, Online PvP, LAN PvP, Shared/Split Screen PvP -> "pvp"
    MMO -> "mmo"
  Never add a mode the Features do not support. Epic games list their features among the EGS tags ("Single Player", "Co-op", "Multiplayer", "Competitive"); read them the same way. Without any feature list, include only modes the game genuinely offers.
- "coopPlayers": maximum players in co-op (integer), or null when there is no co-op.
- "keywords": 10-15 lowercase English descriptors a player would search by: core mechanics, structure, feel, camera/perspective, typical session length, difficulty. One to three words each.
    Good: "turn-based", "deckbuilding", "short runs", "permadeath", "base building", "first-person", "crafting", "branching dialogue", "real-time with pause", "procedural levels", "physics puzzles", "hand-drawn art", "30-minute sessions", "steep learning curve", "no fail state", "couch co-op".
    Bad: genre words already in "genres" ("rpg", "roguelike", "strategy"); words from the title ("stardew", "valley"); marketing or opinion ("fun", "addictive", "masterpiece", "award-winning", "best game"); store features ("achievements", "cloud saves", "controller support"); the themes repeated; whole sentences.
- "pitch": ONE sentence in {{language}} saying for whom and when the game fits, including the kind of session it suits. Examples of the idea (write yours in {{language}}): "A relaxed farming sim for slow evenings; plays fine in 30-minute sessions." / "A tense co-op shooter for a group of friends on a weekend night; a mission takes about an hour." No title, no marketing, at most 200 characters. "" for confidence "low".
- "summary": 2-3 sentences in {{language}}: what kind of game it is, what you actually do, and what makes it distinct. Concrete and neutral — no marketing tone, no "unforgettable experience", no review scores. For confidence "low", one honest sentence.

Write "pitch", "summary" and "themesLocal" in {{language}}; every other text value in English.

OUTPUT: JSON only, exactly this shape:
{"games":[{"title":"...","confidence":"high|medium|low","lengthHours":12,"endless":false,"genres":["..."],"moods":["..."],"themes":["..."],"themesLocal":["..."],"modes":["..."],"coopPlayers":null,"keywords":["..."],"pitch":"...","summary":"..."}]}

GENRES: {{genres}}
MOODS: {{moods}}
MODES: {{modes}}

Use ONLY the listed vocabulary values for genres, moods and modes, spelled exactly as listed (e.g. "souls_like", "coop_online").`;

function systemPrompt(lang: string): string {
  const language = lang === 'ru' ? 'Russian' : 'English';
  return SYSTEM.replaceAll('{{language}}', language)
    .replaceAll('{{genres}}', GENRES.join(', '))
    .replaceAll('{{moods}}', MOODS.join(', '))
    .replaceAll('{{modes}}', MODES.join(', '));
}

/** "1. Title" followed by the title's fact card, indented; a title without facts is sent alone. */
function userPrompt(items: BatchItem[]): string {
  const lines = items.map((t, i) => {
    const facts = factCardText(t.card, FACT_CHARS).trim();
    const head = `${i + 1}. ${t.title}`;
    return facts
      ? `${head}\n${facts
          .split('\n')
          .map((l: string) => `   ${l.trim()}`)
          .filter((l: string) => l.trim())
          .join('\n')}`
      : head;
  });
  return `Games:\n${lines.join('\n')}`;
}

/**
 * Starts (or resumes) a detached enrichment run and returns the status at once;
 * progress streams as `enrich:progress` events. `redo` adds existing profiles to
 * the missing ones: 'otherLang' those in another UI language, 'outdated' those
 * too plus every profile with an older layout. A second call while a run is
 * going returns the status of the running one.
 */
export async function startEnrichment(lang: string, redo: 'none' | 'otherLang' | 'outdated' = 'none'): Promise<EnrichStatus> {
  lastLang = lang;
  if (progress?.running) return enrichStatus(lang);
  // Older callers passed a boolean "redo other-language profiles".
  const raw = redo as unknown;
  const mode: Redo = raw === true ? 'otherLang' : raw === 'otherLang' || raw === 'outdated' ? raw : 'none';
  const todo = todoTitles(lang, mode);
  cancelRequested = false;
  stoppedByError = false;
  const ac = new AbortController();
  aborter = ac;
  const run: EnrichProgress = { ...idleProgress(), running: todo.length > 0, total: todo.length };
  if (todo.length) Object.assign(run, { phase: 'facts', factsDone: 0, factsTotal: todo.length });
  progress = run;
  emitProgress();
  if (todo.length === 0) {
    aborter = null;
    return enrichStatus(lang);
  }

  // Detached: the IPC call returns at once, progress streams as events.
  void (async () => {
    try {
      const cards = await factsPhase(run, todo, ac.signal);
      if (!cancelRequested) await profilesPhase(run, todo, cards, lang, ac.signal);
      if (!cancelRequested) await indexPhase(run, ac.signal, false);
    } catch (e) {
      // The phases handle their own errors; this is a safety net so a bug never leaves "running" stuck.
      if (!cancelRequested) run.error = e instanceof Error ? e.message : String(e);
    } finally {
      finishRun(run);
    }
  })();

  return enrichStatus(lang);
}

/**
 * Runs only the semantic-index phase (detached, same progress events with
 * phase 'index'), for libraries whose profiles exist but whose index is missing
 * or stale. Ignored while a run is going. `lang` only shapes the returned status
 * (defaults to the language of the last status request).
 */
export async function startIndexBuild(lang?: string): Promise<EnrichStatus> {
  const l = lang ?? lastLang;
  if (progress?.running) return enrichStatus(l);
  const st = safeIndexStatus(libraryTitles().size);
  // Nothing to embed and the tag index exists: a run would only flash the progress line.
  if (st.building || (st.stale === 0 && st.tags > 0)) return enrichStatus(l);
  cancelRequested = false;
  stoppedByError = false;
  const ac = new AbortController();
  aborter = ac;
  const run: EnrichProgress = { ...idleProgress(), running: true, total: st.stale, phase: 'index', indexDone: 0, indexTotal: st.stale };
  progress = run;
  emitProgress();
  void (async () => {
    try {
      await indexPhase(run, ac.signal, true);
    } finally {
      finishRun(run);
    }
  })();
  return enrichStatus(l);
}

function finishRun(run: EnrichProgress): void {
  progress = { ...run, running: false, cancelled: cancelRequested && !stoppedByError };
  aborter = null;
  emitProgress();
}

/**
 * Settles with `p`, or rejects with AI_CANCELLED as soon as `signal` aborts. The
 * facts step checks its signal only between store requests, so one request that
 * never answers would otherwise keep the run "running" past Cancel. `p` itself
 * keeps going in the background; its outcome is ignored.
 */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('AI_CANCELLED'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('AI_CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

/**
 * Phase 1: fact cards for the todo titles only. Never fails the run: a title the
 * stores could not be asked about simply has no card, and a broken facts step as
 * a whole (FACTS_UNAVAILABLE: Steam's tag/category catalogs unreachable) falls back
 * to whatever cards are already on disk. Titles left without a card are reported
 * ("FACTS: MISSED n/total"): they are profiled from the title alone and stay
 * outdated (toProfile leaves their version off), which the user would otherwise
 * only notice as a count that barely moved.
 */
async function factsPhase(run: EnrichProgress, todo: TodoTitle[], signal: AbortSignal): Promise<Record<string, FactCard>> {
  run.phase = 'facts';
  const want = new Map(todo.map((t) => [t.key, t.title]));
  let targets: FactTarget[] = [];
  try {
    targets = libraryFactTargets().filter((t: FactTarget) => want.has(t.key));
  } catch {
    /* fall through: every title is looked up by name below */
  }
  // A todo title the targets list does not know (it should not happen) is still looked up by its name.
  const covered = new Set(targets.map((t) => t.key));
  for (const [key, title] of want) if (!covered.has(key)) targets.push({ key, title, appid: null, epicNamespace: null });
  run.factsDone = 0;
  run.factsTotal = targets.length;
  emitProgress();
  try {
    const cards = await unlessAborted(
      ensureFactCards(targets, {
        signal,
        onProgress: (p: FactsProgress) => {
          // A step abandoned on Cancel may still be finishing in the background; its ticks belong to no run.
          if (signal.aborted) return;
          run.factsDone = p.done;
          run.factsTotal = p.total;
          emitProgress(false);
        },
      }),
      signal
    );
    run.factsDone = run.factsTotal;
    reportMissingFacts(run, todo, cards, signal);
    return cards;
  } catch (e) {
    if (cancelRequested || signal.aborted) return {};
    if (process.env.LAUNCHER_AI_DEBUG) console.log(`[enrich] facts step failed: ${e instanceof Error ? e.message : String(e)}`);
    let cards: Record<string, FactCard> = {};
    try {
      cards = getFactCards();
    } catch {
      /* no cards on disk either */
    }
    reportMissingFacts(run, todo, cards, signal);
    return cards;
  }
}

/**
 * ensureFactCards returns normally even when it got nothing for some titles (a store search stopped
 * after repeated throttling, a failed GetItems chunk) and throws when the catalogs are unreachable;
 * stale cards come back too, so only titles with no card at all count as missed.
 */
function reportMissingFacts(run: EnrichProgress, todo: TodoTitle[], cards: Record<string, FactCard>, signal: AbortSignal): void {
  const miss = todo.filter((t) => !cards[t.key]).length;
  if (miss && !cancelRequested && !signal.aborted && !run.error) run.error = `FACTS: MISSED ${miss}/${todo.length}`;
}

/** Phase 2: profiles in batches; a few workers pull from a shared queue. */
async function profilesPhase(run: EnrichProgress, todo: TodoTitle[], cards: Record<string, FactCard>, lang: string, signal: AbortSignal): Promise<void> {
  run.phase = 'profiles';
  emitProgress();
  const system = systemPrompt(lang);
  const cardFor = (key: string): FactCard | null => {
    if (cards[key]) return cards[key];
    try {
      return getFactCard(key);
    } catch {
      return null;
    }
  };
  const items: BatchItem[] = todo.map((t) => ({ ...t, card: cardFor(t.key) }));
  const batches: BatchItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  // Titles of a batch whose answer was cut off or unreadable get one more try in half-size batches,
  // so one bad reply does not leave ten games outdated until the next run.
  const retried = new Set<BatchItem>();

  const runBatch = async (batch: BatchItem[]): Promise<void> => {
    try {
      const res = await chatJson([{ role: 'system', content: system }, { role: 'user', content: userPrompt(batch) }], MAX_TOKENS_PER_BATCH, {
        timeoutMs: BATCH_TIMEOUT_MS,
        signal,
      });
      run.promptTokens += res.promptTokens;
      run.completionTokens += res.completionTokens;
      const parsed = parseJson(res.text);
      const games: unknown[] = Array.isArray(parsed?.games) ? parsed.games : [];
      let stored = 0;
      const missed = new Set(batch);
      for (const [item, raw] of pairResults(games, batch)) {
        const p = toProfile(raw, item, lang, res.model);
        if (p) {
          load().profiles[p.key] = p;
          missed.delete(item);
          stored++;
        }
      }
      const again = [...missed].filter((t) => !retried.has(t));
      if (process.env.LAUNCHER_AI_DEBUG && missed.size) {
        console.log(
          `[enrich] stored ${stored}/${batch.length} from ${res.model} (${res.completionTokens} tokens out, ${res.text.length} chars, ` +
            `parsed: ${parsed ? 'yes' : 'no'}, entries: ${games.length}); missed: ${[...missed].map((t) => t.title).join(' | ')}; ` +
            `reply tail: ${res.text.slice(-160).replace(/\s+/g, ' ')}`
        );
      }
      if (again.length && !cancelRequested) {
        for (const t of again) retried.add(t);
        const half = Math.max(1, Math.ceil(again.length / 2));
        for (let i = 0; i < again.length; i += half) batches.push(again.slice(i, i + half));
      }
      run.done += stored;
      // Titles queued for another try are neither done nor failed yet.
      run.failed += batch.length - stored - again.length;
      load().lastRunAt = new Date().toISOString();
      save(); // partial progress survives a crash or a cancel
    } catch (e) {
      if (cancelRequested) return; // an aborted batch is neither done nor failed — it stays "missing"
      run.failed += batch.length;
      run.error = e instanceof Error ? e.message : String(e);
      // Auth/balance problems won't fix themselves mid-run — stop instead of burning attempts.
      if (STOP_ERRORS.test(run.error)) {
        stoppedByError = true;
        cancelRequested = true;
        aborter?.abort();
      }
    }
    emitProgress();
  };

  // Cancel stops new pulls and aborts in-flight calls.
  const worker = async (): Promise<void> => {
    while (!cancelRequested) {
      const batch = batches.shift();
      if (!batch) return;
      await runBatch(batch);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
}

/**
 * Phase 3: refresh the semantic index. Its failure is reported ("INDEX: …",
 * unless an earlier error of the run is already shown) but never marks profiles
 * as failed — the index can be rebuilt on its own later.
 */
async function indexPhase(run: EnrichProgress, signal: AbortSignal, indexOnly: boolean): Promise<void> {
  run.phase = 'index';
  const stale = safeIndexStatus(libraryTitles().size).stale;
  run.indexDone = 0;
  run.indexTotal = stale;
  if (indexOnly) {
    run.done = 0;
    run.total = stale;
  }
  emitProgress();
  try {
    await buildIndex({
      signal,
      onProgress: (done: number, total: number) => {
        run.indexDone = done;
        run.indexTotal = total;
        if (indexOnly) {
          run.done = done;
          run.total = total;
        }
        emitProgress(false);
      },
    });
  } catch (e) {
    if (cancelRequested || signal.aborted) return;
    if (!run.error) run.error = `INDEX: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function cancelEnrichment(): void {
  cancelRequested = true;
  aborter?.abort();
}

// ---------- parsing the model's answer ----------

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Pairs answer objects with the titles asked about. Exact normalized title first;
 * then, since the prompt asks for the same order, an object whose title came back
 * slightly altered ("Title™", "Title (2015)", missing) lands on the title at its
 * position — only when the answer has one object per title, the position is not
 * claimed yet and the two names overlap.
 */
function pairResults(games: unknown[], batch: BatchItem[]): Map<BatchItem, any> {
  const byKey = new Map(batch.map((t) => [t.key, t]));
  const out = new Map<BatchItem, any>();
  const leftover: number[] = [];
  games.forEach((raw: any, i) => {
    const item = raw && typeof raw === 'object' && typeof raw.title === 'string' ? byKey.get(normalizeTitle(raw.title)) : undefined;
    if (item && !out.has(item)) out.set(item, raw);
    else leftover.push(i);
  });
  if (games.length === batch.length) {
    for (const i of leftover) {
      const raw: any = games[i];
      const item = batch[i];
      if (!raw || typeof raw !== 'object' || out.has(item)) continue;
      const k = typeof raw.title === 'string' ? normalizeTitle(raw.title) : '';
      // An exact name of another listed title is a duplicate answer for that one, not an altered spelling of this one.
      if (k && byKey.has(k)) continue;
      if (!k || k.includes(item.key) || item.key.includes(k)) out.set(item, raw);
    }
  }
  return out;
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string').map((x: string) => x.trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 6) : [];

/** Comparable form of a word or label: letters and digits only ("turn based" = "turn-based", "souls_like" = "souls-like"). */
const flat = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Keywords: lowercase, ≤ 30 chars (longer ones are sentences, not descriptors), deduped, no genre or title repeats, ≤ 15. */
function keywordList(v: unknown, genres: readonly string[], titleKey: string): string[] {
  if (!Array.isArray(v)) return [];
  const genreKeys = new Set(genres.map(flat));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const k = x
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/^[\s"'*•.,;:!-]+|[\s"'*.,;:!]+$/g, '');
    if (!k || k.length > 30) continue;
    const f = flat(k);
    if (!f || f === titleKey || seen.has(f) || genreKeys.has(f)) continue;
    seen.add(f);
    out.push(k);
    if (out.length >= 15) break;
  }
  return out;
}

/** One sentence, ≤ 240 chars, cut at a word boundary when the model ran long. */
function pitchText(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length <= 240) return s;
  const cut = s.slice(0, 239);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 160 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * Confidence as defined by the prompt, held to its own definition: with store
 * facts the profile is grounded, so never "low"; without them the model's memory
 * alone is at most "medium". Missing/invalid → facts ? 'medium' : 'low'.
 */
function confidenceFrom(v: unknown, hasFacts: boolean): Confidence {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  const c: Confidence = s === 'high' || s === 'medium' || s === 'low' ? s : hasFacts ? 'medium' : 'low';
  if (hasFacts && c === 'low') return 'medium';
  if (!hasFacts && c === 'high') return 'medium';
  return c;
}

/** Steam categories (English display names, lowercased) that name a play mode outright. */
const CATEGORY_MODES: Record<string, Mode> = {
  'single-player': 'single',
  'online co-op': 'coop_online',
  'lan co-op': 'coop_local',
  'shared/split screen co-op': 'coop_local',
  pvp: 'pvp',
  'online pvp': 'pvp',
  'lan pvp': 'pvp',
  'shared/split screen pvp': 'pvp',
  mmo: 'mmo',
};

/**
 * Generic categories that say "there is multiplayer" without saying which kind.
 * Many (older) store pages carry only these; then the model's reading of the kind
 * is let through, limited to what the generic category covers.
 */
const CATEGORY_HINTS: Record<string, Mode[]> = {
  'co-op': ['coop_online', 'coop_local'],
  'multi-player': ['coop_online', 'coop_local', 'pvp'],
  'cross-platform multiplayer': ['coop_online', 'pvp'],
  'shared/split screen': ['coop_local', 'pvp'],
};

/**
 * Play modes when the fact card lists Steam categories — the categories are
 * authoritative. Specific categories map deterministically; when they name no
 * multiplayer mode, generic multiplayer categories admit the model's own
 * multiplayer modes of the matching kind. When the categories say nothing about
 * play modes at all (only controller/feature ones), the model's modes stand.
 */
function modesFromCategories(categories: string[], modelModes: Mode[]): Mode[] {
  const derived = new Set<Mode>();
  const hinted = new Set<Mode>();
  for (const c of categories) {
    const name = c.trim().toLowerCase();
    const m = CATEGORY_MODES[name];
    if (m) derived.add(m);
    for (const h of CATEGORY_HINTS[name] ?? []) hinted.add(h);
  }
  if (!derived.size && !hinted.size) return modelModes;
  const specificMultiplayer = [...derived].some((m) => m !== 'single');
  if (!specificMultiplayer) for (const m of modelModes) if (hinted.has(m)) derived.add(m);
  return MODES.filter((m) => derived.has(m));
}

function toProfile(raw: any, item: BatchItem, lang: string, model: string): GameProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const card = item.card;
  const hasFacts = !!card && card.source !== 'none';
  const pick = <T extends string>(v: unknown, vocab: readonly T[], max: number): T[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is T => typeof x === 'string' && (vocab as readonly string[]).includes(x)) as T[])].slice(0, max) : [];
  const len = typeof raw.lengthHours === 'number' && Number.isFinite(raw.lengthHours) && raw.lengthHours > 0 ? Math.round(raw.lengthHours * 2) / 2 : null;
  const genres = pick(raw.genres, GENRES, 6);
  const modelModes = pick(raw.modes, MODES, 5);
  const modes = card && Array.isArray(card.categories) && card.categories.length ? modesFromCategories(card.categories, modelModes) : modelModes;
  // A co-op player count without a co-op mode would light the "co-op" chip for a game the store says has none.
  const hasCoop = modes.includes('coop_local') || modes.includes('coop_online');
  const coop = hasCoop && typeof raw.coopPlayers === 'number' && Number.isFinite(raw.coopPlayers) && raw.coopPlayers > 1 ? Math.min(999, Math.round(raw.coopPlayers)) : null;
  const confidence = confidenceFrom(raw.confidence, hasFacts);
  return {
    key: item.key,
    title: item.title,
    known: confidence !== 'low',
    confidence,
    lengthHours: len,
    endless: raw.endless === true,
    genres,
    moods: pick(raw.moods, MOODS, 5),
    themes: strList(raw.themes),
    themesLocal: strList(raw.themesLocal),
    modes,
    coopPlayers: coop,
    keywords: keywordList(raw.keywords, genres, item.key),
    pitch: pitchText(raw.pitch),
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 700) : '',
    grounded: card?.source ?? 'none',
    // No card at all means the stores could not be asked (a transient error), so the profile rests on the
    // title alone: leave the version off and it counts as outdated, to be rebuilt from facts later. A
    // 'none' card is a definitive "the stores know nothing" and gets the current version.
    ...(card ? { v: PROFILE_VERSION } : {}),
    lang,
    model,
    at: new Date().toISOString(),
  };
}

// ---------- matching (shared by search) ----------

/** Structured "what kind of game" criteria the planner extracts from a phrase. */
export interface TagQuery {
  genres?: Genre[];
  moods?: Mood[];
  modes?: Mode[];
  themes?: string[];
  minLengthHours?: number;
  maxLengthHours?: number;
}

export function tagQueryIsEmpty(q: TagQuery | null | undefined): boolean {
  if (!q) return true;
  return !q.genres?.length && !q.moods?.length && !q.modes?.length && !q.themes?.length && q.minLengthHours === undefined && q.maxLengthHours === undefined;
}

/** AND across the groups that are present, OR inside each group. Themes match themes, keywords, summary and title. */
export function matchProfile(p: GameProfile, q: TagQuery): boolean {
  if (q.genres?.length && !q.genres.some((g) => p.genres.includes(g))) return false;
  if (q.moods?.length && !q.moods.some((m) => p.moods.includes(m))) return false;
  if (q.modes?.length && !q.modes.some((m) => p.modes.includes(m))) return false;
  if (q.maxLengthHours !== undefined && (p.endless || p.lengthHours === null || p.lengthHours > q.maxLengthHours)) return false;
  if (q.minLengthHours !== undefined && !p.endless && (p.lengthHours === null || p.lengthHours < q.minLengthHours)) return false;
  if (q.themes?.length) {
    const hay = `${p.themes.join(' ')} ${(p.themesLocal ?? []).join(' ')} ${(p.keywords ?? []).join(' ')} ${p.summary} ${p.title}`.toLowerCase();
    if (!q.themes.some((t) => hay.includes(t.toLowerCase()))) return false;
  }
  return true;
}
