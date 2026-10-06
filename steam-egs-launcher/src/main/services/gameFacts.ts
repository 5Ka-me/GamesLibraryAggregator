import { app } from 'electron';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { normalizeTitle } from '@app/shared';
import { getEntries } from './localData';
import { cacheGet } from './cache';
import { epicStoreDetails, type EpicDetails } from './epicStore';
import { getRegions } from './regions';
import {
  categoryNames,
  steamAppFactsReport,
  storeSearch,
  tagNames,
  type SteamAppFacts,
  type StoreItem,
} from './steamStore';

// Fact cards: what the public stores say about each library title (year, developer, user tags,
// player modes, review score, a description), so game profiles are grounded in store data instead
// of the model's memory of a bare title, and embedding texts have something real to embed.
//
// Sources, best first:
//   - the game's own Steam page (Steam copies, also Epic+Steam titles);
//   - the Steam page of the same title for Epic-only games (a "twin": exact normalized-title match
//     through the store search, games only — never a DLC or soundtrack with the same name);
//   - the Epic offer (genres, features, description) when Steam does not sell the game;
//   - an explicit 'none' card when neither store knows it, so it is not searched again every run.
//
// Cards live in userData/game-facts.json for FACTS_MAX_AGE_DAYS — deliberately not in the 7-day
// cache, which would throw away 700 titles' worth of slow, rate-limited lookups every week. A
// transient failure (network, 5xx, throttling) never produces a card: a 'none' written over a
// hiccup would hide the game's facts for a month.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FactCard {
  /** normalizeTitle(title). */
  key: string;
  title: string;
  /** Where the facts come from: the game's own Steam page, the Steam page of the same title (Epic-only
   *  game), the Epic offer, or nothing found. */
  source: 'steam' | 'steam_twin' | 'epic' | 'none';
  /** Steam appid of the own copy or the twin; null for epic/none. */
  appid: number | null;
  /** Release year for Steam cards. For 'epic' cards it is the year the offer went live on EGS, which is
   *  the release year only for games that launched there (factCardText labels it accordingly). */
  year: number | null;
  developer: string | null;
  /** Steam user tags in vote order (+ platform-flag tags), or EGS genres + features for 'epic'. Max 20. */
  storeTags: string[];
  /** Steam categories (Single-player, Online Co-op, Full controller support, VR Only, …); [] for epic/none. */
  categories: string[];
  /** EGS genres for 'epic' cards; [] otherwise. */
  genres: string[];
  shortDescription: string | null;
  /** ≤ 600 chars of the long description, markup stripped, not repeating shortDescription. */
  about: string | null;
  reviewPct: number | null;
  reviewCount: number | null;
  /** ISO time the card was built. */
  at: string;
}

export interface FactsProgress {
  done: number;
  total: number;
}

/** One library title in the shape ensureFactCards takes. */
export interface FactTarget {
  key: string;
  title: string;
  appid: number | null;
  epicNamespace: string | null;
}

/** Cards older than this are rebuilt (store tags and review scores drift; descriptions rarely do). */
export const FACTS_MAX_AGE_DAYS = 30;
const MAX_AGE_MS = FACTS_MAX_AGE_DAYS * 24 * 3600_000;

/** GetItems ids per request (the same chunk size steamAppFacts uses, so one flush = one request). */
const STEAM_BATCH = 50;
/** Store-search lookups in flight at once, and the pause each worker takes after a request. */
const LOOKUP_WORKERS = 2;
const LOOKUP_PAUSE_MS = 250;
/** First wait after an HTTP 429; doubles (up to the max) while the store keeps throttling. */
const COOLDOWN_429_MS = 30_000;
const MAX_COOLDOWN_MS = 120_000;
/** This many transient failures in a row means the store is down or throttling hard: stop for this run. */
const MAX_TRANSIENT_STREAK = 4;
/** Twin candidates kept per title (exact matches first); the first one that is a game wins. */
const MAX_TWIN_CANDIDATES = 3;
const MAX_STORE_TAGS = 20;
const SHORT_MAX = 400;
const ABOUT_MAX = 600;
/** Epic cards are written one by one; the file is saved after this many. */
const EPIC_SAVE_EVERY = 20;
/** Extra tries for the Steam tag/category catalogs before a run gives up, and the pause before each. */
const CATALOG_RETRIES = 2;
const CATALOG_RETRY_MS = 3000;

// ---------- persistence ----------

interface FactsFile {
  version: 1;
  cards: Record<string, FactCard>;
}

const file = (): string => join(app.getPath('userData'), 'game-facts.json');
let cache: FactsFile | null = null;
/** Bumped by clearFactCards, so a run that started before the clear stops writing. */
let generation = 0;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const SOURCES: FactCard['source'][] = ['steam', 'steam_twin', 'epic', 'none'];

/** A card read from disk, with every field coerced to its type (null for junk). */
function sanitize(raw: any): FactCard | null {
  if (!raw || typeof raw.key !== 'string' || !raw.key || typeof raw.at !== 'string') return null;
  if (!SOURCES.includes(raw.source)) return null;
  return {
    key: raw.key,
    title: typeof raw.title === 'string' ? raw.title : raw.key,
    source: raw.source,
    appid: numOrNull(raw.appid),
    year: numOrNull(raw.year),
    developer: strOrNull(raw.developer),
    storeTags: strings(raw.storeTags),
    categories: strings(raw.categories),
    genres: strings(raw.genres),
    shortDescription: strOrNull(raw.shortDescription),
    about: strOrNull(raw.about),
    reviewPct: numOrNull(raw.reviewPct),
    reviewCount: numOrNull(raw.reviewCount),
    at: raw.at,
  };
}

function load(): FactsFile {
  if (cache) return cache;
  const cards: Record<string, FactCard> = {};
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf8')) as { cards?: Record<string, unknown> };
      for (const raw of Object.values(parsed?.cards ?? {})) {
        const card = sanitize(raw);
        if (card) cards[card.key] = card;
      }
    }
  } catch {
    /* corrupt → start over; it is derived data */
  }
  cache = { version: 1, cards };
  return cache;
}

/** Atomic persist (tmp + rename): a crash leaves the previous file, never a truncated one. */
function save(): void {
  if (!cache) return;
  const f = file();
  try {
    writeFileSync(`${f}.tmp`, JSON.stringify(cache), 'utf8');
    renameSync(`${f}.tmp`, f);
  } catch {
    /* best effort — memory stays authoritative and the next save writes everything again */
  }
}

function isFresh(card: FactCard | undefined): boolean {
  if (!card) return false;
  const at = Date.parse(card.at);
  // Math.abs: a clock that moved backwards must not make a card look fresh forever.
  return Number.isFinite(at) && Math.abs(Date.now() - at) <= MAX_AGE_MS;
}

// ---------- reads ----------

/** All persisted cards (copy). */
export function getFactCards(): Record<string, FactCard> {
  return { ...load().cards };
}

export function getFactCard(key: string): FactCard | null {
  return load().cards[key] ?? null;
}

/** How many of the given keys lack a fresh card. */
export function missingFactCount(keys: string[]): number {
  const cards = load().cards;
  return [...new Set(keys)].filter((k) => !isFresh(cards[k])).length;
}

/** Library titles (from getEntries, deduped by normalizeTitle) in the shape ensureFactCards takes. */
export function libraryFactTargets(): FactTarget[] {
  const byKey = new Map<string, FactTarget>();
  for (const e of getEntries()) {
    const key = normalizeTitle(e.title);
    if (!key) continue;
    const t = byKey.get(key) ?? { key, title: e.title.trim(), appid: null, epicNamespace: null };
    if (e.source === 'Steam') t.appid = t.appid ?? (Number(e.externalId) || null);
    else t.epicNamespace = t.epicNamespace ?? e.namespace ?? null;
    byKey.set(key, t);
  }
  return [...byKey.values()];
}

export function clearFactCards(): void {
  generation++;
  cache = { version: 1, cards: {} };
  for (const f of [file(), `${file()}.tmp`]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

// ---------- markup → plain text ----------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  trade: '™', reg: '®', copy: '©', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', deg: '°', times: '×', shy: '', zwj: '', zwnj: '',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

// Steam BBCode: embedded media disappears with its content, block tags become line breaks, inline
// formatting tags vanish and keep their text. Lists of known tags only — a plain "[Early Access]" in
// a description is text, not markup. A media tag's content is empty or a URL — never another tag,
// so an unclosed [img] cannot swallow the text up to some later [/img].
const BB_MEDIA = /\[(img|video|previewyoutube|dynamiclink|carousel)\b[^\]]*\][^[]*\[\/\1\]/gi;
const BB_MEDIA_OPEN = /\[\/?(?:img|video|previewyoutube|dynamiclink|carousel)\b[^\]]*\]/gi;
const BB_BLOCK =
  /\[\/?(?:h[1-6]|p|list|olist|ul|ol|li|\*|quote|table|tr|td|th|hr|br|center|expand|code)(?:[= ][^\]]*)?\]/gi;
const BB_INLINE = /\[\/?(?:b|i|u|s|strike|spoiler|noparse|url|color|size|font|emoticon|sup|sub|tt)(?:[= ][^\]]*)?\]/gi;
const HTML_TAG = /<\/?[a-z][a-z0-9]*\b[^>]*>/i;
const PLACEHOLDER = /\{STEAM_[A-Z_]+\}[^\s\]"'<>]*/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>\]]+/gi;
const LINE_BULLET = /^(?:[•●▪■◆►▶✔✓★☆·*\-–—]+\s*|#{1,6}\s+)/;
const ENDS_SENTENCE = /[.!?…:;,"'»”’)\]]$/;

/** Strips Steam BBCode / HTML / placeholders and collapses whitespace. Exported for tests/reuse. */
export function stripMarkup(s: string): string {
  if (!s || typeof s !== 'string') return '';
  let t = s.replace(/\r\n?/g, '\n');
  if (HTML_TAG.test(t)) {
    t = t.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
    // In HTML the tags carry the line breaks; raw newlines are just source formatting.
    if (/<(?:br|p|div|li|h[1-6])\b/i.test(t)) t = t.replace(/\n+/g, ' ');
    t = t
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|tr|table|blockquote|section)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '');
  }
  t = t
    .replace(BB_MEDIA, '\n')
    .replace(BB_MEDIA_OPEN, '\n')
    .replace(BB_BLOCK, '\n')
    .replace(BB_INLINE, '')
    .replace(PLACEHOLDER, '')
    .replace(BARE_URL, '');
  t = decodeEntities(t)
    .replace(/[​-‍﻿]/g, '')
    .replace(/\*\*/g, '');
  const lines = t
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim().replace(LINE_BULLET, '').trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l));
  // Headings and list items end without punctuation; a period keeps them from running into the
  // next line ("BATTLE OUT OF HELL As the immortal…") and gives sentence cutting a boundary.
  return lines
    .map((l, i) => (i < lines.length - 1 && !ENDS_SENTENCE.test(l) ? `${l}.` : l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sentences of plain text (split only where whitespace follows the punctuation, so "1.5" survives). */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…]["'”’»)\]]*)\s+(?=\S)/u)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Cuts at a word boundary with an ellipsis. */
function clipWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(1, max - 1));
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`;
}

/** Whole sentences up to max chars; mid-sentence (word boundary) only when the first sentences are tiny. */
function clipSentences(parts: string[], max: number): string {
  let out = '';
  for (const part of parts) {
    const next = out ? `${out} ${part}` : part;
    if (next.length > max) {
      if (out.length < max * 0.5) out = clipWords(next, max);
      break;
    }
    out = next;
  }
  return out;
}

const contentWords = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];

/**
 * The long description as ≤ 600 chars of plain text, without the sentences that repeat the short
 * description (Steam pages usually open with it, sometimes after a tagline) and without the
 * one- or two-word fragments left over from headings ("Features.").
 */
function aboutText(full: string | null, short: string | null): string | null {
  const text = full ? stripMarkup(full) : '';
  if (!text) return null;
  const shortNorm = short ? normalizeTitle(short) : '';
  const shortWords = new Set(short ? contentWords(short) : []);
  const kept = sentences(text).filter((sent) => {
    const n = normalizeTitle(sent);
    if (!n) return false;
    if (/^\S+(?:\s+\S+)?[.:]$/u.test(sent)) return false;
    if (!shortNorm) return true;
    if (n.length >= 12 && shortNorm.includes(n)) return false;
    if (shortNorm.length >= 40 && n.includes(shortNorm)) return false;
    // Lightly edited copies of the short text ("Rise, Tarnished…" with different punctuation or a word changed).
    const words = contentWords(sent);
    return !(words.length >= 5 && words.filter((w) => shortWords.has(w)).length / words.length >= 0.8);
  });
  return clipSentences(kept, ABOUT_MAX) || null;
}

/** A store's short description as plain text, cut at a sentence boundary. */
function shortText(raw: string | null | undefined, max = SHORT_MAX): string | null {
  const text = raw ? stripMarkup(raw) : '';
  return text ? clipSentences(sentences(text), max) || null : null;
}

// ---------- prompt text ----------

// Store-plumbing categories that say nothing about how a game plays; kept on the card (it is raw
// data), left out of the prompt text so the budget goes to tags and the description.
const NOISE_CATEGORIES = new Set([
  'Steam Achievements', 'Steam Trading Cards', 'Steam Cloud', 'Family Sharing', 'Remote Play on Phone',
  'Remote Play on Tablet', 'Remote Play on TV', 'Stats', 'Steam Leaderboards', 'Captions available',
  'HDR available', 'Steam Timeline', 'Valve Anti-Cheat enabled', 'Steam Turn Notifications',
  'Includes Source SDK', 'Commentary available', 'Additional High-Quality Audio', 'SteamVR Collectibles',
  'Custom Volume Controls', 'Stereo Sound', 'Surround Sound', 'Adjustable Text Size', 'Subtitle Options',
  'Color Alternatives', 'Camera Comfort', 'Narrated Game Menus', 'Chat Speech-to-text', 'Chat Text-to-speech',
  'Keyboard Only Option', 'Mouse Only Option', 'Touch Only Option', 'DualShock Controller Support',
  'DualSense Controller Support', 'Steam Input API Support',
]);

/** 896642 → "896k", 1234 → "1.2k", 2_500_000 → "2.5M". */
function compactCount(n: number): string {
  const fmt = (v: number): string => (v >= 10 ? String(Math.floor(v)) : String(Math.floor(v * 10) / 10));
  if (n >= 1e6) return `${fmt(n / 1e6)}M`;
  if (n >= 1e3) return `${fmt(n / 1e3)}k`;
  return String(n);
}

/**
 * Compact multi-line text of a card for prompts, e.g.
 *   Year: 2016 · Developer: ConcernedApe · Reviews: 98% of 896k   (On EGS since: … for epic cards)
 *   Steam tags: Farming Sim, Life Sim, Pixel Graphics, …   (EGS tags: … for epic cards)
 *   Features: Single-player, Online Co-op, …
 *   Description: <short> <about>
 * Truncated to maxChars (default 900). Empty string for a 'none' card.
 */
export function factCardText(card: FactCard | null, maxChars = 900): string {
  if (!card || card.source === 'none') return '';
  const lines: string[] = [];
  const head: string[] = [];
  // An Epic card's year is the EGS listing date (Rocket League: 2015 game, on EGS since 2020). The
  // profile prompt treats "Year" as an authoritative release year, so it must not be labelled one.
  if (card.year) head.push(`${card.source === 'epic' ? 'On EGS since' : 'Year'}: ${card.year}`);
  if (card.developer) head.push(`Developer: ${card.developer}`);
  if (card.reviewPct != null && card.reviewCount) head.push(`Reviews: ${card.reviewPct}% of ${compactCount(card.reviewCount)}`);
  if (head.length) lines.push(head.join(' · '));
  if (card.storeTags.length) lines.push(`${card.source === 'epic' ? 'EGS tags' : 'Steam tags'}: ${card.storeTags.join(', ')}`);
  const features = card.categories.filter((c) => !NOISE_CATEGORIES.has(c));
  if (features.length) lines.push(`Features: ${features.join(', ')}`);

  const facts = lines.join('\n');
  if (facts.length >= maxChars) return clipWords(facts, maxChars);
  const desc = [card.shortDescription, card.about].filter(Boolean).join(' ');
  const label = 'Description: ';
  const room = maxChars - facts.length - (facts ? 1 : 0) - label.length;
  // A description squeezed into a few characters is noise; the facts alone are better.
  if (!desc || room < 40) return facts;
  return `${facts ? `${facts}\n` : ''}${label}${clipWords(desc, room)}`;
}

// ---------- card builders ----------

const PLATFORM_FLAGS = new Set(['Steam Deck Verified', 'Steam Deck Playable', 'Steam Deck Unsupported', 'VR Only', 'VR Supported']);

function steamCard(t: FactTarget, f: SteamAppFacts, source: 'steam' | 'steam_twin'): FactCard {
  // The platform flags are the most filterable facts on the card — they survive the 20-tag cap.
  const flags = f.tags.filter((x) => PLATFORM_FLAGS.has(x));
  const user = f.tags.filter((x) => !PLATFORM_FLAGS.has(x));
  const short = shortText(f.shortDescription);
  return {
    key: t.key,
    title: t.title,
    source,
    appid: f.appid,
    year: f.releaseYear,
    developer: f.developers.slice(0, 2).join(', ') || null,
    storeTags: [...user.slice(0, Math.max(0, MAX_STORE_TAGS - flags.length)), ...flags],
    categories: f.categories,
    genres: [],
    shortDescription: short,
    about: aboutText(f.fullDescriptionBbcode, short ?? f.shortDescription),
    reviewPct: f.reviewPct,
    reviewCount: f.reviewCount,
    at: new Date().toISOString(),
  };
}

function epicCard(t: FactTarget, d: EpicDetails): FactCard {
  // EGS offer descriptions are a blurb, occasionally a long one: the first sentences are the short
  // description, whatever follows becomes "about".
  const all = d.description ? sentences(stripMarkup(d.description)) : [];
  const short = clipSentences(all, SHORT_MAX) || null;
  const rest = short ? all.slice(sentences(short).length) : [];
  // releaseDate is the offer's effectiveDate: when it went live on EGS, not when the game came out.
  const year = d.releaseDate ? Number(String(d.releaseDate).slice(0, 4)) : NaN;
  const genres = [...new Set(d.genres)];
  return {
    key: t.key,
    title: t.title,
    source: 'epic',
    appid: null,
    // Placeholder dates (2099-01-01 for "coming eventually") are not a release year.
    year: Number.isInteger(year) && year >= 1970 && year <= new Date().getFullYear() + 1 ? year : null,
    developer: d.developer?.trim() || null,
    storeTags: [...new Set([...genres, ...d.features])].slice(0, MAX_STORE_TAGS),
    categories: [],
    genres,
    shortDescription: short,
    about: (short && !short.endsWith('…') && clipSentences(rest, ABOUT_MAX)) || null,
    reviewPct: null,
    reviewCount: null,
    at: new Date().toISOString(),
  };
}

function noneCard(t: FactTarget): FactCard {
  return {
    key: t.key,
    title: t.title,
    source: 'none',
    appid: null,
    year: null,
    developer: null,
    storeTags: [],
    categories: [],
    genres: [],
    shortDescription: null,
    about: null,
    reviewPct: null,
    reviewCount: null,
    at: new Date().toISOString(),
  };
}

// ---------- twin matching ----------

// "Control" on EGS is "CONTROL Ultimate Edition" on Steam: an edition suffix on top of the exact
// title is the same game (the same list epicStore uses). "Remastered", sequels, soundtracks are not.
const EDITION_SUFFIX =
  /^(standard|ultimate|definitive|deluxe|digitaldeluxe|complete|gold|premium|enhanced|special|legendary|anniversary|collectors|gameoftheyear|goty)?(edition)?$/;

function isEditionPair(a: string, b: string): boolean {
  if (a === b || !a || !b) return false;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short) && EDITION_SUFFIX.test(long.slice(short.length));
}

/** Store-search hits that are this title: exact normalized matches first, then edition variants. */
function twinCandidates(title: string, items: StoreItem[]): number[] {
  const want = normalizeTitle(title);
  const exact: number[] = [];
  const edition: number[] = [];
  for (const it of items) {
    if (!(it.appid > 0) || !it.name) continue;
    // Search hits carry no kind; one that is already known as DLC/soundtrack is not worth a lookup.
    if (it.kind && it.kind !== 'game') continue;
    const got = normalizeTitle(it.name);
    if (got === want) exact.push(it.appid);
    else if (isEditionPair(got, want)) edition.push(it.appid);
  }
  return [...new Set([...exact, ...edition])].slice(0, MAX_TWIN_CANDIDATES);
}

/** A twin must be a game; an unknown type is accepted (GetItems omits it for a few old apps). */
const isGame = (f: SteamAppFacts | undefined): f is SteamAppFacts => !!f && (f.type === undefined || f.type === 'game');

/**
 * epicStoreDetails answers null both for "not on EGS" (cached) and for a transient failure (not
 * cached). Its cache entry tells the two apart; the key mirrors epicStore's (lang 'en').
 */
function epicMissIsFinal(t: FactTarget): boolean {
  const key = `epic:en:${getRegions().epicCc}:${t.epicNamespace ?? ''}:${normalizeTitle(t.title)}`;
  const hit = cacheGet<EpicDetails | null>('epicStore', key, Number.MAX_SAFE_INTEGER);
  return !!hit && hit.data == null;
}

const httpStatus = (e: unknown): number | null => {
  const m = /HTTP (\d{3})/.exec(e instanceof Error ? e.message : String(e));
  return m ? Number(m[1]) : null;
};

// ---------- the build ----------

const cancelled = (): Error => new Error('AI_CANCELLED');

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

/** setTimeout that ends early (rejecting with AI_CANCELLED) when the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Waits for a promise that never rejects, giving up (AI_CANCELLED) when the signal aborts. */
function waitFor(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    void p.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

// Runs are serialized: a second call waits for the first, then builds only what is still missing
// (usually nothing). Two runs side by side would double the request rate against the stores.
let tail: Promise<void> = Promise.resolve();

/**
 * Builds missing or stale (older than FACTS_MAX_AGE_DAYS = 30) cards for the given library titles and
 * persists them. `force` rebuilds all given titles. Steam copies → steamAppFacts in batches; Epic-only →
 * Steam twin (exact normalized-title match through storeSearch, 2 lookups in flight, 250 ms pause, HTTP 429
 * → wait 30 s and retry that title once) → steamAppFacts for the twins; no twin → epicStoreDetails
 * (English, description/genres/features/developer/releaseDate) → 'epic' card; nothing → 'none' card.
 * A transient error for a title (network, 5xx, 429 after retry) leaves that title WITHOUT a card (it is
 * retried next time) instead of writing a misleading 'none'. Saves after every batch (atomic tmp+rename).
 * Respects `signal` (stops between requests; throws Error('AI_CANCELLED') when aborted).
 * Throws Error('FACTS_UNAVAILABLE') when Steam's tag/category catalogs still cannot be loaded after
 * CATALOG_RETRIES more tries: no card could be built, so nothing is written.
 * Safe to call concurrently: calls run one after another.
 *
 * Returns the cards of the given titles that exist afterwards (a stale card is returned when its
 * rebuild failed transiently — old facts beat none).
 */
export async function ensureFactCards(
  games: FactTarget[],
  opts: { force?: boolean; signal?: AbortSignal; onProgress?: (p: FactsProgress) => void } = {}
): Promise<Record<string, FactCard>> {
  const prev = tail;
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  // Chained on prev as well: if this call gives up while waiting, the next one still waits for prev.
  tail = prev.then(() => mine);
  try {
    await waitFor(prev, opts.signal);
    await build(games, opts);
  } finally {
    release();
  }
  const cards = load().cards;
  const out: Record<string, FactCard> = {};
  for (const g of games) if (g?.key && cards[g.key]) out[g.key] = cards[g.key];
  return out;
}

const validAppid = (id: unknown): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0;

async function build(
  games: FactTarget[],
  opts: { force?: boolean; signal?: AbortSignal; onProgress?: (p: FactsProgress) => void }
): Promise<void> {
  const { signal } = opts;
  const gen = generation;
  const existing = load().cards;

  // Deduped by key; a duplicate contributes the ids the first row lacked (Epic+Steam titles).
  const todo = new Map<string, FactTarget>();
  for (const g of Array.isArray(games) ? games : []) {
    if (!g?.key || typeof g.title !== 'string') continue;
    const t = todo.get(g.key);
    if (t) {
      t.appid = t.appid ?? (validAppid(g.appid) ? g.appid : null);
      t.epicNamespace = t.epicNamespace ?? g.epicNamespace ?? null;
      continue;
    }
    if (!opts.force && isFresh(existing[g.key])) continue;
    todo.set(g.key, {
      key: g.key,
      title: g.title.trim() || g.key,
      appid: validAppid(g.appid) ? g.appid : null,
      epicNamespace: g.epicNamespace ?? null,
    });
  }
  const total = todo.size;
  if (!total) return;

  const finished = new Set<string>();
  const report = (): void => opts.onProgress?.({ done: finished.size, total });
  const finish = (t: FactTarget): void => {
    finished.add(t.key);
  };
  let dirty = 0;
  const put = (card: FactCard): void => {
    if (gen !== generation) return; // cleared meanwhile — this run's results belong to nobody
    load().cards[card.key] = card;
    dirty++;
  };
  const flushFile = (): void => {
    if (dirty && gen === generation) save();
    dirty = 0;
  };
  const alive = (): boolean => gen === generation;

  report();
  try {
    throwIfAborted(signal);
    // Tag and category names come from two small catalogs; without them every Steam card would be
    // stored tagless, and twins could not be judged. A single failed request must not leave the
    // whole run ungrounded, so they get a few tries; after that the run fails loudly (the caller
    // reports it and can skip the paid profiles) instead of returning as if all titles were done.
    const catalogsReady = async (): Promise<boolean> => {
      const [names, cats] = await Promise.all([tagNames('en'), categoryNames()]);
      return Object.keys(names).length > 0 && Object.keys(cats).length > 0;
    };
    let ready = await catalogsReady();
    for (let i = 0; !ready && i < CATALOG_RETRIES; i++) {
      await sleep(CATALOG_RETRY_MS, signal);
      ready = await catalogsReady();
    }
    if (!ready) throw new Error('FACTS_UNAVAILABLE');

    // ---- 1. Steam copies: one GetItems request per 50 titles ----
    const steam = [...todo.values()].filter((t) => t.appid != null);
    const lookup = [...todo.values()].filter((t) => t.appid == null);
    for (let i = 0; i < steam.length; i += STEAM_BATCH) {
      throwIfAborted(signal);
      if (!alive()) return;
      const batch = steam.slice(i, i + STEAM_BATCH);
      const { facts, failed } = await steamAppFactsReport(batch.map((t) => t.appid!));
      const failedIds = new Set(failed);
      for (const t of batch) {
        const f = facts[t.appid!];
        if (f) {
          put(steamCard(t, f, 'steam'));
          finish(t);
        } else if (failedIds.has(t.appid!)) {
          finish(t); // transient — no card, retried next run
        } else {
          // Steam no longer knows the appid: treat the title like an Epic-only one.
          lookup.push(t);
        }
      }
      flushFile();
      report();
    }

    // ---- 2. Everything else: Steam twin → Epic offer → 'none' ----
    await lookupPhase(lookup, { signal, put, finish, report, flushFile, alive, dirty: () => dirty });
    // Titles skipped after transient failures count as handled for this run.
    if (alive()) opts.onProgress?.({ done: total, total });
  } finally {
    flushFile();
  }
}

interface LookupCtx {
  signal?: AbortSignal;
  put: (card: FactCard) => void;
  finish: (t: FactTarget) => void;
  report: () => void;
  flushFile: () => void;
  alive: () => boolean;
  dirty: () => number;
}

/**
 * Twin lookup and Epic fallback with two workers sharing three queues: store searches, Epic
 * lookups (titles Steam does not sell) and pending twins. Twins are checked in GetItems batches of
 * up to 50 ids as they accumulate, so ~500 Epic-only titles cost ~8 fact requests, not 500.
 */
async function lookupPhase(targets: FactTarget[], ctx: LookupCtx): Promise<void> {
  const { signal, put, finish, report } = ctx;
  if (!targets.length) return;
  const searchQueue = [...targets];
  const epicQueue: FactTarget[] = [];
  const pending: { t: FactTarget; ids: number[] }[] = [];
  let pendingIds = 0;

  let searchStreak = 0;
  let epicStreak = 0;
  let searchStopped = false;
  let epicStopped = false;
  let cooldownUntil = 0;
  let cooldownMs = COOLDOWN_429_MS;
  let epicDone = 0;

  const coolDown = (): void => {
    cooldownUntil = Math.max(cooldownUntil, Date.now() + cooldownMs);
  };

  /** One storeSearch with the shared 429 cooldown; 'transient' when the answer is unknowable now. */
  const search = async (t: FactTarget): Promise<number[] | 'transient'> => {
    const term = t.title.replace(/[™®©]/g, ' ').replace(/\s+/g, ' ').trim();
    for (let attempt = 0; ; attempt++) {
      await sleep(cooldownUntil - Date.now(), signal);
      try {
        const items = await storeSearch(term, 'en');
        cooldownMs = COOLDOWN_429_MS;
        return twinCandidates(t.title, items);
      } catch (e) {
        const status = httpStatus(e);
        if (status === 429) {
          if (attempt > 0) cooldownMs = Math.min(cooldownMs * 2, MAX_COOLDOWN_MS);
          coolDown(); // every worker waits, not only this one
          if (attempt === 0) continue;
          return 'transient';
        }
        // The store refusing this particular term is an answer ("no hit"), not an outage.
        if (status === 400 || status === 404) return [];
        return 'transient';
      }
    }
  };

  const doSearch = async (t: FactTarget): Promise<void> => {
    const res = await search(t);
    if (res === 'transient') {
      finish(t);
      if (++searchStreak >= MAX_TRANSIENT_STREAK) searchStopped = true;
      report();
    } else {
      searchStreak = 0;
      if (res.length) {
        pending.push({ t, ids: res });
        pendingIds += res.length;
      } else {
        epicQueue.push(t);
      }
    }
    await sleep(LOOKUP_PAUSE_MS, signal);
  };

  /** Checks the oldest pending twins (≤ 50 ids, one request); non-games fall through to Epic. */
  const flushTwins = async (): Promise<void> => {
    const take: { t: FactTarget; ids: number[] }[] = [];
    let n = 0;
    while (pending.length && (n === 0 || n + pending[0].ids.length <= STEAM_BATCH)) {
      const p = pending.shift()!;
      take.push(p);
      n += p.ids.length;
    }
    pendingIds -= n;
    if (!take.length) return;
    const { facts, failed } = await steamAppFactsReport(take.flatMap((p) => p.ids));
    const failedIds = new Set(failed);
    for (const p of take) {
      const id = p.ids.find((x) => isGame(facts[x]));
      if (id != null) {
        put(steamCard(p.t, facts[id], 'steam_twin'));
        finish(p.t);
      } else if (p.ids.some((x) => failedIds.has(x))) {
        finish(p.t); // transient
      } else {
        epicQueue.push(p.t); // only DLC/soundtracks share the name — the game itself is not on Steam
      }
    }
    ctx.flushFile();
    report();
  };

  const doEpic = async (t: FactTarget): Promise<void> => {
    const d = await epicStoreDetails(t.title, t.epicNamespace, 'en');
    if (d) {
      put(epicCard(t, d));
      epicStreak = 0;
    } else if (epicMissIsFinal(t)) {
      put(noneCard(t));
      epicStreak = 0;
    } else if (++epicStreak >= MAX_TRANSIENT_STREAK) {
      epicStopped = true;
    }
    finish(t);
    if (++epicDone % EPIC_SAVE_EVERY === 0 && ctx.dirty()) ctx.flushFile();
    report();
    await sleep(LOOKUP_PAUSE_MS, signal);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      throwIfAborted(signal);
      if (!ctx.alive()) return;
      if (searchStopped && searchQueue.length) {
        // The store search is down or throttling hard: these titles wait for the next run.
        for (const t of searchQueue.splice(0)) finish(t);
        report();
      }
      if (epicStopped && epicQueue.length) {
        for (const t of epicQueue.splice(0)) finish(t);
        report();
      }
      if (pendingIds >= STEAM_BATCH) await flushTwins();
      else if (epicQueue.length) await doEpic(epicQueue.shift()!);
      else if (searchQueue.length) await doSearch(searchQueue.shift()!);
      else if (pending.length) await flushTwins();
      else return;
    }
  };

  // allSettled: a cancelled worker must not leave the other one writing after this returns.
  const results = await Promise.allSettled(Array.from({ length: LOOKUP_WORKERS }, () => worker()));
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
}
