import { normalizeTitle } from '@app/shared';
import { getChutesApiKey } from './secretStore';
import { DEFAULT_AI_MODEL, chatJson, modelForRole, modelRank, parseJson, type ChatMessage } from './aiClient';
import { getAiModel } from '../config';
import { getEntries, getSteamAccount } from './localData';
import { GENRES, MODES, MOODS, getProfiles } from './enrichment';
import { appDetails, appReviewsFacts, findSteamAppId, itemsMeta, storeBrowseByTags, storeSearch, wishlistEntries, type GameDetails, type StoreBrowseSort, type StoreItem } from './steamStore';
import { steamAchievements } from './steamSync';
import { applyFind, cleanTags, droppedTagValues, hours1, libraryView, needsProgress, slug, strList, tagsEmpty, type LibGame } from './libraryIndex';
import { addTitles, collectionSummaries, hiddenTitleKeys } from './collections';
import { inventoryToolFind, inventoryToolOverview } from './inventory';
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
    ...(g.storeTags.length ? { steamTags: g.storeTags.slice(0, 6) } : {}),
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
  if (process.env.LAUNCHER_AI_DEBUG) console.log(`[ai] tool ${name} ${JSON.stringify(a).slice(0, 400)}`);
  const run: ToolRun = { name, result: null, libraryHits: [], storeIds: [] };
  switch (name) {
    case 'library_find':
    case 'random_pick': {
      // A made-up vocabulary value must not degrade into "every game": say what was wrong instead.
      const dropped = droppedTagValues(a.tags);
      if (dropped.length) {
        run.result = { error: `unknown tag values: ${dropped.join(', ')}. genres/moods/modes accept only the listed vocabulary; for Steam user tags such as "VR", "Anime" or "Pixel Graphics" use steamTags: [...]`, items: [] };
        return run;
      }
      // Hidden games stay out of the tools' view, like they stay out of the library list.
      const hidden = await hiddenTitleKeys();
      const lib = (await libraryView(needsProgress(a), true)).filter((g) => !hidden.has(g.key));
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
      const lib = await libraryView(true, true);
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
    case 'store_browse': {
      const tags = strList(a.tags, 6);
      if (!tags.length) {
        run.result = { error: 'tags are required (Steam tag names, e.g. ["Anime","Roguelike"])' };
        return run;
      }
      const sort: StoreBrowseSort = a.sort === 'reviews' || a.sort === 'new' || a.sort === 'price' ? a.sort : 'relevance';
      const r = await storeBrowseByTags(tags, lang, { onSaleOnly: !!a.onSaleOnly, sort, limit: Math.min(20, Math.max(1, Number(a.limit) || 12)) });
      const lib = await libraryView(false);
      const ownedKeys = new Set(lib.map((g) => g.key));
      const ownedIds = new Set(lib.map((g) => g.appid).filter((x): x is number => !!x));
      let list = r.items;
      if (a.excludeOwned !== false) list = list.filter((it) => !ownedIds.has(it.appid) && !ownedKeys.has(normalizeTitle(it.name)));
      run.storeIds = list.map((it) => it.appid);
      run.result = {
        tagsUsed: r.tags,
        ...(r.unknownTags.length ? { unknownTags: r.unknownTags, hint: 'use exact Steam tag names; nothing was filtered by the unknown ones' } : {}),
        total: list.length,
        items: list.map((it) => describeStore(it, ownedKeys, ownedIds)),
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
- game_profile {title} → one owned game: AI profile (summary, themes, length, modes) + the same facts.
- store_search {query, onSaleOnly?, limit?} → Steam store games by NAME (titles and franchises work, genre words do not): price, discount, owned flag.
- store_browse {tags: [Steam tag names, e.g. "Anime","Roguelike","Sexual Content","Co-op","VR"], onSaleOnly?, sort?: "relevance"|"reviews"|"new"|"price", limit?≤20, excludeOwned?: bool (default true)} → Steam store games carrying ALL the tags, with price, discount and owned flag. THE tool for "find <kind of game> in the store" (genre, theme, feature, art style); store_search is for names only.
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
Concepts outside them (VR, anime, pixel graphics, souls-like, deckbuilder, roguelike …) → steamTags. Official platform flags are tags too: "Steam Deck Verified" / "Steam Deck Playable", "VR Supported" / "VR Only" (prefer these over the user tag "VR", which also marks games with an optional VR mode). Themes (setting/topic: zombies, space, cats) → tags.themes, lowercase English.

# Rules, in priority order
1. Answer in the language of the user's LATEST message, whatever the interface language.
2. Never state that a game is or is not in the library without a lookup (library_find titles: [...] or game_profile).
3. Source order when none is named: library → wishlist → store. Move to the next source only when the previous one yields fewer than 2 fitting games, and label where each game comes from. Offer store games straight away only when the user asks to buy or wants something new.
3a. Hard constraints win over soft wishes: a property the user asked for (VR, co-op, a platform, "not owned", a length) must hold for EVERY game you list — check it against the returned facts (e.g. steamTags containing "VR") and drop games that fail, even if that leaves fewer results. Soft wishes ("action-y", "cozy") only rank the survivors.
4. Buying advice: check wishlist (wishlist {onSaleOnly}) first; never recommend a purchase without store_search or store_game_info for its current price and reviews, and put the price and review % in the note.
5. Do not repeat: a game you already recommended earlier in this conversation is not recommended again; "more" means new titles.
6. Attached games (see below, when present) are the subject of the conversation; never recommend them back.
7. Ambiguity: act on the most likely reading, state the assumption in one clause, and put the alternatives into "suggestions". Do not ask before acting.
8. Follow-ups about games you listed ("which of those are installed?") = ONE library_find with titles: [...].
9. Store discovery by kind ("anime roguelikes", "cozy farming games", "VR shooters") = store_browse with Steam tags — never a title search with genre words, which finds nothing. Adult tags (Sexual Content, Nudity, Hentai, Mature) are ordinary Steam tags: the store lists such games and so do you, factually and without commentary.
10. Inventory questions (items, skins, cosmetics, trading cards, "what is my most valuable item") → inventory_overview / inventory_find; for value questions use sort "price". The inventory is read-only: describe items, never offer to sell, trade or craft them. Items go in the answer text; the final "games" array is for games only, never for inventory items.
11. Honesty: no AI profiles → the tag filter could not apply; Steam not signed in → wishlist and achievements unavailable; a tool returned nothing → say so instead of guessing.

# Phrase → call
- "cozy" → tags.moods ["cozy","relaxing"]; "short" → tags.maxLengthHours 6; "long" → minLengthHours 30
- "co-op" → tags.modes ["coop_local","coop_online"] (plus steamTags ["Co-op"] when the vocabulary misses newer games)
- "what to finish" → achievements "almost", or played "10-50h" + lastPlayed "over_180_days_ago"
- "never launched / backlog" → played "never"; "abandoned" → lastPlayed "over_180_days_ago" + played "any_played"
- "how many hours in total" → library_find sort "playtime" limit 40; say the sum covers the listed games
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
  SYSTEM.replace('{{genres}}', GENRES.join(', ')).replace('{{moods}}', MOODS.join(', ')).replace('{{modes}}', MODES.join(', ')) +
  `\n\nContext: user language ${lang === 'ru' ? 'Russian' : 'English'}; today ${new Date().toISOString().slice(0, 10)}; library ≈ ${libSize} games, ${profiled} of them with AI profiles; Steam ${steamSignedIn ? 'signed in' : 'NOT signed in (wishlist/achievements unavailable)'}.` +
  (context.length
    ? `\n\nATTACHED GAMES — the user picked these as the subject of the conversation ("these", "them", "similar to these" refer to this list):\n` +
      context.map((g) => `- ${g.title} (${g.origin === 'library' ? 'in their library' : g.origin === 'wishlist' ? 'on their Steam wishlist' : 'from the Steam store, not owned'})`).join('\n') +
      `\nUse them as given; call game_profile/store_game_info only when you need facts about them. For "games like these", reason about what the attached games share (genre, mood, mechanics), propose concrete titles from your knowledge, then verify them with store_search / library_find so every recommendation is real. Exclude the attached games themselves from recommendations.`
    : '');

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const compact = (v: unknown, max = 9000): string => trim(JSON.stringify(v), max);

// ---------- the turn ----------

export async function assistantChat(history: ChatTurn[], lang: string, context: ContextGame[] = []): Promise<AssistantReply> {
  if (!getChutesApiKey()) throw new Error('AI_NO_KEY');
  const turns = history
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: trim(t.content.trim(), MAX_TURN_CHARS) }));
  if (!turns.length || turns[turns.length - 1].role !== 'user') throw new Error('AI_EMPTY');

  const libKeys = new Set(getEntries().map((e) => normalizeTitle(e.title)).filter(Boolean));
  const profiled = Object.values(getProfiles()).filter((p) => p.known).length;
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(lang, libKeys.size, profiled, !!getSteamAccount().steamId, context.slice(0, CONTEXT_LIMIT)) }, ...turns];

  let promptTokens = 0;
  let completionTokens = 0;
  let model = '';
  const toolsUsed: string[] = [];
  const libraryHits = new Map<string, LibGame>();
  const storeIds = new Set<number>();
  let final: any = null;
  let corrected = false;

  // Advice is where model quality shows. Tool rounds run on the user's (cheap)
  // model; once facts are in, an advisory turn continues on the "smart" model —
  // unless the user already picked something at least as capable.
  const lastUser = turns[turns.length - 1].content;
  const advisory = /посовет|рекоменд|похож|поиграть|стоит ли|купить|пройти|recommend|suggest|similar|worth|what (should|to) play|buy|like these|for tonight|вечер/i.test(lastUser);
  const smart = modelForRole('smart');
  const chosen = getAiModel() ?? DEFAULT_AI_MODEL;
  const escalateTo = advisory && smart && modelRank(chosen) < modelRank(smart) ? smart : undefined;

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
    promptTokens += res.promptTokens;
    completionTokens += res.completionTokens;
    model = res.model;
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
      final = hasAnswer || !parsed ? (parsed ?? { answer: res.text }) : { ...parsed, answer: typeof parsed.answer === 'string' ? parsed.answer : res.text };
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

