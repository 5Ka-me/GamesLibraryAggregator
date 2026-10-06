import { normalizeTitle } from '@app/shared';
import { getStoreCacheTtlMs } from '../config';
import { cached } from './cache';
import { BROWSER_UA, httpFetch, httpJson } from './http';
import { getRegions } from './regions';
import { META_VERSION, TAG_SYNONYMS, findSteamAppId, itemsMeta, storeSearch, tagNames, type StoreBrowseSort, type StoreItem } from './steamStore';
import { resolveTagsWithin, scoreTexts, type TagResolution } from './embeddings';
import { getFactCard } from './gameFacts';
import { libraryView, ownedSteamAppids, type LibGame } from './libraryIndex';

// Store discovery for the assistant: "games like Hades", "a cozy farming sim
// under $20", "roguelikes but not horror". Candidates come from Steam's own
// "More like this" lists of the reference games (Valve's co-play based
// similarity is far better than anything we could infer from tags), or from
// Steam's tag search when there are no references. Everything is then
// hydrated through the cached batch metadata, filtered by hard constraints
// (required/excluded tags, price, sale, ownership) and ranked by soft tags,
// review quality and — when a free description is given — embedding
// similarity. Only public store data and the wanted phrases leave the machine.

// Cache namespace (userData/cache/similar.json).
const NS = 'similar';
/** "More like this" lists change slowly; a week keeps a reference game to one fetch per week. */
const MORELIKE_TTL_MS = 7 * 24 * 3600_000;
/** The page is ~160 KB of HTML and Steam is sometimes slow to render it. */
const MORELIKE_TIMEOUT_MS = 20_000;
/** Same cookies storeBrowseByTags sends, so age-gated games are not silently dropped. */
const MATURE_COOKIE = 'birthtime=0; wants_mature_content=1; lastagecheckage=1-0-1990';

/** Section weights: released similar games matter most; coming-soon games can't be bought or played. */
const SECTION_WEIGHT: Record<string, number> = { released: 1, topselling: 0.8, newreleases: 0.6, comingsoon: 0 };
/** Section markers in document order on the "More like this" page. */
const SECTION_RE = /\sid="(released|comingsoon|newreleases|topselling)"/g;
// Bundles/packages carry comma-separated appid lists; requiring the closing
// quote right after the digits keeps only single apps.
const APPID_RE = /data-ds-appid="(\d+)"/g;

/** Reference games per call: the assistant's pipeline starts from the user's references plus well-known
 *  examples of the kind. Pages are cached for a week and fetched at most MORELIKE_CONCURRENCY at a time. */
const MAX_REFS = 6;
const MORELIKE_CONCURRENCY = 3;
const MAX_META_IDS = 120;
const BROWSE_LIMIT = 40;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 20;
/** Ranking weights (step 4 of the spec): soft tag coverage, review quality, semantic blend. */
const SOFT_TAG_WEIGHT = 0.15;
const REVIEW_WEIGHT = 0.1;
const SEMANTIC_WEIGHT = 0.4;
/** Only the best prelim candidates are embedded — keeps scoreTexts to one or two requests. */
const SEMANTIC_POOL_MIN = 36;
/** Browse-only candidates next to reference lists rank below most "similar to" hits. */
const SUPPLEMENT_FACTOR = 0.3;
/** A relaxed (fewer-tags) search is a weaker signal than the strict one. */
const RELAXED_FACTOR = 0.7;
/**
 * Upper bound for each embedding call (tag resolver, semantic re-rank). Both are optional refinements
 * with a fallback, and an endpoint that stalls instead of failing would otherwise cost about two
 * minutes per call (60 s request timeout plus a retry) while the chat shows "Checking…".
 */
const EMBED_DEADLINE_MS = 15_000;
/** Steam's price stops per currency change only when Valve reprices a region. */
const PRICE_STOPS_TTL_MS = 30 * 24 * 3600_000;

/**
 * Official platform flags that also satisfy a wish: a game flagged "VR Only" is a VR game even when
 * players never voted the "VR" user tag; "Steam Deck Verified" is better than merely "Playable".
 */
const TAG_EQUIV: Record<string, string[]> = {
  vr: ['VR Only', 'VR Supported'],
  'vr supported': ['VR Only'],
  'steam deck playable': ['Steam Deck Verified'],
};

/**
 * Platform flags are not Steam tag ids, so the tag search cannot browse by them: VR flags browse by the
 * "VR" user tag instead, Steam Deck flags through the search's own Deck filter (null here, see
 * deckLevels). The metadata filter still enforces the flag.
 */
const BROWSE_STANDIN: Record<string, string | null> = {
  'vr only': 'VR',
  'vr supported': 'VR',
  'steam deck verified': null,
  'steam deck playable': null,
  'steam deck unsupported': null,
};
/** The flags above in their canonical spelling (GetTagList lacks them; itemsMeta adds them as tags). */
const PLATFORM_FLAGS = ['Steam Deck Verified', 'Steam Deck Playable', 'Steam Deck Unsupported', 'VR Supported', 'VR Only'];
const browseName = (name: string): string | null => {
  const k = name.toLowerCase();
  return k in BROWSE_STANDIN ? BROWSE_STANDIN[k] : name;
};
/** Steam tag ids to search by (Steam ANDs them, so at most four). */
const browseIds = (groups: TagGroup[], lookup: TagLookup): string[] =>
  [
    ...new Set(
      groups
        .map((g) => browseName(g.names[0]))
        .map((n) => (n ? lookup(n)?.id : undefined))
        .filter((id): id is string => !!id)
    ),
  ].slice(0, 4);

/**
 * The search's `deck_compatibility` values (verified live: 3 lists only Verified games, 2 only Playable
 * ones — so a Playable wish searches both).
 */
const DECK_LEVEL: Record<string, number> = { 'steam deck verified': 3, 'steam deck playable': 2 };

/**
 * Deck levels to search when a required group is satisfied by Steam Deck flags alone ("Playable" also
 * accepts Verified → [3, 2]; "Verified" → [3]); several such groups intersect. Null without one.
 */
function deckLevels(required: TagGroup[]): number[] | null {
  let levels: number[] | null = null;
  for (const g of required) {
    const accept = [...g.accept];
    if (g.literal || !accept.length || !accept.every((t) => t in DECK_LEVEL)) continue;
    const mine = [...new Set(accept.map((t) => DECK_LEVEL[t]))].sort((a, b) => b - a);
    levels = levels ? levels.filter((l) => mine.includes(l)) : mine;
  }
  return levels && levels.length ? levels : null;
}

// Epic sells "Tomb Raider GAME OF THE YEAR EDITION", Steam "Tomb Raider": an edition suffix on a
// normalized title is the same game (close to the list gameFacts uses for twins). Sequels,
// remasters and subtitles are not stripped — hiding a game that isn't owned is worse than the miss.
const EDITION_SUFFIX_RE =
  /(?:(?:standard|ultimate|definitive|deluxe|digitaldeluxe|complete|gold|premium|enhanced|special|legendary|anniversary|collectors|gameoftheyear|goty)edition|gameoftheyear|goty|directorscut)$/;
/** A normalized title without a trailing edition suffix (unchanged when there is none or too little is left). */
function editionBase(key: string): string {
  const base = key.replace(EDITION_SUFFIX_RE, '');
  return base.length >= 3 ? base : key;
}

/** storeSearch hits that are clearly not the game itself (the loose title match must not pick these). */
const NON_GAME_RE = /\b(soundtrack|ost|dlc|season pass|art ?book|demo|playtest|dedicated server|sdk|expansion pass)\b/i;

// ===================== More like this =====================

/**
 * Steam's "More like this" list for one app: appids with a 0..1 weight (section weight × rank decay),
 * reference appid removed, coming-soon section ignored. Cached in cache NS 'similar' for 7 days
 * (key `morelike:<appid>`); [] cached for a page without results; transient errors throw (not cached).
 */
export async function moreLikeThis(appid: number): Promise<{ appid: number; w: number }[]> {
  if (!Number.isInteger(appid) || appid <= 0) return [];
  return cached(NS, `morelike:${appid}`, MORELIKE_TTL_MS, async () => {
    const res = await httpFetch(`https://store.steampowered.com/recommended/morelike/app/${appid}/`, {
      timeoutMs: MORELIKE_TIMEOUT_MS,
      headers: { 'User-Agent': BROWSER_UA, Cookie: MATURE_COOKIE },
    });
    if (res.redirected && !/\/morelike\/app\/\d+/.test(res.url)) {
      // Unknown apps, DLC and soundtracks redirect to the personal /recommended/ page, whose
      // appids are not "like this" at all — a legit empty answer. Any other redirect (age check,
      // login wall) is unexpected and must not be cached as "no similar games".
      if (/\/recommended\/?(?:[?#].*)?$/.test(res.url)) return [];
      throw new Error('Request failed: unexpected redirect');
    }
    return parseMoreLike(await res.text(), appid);
  });
}

/** Splits the page into its sections and weights each listed app by section and position. */
function parseMoreLike(html: string, ref: number): { appid: number; w: number }[] {
  const ids: { at: number; id: number }[] = [];
  for (const m of html.matchAll(APPID_RE)) ids.push({ at: m.index ?? 0, id: Number(m[1]) });
  const marks: { at: number; name: string }[] = [];
  for (const m of html.matchAll(SECTION_RE)) marks.push({ at: m.index ?? 0, name: m[1] });
  marks.sort((a, b) => a.at - b.at);

  let sections: { name: string; ids: number[] }[];
  if (marks.length) {
    // Everything before the first marker is the reference game's own capsule.
    sections = marks.map((mk, i) => {
      const end = marks[i + 1]?.at ?? Infinity;
      return { name: mk.name, ids: ids.filter((x) => x.at > mk.at && x.at < end).map((x) => x.id) };
    });
  } else {
    // Layout changed: the first capsule is still the reference, the rest is what Steam suggests.
    // A page with no markers and nothing to suggest is not a page we understand — throw so it is
    // retried later instead of caching "no similar games" for a week.
    if (ids.length <= 1) throw new Error('Request failed: unrecognized page');
    sections = [{ name: 'released', ids: ids.slice(1).map((x) => x.id) }];
  }

  const best = new Map<number, number>();
  for (const s of sections) {
    const weight = SECTION_WEIGHT[s.name] ?? 0;
    if (!weight) continue;
    const list = [...new Set(s.ids.filter((id) => id > 0 && id !== ref))];
    list.forEach((id, rank) => {
      const w = round3(weight * (1 - (0.5 * rank) / list.length));
      if (w > (best.get(id) ?? 0)) best.set(id, w);
    });
  }
  return [...best].map(([appid, w]) => ({ appid, w })).sort((a, b) => b.w - a.w);
}

// ===================== Discovery =====================

export interface DiscoverArgs {
  /** Reference games by title (owned or not) — "like Hades". */
  similarTo?: string[];
  /** Soft tag wishes (any language/phrasing; resolved through resolveTags). Boost only. */
  tags?: string[];
  /** Hard tags every result must carry (resolved to exact names first). */
  requireTags?: string[];
  /** Tags no result may carry (resolved). */
  excludeTags?: string[];
  /** Free description; used for semantic re-ranking (scoreTexts) and, without refs/tags, resolved to tags. */
  query?: string;
  onSaleOnly?: boolean;
  /** In the store currency's major units (e.g. 20 = $20 / 20 zł). */
  maxPrice?: number;
  excludeOwned?: boolean; // default true
  /** Titles/appids to leave out (attached games, earlier recommendations). */
  excludeTitles?: string[];
  limit?: number; // default 12, max 20
}

export interface DiscoverItem {
  item: StoreItem; // from itemsMeta (price, tags, reviewPct …)
  score: number;
  /** Short English reasons: "similar to Hades, Dead Cells", "tags: Roguelike, Pixel Graphics". */
  why: string[];
}

export interface DiscoverResult {
  items: DiscoverItem[];
  /** Reference games resolved to Steam appids (title as found). */
  refs: { title: string; appid: number }[];
  /** Reference titles that could not be found on Steam. */
  unknownRefs: string[];
  /** Exact Steam tag names used per role. */
  tagsUsed: { soft: string[]; required: string[]; excluded: string[] };
  /**
   * Phrases no tag matched. Soft ones are ignored; required and excluded ones are still enforced, by a
   * literal match (the phrase as a substring of a tag name, English or UI language).
   */
  unknownTags: string[];
}

/** One wished/required/excluded phrase resolved to exact Steam tag names. */
interface TagGroup {
  phrase: string;
  /** Exact Steam tag names, best first (the phrase itself for a literal group). */
  names: string[];
  /** Lowercased names plus platform-flag equivalents — what counts as "carries it". */
  accept: Set<string>;
  /**
   * A required/excluded phrase no tag matched: enforced as a substring of the game's tag names instead of
   * being dropped, so "require anime" never silently turns into "anything goes".
   */
  literal?: boolean;
}

interface Candidate {
  score: number;
  /** Indexes into `refs` of the reference games whose lists contained it. */
  refs: Set<number>;
}

/** Hard constraints Steam's search can apply itself, before the top hits are taken. */
interface SearchFilters {
  onSaleOnly: boolean;
  /** Price cap in the store currency's major units; 0 = free only; null = any price. */
  maxPrice: number | null;
  /** Steam Deck levels to search (results merged); null = no Deck filter. */
  deck: number[] | null;
}

/**
 * Normalized owned titles plus their edition-less forms, for the title half of the ownership check
 * (games without a Steam twin card). Look a store title up with ownsTitle.
 */
export function ownedTitleKeys(lib: Pick<LibGame, 'key'>[]): Set<string> {
  const out = new Set<string>();
  for (const g of lib) {
    out.add(g.key);
    out.add(editionBase(g.key));
  }
  return out;
}

/** True when a normalized store title is owned, with or without an edition suffix on either side. */
export const ownsTitle = (owned: Set<string>, key: string): boolean => owned.has(key) || owned.has(editionBase(key));

/**
 * Finds store games for a wish: Steam's "More like this" lists of the reference games (or Steam's tag
 * search without references), hydrated through itemsMeta, filtered by the hard constraints and ranked
 * by soft tags, reviews and (with a query) embedding similarity. Never throws for store or embedding
 * failures — the parts that worked still produce results.
 */
export async function storeDiscover(args: DiscoverArgs, lang: string): Promise<DiscoverResult> {
  const similarTo = cleanList(args.similarTo, MAX_REFS, normalizeTitle);
  const softPhrases = cleanList(args.tags, 8);
  const requirePhrases = cleanList(args.requireTags, 6);
  const excludePhrases = cleanList(args.excludeTags, 8);
  const query = typeof args.query === 'string' ? args.query.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit) || DEFAULT_LIMIT)));
  const excludeOwned = args.excludeOwned !== false;
  const maxPrice = typeof args.maxPrice === 'number' && Number.isFinite(args.maxPrice) && args.maxPrice >= 0 ? args.maxPrice : null;
  const onSaleOnly = args.onSaleOnly === true;

  // ---- 1. owned sets, references, tag phrases (independent → parallel) ----
  const lib = await libraryView(false).catch(() => [] as LibGame[]);
  const libByKey = new Map(lib.map((g) => [g.key, g]));
  const ownedKeys = ownedTitleKeys(lib);
  const ownedAppids = ownedSteamAppids(lib);

  const [refRows, resolved, toEnglish, lookup] = await Promise.all([
    mapPool(similarTo, MORELIKE_CONCURRENCY, (t) => resolveRef(t, libByKey, lang).catch(() => null)),
    resolvePhrases([...softPhrases, ...requirePhrases, ...excludePhrases]),
    englishTagMapper(lang),
    tagLookup(),
  ]);

  const refs: { title: string; appid: number }[] = [];
  const unknownRefs: string[] = [];
  refRows.forEach((r, i) => {
    if (!r) unknownRefs.push(similarTo[i]);
    else if (!refs.some((x) => x.appid === r.appid)) refs.push(r);
  });

  const unknownTags: string[] = [];
  const groupsFor = (phrases: string[], top: number, hard: boolean): TagGroup[] =>
    phrases.flatMap((phrase) => {
      const names = uniq((resolved.get(phrase.toLowerCase())?.tags ?? []).slice(0, top).map((t) => t.name).filter(Boolean));
      if (!names.length) {
        if (!unknownTags.some((u) => u.toLowerCase() === phrase.toLowerCase())) unknownTags.push(phrase);
        // A wish can be dropped; a hard constraint is enforced literally rather than not at all.
        return hard ? [literalGroup(phrase)] : [];
      }
      return [tagGroup(phrase, names)];
    });
  // Required tags stay narrow (an OR of two near-identical tags at most); exclusions cast wider so
  // "no horror" also drops "Psychological Horror".
  const soft = groupsFor(softPhrases, 2, false);
  const required = groupsFor(requirePhrases, 2, true);
  const excluded = groupsFor(excludePhrases, 3, true);

  // ---- 2. candidates ----
  // Price, sale and Steam Deck go to Steam's search too: filtering only after the top 40 hits are
  // taken leaves "free co-op games" with the few free titles that happen to rank there.
  const filters: SearchFilters = { onSaleOnly, maxPrice, deck: deckLevels(required) };
  const requiredIds = browseIds(required, lookup);
  const cands = new Map<number, Candidate>();
  const add = (appid: number, score: number, refIndex?: number): void => {
    const c = cands.get(appid) ?? { score: 0, refs: new Set<number>() };
    if (refIndex === undefined) c.score = Math.max(c.score, score);
    else {
      c.score += score;
      c.refs.add(refIndex);
    }
    cands.set(appid, c);
  };

  if (refs.length) {
    const [lists, supplement] = await Promise.all([
      mapPool(refs, MORELIKE_CONCURRENCY, (r) => moreLikeThis(r.appid).catch(() => null)),
      // A "like Hades" list rarely survives a hard tag such as VR; a tag search for the required
      // tags tops it up so the hard constraint doesn't leave the answer empty.
      requiredIds.length ? browseCandidates(requiredIds, ['relevance'], filters) : Promise.resolve(new Map<number, number>()),
    ]);
    // Averaging over the refs that answered keeps the base on the same 0..1 scale as the browse
    // path (so the tag/review boosts weigh the same) while games similar to several refs still win.
    const answered = Math.max(1, lists.filter((l) => l && l.length).length);
    lists.forEach((list, i) => {
      for (const { appid, w } of list ?? []) add(appid, w / answered, i);
    });
    // Scaled the same way, so with five references the generic fillers don't outrank games Steam
    // lists as similar to one of them.
    if (cands.size) for (const [appid, s] of supplement) if (!cands.has(appid)) add(appid, (s * SUPPLEMENT_FACTOR) / answered);
  }
  if (!cands.size) {
    // A bare description ("something relaxing with farming") still needs tags to search the store by —
    // also next to constraints the search can't browse by tag (a Steam Deck flag, an unknown phrase).
    if (!browseIds([...required, ...soft], lookup).length && query) {
      const fromQuery = (await resolvePhrases([query])).get(query.toLowerCase())?.tags ?? [];
      for (const t of fromQuery.slice(0, 2)) if (t.name) soft.push(tagGroup(query, [t.name]));
    }
    const browseTags = browseIds([...required, ...soft], lookup);
    // With no tag at all, the search's own filters ("Deck Verified", "free", "on sale") still narrow it.
    if (browseTags.length || hasSearchFilter(filters)) {
      const strict = await browseCandidates(browseTags, ['relevance', 'reviews'], filters);
      for (const [appid, s] of strict) add(appid, s);
      // Steam ANDs search tags; four of them can leave almost nothing. One relaxed search by the
      // first (required, if any) tag still respects the hard filters, which run on metadata below.
      if (cands.size < limit * 2 && browseTags.length > 1) {
        const relaxed = await browseCandidates(browseTags.slice(0, 1), ['reviews'], filters);
        for (const [appid, s] of relaxed) add(appid, s * RELAXED_FACTOR);
      }
    }
  }

  // Literal groups carry the phrase, not a Steam tag name; they are reported in unknownTags.
  const tagsUsed = {
    soft: uniq(soft.flatMap((g) => g.names)),
    required: uniq(required.filter((g) => !g.literal).flatMap((g) => g.names)),
    excluded: uniq(excluded.filter((g) => !g.literal).flatMap((g) => g.names)),
  };
  const empty: DiscoverResult = { items: [], refs, unknownRefs, tagsUsed, unknownTags };
  if (!cands.size) return empty;

  // ---- 3. metadata + hard filters ----
  const { appids: excludedAppids, keys: excludedKeys } = parseExclusions(args.excludeTitles);
  for (const r of refs) {
    excludedAppids.add(r.appid);
    excludedKeys.add(normalizeTitle(r.title));
  }
  const ids = [...cands]
    .filter(([appid]) => !excludedAppids.has(appid) && !(excludeOwned && ownedAppids.has(appid)))
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, MAX_META_IDS)
    .map(([appid]) => appid);
  if (!ids.length) return empty;

  const meta = await itemsMeta(ids, lang).catch(() => ({}) as Record<number, StoreItem>);
  // Metadata cached before review stats were recorded would rank every game as unreviewed; refresh
  // those once (later calls see the current layout from the cache).
  const outdated = ids.filter((id) => meta[id] && meta[id].metaV !== META_VERSION);
  if (outdated.length) Object.assign(meta, await itemsMeta(outdated, lang, true).catch(() => ({})));

  interface Ranked {
    item: StoreItem;
    /** English tag names. */
    tags: string[];
    /** The same tags as itemsMeta gave them (UI language), index for index. */
    raw: string[];
    cand: Candidate;
    score: number;
  }
  const ranked: Ranked[] = [];
  const seenNames = new Set<string>();
  for (const appid of ids) {
    const item = meta[appid];
    if (!item) continue;
    if (item.kind && item.kind !== 'game') continue;
    if (item.comingSoon) continue;
    const key = normalizeTitle(item.name);
    if (excludedKeys.has(key)) continue;
    if (excludeOwned && (ownedAppids.has(appid) || ownsTitle(ownedKeys, key))) continue;
    const raw = item.tags ?? [];
    const tags = raw.map(toEnglish);
    if (!required.every((g) => carriedTag(g, tags, raw) !== null)) continue;
    if (excluded.some((g) => carriedTag(g, tags, raw) !== null)) continue;
    if (onSaleOnly && !((item.price?.discountPct ?? 0) > 0)) continue;
    if (maxPrice !== null && !fitsPrice(item, maxPrice)) continue;
    // Steam lists the same game under several SKUs now and then; `ids` is score-ordered, so the
    // first one kept is the better-ranked copy.
    if (seenNames.has(key)) continue;
    seenNames.add(key);

    // ---- 4. ranking ----
    const cand = cands.get(appid)!;
    const softFrac = soft.length ? soft.filter((g) => carriedTag(g, tags, raw) !== null).length / soft.length : 0;
    const score = cand.score + SOFT_TAG_WEIGHT * softFrac + REVIEW_WEIGHT * reviewBoost(item);
    ranked.push({ item, tags, raw, cand, score });
  }
  ranked.sort((a, b) => b.score - a.score);

  let pool = ranked;
  if (query && ranked.length) {
    pool = ranked.slice(0, Math.max(SEMANTIC_POOL_MIN, limit * 3));
    try {
      const sims = await scoreTexts(
        query,
        pool.map((r) => `${r.item.name}. Tags: ${r.tags.slice(0, 12).join(', ')}`),
        { signal: AbortSignal.timeout(EMBED_DEADLINE_MS) }
      );
      if (sims.length === pool.length) {
        pool.forEach((r, i) => {
          const sim = Number.isFinite(sims[i]) ? sims[i] : 0;
          r.score = (1 - SEMANTIC_WEIGHT) * r.score + SEMANTIC_WEIGHT * sim;
        });
        pool.sort((a, b) => b.score - a.score);
      }
    } catch {
      /* no key / embedding endpoint down or too slow — the tag and review ranking stands */
    }
  }

  // ---- 5. reasons ----
  const items: DiscoverItem[] = pool.slice(0, limit).map((r) => {
    const why: string[] = [];
    const refTitles = [...r.cand.refs].sort((a, b) => a - b).map((i) => refs[i]?.title).filter((t): t is string => !!t);
    if (refTitles.length) why.push(`similar to ${refTitles.slice(0, 3).join(', ')}`);
    // Name the tag the game actually carries ("VR Only" rather than the wished "VR").
    const matched = uniq([...required, ...soft].map((g) => carriedTag(g, r.tags, r.raw)).filter((t): t is string => !!t));
    if (matched.length) why.push(`tags: ${matched.slice(0, 5).join(', ')}`);
    return { item: r.item, score: round3(r.score), why };
  });

  return { items, refs, unknownRefs, tagsUsed, unknownTags };
}

// ===================== helpers =====================

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Case-insensitive dedupe that keeps the first spelling. */
function uniq(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Strings only (the args come from model JSON), trimmed, deduped by `keyOf`, capped. */
function cleanList(v: unknown, max: number, keyOf: (s: string) => string = (s) => s.toLowerCase()): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.replace(/\s+/g, ' ').trim().slice(0, 200);
    const k = s ? keyOf(s) : '';
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Excluded titles become normalized keys; bare numbers are taken as appids too. */
function parseExclusions(v: unknown): { appids: Set<number>; keys: Set<string> } {
  const appids = new Set<number>();
  const keys = new Set<string>();
  for (const x of Array.isArray(v) ? v : []) {
    if (typeof x === 'number' && Number.isInteger(x) && x > 0) appids.add(x);
    if (typeof x !== 'string') continue;
    const s = x.trim();
    if (/^\d+$/.test(s)) appids.add(Number(s));
    const k = normalizeTitle(s);
    if (k) keys.add(k);
  }
  return { appids, keys };
}

function tagGroup(phrase: string, names: string[]): TagGroup {
  const accept = new Set<string>();
  for (const n of names) {
    accept.add(n.toLowerCase());
    for (const e of TAG_EQUIV[n.toLowerCase()] ?? []) accept.add(e.toLowerCase());
  }
  return { phrase, names, accept };
}

function literalGroup(phrase: string): TagGroup {
  return { phrase, names: [phrase], accept: new Set([phrase.toLowerCase()]), literal: true };
}

/** A literal phrase matches inside a tag name ("horror" in "Psychological Horror"); very short ones only as the whole name. */
const literalHit = (tag: string, phrase: string): boolean => (phrase.length >= 3 ? tag.includes(phrase) : tag === phrase);

/**
 * The tag (English name) by which a game satisfies a group, or null. `tags` are English names, `raw`
 * the same tags in the UI language, index for index: an unresolved literal phrase is usually in the
 * user's language, so it is looked for in both.
 */
function carriedTag(g: TagGroup, tags: string[], raw: string[]): string | null {
  const phrase = g.literal ? g.names[0].toLowerCase() : '';
  for (let i = 0; i < tags.length; i++) {
    const en = tags[i].toLowerCase();
    if (!g.literal) {
      if (g.accept.has(en)) return tags[i];
    } else if (literalHit(en, phrase) || literalHit((raw[i] ?? '').toLowerCase(), phrase)) return tags[i];
  }
  return null;
}

/**
 * Free fits any cap and is all a cap of 0 accepts; otherwise the current price must be known and within
 * the cap. A game with no price in this region (not sold here, no purchase option) can't be shown as
 * "under $20" — or worse, as a free pick. Shared with the pipeline's wishlist/store checks.
 */
export function fitsPrice(item: StoreItem, maxPrice: number): boolean {
  if (item.isFree || item.price?.final === 0) return true;
  const final = item.price?.final;
  return maxPrice > 0 && final != null && final / 100 <= maxPrice;
}

/** 0..1: how well-reviewed the game is, damped for games with only a handful of reviews. */
function reviewBoost(item: StoreItem): number {
  const pct = item.reviewPct ?? null;
  if (pct == null) return 0;
  const tier = pct >= 90 ? 1 : pct >= 80 ? 0.6 : pct >= 70 ? 0.3 : 0;
  const count = Math.max(0, item.reviewCount ?? 0);
  return tier * Math.min(1, Math.log10(count + 1) / 4);
}

/**
 * All phrases resolved in one call (one embedding request for the non-exact ones), keyed by the
 * lowercased phrase. The embedding pass gets EMBED_DEADLINE_MS; past it only exact tag names and
 * synonyms resolve and the rest stays unresolved (hard constraints among them become literal groups in
 * storeDiscover). The local lookup below is a last safety net for an unexpected resolver error.
 */
async function resolvePhrases(phrases: string[]): Promise<Map<string, TagResolution>> {
  const list = uniq(phrases.map((p) => p.trim()).filter(Boolean));
  const out = new Map<string, TagResolution>();
  if (!list.length) return out;
  let res: TagResolution[];
  try {
    res = await resolveTagsWithin(list, EMBED_DEADLINE_MS, { top: 3 });
  } catch {
    const lookup = await tagLookup();
    res = list.map((p) => {
      const name = lookup(p)?.name ?? PLATFORM_FLAGS.find((f) => f.toLowerCase() === p.toLowerCase());
      return name ? { phrase: p, tags: [{ name, score: 1 }], exact: true } : { phrase: p, tags: [], exact: false };
    });
  }
  list.forEach((p, i) => {
    const hit = res.find((r) => r?.phrase?.trim().toLowerCase() === p.toLowerCase()) ?? res[i];
    if (hit) out.set(p.toLowerCase(), hit);
  });
  return out;
}

/**
 * itemsMeta tags are in the UI language (Russian names for 'ru'); filters and reasons work with the
 * English names resolveTags returns, so map them back through the tag ids. Platform-flag tags are
 * always English and pass through unchanged.
 */
async function englishTagMapper(lang: string): Promise<(tag: string) => string> {
  if (lang === 'en') return (t) => t;
  try {
    const [local, en] = await Promise.all([tagNames(lang), tagNames('en')]);
    const map = new Map<string, string>();
    for (const [id, name] of Object.entries(local)) if (en[id] && !map.has(name)) map.set(name, en[id]);
    return (t) => map.get(t) ?? t;
  } catch {
    return (t) => t;
  }
}

/** An English Steam tag name in any spelling storeBrowseByTags accepts → its id and canonical name. */
type TagLookup = (name: string) => { id: string; name: string } | null;

/** Builds the TagLookup from the cached English tag list (exact name, TAG_SYNONYMS, hyphen/space variants). */
async function tagLookup(): Promise<TagLookup> {
  const names = await tagNames('en').catch(() => ({}) as Record<string, string>);
  const byName = new Map<string, { id: string; name: string }>();
  for (const [id, name] of Object.entries(names)) byName.set(name.toLowerCase(), { id, name });
  return (raw) => {
    const w = raw.trim().toLowerCase();
    if (!w) return null;
    return (
      byName.get(w) ??
      byName.get((TAG_SYNONYMS[w] ?? '').toLowerCase()) ??
      byName.get(w.replace(/-/g, ' ')) ??
      byName.get(w.replace(/\s+/g, '-')) ??
      null
    );
  };
}

const hasSearchFilter = (f: SearchFilters): boolean => f.onSaleOnly || f.maxPrice !== null || !!f.deck;

/**
 * Candidate scores from Steam's search: 1 - rank/len, max over the requested sort orders (and Deck
 * levels). Without tags it runs only when a filter narrows it — an unfiltered "all games" list is no
 * answer. A failing search just contributes nothing.
 */
async function browseCandidates(tagIds: string[], sorts: StoreBrowseSort[], f: SearchFilters): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!tagIds.length && !hasSearchFilter(f)) return out;
  const decks: (number | null)[] = f.deck ?? [null];
  const lists = await Promise.all(
    sorts.flatMap((sort) => decks.map((deck) => searchAppids(tagIds, sort, f, deck).catch(() => [] as number[])))
  );
  for (const list of lists) {
    list.forEach((appid, rank) => {
      const s = 1 - rank / list.length;
      if (appid > 0 && s > (out.get(appid) ?? 0)) out.set(appid, s);
    });
  }
  return out;
}

/** Steam search sort parameter per sort order ('' = Steam's relevance). */
const SEARCH_SORT: Record<StoreBrowseSort, string> = { relevance: '', reviews: 'Reviews_DESC', new: 'Released_DESC', price: 'Price_ASC' };

/**
 * One page of the storefront search (the search page in JSON form) as appids: games carrying all
 * `tagIds`, narrowed by sale, price and Steam Deck level. storeBrowseByTags has neither the Deck nor
 * the price filter and needs a tag; metadata is hydrated later for the merged candidates anyway, so
 * only the appids are kept. Same mature-content cookies, so age-gated games are not dropped. Cached
 * like the other store searches.
 */
async function searchAppids(tagIds: string[], sort: StoreBrowseSort, f: SearchFilters, deck: number | null): Promise<number[]> {
  const cc = getRegions().steamCc;
  const price = f.maxPrice === null ? null : f.maxPrice === 0 ? 'free' : await priceStop(cc, f.maxPrice);
  const sortBy = SEARCH_SORT[sort] ?? '';
  const key = `search:${cc}:${tagIds.join(',')}:${f.onSaleOnly ? 1 : 0}:${price ?? ''}:${deck ?? ''}:${sortBy}:${BROWSE_LIMIT}`;
  return cached(NS, key, getStoreCacheTtlMs(), async () => {
    const url =
      `https://store.steampowered.com/search/results/?json=1&category1=998&count=${BROWSE_LIMIT}&start=0&cc=${cc}` +
      (tagIds.length ? `&tags=${tagIds.join(',')}` : '') +
      (f.onSaleOnly ? '&specials=1' : '') +
      (price !== null ? `&maxprice=${price}` : '') +
      (deck ? `&deck_compatibility=${deck}` : '') +
      (sortBy ? `&sort_by=${sortBy}` : '');
    const data = await httpJson<{ items?: { logo?: unknown }[] }>(url, {
      headers: { 'User-Agent': BROWSER_UA, Cookie: MATURE_COOKIE },
    });
    const appids: number[] = [];
    for (const it of Array.isArray(data?.items) ? data.items : []) {
      const m = /\/apps\/(\d+)\//.exec(String(it?.logo ?? ''));
      if (m) appids.push(Number(m[1]));
    }
    return [...new Set(appids)];
  });
}

/**
 * The search's `maxprice` for a cap: Steam honours only its own price stops for the region's currency
 * ("Under $5", "Under 20 zł", "Under 150 RUB" …) and silently ignores any other value, so the cap is
 * rounded up to the next stop (the metadata filter enforces the exact cap). The stops come from the
 * search page; null (no server-side cap) when the cap is above the last stop or the page is unreadable.
 */
async function priceStop(cc: string, cap: number): Promise<number | null> {
  try {
    const stops = await cached(NS, `pricestops:${cc}`, PRICE_STOPS_TTL_MS, async () => {
      const res = await httpFetch(`https://store.steampowered.com/search/?cc=${cc}`, { headers: { 'User-Agent': BROWSER_UA } });
      const m = /rgPriceStopData\s*=\s*(\[[^\]]*\])/.exec(await res.text());
      // Layout change: throw so it is retried later instead of caching "no stops" for a month.
      if (!m) throw new Error('Request failed: no price stops on the search page');
      const list = (JSON.parse(m[1]) as { price?: unknown }[]).map((s) => Number(s?.price)).filter((n) => Number.isFinite(n) && n > 0);
      return [...new Set(list)].sort((a, b) => a - b);
    });
    // Strictly above: whether "Under $20" includes a $20.00 game is Steam's call, the cap's is ours.
    return stops.find((s) => s > cap) ?? null;
  } catch {
    return null;
  }
}

/**
 * A reference title → Steam appid: the library's own Steam copy, the fact card's Steam twin (Epic-only
 * games), an exact store match, else the first store hit whose normalized title contains (or is
 * contained in) the wanted one — "Witcher 3" → "The Witcher 3: Wild Hunt".
 */
async function resolveRef(title: string, libByKey: Map<string, LibGame>, lang: string): Promise<{ title: string; appid: number } | null> {
  const key = normalizeTitle(title);
  if (!key) return null;
  const own = libByKey.get(key);
  if (own?.appid) return { title: own.title, appid: own.appid };
  const name = own?.title ?? title;
  let twin: number | null = null;
  try {
    twin = getFactCard(key)?.appid ?? null;
  } catch {
    twin = null; // fact store unreadable — the store lookups below still work
  }
  if (twin) return { title: name, appid: twin };
  const exact = await findSteamAppId(title, lang).catch(() => null);
  if (exact) return { title: name, appid: exact };
  // Same search findSteamAppId just ran, so this is normally a cache hit.
  const hits = await storeSearch(title, lang).catch(() => [] as StoreItem[]);
  const loose = hits.find((h) => {
    if (!(h.appid > 0) || NON_GAME_RE.test(h.name)) return false;
    const k = normalizeTitle(h.name);
    // Very short keys ("it", "ys") would match half the store.
    return k.length >= 3 && key.length >= 3 && (k.includes(key) || key.includes(k));
  });
  return loose ? { title: loose.name, appid: loose.appid } : null;
}

/** Runs `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
