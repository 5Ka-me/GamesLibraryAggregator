import { app } from 'electron';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { normalizeTitle } from '@app/shared';
import { getEntries } from './localData';
import { emit } from './events';
import { chatJson, estimateUsd, parseJson } from './aiClient';
import { getAiModel } from '../config';
import { DEFAULT_AI_MODEL } from './aiClient';

// Library enrichment: a one-off (then incremental) pass that asks the model
// for a structured profile of every game the stores only know by name —
// length, genres, moods, themes, play modes, a short summary. The result is
// a local file; from then on meaning-based search, library/reel filters and
// the genre statistics work offline and for free.
//
// Facts vs estimates: everything here is the model's knowledge, not store
// data. The UI labels it as such, and unknown titles are kept with
// `known: false` so they are never mistaken for real metadata.

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

export interface GameProfile {
  /** normalizeTitle(title) — the join key with the library. */
  key: string;
  title: string;
  /** The model recognised the game; false = everything below is a guess. */
  known: boolean;
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
  /** 2–3 sentences in the UI language of the run. */
  summary: string;
  lang: string;
  model: string;
  at: string;
}

interface EnrichmentFile {
  version: 1;
  profiles: Record<string, GameProfile>;
  lastRunAt?: string;
}

export interface EnrichProgress {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  cancelled: boolean;
  error?: string;
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
}

export interface Estimate {
  tokens: number;
  usd: number | null;
  requests: number;
  minutes: number;
  model: string;
}

async function estimateFor(titles: number): Promise<Estimate> {
  const batches = Math.ceil(titles / BATCH);
  const tokens = titles * (IN_PER_TITLE + OUT_PER_TITLE) + batches * IN_PER_BATCH;
  const model = getAiModel() ?? DEFAULT_AI_MODEL;
  const usd = titles > 0 ? await estimateUsd(titles * IN_PER_TITLE + batches * IN_PER_BATCH, titles * OUT_PER_TITLE, model) : 0;
  return { tokens, usd, requests: batches, minutes: Math.max(1, Math.round((batches * SECONDS_PER_BATCH) / CONCURRENCY / 60)), model };
}

const BATCH = 15;
/** Requests in flight at once; chutes serves each model from a pool, three keeps a 700-game run near 15 min. */
const CONCURRENCY = 3;
const MAX_TOKENS_PER_BATCH = 4500;
/** A batch answer is ~3k output tokens; slow moments on the provider need headroom. */
const BATCH_TIMEOUT_MS = 240_000;
/** Observed wall-clock per batch on the default model, for the estimate shown before the run. */
const SECONDS_PER_BATCH = 60;
/** Per-title token cost, a little above what a real run showed (43 in / 136 out per title incl. the prompt). */
const IN_PER_TITLE = 20;
const OUT_PER_TITLE = 160;
const IN_PER_BATCH = 500;

const file = (): string => join(app.getPath('userData'), 'enrichment.json');
let cache: EnrichmentFile | null = null;

function load(): EnrichmentFile {
  if (cache) return cache;
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<EnrichmentFile>;
      if (parsed && parsed.profiles && typeof parsed.profiles === 'object') {
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

export function clearProfiles(): void {
  cache = { version: 1, profiles: {} };
  try {
    if (existsSync(file())) unlinkSync(file());
  } catch {
    /* ignore */
  }
  emit('enrich:progress', { ...idleProgress(), done: 0 });
}

/**
 * Unique library titles to (re)profile, alphabetically: those without a profile,
 * plus — when asked — those whose profile was written in another UI language
 * (summary and local themes are language-bound; the rest is not).
 */
function todoTitles(lang: string, redoOtherLang: boolean): { key: string; title: string }[] {
  const profiles = load().profiles;
  const seen = new Map<string, string>();
  for (const e of getEntries()) {
    const key = normalizeTitle(e.title);
    if (!key || seen.has(key)) continue;
    const p = profiles[key];
    if (!p || (redoOtherLang && p.lang !== lang)) seen.set(key, e.title.trim());
  }
  return [...seen.entries()].map(([key, title]) => ({ key, title })).sort((a, b) => a.title.localeCompare(b.title));
}

/** Profiles of library games written in a language other than the current UI language. */
function otherLangCount(lang: string): number {
  const profiles = load().profiles;
  const keys = new Set(getEntries().map((e) => normalizeTitle(e.title)).filter(Boolean));
  return [...keys].filter((k) => profiles[k] && profiles[k].lang !== lang).length;
}

function libraryKeyCount(): number {
  return new Set(getEntries().map((e) => normalizeTitle(e.title)).filter(Boolean)).size;
}

// ---------- status / estimate ----------

let progress: EnrichProgress | null = null;
let cancelRequested = false;
let aborter: AbortController | null = null;

const idleProgress = (): EnrichProgress => ({ running: false, done: 0, total: 0, failed: 0, promptTokens: 0, completionTokens: 0, cancelled: false });

export async function enrichStatus(lang = 'en'): Promise<EnrichStatus> {
  const missing = todoTitles(lang, false).length;
  const otherLang = otherLangCount(lang);
  return {
    profiles: Object.keys(load().profiles).length,
    games: libraryKeyCount(),
    missing,
    lastRunAt: load().lastRunAt ?? null,
    running: !!progress?.running,
    progress,
    estimate: await estimateFor(missing),
    otherLang,
    estimateOtherLang: await estimateFor(missing + otherLang),
  };
}

// ---------- the run ----------

const SYSTEM = `You annotate video games for a personal game-library app. You receive a numbered list of game titles. For EVERY title return one object, in the same order, inside {"games": [...]}. Fields:

- "title": the title copied EXACTLY as listed.
- "known": true if you recognise this game well enough to describe it; false otherwise (then keep the other fields minimal and honest).
- "lengthHours": number — typical hours to finish the main story/campaign for an average player; null if unknown or if the game has no ending.
- "endless": true when there is no defined ending (multiplayer-only, sandbox, idle/clicker, live service, sports/racing seasons).
- "genres": 2-6 values from GENRES, most defining first.
- "moods": 1-5 values from MOODS describing how it feels to play.
- "themes": up to 6 short lowercase English nouns for setting and subject matter (e.g. "space", "zombies", "medieval", "cats", "cyberpunk", "ww2").
- "themesLocal": the same themes, in the same order, translated into {{language}} (lowercase; identical to "themes" when the language is English).
- "modes": subset of MODES that the game genuinely offers.
- "coopPlayers": max players in co-op (integer) or null when there is no co-op.
- "summary": 2-3 sentences in {{language}}: what kind of game it is, what you actually do, and what makes it distinct. Concrete and neutral — no marketing tone, no "unforgettable experience". For an unknown game, one honest sentence.

GENRES: {{genres}}
MOODS: {{moods}}
MODES: {{modes}}

Use ONLY the listed vocabulary values for genres, moods and modes. Output JSON only.`;

export async function startEnrichment(lang: string, redoOtherLang = false): Promise<EnrichStatus> {
  if (progress?.running) return enrichStatus(lang);
  const todo = todoTitles(lang, redoOtherLang);
  cancelRequested = false;
  aborter = new AbortController();
  progress = { ...idleProgress(), running: todo.length > 0, total: todo.length };
  emit('enrich:progress', progress);
  if (todo.length === 0) return enrichStatus(lang);

  // Detached: the IPC call returns at once, progress streams as events.
  void (async () => {
    const language = lang === 'ru' ? 'Russian' : 'English';
    const system = SYSTEM.replace('{{language}}', language)
      .replace('{{genres}}', GENRES.join(', '))
      .replace('{{moods}}', MOODS.join(', '))
      .replace('{{modes}}', MODES.join(', '));
    const batches: { key: string; title: string }[][] = [];
    for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
    const signal = aborter!.signal;

    const runBatch = async (batch: { key: string; title: string }[]): Promise<void> => {
      try {
        const numbered = batch.map((t, k) => `${k + 1}. ${t.title}`).join('\n');
        const res = await chatJson([{ role: 'system', content: system }, { role: 'user', content: `Titles:\n${numbered}` }], MAX_TOKENS_PER_BATCH, {
          timeoutMs: BATCH_TIMEOUT_MS,
          signal,
        });
        progress!.promptTokens += res.promptTokens;
        progress!.completionTokens += res.completionTokens;
        const parsed = parseJson(res.text);
        const games: unknown[] = Array.isArray(parsed?.games) ? parsed.games : [];
        const byKey = new Map(batch.map((t) => [t.key, t]));
        let stored = 0;
        for (const raw of games) {
          const p = toProfile(raw, byKey, lang, res.model);
          if (p) {
            load().profiles[p.key] = p;
            stored++;
          }
        }
        progress!.done += stored;
        progress!.failed += batch.length - stored;
        load().lastRunAt = new Date().toISOString();
        save(); // partial progress survives a crash or a cancel
      } catch (e) {
        if (cancelRequested) return; // an aborted batch is neither done nor failed — it stays "missing"
        progress!.failed += batch.length;
        progress!.error = e instanceof Error ? e.message : String(e);
        // Auth/balance problems won't fix themselves mid-run — stop instead of burning attempts.
        if (/AI_NO_KEY|AI_AUTH|AI_BALANCE/.test(progress!.error)) {
          cancelRequested = true;
          aborter?.abort();
        }
      }
      emit('enrich:progress', progress);
    };

    // A few workers pull from the shared queue; cancel stops new pulls and aborts in-flight calls.
    const worker = async (): Promise<void> => {
      while (!cancelRequested) {
        const batch = batches.shift();
        if (!batch) return;
        await runBatch(batch);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

    const stoppedByError = /AI_NO_KEY|AI_AUTH|AI_BALANCE/.test(progress!.error ?? '');
    progress = { ...progress!, running: false, cancelled: cancelRequested && !stoppedByError };
    aborter = null;
    emit('enrich:progress', progress);
  })();

  return enrichStatus(lang);
}

export function cancelEnrichment(): void {
  cancelRequested = true;
  aborter?.abort();
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string').map((x: string) => x.trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 6) : [];

/* eslint-disable @typescript-eslint/no-explicit-any */
function toProfile(raw: any, byKey: Map<string, { key: string; title: string }>, lang: string, model: string): GameProfile | null {
  if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string') return null;
  const key = normalizeTitle(raw.title);
  const src = byKey.get(key);
  if (!src) return null; // a title we didn't ask about — dropped
  const pick = <T extends string>(v: unknown, vocab: readonly T[], max: number): T[] =>
    Array.isArray(v) ? (v.filter((x): x is T => typeof x === 'string' && (vocab as readonly string[]).includes(x)) as T[]).slice(0, max) : [];
  const len = typeof raw.lengthHours === 'number' && Number.isFinite(raw.lengthHours) && raw.lengthHours > 0 ? Math.round(raw.lengthHours * 2) / 2 : null;
  const coop = typeof raw.coopPlayers === 'number' && Number.isFinite(raw.coopPlayers) && raw.coopPlayers > 1 ? Math.min(999, Math.round(raw.coopPlayers)) : null;
  return {
    key,
    title: src.title,
    known: raw.known !== false,
    lengthHours: len,
    endless: raw.endless === true,
    genres: pick(raw.genres, GENRES, 6),
    moods: pick(raw.moods, MOODS, 5),
    themes: strList(raw.themes),
    themesLocal: strList(raw.themesLocal),
    modes: pick(raw.modes, MODES, 5),
    coopPlayers: coop,
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 700) : '',
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

/** AND across the groups that are present, OR inside each group. */
export function matchProfile(p: GameProfile, q: TagQuery): boolean {
  if (q.genres?.length && !q.genres.some((g) => p.genres.includes(g))) return false;
  if (q.moods?.length && !q.moods.some((m) => p.moods.includes(m))) return false;
  if (q.modes?.length && !q.modes.some((m) => p.modes.includes(m))) return false;
  if (q.maxLengthHours !== undefined && (p.endless || p.lengthHours === null || p.lengthHours > q.maxLengthHours)) return false;
  if (q.minLengthHours !== undefined && !p.endless && (p.lengthHours === null || p.lengthHours < q.minLengthHours)) return false;
  if (q.themes?.length) {
    const hay = `${p.themes.join(' ')} ${p.summary} ${p.title}`.toLowerCase();
    if (!q.themes.some((t) => hay.includes(t.toLowerCase()))) return false;
  }
  return true;
}
