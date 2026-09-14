import { normalizeTitle } from '@app/shared';
import { getChutesApiKey } from './secretStore';
import { chatJson, parseJson, type ChatMessage } from './aiClient';
import { getEntries, getSteamAccount } from './localData';
import { GENRES, MODES, MOODS, getProfiles, matchProfile, type GameProfile, type Genre, type Mode, type Mood, type TagQuery } from './enrichment';
import { appDetails, appReviewsFacts, findSteamAppId, itemsMeta, storeSearch, wishlistEntries, type GameDetails, type StoreItem } from './steamStore';
import { steamAchievements, steamAchievementsProgress, type SteamAchievementProgress } from './steamSync';
import { scanInstalledSteamAppIds } from './steamScan';
import * as legendary from './legendary';
import { emit } from './events';

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

const MAX_ROUNDS = 3;
const MAX_CALLS_PER_ROUND = 4;
const MAX_HISTORY_TURNS = 10;
const MAX_TURN_CHARS = 1500;
const ANSWER_MAX_TOKENS = 1400;
const MAX_LIST = 40;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

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
  usage: { promptTokens: number; completionTokens: number };
}

export interface AssistantProgress {
  phase: 'thinking' | 'tools' | 'answer';
  tools: string[];
  round: number;
}

// ---------- local views of the library ----------

interface LibGame {
  key: string;
  title: string;
  sources: ('Steam' | 'Epic')[];
  appid: number | null;
  epicAppName: string | null;
  iconUrl: string | null;
  minutes: number;
  minutes2w: number;
  lastPlayedAt: string | null;
  installed: boolean;
  profile: GameProfile | null;
  progress: SteamAchievementProgress | null;
}

async function installedSets(): Promise<{ steam: Set<string>; epic: Set<string> }> {
  const [steam, epic] = await Promise.all([
    Promise.resolve()
      .then(() => scanInstalledSteamAppIds())
      .catch(() => [] as string[]),
    legendary.listInstalled().catch(() => []),
  ]);
  return { steam: new Set(steam.map(String)), epic: new Set(epic.map((g) => g.app_name)) };
}

/** The library as the tools see it: one row per title, both stores merged. */
async function libraryView(withProgress: boolean): Promise<LibGame[]> {
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
      appid: null,
      epicAppName: null,
      iconUrl: null,
      minutes: 0,
      minutes2w: 0,
      lastPlayedAt: null,
      installed: false,
      profile: profiles[key] ?? null,
      progress: null,
    };
    if (!g.sources.includes(e.source)) g.sources.push(e.source);
    g.iconUrl = g.iconUrl ?? e.iconUrl ?? null;
    g.minutes += e.playtimeMinutes ?? 0;
    g.minutes2w += e.playtime2WeeksMinutes ?? 0;
    if (e.lastPlayedAt && (!g.lastPlayedAt || e.lastPlayedAt > g.lastPlayedAt)) g.lastPlayedAt = e.lastPlayedAt;
    if (e.source === 'Steam') {
      g.appid = g.appid ?? (Number(e.externalId) || null);
      if (inst.steam.has(e.externalId)) g.installed = true;
    } else {
      g.epicAppName = g.epicAppName ?? e.appName ?? null;
      if (e.appName && inst.epic.has(e.appName)) g.installed = true;
    }
    byKey.set(key, g);
  }
  const list = [...byKey.values()];
  if (withProgress) {
    const ids = list.map((g) => g.appid).filter((x): x is number => !!x);
    const rows = await steamAchievementsProgress(ids).catch(() => [] as SteamAchievementProgress[]);
    const byId = new Map(rows.map((r) => [r.appId, r]));
    for (const g of list) if (g.appid) g.progress = byId.get(g.appid) ?? null;
  }
  return list;
}

type PlayedBucket = 'never' | '<1h' | '1-10h' | '10-50h' | '50h+';
const playedBucket = (m: number): PlayedBucket => (m === 0 ? 'never' : m < 60 ? '<1h' : m < 600 ? '1-10h' : m < 3000 ? '10-50h' : '50h+');
type AchBucket = 'none' | 'started' | 'half' | 'almost' | 'perfect';
const achBucket = (p: SteamAchievementProgress | null): AchBucket | null =>
  !p || p.total === 0 ? null : p.allUnlocked ? 'perfect' : p.percentage >= 80 ? 'almost' : p.percentage >= 40 ? 'half' : p.unlocked > 0 ? 'started' : 'none';
const daysSince = (iso: string | null): number | null => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null);

const hours1 = (m: number): number => Math.round(m / 6) / 10;

/** What a tool says about one game: per-game facts, no account data. */
function describe(g: LibGame): Record<string, unknown> {
  const p = g.profile;
  return {
    title: g.title,
    on: g.sources.map((s) => (s === 'Epic' ? 'EGS' : s)),
    installed: g.installed,
    hoursPlayed: hours1(g.minutes),
    ...(g.lastPlayedAt ? { lastPlayed: g.lastPlayedAt.slice(0, 10) } : {}),
    ...(g.minutes2w > 0 ? { hoursLast2Weeks: hours1(g.minutes2w) } : {}),
    ...(g.progress && g.progress.total > 0 ? { achievements: `${g.progress.unlocked}/${g.progress.total} (${g.progress.percentage}%)` } : {}),
    ...(p && p.known
      ? {
          length: p.endless ? 'endless' : p.lengthHours !== null ? `~${p.lengthHours}h` : null,
          genres: p.genres.slice(0, 4),
          moods: p.moods.slice(0, 4),
          modes: p.modes,
          ...(p.coopPlayers ? { coop: p.coopPlayers } : {}),
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
});

// ---------- tools ----------

interface FindArgs {
  sources?: ('Steam' | 'EGS' | 'Epic')[];
  installed?: boolean;
  played?: PlayedBucket | 'any_played';
  achievements?: AchBucket | 'has_any';
  lastPlayed?: 'last_2_weeks' | 'last_90_days' | 'over_180_days_ago' | 'never';
  titleContains?: string;
  /** Exact titles to look up (follow-ups about games already mentioned). */
  titles?: string[];
  tags?: TagQuery;
  sort?: 'playtime' | 'recent' | 'alpha' | 'random' | 'achievements';
  limit?: number;
}

const strList = (v: unknown, max = 8): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);
const slug = (s: string) => s.toLowerCase().trim().replace(/[\s-]+/g, '_');

/** Only vocabulary values survive: a made-up slug matches nothing instead of "almost" matching. */
function cleanTags(raw: unknown): TagQuery {
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

const tagsEmpty = (q: TagQuery) => !q.genres && !q.moods && !q.modes && !q.themes && q.maxLengthHours === undefined && q.minLengthHours === undefined;

function applyFind(list: LibGame[], a: FindArgs): LibGame[] {
  const sources = (a.sources ?? []).map((s) => (s === 'EGS' ? 'Epic' : s));
  const tags = cleanTags(a.tags);
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
    // Tag filters need a profile; games without one can't match (the model is told so).
    if (!tagsEmpty(tags) && !(g.profile && g.profile.known && matchProfile(g.profile, tags))) return false;
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
    owned: ownedIds.has(it.appid) || ownedKeys.has(normalizeTitle(it.name)),
  };
}

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
  const owned = lib.some((g) => g.appid === appid || g.key === normalizeTitle(d.name));
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
async function runTool(name: string, args: any, lang: string): Promise<ToolRun> {
  const a = args && typeof args === 'object' ? args : {};
  const run: ToolRun = { name, result: null, libraryHits: [], storeIds: [] };
  switch (name) {
    case 'library_find':
    case 'random_pick': {
      const needsProgress = !!a.achievements || a.sort === 'achievements';
      const lib = await libraryView(needsProgress);
      const found = applyFind(lib, { ...a, ...(name === 'random_pick' ? { sort: 'random' } : {}) });
      const limit = Math.min(MAX_LIST, Math.max(1, Number(a.limit) || (name === 'random_pick' ? 3 : 25)));
      const shown = found.slice(0, limit);
      run.libraryHits = shown;
      const unprofiled = !tagsEmpty(cleanTags(a.tags)) ? lib.filter((g) => !g.profile?.known).length : 0;
      run.result = {
        total: found.length,
        shown: shown.length,
        ...(unprofiled ? { note: `${unprofiled} games have no AI profile and cannot match tag filters` } : {}),
        items: shown.map(describe),
      };
      return run;
    }
    case 'game_profile': {
      const lib = await libraryView(true);
      const key = normalizeTitle(String(a.title ?? ''));
      const g = lib.find((x) => x.key === key) ?? lib.find((x) => x.key.includes(key) || key.includes(x.key));
      if (!g) {
        run.result = { owned: false, note: 'not in the library; use store_game_info for store games' };
        return run;
      }
      run.libraryHits = [g];
      run.result = { ...describe(g), owned: true, ...(g.profile?.known ? { summary: g.profile.summary, themes: g.profile.themes } : { note: 'no AI profile for this game yet' }) };
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
      const lib = await libraryView(false);
      const ownedKeys = new Set(lib.map((g) => g.key));
      const ownedIds = new Set(lib.map((g) => g.appid).filter((x): x is number => !!x));
      let list = items.filter((it) => !it.kind || it.kind === 'game').filter((it) => !it.comingSoon);
      if (a.onSaleOnly) list = list.filter((it) => (it.price?.discountPct ?? 0) > 0);
      list = list.slice(0, Math.min(12, Math.max(1, Number(a.limit) || 8)));
      run.storeIds = list.map((it) => it.appid);
      run.result = { items: list.map((it) => describeStore(it, ownedKeys, ownedIds)) };
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

const SYSTEM = `You are the assistant inside a desktop game-library app (Steam + Epic Games Store). You help the user decide what to play, what to finish or drop, what to buy, and you answer questions about their library. You cannot see the user's data directly: you call TOOLS, the app runs them locally and returns games with facts (hours, last played, achievements, installed, AI profiles). For totals ("how many hours in all"), fetch with library_find sort "playtime", limit 40, and say the sum covers the listed games. Ground every claim in tool results; never invent what the user owns or played.

TOOLS (call with {"calls":[{"tool":name,"args":{...}}]}, up to ${MAX_CALLS_PER_ROUND} per round, ${MAX_ROUNDS} rounds max):
- library_find {sources?: ["Steam"|"EGS"], installed?: bool, played?: "never"|"<1h"|"1-10h"|"10-50h"|"50h+"|"any_played", achievements?: "none"|"started"|"half"|"almost"|"perfect"|"has_any", lastPlayed?: "last_2_weeks"|"last_90_days"|"over_180_days_ago"|"never", titleContains?: string, titles?: [exact titles — for follow-ups about games already listed, ONE call], tags?: {genres?: [..], moods?: [..], modes?: [..], themes?: [..], maxLengthHours?: n, minLengthHours?: n}, sort?: "playtime"|"recent"|"alpha"|"random"|"achievements", limit?: n≤${MAX_LIST}} → owned games matching ALL given conditions, with facts: hours played, last played date, hours in the last 2 weeks, achievements unlocked/total, installed, AI profile (length/genres/moods/modes).
- random_pick {same filters, limit?: n} → a few random owned games from the filtered pool.
- game_profile {title} → the AI profile + facts of ONE owned game (summary, themes, length, modes, hours, last played, achievements).
- store_search {query, onSaleOnly?: bool, limit?: n} → Steam store games by NAME (title fragments and franchises work; genre words do not), with price, discount, review score, owned flag.
- store_game_info {title | appid} → full store facts for one game: price, discount, release, genres, tags, metacritic, review score + positive %, RECENT (30-day sample) reviews %, current players, a few review snippets, similar games the user already owns.
- wishlist {onSaleOnly?: bool} → the user's Steam wishlist with prices and discounts.
- achievements {title} → progress and the remaining achievements of one owned Steam game, easiest first.

Tag vocabularies for library_find.tags — use ONLY these values:
GENRES: {{genres}}
MOODS: {{moods}}
MODES: {{modes}}

HOW TO WORK
- Think about what data answers the question, call the needed tools (several at once when independent), then answer. Follow-up about games you already listed ("which of those are installed?") = ONE library_find with titles: [...], never one call per game. Prefer tags over guessing: "cozy" → moods ["cozy","relaxing"]; "short" → maxLengthHours 6; "co-op" → modes ["coop_local","coop_online"]; "what to finish" → achievements "almost" or played "10-50h" + lastPlayed "over_180_days_ago".
- "Is X worth buying": call store_game_info, then weigh: overall vs RECENT review %, review count, price and discount, current players (dead multiplayer = risk), release date, and whether the user already owns similar games (from similarOwned) they never played. Give a clear verdict: buy now / wait for a sale / skip / you already own similar unplayed games.
- Recommend 2–5 concrete games with a one-line reason each, not long lists, unless the user asks for a list. Titles must come from tool results (or be well-known store games when the user asks for new ones).
- Be honest about gaps: no AI profiles → say tag filters could not be applied; Steam not signed in → say so.

FINAL ANSWER format (JSON only):
{"answer": "markdown text in the user's language; short paragraphs or bullets; bold game titles with **Title**",
 "games": [{"title": "exact title from tool results", "note": "why, ≤ 12 words"}],   // 0-8, the games you recommend or discuss
 "suggestions": ["a natural follow-up the user might ask", ...]}   // 0-3, in the user's language
Either {"calls": [...]} or the final answer object — never both, no prose outside JSON.`;

const systemPrompt = (lang: string, libSize: number, profiled: number, steamSignedIn: boolean): string =>
  SYSTEM.replace('{{genres}}', GENRES.join(', ')).replace('{{moods}}', MOODS.join(', ')).replace('{{modes}}', MODES.join(', ')) +
  `\n\nContext: user language ${lang === 'ru' ? 'Russian' : 'English'}; today ${new Date().toISOString().slice(0, 10)}; library ≈ ${libSize} games, ${profiled} of them with AI profiles; Steam ${steamSignedIn ? 'signed in' : 'NOT signed in (wishlist/achievements unavailable)'}.`;

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const compact = (v: unknown, max = 9000): string => trim(JSON.stringify(v), max);

// ---------- the turn ----------

export async function assistantChat(history: ChatTurn[], lang: string): Promise<AssistantReply> {
  if (!getChutesApiKey()) throw new Error('AI_NO_KEY');
  const turns = history
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: trim(t.content.trim(), MAX_TURN_CHARS) }));
  if (!turns.length || turns[turns.length - 1].role !== 'user') throw new Error('AI_EMPTY');

  const libKeys = new Set(getEntries().map((e) => normalizeTitle(e.title)).filter(Boolean));
  const profiled = Object.values(getProfiles()).filter((p) => p.known).length;
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(lang, libKeys.size, profiled, !!getSteamAccount().steamId) }, ...turns];

  let promptTokens = 0;
  let completionTokens = 0;
  let model = '';
  const toolsUsed: string[] = [];
  const libraryHits = new Map<string, LibGame>();
  const storeIds = new Set<number>();
  let final: any = null;

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    emit('ai:progress', { phase: round === 0 ? 'thinking' : 'answer', tools: toolsUsed, round } satisfies AssistantProgress);
    const forced = round === MAX_ROUNDS;
    const msgs: ChatMessage[] = forced ? [...messages, { role: 'user', content: 'Tool budget exhausted — answer now with what you have, JSON final answer only.' }] : messages;
    const res = await chatJson(msgs, ANSWER_MAX_TOKENS);
    promptTokens += res.promptTokens;
    completionTokens += res.completionTokens;
    model = res.model;
    const parsed = parseJson(res.text);
    const calls: any[] = !forced && Array.isArray(parsed?.calls) ? parsed.calls.slice(0, MAX_CALLS_PER_ROUND) : [];
    if (!calls.length) {
      final = parsed ?? { answer: res.text };
      break;
    }
    const names = calls.map((c) => String(c?.tool ?? '')).filter(Boolean);
    for (const n of names) if (!toolsUsed.includes(n)) toolsUsed.push(n);
    emit('ai:progress', { phase: 'tools', tools: names, round } satisfies AssistantProgress);
    const runs = await Promise.all(calls.map((c) => runTool(String(c?.tool ?? ''), c?.args, lang).catch((e) => ({ name: String(c?.tool), result: { error: e instanceof Error ? e.message : String(e) }, libraryHits: [], storeIds: [] }) as ToolRun)));
    for (const r of runs) {
      for (const g of r.libraryHits) libraryHits.set(g.key, g);
      for (const id of r.storeIds) storeIds.add(id);
    }
    messages.push({ role: 'assistant', content: JSON.stringify({ calls }) });
    messages.push({ role: 'user', content: `Tool results:\n${runs.map((r) => `${r.name}: ${compact(r.result)}`).join('\n')}` });
  }

  // Resolve the games the model names: owned → library card, else store card when the store knows them.
  const answer = typeof final?.answer === 'string' ? final.answer.trim() : typeof final === 'string' ? final : '';
  const rawGames: any[] = Array.isArray(final?.games) ? final.games.slice(0, 8) : [];
  const lib = libraryHits.size ? [...libraryHits.values()] : await libraryView(false);
  const allLib = libraryHits.size ? await libraryView(false) : lib;
  const games: AssistantGame[] = [];
  const storeLookups: { title: string; note: string | null }[] = [];
  for (const g of rawGames) {
    const title = typeof g?.title === 'string' ? g.title.trim() : '';
    if (!title) continue;
    const note = typeof g?.note === 'string' ? trim(g.note.trim(), 120) : null;
    const key = normalizeTitle(title);
    const owned = allLib.find((x) => x.key === key);
    if (owned) games.push(toRef(owned, note));
    else storeLookups.push({ title, note });
  }
  if (storeLookups.length) {
    const known = storeIds.size ? await storeItemsFor([...storeIds], lang) : [];
    for (const s of storeLookups) {
      const k = normalizeTitle(s.title);
      const hit = known.find((it) => normalizeTitle(it.name) === k) ?? null;
      const appid = hit?.appid ?? (await findSteamAppId(s.title, lang).catch(() => null));
      games.push({ title: hit?.name ?? s.title, note: s.note, owned: false, installed: false, appid, epicAppName: null, iconUrl: null });
    }
  }

  return {
    answer,
    games,
    libraryResults: [...libraryHits.values()].slice(0, 60).map((g) => toRef(g)),
    storeResults: [...storeIds].slice(0, 24),
    suggestions: Array.isArray(final?.suggestions) ? final.suggestions.filter((s: unknown): s is string => typeof s === 'string').slice(0, 3).map((s: string) => trim(s, 100)) : [],
    toolsUsed,
    model,
    usage: { promptTokens, completionTokens },
  };
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

const VERDICT_SYSTEM = `You judge whether a Steam game is worth buying for one specific user, from the FACTS given (store data + which similar games the user already owns and how much they played them). Do not invent facts. Address the user directly as "you"; never say "the user". Weigh: overall review % vs recent 30-day % (declining recent = risk, improving = good sign), review volume, price and discount (a deep discount tilts toward "buy", full price toward "wait"), current players (matters for multiplayer only), age. Similar owned-but-unplayed games are a secondary factor: mention them as a note; choose "own_similar" only when they are close substitutes (same genre AND similar mood) and the game itself is not clearly superior. If the user already owns the game, verdict is "already_owned" and the summary says whether it is worth playing now. Output JSON only:
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

