import { normalizeTitle, chipMatches, type TagChip } from '@app/shared';
import { getEntries } from './localData';
import { GENRES, MODES, MOODS, getProfiles, matchProfile, type GameProfile, type Genre, type Mode, type Mood, type TagQuery } from './enrichment';
import { steamAchievementsProgress, type SteamAchievementProgress } from './steamSync';
import { META_VERSION, itemsMeta } from './steamStore';
import { epicTagsCached, warmEpicTags } from './epicStore';
import { getFactCard } from './gameFacts';
import { scanInstalledSteamAppIds } from './steamScan';
import * as legendary from './legendary';

// One merged view of the library for the main process: a row per title with
// both stores' entries folded in, install state, playtime, achievement
// progress and the AI profile. Used by the assistant's tools and by dynamic
// collections, which share the same filter language (FindArgs).

/** A store-specific handle on a game: Steam appid or Epic app name. Stable across syncs. */
export interface GameRef {
  source: 'Steam' | 'Epic' | string;
  id: string;
}

export interface LibGame {
  /** normalizeTitle(title) — the merge key. */
  key: string;
  title: string;
  sources: ('Steam' | 'Epic')[];
  refs: GameRef[];
  appid: number | null;
  epicAppName: string | null;
  epicNamespace: string | null;
  iconUrl: string | null;
  minutes: number;
  minutes2w: number;
  lastPlayedAt: string | null;
  installed: boolean;
  profile: GameProfile | null;
  progress: SteamAchievementProgress | null;
  /**
   * Steam's user tags for the Steam copy ("VR", "Roguelike", …, then the platform flags). For Epic-only
   * games: the Steam twin's user tags and VR flags from the fact card, then EGS genre/feature tags.
   * Empty until loaded (libraryView withStoreTags).
   */
  storeTags: string[];
}

/** The renderer's route key for a game (LibraryPage.gameKey): Steam appid first, then Epic app name, then the title. */
export const libKey = (g: LibGame): string =>
  g.appid ? `s-${g.appid}` : g.epicAppName ? `e-${encodeURIComponent(g.epicAppName)}` : `t-${encodeURIComponent(g.key)}`;

const INSTALLED_TTL_MS = 5_000;
let installedCache: { at: number; value: { steam: Set<string>; epic: Set<string> } } | null = null;

/** Installed Steam appids + Epic app names; briefly cached because legendary is a child process. */
async function installedSets(): Promise<{ steam: Set<string>; epic: Set<string> }> {
  if (installedCache && Date.now() - installedCache.at < INSTALLED_TTL_MS) return installedCache.value;
  const [steam, epic] = await Promise.all([
    Promise.resolve()
      .then(() => scanInstalledSteamAppIds())
      .catch(() => [] as string[]),
    legendary.listInstalled().catch(() => []),
  ]);
  const value = { steam: new Set(steam.map(String)), epic: new Set(epic.map((g) => g.app_name)) };
  installedCache = { at: Date.now(), value };
  return value;
}

let storeTagsRefetched = false;

/** Case-insensitive dedupe that keeps the first spelling and the order. */
function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Store tags an Epic-only game's fact card contributes. A Steam twin's user tags describe the same
 * game, VR flags included; its Steam Deck rating is left out, because Valve rated the Steam build and
 * the Epic copy runs through another launcher. An 'epic' card holds the EGS genres/features, the same
 * vocabulary as the live EGS tags, so it covers games the background warm-up has not reached yet.
 */
function cardTags(key: string): string[] {
  const card = getFactCard(key);
  if (card?.source === 'steam_twin') return card.storeTags.filter((t) => !/^Steam Deck /i.test(t));
  if (card?.source === 'epic') return card.storeTags;
  return [];
}

/**
 * Attaches store tags: Steam user tags from the batched store metadata for
 * Steam copies (cached, SWR; one forced refresh per process for metadata
 * cached before tags were requested; the persisted fact card when the store
 * gives nothing). Games that exist only on Epic get their fact card's tags —
 * the Steam twin's user tags first, so Steam-tag filters ("VR", "Anime") reach
 * them too — plus the EGS genre/feature tags. The EGS side warms in the
 * background — the first call waits briefly for what the disk cache already
 * has and later calls see the rest; cards are read synchronously from disk.
 */
async function attachStoreTags(list: LibGame[]): Promise<void> {
  const ids = list.map((g) => g.appid).filter((x): x is number => !!x);
  if (ids.length) {
    let meta = await itemsMeta(ids, 'en').catch(() => ({}) as Awaited<ReturnType<typeof itemsMeta>>);
    const current = ids.filter((id) => meta[id]?.metaV === META_VERSION).length;
    if (!storeTagsRefetched && current < ids.length / 2) {
      storeTagsRefetched = true;
      meta = await itemsMeta(ids, 'en', true).catch(() => meta);
    }
    for (const g of list) if (g.appid) g.storeTags = meta[g.appid]?.tags ?? getFactCard(g.key)?.storeTags ?? [];
  }
  const epicOnly = list.filter((g) => !g.appid);
  const withNs = epicOnly.filter((g) => g.epicNamespace);
  if (withNs.length) {
    const warm = warmEpicTags(withNs.map((g) => ({ ns: g.epicNamespace!, title: g.title })));
    await Promise.race([warm, new Promise((r) => setTimeout(r, 2000))]);
  }
  for (const g of epicOnly) {
    g.storeTags = dedupeTags([...cardTags(g.key), ...(g.epicNamespace ? (epicTagsCached(g.epicNamespace) ?? []) : [])]);
  }
}

/**
 * Steam appids the user owns the game of: Steam copies plus the Steam twins of Epic-only games (from
 * their fact cards). A store listing of a game owned on Epic then counts as owned even when its
 * localized or edition-suffixed store name differs from the library title.
 */
export function ownedSteamAppids(list: LibGame[]): Set<number> {
  const out = new Set<number>();
  for (const g of list) {
    if (g.appid) out.add(g.appid);
    else {
      const card = getFactCard(g.key);
      if (card?.source === 'steam_twin' && card.appid) out.add(card.appid);
    }
  }
  return out;
}

/** The official platform flags itemsMeta and the fact cards add as tags (English in every UI language). */
export const PLATFORM_FLAG_RE = /^(Steam Deck (Verified|Playable|Unsupported)|VR (Only|Supported))$/i;

/**
 * The store tags shown to a model for one game, at most `max`: platform flags first (the store lists them
 * after up to 20 user tags, so a plain slice never showed them), then the tags a filter asked for (`want`,
 * substring match), then the most voted rest. A model told to check hard properties against the facts
 * must be able to see what the filter matched.
 */
export function factTags(tags: string[], want: string[], max = 8): string[] {
  const w = want.map((x) => x.toLowerCase()).filter(Boolean);
  const asked = (t: string): boolean => w.some((x) => t.toLowerCase().includes(x));
  const flags = tags.filter((t) => PLATFORM_FLAG_RE.test(t));
  const rest = tags.filter((t) => !PLATFORM_FLAG_RE.test(t));
  return [...flags, ...rest.filter(asked), ...rest.filter((t) => !asked(t))].slice(0, max);
}

export async function libraryView(withProgress: boolean, withStoreTags = false): Promise<LibGame[]> {
  const inst = await installedSets();
  const profiles = getProfiles();
  const byKey = new Map<string, LibGame>();
  for (const e of getEntries()) {
    const key = normalizeTitle(e.title);
    if (!key) continue;
    const g = byKey.get(key) ?? {
      key,
      title: e.title.trim(),
      sources: [],
      refs: [],
      appid: null,
      epicAppName: null,
      epicNamespace: null,
      iconUrl: null,
      minutes: 0,
      minutes2w: 0,
      lastPlayedAt: null,
      installed: false,
      profile: profiles[key] ?? null,
      progress: null,
      storeTags: [],
    };
    if (!g.sources.includes(e.source)) g.sources.push(e.source);
    g.iconUrl = g.iconUrl ?? e.iconUrl ?? null;
    g.minutes += e.playtimeMinutes ?? 0;
    g.minutes2w += e.playtime2WeeksMinutes ?? 0;
    if (e.lastPlayedAt && (!g.lastPlayedAt || e.lastPlayedAt > g.lastPlayedAt)) g.lastPlayedAt = e.lastPlayedAt;
    if (e.source === 'Steam') {
      g.appid = g.appid ?? (Number(e.externalId) || null);
      g.refs.push({ source: 'Steam', id: e.externalId });
      if (inst.steam.has(e.externalId)) g.installed = true;
    } else {
      g.epicAppName = g.epicAppName ?? e.appName ?? null;
      g.epicNamespace = g.epicNamespace ?? e.namespace ?? null;
      g.refs.push({ source: 'Epic', id: e.appName ?? e.externalId });
      if (e.appName && inst.epic.has(e.appName)) g.installed = true;
    }
    byKey.set(key, g);
  }
  const list = [...byKey.values()];
  if (withStoreTags) await attachStoreTags(list);
  if (withProgress) {
    const ids = list.map((g) => g.appid).filter((x): x is number => !!x);
    const rows = await steamAchievementsProgress(ids).catch(() => [] as SteamAchievementProgress[]);
    const byId = new Map(rows.map((r) => [r.appId, r]));
    for (const g of list) if (g.appid) g.progress = byId.get(g.appid) ?? null;
  }
  return list;
}

// ---------- buckets ----------

export type PlayedBucket = 'never' | '<1h' | '1-10h' | '10-50h' | '50h+';
export const playedBucket = (m: number): PlayedBucket => (m === 0 ? 'never' : m < 60 ? '<1h' : m < 600 ? '1-10h' : m < 3000 ? '10-50h' : '50h+');
export type AchBucket = 'none' | 'started' | 'half' | 'almost' | 'perfect';
export const achBucket = (p: SteamAchievementProgress | null): AchBucket | null =>
  !p || p.total === 0 ? null : p.allUnlocked ? 'perfect' : p.percentage >= 80 ? 'almost' : p.percentage >= 40 ? 'half' : p.unlocked > 0 ? 'started' : 'none';
export const daysSince = (iso: string | null): number | null => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null);
export const hours1 = (m: number): number => Math.round(m / 6) / 10;

// ---------- the filter language ----------

/** Filters the assistant's library tools and dynamic collections both understand. */
export interface FindArgs {
  sources?: ('Steam' | 'EGS' | 'Epic')[];
  installed?: boolean;
  played?: PlayedBucket | 'any_played';
  achievements?: AchBucket | 'has_any';
  lastPlayed?: 'last_2_weeks' | 'last_90_days' | 'over_180_days_ago' | 'never';
  titleContains?: string;
  /** Exact titles to look up (follow-ups about games already mentioned). */
  titles?: string[];
  tags?: TagQuery;
  /** Profile-based quick chips (the library's Filters row). */
  chips?: TagChip[];
  /**
   * Steam user tags the game must carry (any of them, case-insensitive substring; longer names also
   * ignore spaces and hyphens, so Steam's "Roguelite" meets EGS's "Rogue-Lite"): "VR", "Anime", "Pixel Graphics"…
   */
  steamTags?: string[];
  sort?: 'playtime' | 'recent' | 'alpha' | 'random' | 'achievements';
  limit?: number;
}

/** Does this filter need achievement progress (a batched Steam call) to be evaluated? */
export const needsProgress = (a: FindArgs): boolean => !!a.achievements || a.sort === 'achievements';
/** Does this filter need Steam store tags (batched store metadata)? */
export const needsStoreTags = (a: FindArgs): boolean => Array.isArray(a.steamTags) && a.steamTags.length > 0;

/** Tag values the model asked for that are not in the vocabularies (so the caller can say so instead of silently ignoring them). */
export function droppedTagValues(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, vocab] of [['genres', GENRES], ['moods', MOODS], ['modes', MODES]] as const) {
    for (const v of strList(r[key])) if (!(vocab as readonly string[]).includes(slug(v))) out.push(v);
  }
  return out;
}

export const strList = (v: unknown, max = 8): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);
export const slug = (s: string): string => s.toLowerCase().trim().replace(/[\s-]+/g, '_');

/** Only vocabulary values survive: a made-up slug matches nothing instead of "almost" matching. */
export function cleanTags(raw: unknown): TagQuery {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const genres = strList(r.genres).map(slug).filter((g): g is Genre => (GENRES as readonly string[]).includes(g));
  const moods = strList(r.moods).map(slug).filter((m): m is Mood => (MOODS as readonly string[]).includes(m));
  const modes = strList(r.modes).map(slug).filter((m): m is Mode => (MODES as readonly string[]).includes(m));
  const themes = strList(r.themes, 3).map((t) => t.toLowerCase().slice(0, 40));
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  return {
    ...(genres.length ? { genres } : {}),
    ...(moods.length ? { moods } : {}),
    ...(modes.length ? { modes } : {}),
    ...(themes.length ? { themes } : {}),
    ...(n(r.maxLengthHours) !== undefined ? { maxLengthHours: n(r.maxLengthHours) } : {}),
    ...(n(r.minLengthHours) !== undefined ? { minLengthHours: n(r.minLengthHours) } : {}),
  };
}

export const tagsEmpty = (q: TagQuery): boolean => !q.genres && !q.moods && !q.modes && !q.themes && q.maxLengthHours === undefined && q.minLengthHours === undefined;

/** Spelling-insensitive form of a tag: "Rogue-Lite" / "Roguelite", "Single Player" / "Singleplayer". */
const squashTag = (s: string): string => s.toLowerCase().replace(/&/g, 'and').replace(/[\s\-_'’.]+/g, '');

/**
 * Does a game tag satisfy a wanted tag? A plain substring first (as always). The squashed form joins
 * words, which would let a short wish match across a word gap ("vr" in "dev resources"), so it is
 * used only for longer wishes.
 */
function tagMatches(have: string, want: string): boolean {
  if (have.toLowerCase().includes(want)) return true;
  const w = squashTag(want);
  return w.length >= 6 && squashTag(have).includes(w);
}

export function applyFind(list: LibGame[], a: FindArgs): LibGame[] {
  const sources = (a.sources ?? []).map((s) => (s === 'EGS' ? 'Epic' : s));
  const tags = cleanTags(a.tags);
  const chips = (a.chips ?? []).filter((c): c is TagChip => typeof c === 'string');
  const steamTags = strList(a.steamTags, 6).map((x) => x.toLowerCase().trim()).filter(Boolean);
  const q = a.titleContains?.toLowerCase().trim();
  const wanted = Array.isArray(a.titles) ? new Set(a.titles.filter((x): x is string => typeof x === 'string').map(normalizeTitle)) : null;
  let out = list.filter((g) => {
    if (wanted && !wanted.has(g.key)) return false;
    if (sources.length && !g.sources.some((s) => sources.includes(s))) return false;
    if (a.installed !== undefined && g.installed !== a.installed) return false;
    if (a.played === 'any_played' ? g.minutes === 0 : a.played && playedBucket(g.minutes) !== a.played) return false;
    if (a.achievements) {
      const b = achBucket(g.progress);
      if (a.achievements === 'has_any' ? !b : b !== a.achievements) return false;
    }
    if (a.lastPlayed) {
      const d = daysSince(g.lastPlayedAt);
      if (a.lastPlayed === 'never' && (d !== null || g.minutes > 0)) return false;
      if (a.lastPlayed === 'last_2_weeks' && (d === null || d > 14)) return false;
      if (a.lastPlayed === 'last_90_days' && (d === null || d > 90)) return false;
      if (a.lastPlayed === 'over_180_days_ago' && d !== null && d < 180) return false;
    }
    if (q && !g.title.toLowerCase().includes(q)) return false;
    // Tag and chip filters need a profile; games without one can't match (the model is told so).
    if (!tagsEmpty(tags) && !(g.profile && g.profile.known && matchProfile(g.profile, tags))) return false;
    if (chips.length && !chips.every((c) => chipMatches(c, g.profile))) return false;
    if (steamTags.length && !steamTags.some((want) => g.storeTags.some((have) => tagMatches(have, want)))) return false;
    return true;
  });
  switch (a.sort) {
    case 'recent':
      out.sort((x, y) => (y.lastPlayedAt ?? '').localeCompare(x.lastPlayedAt ?? ''));
      break;
    case 'alpha':
      out.sort((x, y) => x.title.localeCompare(y.title));
      break;
    case 'achievements':
      out.sort((x, y) => (y.progress?.percentage ?? -1) - (x.progress?.percentage ?? -1));
      break;
    case 'random':
      out = out.map((g) => [Math.random(), g] as const).sort((x, y) => x[0] - y[0]).map(([, g]) => g);
      break;
    default:
      out.sort((x, y) => y.minutes - x.minutes);
  }
  return out;
}
