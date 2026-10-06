import { app } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeTitle } from '@app/shared';
import { addAiUsage } from '../config';
import { chutesHeaders } from './aiClient';
import { PROFILE_VERSION, getProfiles, type GameProfile } from './enrichment';
import { getFactCards, type FactCard } from './gameFacts';
import { getEntries } from './localData';
import { getChutesApiKey } from './secretStore';
import { TAG_SYNONYMS, tagNames } from './steamStore';

// Semantic layer of the assistant: text embeddings from the public chutes.ai
// Qwen3-Embedding chute (same key as chat), used for three things:
//   - a persistent index of the library (one vector per unique title, built
//     from its profile + store fact card) → "games like X / a mood" ranking;
//   - ad-hoc scoring of store/wishlist items against a wish (memory cache);
//   - a tag resolver that maps free phrases in any language ("coop", "pixel
//     art", the Russian word for "space") to exact Steam tag names, so hard
//     filters hit real tags.
//
// Vectors are Matryoshka-truncated to EMBED_DIMS and L2-normalized on our
// side (the server may or may not honour `dimensions`), so cosine similarity
// is a plain dot product. Only game facts and search phrases are sent —
// nothing that identifies the account.

/* eslint-disable @typescript-eslint/no-explicit-any */

export const EMBED_MODEL = 'Qwen/Qwen3-Embedding-8B';
export const EMBED_URL = 'https://chutes-qwen-qwen3-embedding-8b-tee.chutes.ai/v1/embeddings';
export const EMBED_DIMS = 1024;

/** Tag resolver: the lowest similarity an embedded tag may have to count as a match. */
export const TAG_MIN_SCORE = 0.55;
/** Tag resolver: tags further than this below the best hit are dropped (a phrase rarely means unrelated tags). */
export const TAG_BEST_DELTA = 0.08;
/** semanticSearch blend: weight of the similarity to the query when reference games are given too. */
export const QUERY_WEIGHT = 0.65;
/** semanticSearch blend: weight of the best similarity to one of the reference games. */
export const REF_WEIGHT = 0.35;

/** Texts per request; ~32 × 400 tokens keeps a request well inside the chute's limits. */
const BATCH = 32;
/** Requests in flight at once for one embedTexts call / one index build. */
const IN_FLIGHT = 3;
const TIMEOUT_MS = 60_000;
/** One retry: a rate limit needs a longer breath than a 5xx or a timeout. */
const RETRY_RATE_MS = 5_000;
const RETRY_OTHER_MS = 2_000;
/** Builds ride out chutes' "at maximum capacity" spells: a 429 / 5xx is retried after 5, 15 and 30 s. */
const BUILD_BACKOFF_MS = [5_000, 15_000, 30_000];
/** Chat path: every stage has a non-embedding fallback, so a slow endpoint is given up on early. */
const INTERACTIVE_TIMEOUT_MS = 12_000;
/** Chat path: a dropped keep-alive socket is retried once right away; anything slower is not retried. */
const INTERACTIVE_NET_RETRY_MS = 300;
/** After a chat-path request fails on capacity, a timeout or the network, chat-path calls fail fast this long. */
const BREAKER_MS = 60_000;
/** Errors that mean "the endpoint is busy or unreachable" (they open the breaker), not "this request is bad". */
const TRIPS_BREAKER = /^AI_(RATE|TIMEOUT|NETWORK|HTTP_5\d\d)\b/;
/** Hard cap per input text (characters), whatever the caller passes. */
const MAX_INPUT_CHARS = 4000;
const GAME_TEXT_MAX = 1500;
const QUERY_CACHE_MAX = 200;
const DOC_CACHE_MAX = 3000;
/** After a failed on-demand tag-index build, the resolver stays exact-only this long instead of retrying per call. */
const TAG_RETRY_MS = 120_000;
/**
 * The embedding pass needs (nearly) every Steam tag indexed: against a half-synced index a phrase whose own tag
 * is missing would resolve to a merely related one ("space" → "Sci-fi") and filter by it. A handful missing
 * (Steam added a tag, the sync is pending) is fine.
 */
const TAG_MIN_COVERAGE = 0.98;
/** The index file is rewritten at most this often during a build (it is a few MB), and once at the end. */
const SAVE_EVERY_MS = 3_000;
const FILE_VERSION = 1;

const GAME_TASK = 'Given a description of what a player wants to play, retrieve games that match it';
const TAG_TASK = 'Given a phrase describing a game genre, feature, theme or art style, retrieve the Steam store tag that names it';

/**
 * Official platform flags that the app turns into tags (see fetchMetaChunks) although GetTagList lacks
 * them. All are exact-match vocabulary; the hints make them findable by meaning ("steam deck", "virtual
 * reality"). "Steam Deck Unsupported" is left out of the embedding index on purpose: embeddings are bad at
 * negation, and "games for the deck" must not resolve to it.
 */
const PLATFORM_TAGS: Record<string, string[] | null> = {
  'Steam Deck Verified': ['steam deck', 'deck verified', 'handheld'],
  'Steam Deck Playable': ['steam deck', 'deck playable', 'handheld'],
  'Steam Deck Unsupported': null,
  'VR Supported': ['virtual reality', 'vr headset optional'],
  'VR Only': ['virtual reality', 'vr headset required'],
};

/**
 * Every word → tag synonym the resolver knows. TAG_SYNONYMS also holds the resolver's own spellings ("mods" →
 * Moddable, "virtual reality" → VR), so the store's tag search and the resolver agree on them.
 */
const synonymEntries = (): [string, string][] => Object.entries(TAG_SYNONYMS);

const STOP_ERRORS = /AI_NO_KEY|AI_AUTH|AI_BALANCE/;

const MODE_LABEL: Record<string, string> = {
  single: 'single-player',
  coop_local: 'local co-op',
  coop_online: 'online co-op',
  pvp: 'PvP',
  mmo: 'MMO',
};

// ---------- small helpers ----------

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const isTimeout = (e: unknown): boolean => (e as any)?.name === 'TimeoutError' || /aborted due to timeout/i.test(errMsg(e));
/** Input as the endpoint gets it: trimmed, capped, never empty (an empty string is a 400 on some servers). */
const prep = (t: string): string => String(t ?? '').trim().slice(0, MAX_INPUT_CHARS) || '-';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('AI_CANCELLED'));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('AI_CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Waits for a shared promise but lets this caller leave early when its own signal aborts. */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Error('AI_CANCELLED'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('AI_CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

/** Runs fn over items with at most `limit` in flight; the first failure stops new pulls and is rethrown. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown = null;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        if (!failed) {
          failed = true;
          failure = e;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
}

function lruGet<V>(m: Map<string, V>, k: string): V | undefined {
  const v = m.get(k);
  if (v !== undefined) {
    m.delete(k);
    m.set(k, v);
  }
  return v;
}

function lruSet<V>(m: Map<string, V>, k: string, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

// ---------- the endpoint ----------

class EmbedHttpError extends Error {
  constructor(
    public status: number,
    detail: string
  ) {
    super(`${status === 429 ? 'AI_RATE' : `AI_HTTP_${status}`}: embeddings: ${detail}`);
  }
}

/**
 * Request shapes, richest first: `dimensions` (unverified on this chute) and base64 output (in its schema) are
 * optional extras. A server that rejects an extra answers 400/422 — or, behind chutes' gateway, 500 "exhausted
 * all available targets" because every instance refused the body — so the client steps down one shape and,
 * when the plainer one works, keeps using it for the rest of the session.
 */
const SHAPES: { dims: boolean; base64: boolean }[] = [
  { dims: true, base64: true },
  { dims: false, base64: true },
  { dims: false, base64: false },
];
let shapeIndex = 0;
const maybeShapeProblem = (status: number, detail: string): boolean =>
  status === 400 || status === 422 || (status === 500 && /exhausted all available targets/i.test(detail));

/** Raw vector → EMBED_DIMS-long, L2-normalized Float32Array (Matryoshka prefix); null when unusable. */
function toVec(raw: unknown): Float32Array | null {
  let src: ArrayLike<number> | null = null;
  if (Array.isArray(raw)) src = raw;
  else if (typeof raw === 'string' && raw) {
    // encoding_format "base64": little-endian float32 bytes. A plain number list is accepted too.
    const buf = Buffer.from(raw, 'base64');
    const f = new Float32Array(Math.floor(buf.byteLength / 4));
    new Uint8Array(f.buffer).set(buf.subarray(0, f.length * 4));
    src = f;
  }
  if (!src || src.length < EMBED_DIMS) return null;
  const v = new Float32Array(EMBED_DIMS);
  let sq = 0;
  for (let i = 0; i < EMBED_DIMS; i++) {
    const x = Number(src[i]) || 0;
    v[i] = x;
    sq += x * x;
  }
  if (!(sq > 0)) return null;
  const inv = 1 / Math.sqrt(sq);
  for (let i = 0; i < EMBED_DIMS; i++) v[i] *= inv;
  return v;
}

/**
 * How hard one embedding call tries. 'build' (index builds and the build's tag sync — nobody waits on a single
 * request): 60 s timeout, 429 / 5xx retried after 5, 15 and 30 s, so one capacity spell does not abort a
 * 20-minute run. 'interactive' (chat turns): 12 s timeout, no retry beyond a dropped socket, and the shared
 * breaker below, so a busy endpoint costs a turn one short wait instead of a full timeout per stage.
 * 'default': the contract embedTexts documents (60 s, one retry).
 */
type EmbedMode = 'default' | 'build' | 'interactive';

/**
 * Chat-path circuit breaker: until this time interactive calls fail at once with AI_RATE (their callers fall
 * back to tags or word overlap). Opened by an interactive failure that means "busy or unreachable", closed by
 * any successful request. Builds neither open nor obey it — they have their own, longer patience.
 */
let embedDownUntil = 0;
const breakerOpen = (): boolean => Date.now() < embedDownUntil;

async function embedRequest(input: string[], timeoutMs: number, signal?: AbortSignal): Promise<Float32Array[]> {
  const post = (shape: { dims: boolean; base64: boolean }): Promise<Response> =>
    fetch(EMBED_URL, {
      method: 'POST',
      headers: chutesHeaders(true),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: EMBED_MODEL,
        input,
        // base64 is ~4x smaller on the wire than a JSON list of 4096 floats per text.
        ...(shape.base64 ? { encoding_format: 'base64' } : {}),
        ...(shape.dims ? { dimensions: EMBED_DIMS } : {}),
      }),
    });
  let res = await post(SHAPES[shapeIndex]);
  let detail = '';
  // Step down through the plainer request shapes while the failure may be about an optional field.
  for (let next = shapeIndex + 1; !res.ok && next < SHAPES.length; next++) {
    if (res.status === 401 || res.status === 403 || res.status === 402) break;
    detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    if (!maybeShapeProblem(res.status, detail)) break;
    res = await post(SHAPES[next]);
    detail = '';
    if (res.ok) shapeIndex = next;
  }
  if (res.status === 401 || res.status === 403) throw new Error('AI_AUTH');
  if (res.status === 402) throw new Error('AI_BALANCE');
  if (!res.ok) {
    if (!detail) detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new EmbedHttpError(res.status, detail || 'request failed');
  }
  let json: any;
  try {
    json = await res.json();
  } catch (e) {
    if (signal?.aborted || isTimeout(e)) throw e;
    throw new EmbedHttpError(502, 'unreadable reply');
  }
  // Billed as soon as the server answered, whether or not the reply is usable.
  addAiUsage(Number(json?.usage?.prompt_tokens ?? 0) || 0, 0);
  const rows: any[] = Array.isArray(json?.data) ? json.data : [];
  if (rows.length !== input.length) throw new EmbedHttpError(502, `expected ${input.length} vectors, got ${rows.length}`);
  const out: (Float32Array | null)[] = new Array(input.length).fill(null);
  rows.forEach((r, pos) => {
    const idx = Number.isInteger(r?.index) && r.index >= 0 && r.index < input.length ? (r.index as number) : pos;
    out[idx] = toVec(r?.embedding);
  });
  if (out.some((v) => !v)) throw new EmbedHttpError(502, 'malformed vectors');
  return out as Float32Array[];
}

/**
 * Delay before retry number `attempt + 1`, or null when the call should give up: retrying cannot help (auth,
 * balance, bad request) or the mode's budget is spent (see EmbedMode).
 */
function retryDelay(e: unknown, attempt: number, mode: EmbedMode): number | null {
  let kind: 'rate' | 'server' | 'timeout' | 'net';
  if (e instanceof EmbedHttpError) {
    if (e.status === 429) kind = 'rate';
    else if (e.status >= 500) kind = 'server';
    else return null; // another 4xx: the same request fails the same way
  } else if (isTimeout(e)) kind = 'timeout';
  else if (/^AI_/.test(errMsg(e))) return null;
  else kind = 'net'; // a network hiccup (reset, DNS)
  if (mode === 'interactive') return kind === 'net' && attempt === 0 ? INTERACTIVE_NET_RETRY_MS : null;
  if (mode === 'build' && (kind === 'rate' || kind === 'server')) return BUILD_BACKOFF_MS[attempt] ?? null;
  if (attempt >= 1) return null;
  return kind === 'rate' ? RETRY_RATE_MS : RETRY_OTHER_MS;
}

/** Every error leaving this module carries an AI_* code, so callers can tell "stop the run" from "skip". */
function asAiError(e: unknown): Error {
  if (e instanceof Error && /^AI_/.test(e.message)) return e;
  if (isTimeout(e)) return new Error('AI_TIMEOUT: the embedding model did not answer in time');
  return new Error(`AI_NETWORK: embeddings: ${errMsg(e)}`);
}

async function embedBatch(input: string[], mode: EmbedMode, signal?: AbortSignal): Promise<Float32Array[]> {
  const interactive = mode === 'interactive';
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error('AI_CANCELLED');
    if (interactive && breakerOpen()) throw new Error('AI_RATE: embeddings: skipped, the endpoint failed moments ago');
    try {
      const vecs = await embedRequest(input, interactive ? INTERACTIVE_TIMEOUT_MS : TIMEOUT_MS, signal);
      embedDownUntil = 0; // it answers again
      return vecs;
    } catch (e) {
      if (signal?.aborted) throw new Error('AI_CANCELLED');
      const wait = retryDelay(e, attempt, mode);
      if (wait === null) {
        const err = asAiError(e);
        if (interactive && TRIPS_BREAKER.test(err.message)) embedDownUntil = Date.now() + BREAKER_MS;
        throw err;
      }
      await sleep(wait, signal);
    }
  }
}

/** embedTexts with an explicit EmbedMode — the module's own entry point. */
async function embedWith(texts: string[], opts: { kind?: 'doc' | 'query'; task?: string; signal?: AbortSignal }, mode: EmbedMode): Promise<Float32Array[]> {
  if (!texts.length) return [];
  if (opts.signal?.aborted) throw new Error('AI_CANCELLED');
  if (!getChutesApiKey()) throw new Error('AI_NO_KEY');
  const task = (opts.task ?? GAME_TASK).trim();
  const inputs = texts.map((t) => (opts.kind === 'query' ? `Instruct: ${task}\nQuery: ${prep(t)}` : prep(t)));
  const batches: { start: number; input: string[] }[] = [];
  for (let i = 0; i < inputs.length; i += BATCH) batches.push({ start: i, input: inputs.slice(i, i + BATCH) });
  const out: Float32Array[] = new Array(inputs.length);
  await pool(batches, IN_FLIGHT, async (b) => {
    const vecs = await embedBatch(b.input, mode, opts.signal);
    vecs.forEach((v, j) => {
      out[b.start + j] = v;
    });
  });
  return out;
}

/**
 * Embeds texts (batches of 32, 60 s timeout per request, one retry after 2 s / 5 s on 429/5xx/timeout,
 * respects signal → Error('AI_CANCELLED')). kind 'query' wraps each text as
 * `Instruct: ${task}\nQuery: ${text}` (task defaults to a game-retrieval instruction). Returns L2-normalized
 * EMBED_DIMS-long Float32Arrays in input order. Throws 'AI_NO_KEY' without a key, 'AI_AUTH' on 401/403,
 * 'AI_BALANCE' on 402. Adds the usage to the AI counters via addAiUsage(prompt_tokens, 0) from ../config.
 *
 * The module's own callers pick their budget instead (EmbedMode): index builds are more patient, the chat
 * path (semanticSearch, scoreTexts, resolveTags) gives up after 12 s and fails fast for a minute after that.
 */
export function embedTexts(texts: string[], opts: { kind?: 'doc' | 'query'; task?: string; signal?: AbortSignal } = {}): Promise<Float32Array[]> {
  return embedWith(texts, opts, 'default');
}

/** Cosine similarity of two normalized vectors (= their dot product). */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

// ---------- memory caches for queries and ad-hoc documents ----------

const queryCache = new Map<string, Float32Array>();
const docCache = new Map<string, Float32Array>();

/** Query vectors for the given task, cached by text (identical phrases are embedded once). Chat path: interactive budget. */
async function queryVectors(texts: string[], task: string, signal?: AbortSignal): Promise<Float32Array[]> {
  const keyOf = (t: string): string => `${task}\n${prep(t)}`;
  const local = new Map<string, Float32Array>();
  const missing = new Map<string, string>();
  for (const t of texts) {
    const k = keyOf(t);
    if (local.has(k) || missing.has(k)) continue;
    const hit = lruGet(queryCache, k);
    if (hit) local.set(k, hit);
    else missing.set(k, t);
  }
  if (missing.size) {
    const keys = [...missing.keys()];
    const vecs = await embedWith([...missing.values()], { kind: 'query', task, signal }, 'interactive');
    keys.forEach((k, i) => {
      local.set(k, vecs[i]);
      lruSet(queryCache, k, vecs[i], QUERY_CACHE_MAX);
    });
  }
  return texts.map((t) => local.get(keyOf(t))!);
}

// ---------- the text a game is embedded from ----------

/** v2 profile fields, read defensively: v1 profiles simply lack them. */
type ProfileFields = GameProfile & { keywords?: string[]; pitch?: string };

/** Cuts at a word boundary (keeping line breaks) and marks the cut with an ellipsis. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  const sp = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'));
  return `${(sp > max * 0.6 ? head.slice(0, sp) : head).trimEnd()}…`;
}

/** One line of prose: whitespace collapsed, then cut. */
const clip = (s: string, max: number): string => cut(s.replace(/\s+/g, ' ').trim(), max);

/** Strings only, trimmed, deduped case-insensitively, at most `max`. */
function words(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const w = x.replace(/_/g, ' ').trim();
    if (!w || seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase());
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

function lengthWord(h: number): string {
  if (h <= 6) return 'short';
  if (h <= 20) return 'medium length';
  if (h <= 50) return 'long';
  return 'very long';
}

/** Whether a fact card carries anything a profile could be checked against. */
const cardHasFacts = (c: FactCard): boolean =>
  (Array.isArray(c.storeTags) && c.storeTags.length > 0) || (Array.isArray(c.genres) && c.genres.length > 0) || !!c.shortDescription?.trim() || !!c.about?.trim();

/** The text a library game is embedded from: title, pitch, summary, keywords, store description (short),
 *  store tags (≤ 12), genres, moods, themes, modes, length — whatever exists. English labels. ≤ 1500 chars.
 *  An unknown title's profile (known: false) contributes nothing; a title-only (v1) profile next to a card
 *  with facts contributes only its modes and length (see below). */
export function gameEmbedText(title: string, profile: GameProfile | null, card: FactCard | null): string {
  const c = card && card.source !== 'none' && cardHasFacts(card) ? card : null;
  // An unknown title's profile is boilerplate ("I am not familiar with this game", word for word across dozens
  // of games): embedding it would pull every unknown game together. Title and store facts only.
  const p = profile && profile.known !== false ? (profile as ProfileFields) : null;
  // A title-only (v1) profile can contradict the store (a "city builder" whose tags say FPS): next to store
  // facts the store's word wins, and only the play-shape fields (modes, length) are kept. A grounded (v2)
  // profile, or any profile without facts to check it against, is used whole.
  const prose = p && (p.v === PROFILE_VERSION || !c) ? p : null;
  const lines: string[] = [clip(title, 200)];
  // Short structured lines first and the free description last, so the length cap cuts prose, not facts.
  if (typeof prose?.pitch === 'string' && prose.pitch.trim()) lines.push(clip(prose.pitch, 240));
  if (typeof prose?.summary === 'string' && prose.summary.trim()) lines.push(`Summary: ${clip(prose.summary, 500)}`);
  const keywords = words(prose?.keywords, 15);
  if (keywords.length) lines.push(`Keywords: ${keywords.join(', ')}`);
  const tags = words(c?.storeTags, 12);
  if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);
  const genres = words([...(prose?.genres ?? []), ...(c?.genres ?? [])], 8);
  if (genres.length) lines.push(`Genres: ${genres.join(', ')}`);
  const moods = words(prose?.moods, 6);
  if (moods.length) lines.push(`Moods: ${moods.join(', ')}`);
  const themes = words(prose?.themes, 8);
  if (themes.length) lines.push(`Themes: ${themes.join(', ')}`);
  const modes = (p?.modes ?? []).map((m) => MODE_LABEL[m] ?? m);
  if (modes.length) lines.push(`Modes: ${modes.join(', ')}${p?.coopPlayers ? ` (co-op up to ${p.coopPlayers} players)` : ''}`);
  if (p?.endless) lines.push('Length: endless, no defined ending');
  else if (typeof p?.lengthHours === 'number' && p.lengthHours > 0) lines.push(`Length: ${lengthWord(p.lengthHours)}, about ${p.lengthHours} hours`);
  const desc = c?.shortDescription?.trim() ? clip(c.shortDescription, 400) : c?.about?.trim() ? clip(c.about, 300) : '';
  if (desc) lines.push(`Description: ${desc}`);
  const text = lines.join('\n');
  return cut(text, GAME_TEXT_MAX);
}

// ---------- the persistent index ----------

interface Vec {
  /** sha1 of the embedded text — a changed profile or card means a changed hash, i.e. a stale vector. */
  h: string;
  v: Float32Array;
}

interface IndexState {
  games: Map<string, Vec>;
  tags: Map<string, Vec>;
}

interface IndexFile {
  version: number;
  model: string;
  dims: number;
  games: Record<string, { h: string; v: string }>;
  tags: Record<string, { h: string; v: string }>;
}

const indexFile = (): string => join(app.getPath('userData'), 'embeddings.json');

let state: IndexState | null = null;
/** Bumped by clearIndex, so a build still running stops instead of writing into the cleared index. */
let generation = 0;
let lastError: string | null = null;
let gamesBuild: Promise<{ embedded: number; total: number }> | null = null;
const progressListeners = new Set<(done: number, total: number) => void>();
let tagsSync: Promise<void> | null = null;
let tagsFailedAt = 0;

function encodeVec(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

function decodeVec(b64: string): Float32Array | null {
  const buf = Buffer.from(b64, 'base64');
  if (buf.byteLength !== EMBED_DIMS * 4) return null;
  // Copy instead of viewing: a Buffer from the pool may sit at an offset Float32Array cannot start at.
  const out = new Float32Array(EMBED_DIMS);
  new Uint8Array(out.buffer).set(buf);
  return out;
}

function readVecs(src: unknown, into: Map<string, Vec>): void {
  if (!src || typeof src !== 'object') return;
  for (const [k, e] of Object.entries(src as Record<string, any>)) {
    if (typeof e?.h !== 'string' || typeof e?.v !== 'string') continue;
    const v = decodeVec(e.v);
    if (v) into.set(k, { h: e.h, v });
  }
}

function load(): IndexState {
  if (state) return state;
  const fresh: IndexState = { games: new Map(), tags: new Map() };
  try {
    if (existsSync(indexFile())) {
      const parsed = JSON.parse(readFileSync(indexFile(), 'utf8')) as Partial<IndexFile>;
      // Vectors of another model or size live in another space; such a file is simply rebuilt.
      if (parsed && parsed.version === FILE_VERSION && parsed.model === EMBED_MODEL && parsed.dims === EMBED_DIMS) {
        readVecs(parsed.games, fresh.games);
        readVecs(parsed.tags, fresh.tags);
      }
    }
  } catch {
    /* corrupt → start over; it is derived data */
  }
  state = fresh;
  return state;
}

function save(s: IndexState): void {
  if (s !== state) return; // cleared meanwhile
  const out: IndexFile = { version: FILE_VERSION, model: EMBED_MODEL, dims: EMBED_DIMS, games: {}, tags: {} };
  for (const [k, e] of s.games) out.games[k] = { h: e.h, v: encodeVec(e.v) };
  for (const [k, e] of s.tags) out.tags[k] = { h: e.h, v: encodeVec(e.v) };
  try {
    const f = indexFile();
    writeFileSync(`${f}.tmp`, JSON.stringify(out), 'utf8');
    renameSync(`${f}.tmp`, f);
  } catch {
    /* best effort — the in-memory index still serves this session */
  }
}

/** Unique library titles (normalizeTitle keys). */
function libraryKeys(): Set<string> {
  const out = new Set<string>();
  for (const e of getEntries()) {
    const k = normalizeTitle(e.title);
    if (k) out.add(k);
  }
  return out;
}

/** What every library game should be embedded from right now, with the text's hash. */
function libraryTexts(): Map<string, { text: string; h: string }> {
  const profiles = getProfiles();
  const cards = getFactCards();
  const out = new Map<string, { text: string; h: string }>();
  for (const e of getEntries()) {
    const key = normalizeTitle(e.title);
    if (!key || out.has(key)) continue;
    const profile = profiles[key] ?? null;
    // The profile's title is stable across syncs; the first store row's spelling may flip ("DOOM"/"Doom").
    const text = gameEmbedText(profile?.title || e.title.trim(), profile, cards[key] ?? null);
    out.set(key, { text, h: sha1(text) });
  }
  return out;
}

export interface IndexStatus {
  /** Library games with a current vector. */
  indexed: number;
  /** Library games (unique titles). */
  games: number;
  /** Library games whose vector is missing or whose text changed since. */
  stale: number;
  building: boolean;
  /** Steam tags indexed for the tag resolver. */
  tags: number;
  model: string;
  lastError: string | null;
}

export function indexStatus(): IndexStatus {
  const s = load();
  const lib = libraryTexts();
  let indexed = 0;
  for (const [key, t] of lib) if (s.games.get(key)?.h === t.h) indexed++;
  return { indexed, games: lib.size, stale: lib.size - indexed, building: !!gamesBuild, tags: s.tags.size, model: EMBED_MODEL, lastError };
}

// ---------- the tag index ----------

/** English Steam tag names, [] when the list is unavailable (offline with a cold cache). */
async function englishTagNames(): Promise<string[]> {
  const names = await tagNames('en').catch(() => ({}) as Record<string, string>);
  return [...new Set(Object.values(names).filter((n): n is string => typeof n === 'string' && !!n.trim()))];
}

/** The synonym tables inverted: lowercase tag name → the everyday words that mean it. */
function synonymsByTag(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const [word, tag] of synonymEntries()) {
    if (seen.has(word.toLowerCase())) continue; // the first table to define a word owns it
    seen.add(word.toLowerCase());
    const k = tag.toLowerCase();
    out.set(k, [...(out.get(k) ?? []), word]);
  }
  return out;
}

/** The text each tag is embedded from: `<Tag>` plus its synonyms, e.g. "Sexual Content (erotic, nsfw, adult)". */
async function tagTexts(): Promise<Map<string, { text: string; h: string }>> {
  const names = await englishTagNames();
  const out = new Map<string, { text: string; h: string }>();
  if (!names.length) return out;
  const syn = synonymsByTag();
  const platform = Object.entries(PLATFORM_TAGS).filter(([, hints]) => hints !== null).map(([n]) => n);
  for (const name of [...names, ...platform]) {
    if (out.has(name)) continue;
    const extra = [...(syn.get(name.toLowerCase()) ?? []), ...(PLATFORM_TAGS[name] ?? [])].filter((w) => w.toLowerCase() !== name.toLowerCase());
    const text = extra.length ? `${name} (${[...new Set(extra)].join(', ')})` : name;
    out.set(name, { text, h: sha1(text) });
  }
  return out;
}

/**
 * Embeds tags that are missing or whose text changed, drops tags Steam no longer lists. Batch by batch: every
 * finished batch is kept (and saved) even when a later one fails, so a retry embeds only what is still missing.
 */
async function syncTags(mode: EmbedMode): Promise<void> {
  const gen = generation;
  const desired = await tagTexts();
  if (!desired.size) return; // tag list unavailable: keep whatever is indexed
  const s = load();
  let changed = false;
  for (const name of [...s.tags.keys()]) {
    if (!desired.has(name)) {
      s.tags.delete(name);
      changed = true;
    }
  }
  const todo = [...desired].filter(([name, t]) => s.tags.get(name)?.h !== t.h);
  const slices: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += BATCH) slices.push(todo.slice(i, i + BATCH));
  try {
    await pool(slices, IN_FLIGHT, async (slice) => {
      if (gen !== generation) return; // cleared meanwhile: nothing more to send
      const vecs = await embedWith(
        slice.map(([, t]) => t.text),
        { kind: 'doc' },
        mode
      );
      if (gen !== generation) return;
      slice.forEach(([name, t], i) => s.tags.set(name, { h: t.h, v: vecs[i] }));
      changed = true;
    });
  } finally {
    if (changed && gen === generation) save(s);
  }
}

/**
 * Single-flight tag-index sync. It runs detached from any caller's signal (≈15 small requests) so a
 * cancelled caller does not waste a half-built index; callers abort only their own wait. `onDemand`
 * (the resolver, inside a chat turn) uses the interactive budget and skips the attempt for a while after a
 * failure instead of paying for it per call; the index build's sync uses the patient build budget.
 */
function ensureTagIndex(onDemand: boolean, signal?: AbortSignal): Promise<void> {
  if (onDemand && Date.now() - tagsFailedAt < TAG_RETRY_MS) return Promise.resolve();
  if (!tagsSync) {
    tagsSync = syncTags(onDemand ? 'interactive' : 'build')
      .then(
        () => {
          tagsFailedAt = 0;
        },
        (e) => {
          tagsFailedAt = Date.now();
          throw e;
        }
      )
      .finally(() => {
        tagsSync = null;
      });
  }
  return untilAborted(tagsSync, signal);
}

// ---------- building the library index ----------

function report(done: number, total: number): void {
  for (const l of progressListeners) {
    try {
      l(done, total);
    } catch {
      /* a listener's problem is not the build's */
    }
  }
}

async function runBuild(signal?: AbortSignal): Promise<{ embedded: number; total: number }> {
  if (signal?.aborted) throw new Error('AI_CANCELLED');
  // No key check up front: a build with nothing to embed (only pruning) works without one, and
  // embedTexts throws AI_NO_KEY as soon as something does need the network.
  const gen = generation;
  const s = load();
  const lib = libraryTexts();
  let dirty = false;
  // Games that left the library (removed from an account, renamed) keep no vector.
  for (const key of [...s.games.keys()]) {
    if (!lib.has(key)) {
      s.games.delete(key);
      dirty = true;
    }
  }
  const todo = [...lib].filter(([key, t]) => s.games.get(key)?.h !== t.h).map(([key, t]) => ({ key, text: t.text, h: t.h }));
  report(0, todo.length);

  // Tags first (once; afterwards only when Steam's list changes). A transient tag failure must not cost
  // the games their index — the resolver builds tags on demand later; account problems stop everything.
  let tagIssue: string | null = null;
  try {
    await ensureTagIndex(false, signal);
  } catch (e) {
    if (signal?.aborted) throw new Error('AI_CANCELLED');
    if (STOP_ERRORS.test(errMsg(e))) throw e;
    tagIssue = errMsg(e);
  }

  const chunks: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += BATCH) chunks.push(todo.slice(i, i + BATCH));
  let done = 0;
  let savedAt = Date.now();
  try {
    await pool(chunks, IN_FLIGHT, async (chunk) => {
      if (gen !== generation) throw new Error('AI_CANCELLED');
      const vecs = await embedWith(
        chunk.map((t) => t.text),
        { kind: 'doc', signal },
        'build'
      );
      if (gen !== generation) throw new Error('AI_CANCELLED');
      chunk.forEach((t, i) => s.games.set(t.key, { h: t.h, v: vecs[i] }));
      dirty = true;
      done += chunk.length;
      if (Date.now() - savedAt >= SAVE_EVERY_MS) {
        save(s);
        savedAt = Date.now();
        dirty = false;
      }
      report(done, todo.length);
    });
  } finally {
    // Partial progress survives a cancel or a failure; stale titles are simply redone next time.
    if (dirty && gen === generation) save(s);
  }
  lastError = tagIssue ? `Tag index: ${tagIssue}` : null;
  return { embedded: done, total: lib.size };
}

/**
 * (Re)embeds library games whose text hash changed or is missing (text from gameEmbedText with the
 * current profile + fact card), drops vectors of games no longer in the library, and builds the tag index
 * once (all Steam tags from tagNames('en'), each embedded as `<Tag>` plus its TAG_SYNONYMS words, e.g.
 * "Sexual Content (erotic, nsfw, adult)"). Persists to userData/embeddings.json:
 *   { version: 1, model, dims, games: { [key]: { h: sha1(text), v: base64(Float32Array) } },
 *     tags: { [tagName]: { h, v } } }
 * (atomic tmp+rename; loaded lazily and kept in memory as Float32Arrays). A second call while one runs
 * returns the running promise. Emits nothing itself; reports through onProgress.
 *
 * Progress counts games only (`total` = stale games), so it matches IndexStatus.stale; the tag index is
 * synced before the first game tick. The first caller's signal cancels the build; a joining caller's
 * signal only ends its own wait, and its onProgress is fed too.
 */
export function buildIndex(opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<{ embedded: number; total: number }> {
  if (opts.onProgress) progressListeners.add(opts.onProgress);
  if (gamesBuild) return untilAborted(gamesBuild, opts.signal);
  gamesBuild = runBuild(opts.signal)
    .catch((e) => {
      const msg = errMsg(e);
      if (!/AI_CANCELLED/.test(msg)) lastError = msg;
      throw e;
    })
    .finally(() => {
      gamesBuild = null;
      progressListeners.clear();
    });
  return gamesBuild;
}

// ---------- search ----------

export interface SemanticHit {
  key: string;
  score: number;
}

/**
 * Ranks library games by meaning. `query` is embedded as a query (cached in memory by text, 200 entries);
 * optional `refKeys` (owned reference games) blend in: score = 0.65·cos(query) + 0.35·max cos(ref) when a
 * query is given, or the ref term alone when the query is empty. `candidates` limits the pool (keys from
 * hard filters); games without a vector are skipped. Returns the top k (default 20) by score.
 * Throws Error('INDEX_EMPTY') when no library vectors exist.
 *
 * The reference games themselves are left out of the results (a game is not "like itself"); an empty
 * query without usable references returns []. Embedding errors propagate (AI_* codes).
 */
export async function semanticSearch(
  query: string,
  opts: { candidates?: string[] | null; k?: number; refKeys?: string[]; signal?: AbortSignal } = {}
): Promise<SemanticHit[]> {
  const s = load();
  const lib = libraryKeys();
  let any = false;
  for (const k of lib) {
    if (s.games.has(k)) {
      any = true;
      break;
    }
  }
  if (!any) throw new Error('INDEX_EMPTY');
  const refSet = new Set((opts.refKeys ?? []).map((k) => normalizeTitle(String(k ?? ''))).filter(Boolean));
  const refVecs = [...refSet].map((k) => s.games.get(k)?.v).filter((v): v is Float32Array => !!v);
  const q = (query ?? '').trim();
  if (!q && !refVecs.length) return [];
  const qv = q ? (await queryVectors([q], GAME_TASK, opts.signal))[0] : null;
  const inPool = opts.candidates ? new Set(opts.candidates.map((k) => normalizeTitle(String(k ?? ''))).filter(Boolean)) : lib;
  const k = typeof opts.k === 'number' && Number.isFinite(opts.k) ? Math.max(1, Math.min(500, Math.round(opts.k))) : 20;
  const hits: SemanticHit[] = [];
  for (const key of inPool) {
    if (!lib.has(key) || refSet.has(key)) continue;
    const e = s.games.get(key);
    if (!e) continue;
    let refScore = -1;
    for (const r of refVecs) refScore = Math.max(refScore, cosine(r, e.v));
    const score = qv && refVecs.length ? QUERY_WEIGHT * cosine(qv, e.v) + REF_WEIGHT * refScore : qv ? cosine(qv, e.v) : refScore;
    hits.push({ key, score: round4(score) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, k);
}

/**
 * Ranks arbitrary non-library items (store/wishlist candidates) by meaning: embeds each item's text as a
 * document (memory cache by text hash, 3000 entries max) and the query as a query. Returns scores in input
 * order. Chat path: 12 s per request, and AI_RATE at once while the endpoint is known to be down.
 */
export async function scoreTexts(query: string, texts: string[], opts: { signal?: AbortSignal } = {}): Promise<number[]> {
  if (!texts.length) return [];
  const q = (query ?? '').trim();
  if (!q) return texts.map(() => 0);
  const hashes = texts.map((t) => sha1(prep(t)));
  const local = new Map<string, Float32Array>();
  const missing = new Map<string, string>();
  hashes.forEach((h, i) => {
    if (local.has(h) || missing.has(h)) return;
    const hit = lruGet(docCache, h);
    if (hit) local.set(h, hit);
    else missing.set(h, texts[i]);
  });
  const [qvs, docVecs] = await Promise.all([
    queryVectors([q], GAME_TASK, opts.signal),
    missing.size ? embedWith([...missing.values()], { kind: 'doc', signal: opts.signal }, 'interactive') : Promise.resolve([] as Float32Array[]),
  ]);
  [...missing.keys()].forEach((h, i) => {
    local.set(h, docVecs[i]);
    lruSet(docCache, h, docVecs[i], DOC_CACHE_MAX);
  });
  return hashes.map((h) => round4(cosine(qvs[0], local.get(h)!)));
}

// ---------- tag resolver ----------

export interface TagResolution {
  /** The phrase as given. */
  phrase: string;
  /** Best Steam tag names, best first (≤ top), each with a score; exact matches score 1. */
  tags: { name: string; score: number }[];
  /** True when the phrase matched a tag name or a synonym exactly (case-insensitive). */
  exact: boolean;
}

/** Spelling-insensitive form: "Co-op" / "co op" / "coop" and "hack & slash" / "Hack and Slash" agree. */
const squash = (s: string): string =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[\s\-_'’.]+/g, '');

/** Every accepted spelling → the canonical tag name. Real names win over squashed forms and synonyms. */
function exactLookup(names: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const add = (form: string, name: string): void => {
    if (form && !map.has(form)) map.set(form, name);
  };
  const all = [...new Set([...names, ...Object.keys(PLATFORM_TAGS)])];
  for (const n of all) add(n.toLowerCase(), n);
  for (const n of all) add(squash(n), n);
  const byLower = new Map(all.map((n) => [n.toLowerCase(), n]));
  for (const [word, tag] of synonymEntries()) {
    const name = byLower.get(tag.toLowerCase()) ?? tag;
    add(word.toLowerCase(), name);
    add(squash(word), name);
  }
  return map;
}

function exactTag(phrase: string, lookup: Map<string, string>): string | null {
  const w = phrase
    .toLowerCase()
    .replace(/^[\s"'«»“”.,;:!?]+|[\s"'«»“”.,;:!?]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!w) return null;
  const direct = (f: string): string | undefined => lookup.get(f) ?? lookup.get(f.replace(/-/g, ' ')) ?? lookup.get(f.replace(/\s+/g, '-'));
  const any = (f: string): string | undefined => direct(f) ?? lookup.get(squash(f));
  const whole = any(w);
  if (whole) return whole;
  // The whole phrase in the singular before "games" is stripped: "party games" → "Party Game", not "Party"
  // ("card", "board", "word", "god" likewise). Direct spellings only: the squashed "wargame" would turn
  // "war games" (games about war) into "Wargame"; it falls through to "War" below.
  if (w.length > 3 && w.endsWith('s')) {
    const one = direct(w.slice(0, -1));
    if (one) return one;
  }
  const bare = w.replace(/\s+games?$/, ''); // "horror games" → "horror"
  if (bare !== w) {
    const hit = any(bare);
    if (hit) return hit;
  }
  // Plurals last ("roguelikes", "puzzles"); real names like "Zombies" already matched above.
  if (bare.length > 3 && bare.endsWith('s')) {
    const one = bare.slice(0, -1);
    return lookup.get(one) ?? lookup.get(squash(one)) ?? null;
  }
  return null;
}

/** Pass 1 of the resolver (no network beyond the cached tag list): exact names, synonyms, spelling variants. */
async function exactPass(phrases: string[]): Promise<{ names: string[]; out: TagResolution[] }> {
  const names = await englishTagNames();
  // Offline with a cold tag cache: the names the tag index already knows still make a vocabulary.
  const lookup = exactLookup(names.length ? names : [...load().tags.keys()]);
  const out: TagResolution[] = (Array.isArray(phrases) ? phrases : []).map((raw) => {
    const phrase = typeof raw === 'string' ? raw : String(raw ?? '');
    const hit = exactTag(phrase, lookup);
    return hit ? { phrase, tags: [{ name: hit, score: 1 }], exact: true } : { phrase, tags: [], exact: false };
  });
  return { names, out };
}

/**
 * Maps free phrases in any language ("anime", "pixel art", "coop", "space", "vr") to exact Steam tag names. Pass 1:
 * exact name / TAG_SYNONYMS / hyphen-space variants (no network). Pass 2 (only for the rest): embedding
 * similarity against the tag index (built on demand if missing — tags only, cheap), keeping tags with
 * score ≥ TAG_MIN_SCORE (0.55) and within 0.08 of the best, at most `top` (default 3). Official platform
 * flag tags ("Steam Deck Verified", "Steam Deck Playable", "VR Supported", "VR Only") are always part of
 * the exact-match vocabulary even though GetTagList lacks them. Never throws for network problems — falls
 * back to exact-only results (tags: [] for unresolved phrases).
 *
 * The only error it throws is AI_CANCELLED, when the caller's own signal aborts. Pass 2 is skipped without a
 * key, after a failed on-demand tag-index build (for TAG_RETRY_MS), while the chat-path breaker is open, and
 * while the tag index covers less than TAG_MIN_COVERAGE of Steam's tags.
 */
export async function resolveTags(phrases: string[], opts: { top?: number; min?: number; signal?: AbortSignal } = {}): Promise<TagResolution[]> {
  const top = typeof opts.top === 'number' && Number.isFinite(opts.top) ? Math.max(1, Math.min(10, Math.round(opts.top))) : 3;
  const min = typeof opts.min === 'number' && Number.isFinite(opts.min) ? opts.min : TAG_MIN_SCORE;
  const { names, out } = await exactPass(phrases);
  const rest = out.filter((r) => !r.exact && r.phrase.trim());
  // An open breaker means the endpoint just failed a chat-path call: do not start a tag sync or wait on it.
  if (!rest.length || !getChutesApiKey() || breakerOpen()) return out;
  try {
    await ensureTagIndex(true, opts.signal);
    const tags = load().tags;
    if (!tags.size) return out;
    if (names.length && names.filter((n) => tags.has(n)).length < names.length * TAG_MIN_COVERAGE) return out;
    const index = [...tags.entries()];
    const vecs = await queryVectors(
      rest.map((r) => r.phrase.trim()),
      TAG_TASK,
      opts.signal
    );
    rest.forEach((r, i) => {
      const scored = index.map(([name, e]) => ({ name, score: cosine(vecs[i], e.v) })).sort((a, b) => b.score - a.score);
      const best = scored[0]?.score ?? 0;
      r.tags = scored
        .filter((t) => t.score >= min && t.score >= best - TAG_BEST_DELTA)
        .slice(0, top)
        .map((t) => ({ name: t.name, score: round4(t.score) }));
    });
  } catch (e) {
    if (opts.signal?.aborted) throw new Error('AI_CANCELLED');
    // Network trouble, rate limits, no budget: exact matches stand, the rest stays unresolved.
    if (process.env.LAUNCHER_AI_DEBUG) console.log(`[ai] tag resolver fell back to exact matches: ${errMsg(e).slice(0, 200)}`);
    for (const r of rest) r.tags = [];
  }
  return out;
}

/**
 * resolveTags for a chat turn: the embedding pass gets at most `waitMs`. A first-ever tag-index sync (≈15
 * requests) or a stalled endpoint would otherwise hold the turn; past the deadline the exact matches (pass 1)
 * still come back, the other phrases stay unresolved, and a running tag sync goes on detached for the next
 * turn. Throws AI_CANCELLED only when the caller's own signal aborts.
 */
export async function resolveTagsWithin(
  phrases: string[],
  waitMs: number,
  opts: { top?: number; min?: number; signal?: AbortSignal } = {}
): Promise<TagResolution[]> {
  const deadline = AbortSignal.timeout(Math.max(0, waitMs));
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  try {
    return await resolveTags(phrases, { ...opts, signal });
  } catch (e) {
    if (opts.signal?.aborted) throw new Error('AI_CANCELLED');
    if (!deadline.aborted) throw e;
    if (process.env.LAUNCHER_AI_DEBUG) console.log(`[ai] tag resolver: no embedding answer within ${waitMs} ms, exact matches only`);
    return (await exactPass(phrases)).out;
  }
}

/**
 * Deletes the library vectors and the query/document caches; the file is removed, or rewritten with the tag
 * index alone. The tag index is kept: it comes from Steam's tag list, not from the user's games or profiles,
 * and dropping it would make the next chat turn pay for a full tag re-sync.
 */
export function clearIndex(): void {
  generation++;
  // A copy, so a tag sync still running on the old state cannot write into the kept map.
  const tags = new Map(load().tags);
  state = { games: new Map(), tags };
  queryCache.clear();
  docCache.clear();
  lastError = null;
  tagsFailedAt = 0;
  const f = indexFile();
  for (const p of [f, `${f}.tmp`]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  if (tags.size) save(state);
}
