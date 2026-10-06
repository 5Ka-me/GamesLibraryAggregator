// Steam storefront data for the in-app Store page. All requests run in the
// main process (no CORS). Endpoints are Valve's public-but-undocumented
// storefront APIs — the same ones the Steam site itself uses:
//   - /api/featured + /api/featuredcategories  → front-page sections
//   - /api/storesearch                          → search by title
//   - IWishlistService/GetWishlist              → wishlist appids (public profiles)
//   - IStoreBrowseService/GetItems              → batch name/price/discount for appids
//                                                 (and English descriptions for fact cards)
//   - IStoreBrowseService/GetStoreCategories    → category names (Single-player, Online Co-op, …)
//
// Everything goes through the unified memory+disk cache (services/cache.ts)
// with stale-while-revalidate: priced data uses the "dynamic" TTL
// (LAUNCHER_STORE_CACHE_TTL, default 1 h), the tag list is static (24 h). The
// UI refresh button passes force=true to fetch live. Wishlist metadata is
// fetched lazily in batches driven by the renderer's scroll position, so large
// wishlists don't hammer the API upfront.

import { normalizeTitle } from '@app/shared';
import { getStoreCacheTtlMs } from '../config';
import { cached, cacheGet, cacheSet, cachePurge, TTL_STATIC_MS } from './cache';
import { BROWSER_UA, httpJson } from './http';
import { getRegions } from './regions';

const STORE_API = 'https://store.steampowered.com/api';
const WEB_API = 'https://api.steampowered.com';
const ASSET_CDN = 'https://shared.cloudflare.steamstatic.com/store_item_assets/';

export interface StorePrice {
  currency?: string;
  /** Prices in cents (when known numerically). */
  initial?: number | null;
  final?: number | null;
  discountPct?: number;
  /** Preformatted strings (already localized, currency included). */
  formattedFinal?: string | null;
  formattedOriginal?: string | null;
}

export interface StoreItem {
  appid: number;
  name: string;
  image?: string | null;
  price?: StorePrice | null;
  isFree?: boolean;
  /** External link override (spotlight banners); default is the app page. */
  url?: string;
  /** Promo label overlaid on the image (e.g. "MIDWEEK DEAL"). */
  badge?: string;
  /** Render as a wide banner card instead of a capsule. */
  banner?: boolean;
  /** Unreleased game — the UI shows the release date instead of a price. */
  comingSoon?: boolean;
  /** Steam release date (unix seconds), when known. */
  releaseUnix?: number;
  /** What the app is (GetItems `type`: 0 game, 4 DLC, 11 soundtrack); absent = unknown. */
  kind?: 'game' | 'dlc' | 'music' | 'other';
  /**
   * Steam's user tags ("VR", "Roguelike", …), most voted first, followed by official platform
   * flags expressed as tags: "Steam Deck Verified" / "Steam Deck Playable" / "Steam Deck Unsupported",
   * "VR Supported" / "VR Only". Absent in metadata cached before tags were requested.
   */
  tags?: string[];
  /** Share of positive Steam reviews (0–100, all languages); null when the game has no reviews yet. */
  reviewPct?: number | null;
  /** Number of Steam reviews behind reviewPct. */
  reviewCount?: number | null;
  /** Metadata layout version; the library index refetches once when it sees an older layout. */
  metaV?: number;
}

/** Bumped when fetchMetaChunks starts recording new fields, so cached items get refreshed once. */
export const META_VERSION = 3;

export interface StoreSection {
  id: string;
  /** Section title from Steam (localized); empty for the featured carousel. */
  name: string;
  /** Banner sections (spotlights) have image-only items without prices. */
  banner?: boolean;
  items: StoreItem[];
}

export interface StoreHome {
  sections: StoreSection[];
}

/** A raw wishlist row — cheap to fetch; metadata is hydrated separately. */
export interface WishlistEntry {
  appid: number;
  priority: number;
  /** Unix seconds. */
  dateAdded: number;
}

/** Renderer-side merge of a wishlist entry and its store metadata. */
export type WishlistItem = StoreItem & { priority: number; dateAdded: number };

// Locale follows the UI language; the country (→ currency, regional prices)
// comes from the local Steam account region (fallback US).
function region(lang: string): { l: string; cc: string } {
  return { l: lang === 'ru' ? 'russian' : 'english', cc: getRegions().steamCc };
}

// Cache namespace (userData/cache/steamStore.json).
const NS = 'steamStore';

// ===================== helpers =====================

const getJson = <T,>(url: string): Promise<T> =>
  httpJson<T>(url, { headers: { 'User-Agent': BROWSER_UA } });

/* eslint-disable @typescript-eslint/no-explicit-any */

function discountPct(initial?: number | null, final?: number | null): number | undefined {
  if (initial != null && final != null && initial > final && initial > 0) {
    return Math.round((1 - final / initial) * 100);
  }
  return undefined;
}

// Same key cross-store matching uses everywhere (see @app/shared/matching).
const normName = normalizeTitle;

/**
 * Steam front-page sections repeat the same product as several SKUs (e.g. four
 * "Steam Machine" entries). Collapse exact name+price duplicates; different
 * configurations with different prices stay visible.
 */
function dedupeItems(items: StoreItem[]): StoreItem[] {
  const seen = new Set<string>();
  const out: StoreItem[] = [];
  for (const item of items) {
    const key = `${normName(item.name)}|${item.price?.final ?? item.price?.formattedFinal ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Maps a featured/featuredcategories "capsule" item. */
function mapCapsule(raw: any): StoreItem {
  const hasPrice = raw.final_price != null;
  return {
    appid: raw.id,
    name: raw.name ?? `App ${raw.id}`,
    image: raw.small_capsule_image ?? raw.large_capsule_image ?? raw.header_image ?? null,
    isFree: hasPrice && raw.final_price === 0,
    price: hasPrice
      ? {
          currency: raw.currency,
          initial: raw.original_price ?? null,
          final: raw.final_price,
          discountPct:
            raw.discount_percent > 0
              ? raw.discount_percent
              : discountPct(raw.original_price, raw.final_price),
        }
      : null,
  };
}

/** Capsule image from GetItems assets (exists for virtually every item). */
function assetImage(si: any): string | null {
  const a = si?.assets;
  if (!a?.asset_url_format) return null;
  const file = a.small_capsule ?? a.header ?? a.main_capsule;
  if (!file) return null;
  return ASSET_CDN + String(a.asset_url_format).replace('${FILENAME}', file);
}

/** Fallback image by CDN convention (may 404 for some items — UI has onError). */
export const conventionCapsule = (appid: number): string =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_231x87.jpg`;

/** Server-side sort orders supported by Steam's search (honest across the whole section). */
export type SectionSort = 'default' | 'price_asc' | 'price_desc' | 'release' | 'reviews' | 'name';

const SORT_BY: Record<SectionSort, string | null> = {
  default: null,
  price_asc: 'Price_ASC',
  price_desc: 'Price_DESC',
  release: 'Released_DESC',
  reviews: 'Reviews_DESC',
  name: 'Name_ASC',
};

// ===================== Front page =====================

export async function storeHome(lang: string, force = false): Promise<StoreHome> {
  const { l, cc } = region(lang);
  return cached(NS, `home:${lang}:${cc}`, getStoreCacheTtlMs(), () => fetchHome(l, cc, lang), {
    force,
  });
}

async function fetchHome(l: string, cc: string, lang: string): Promise<StoreHome> {
  // featuredcategories carries most of the page; if IT fails there's nothing
  // to render, so that one is allowed to reject.
  const [featured, cats] = await Promise.all([
    getJson<any>(`${STORE_API}/featured/?l=${l}&cc=${cc}`).catch(() => null),
    getJson<any>(`${STORE_API}/featuredcategories/?l=${l}&cc=${cc}`),
  ]);

  const sections: StoreSection[] = [];

  // Big featured carousel.
  if (featured?.featured_win?.length) {
    sections.push({ id: 'featured', name: '', items: dedupeItems(featured.featured_win.map(mapCapsule)) });
  }

  // Standard sections (names come localized from the API).
  for (const key2 of ['specials', 'top_sellers', 'new_releases', 'coming_soon']) {
    const cat = cats?.[key2];
    if (cat?.items?.length) {
      sections.push({ id: key2, name: cat.name ?? key2, items: dedupeItems(cat.items.map(mapCapsule)) });
    }
  }

  // featuredcategories reports unreleased games with final_price=0 (which
  // mapCapsule reads as "Free") and carries no release dates — enrich the
  // Coming Soon row from GetItems (real is_free + release date, cached).
  const coming = sections.find((s) => s.id === 'coming_soon');
  if (coming) {
    try {
      const meta = await itemsMeta(
        coming.items.filter((i) => i.appid > 0).map((i) => i.appid),
        lang
      );
      coming.items = coming.items.map((it) => {
        const m = meta[it.appid];
        return m
          ? {
              ...it,
              price: m.price ?? null,
              isFree: m.isFree ?? false,
              comingSoon: m.comingSoon ?? true,
              releaseUnix: m.releaseUnix,
            }
          : { ...it, price: null, isFree: false, comingSoon: true };
      });
    } catch {
      // enrichment is best-effort — at least drop the bogus "Free" labels
      coming.items = coming.items.map((it) => ({ ...it, price: null, isFree: false, comingSoon: true }));
    }
  }

  // Extra recommendation rows: budget deals + genre selections. Fetched in
  // parallel; any failure just drops that row (the front page still renders).
  const [budget, ...genreRows] = await Promise.all([
    storeSection('under_budget', lang, 0, 12)
      .then((p): StoreSection | null =>
        p.items.length ? { id: 'under_budget', name: '', items: p.items.slice(0, 12) } : null
      )
      .catch(() => null),
    ...HOME_GENRES.map((g) => genreRow(g, lang).catch(() => null)),
  ]);
  if (budget) sections.push(budget);
  for (const row of genreRows) if (row) sections.push(row);

  // Spotlights live under numeric keys, one small category per promo, holding
  // items of TWO kinds:
  //   - promo banners {name: promo label, header_image, url} — the label goes
  //     onto a badge, the game name is derived from the /app/ URL slug;
  //   - daily-deal game capsules {id, type, prices} — rendered as regular
  //     priced cards (feeding their id to a banner used to link to app/0).
  // Everything is merged into one section, deduped, imageless banners dropped.
  const spotlightItems: StoreItem[] = [];
  const spotlightSeen = new Set<string>();
  let spotlightName = '';
  for (const key2 of Object.keys(cats ?? {})) {
    if (!/^\d+$/.test(key2)) continue;
    const cat = cats[key2];
    if (!cat?.items?.length) continue;
    if (!spotlightName && cat.name) spotlightName = cat.name;

    for (const i of cat.items) {
      // Game capsule (daily deal): a normal priced card.
      if (typeof i?.id === 'number') {
        if (i.type !== 0 && i.type != null) continue; // bundles/packages — ids are not appids
        const item = mapCapsule(i);
        const dedupeKey = `cap|${item.appid}`;
        if (item.appid > 0 && !spotlightSeen.has(dedupeKey)) {
          spotlightSeen.add(dedupeKey);
          spotlightItems.push(item);
        }
        continue;
      }

      // Promo banner.
      if (!i?.name || !i?.header_image) continue;
      const url: string | undefined = i.url;
      const appMatch = url?.match(/\/app\/(\d+)(?:\/([^/?#]+))?/);
      const appid = appMatch ? parseInt(appMatch[1], 10) : 0;
      const gameName = appMatch?.[2]
        ? decodeURIComponent(appMatch[2]).replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
        : null;
      const item: StoreItem = {
        appid,
        // Caption = the game's name when the URL points at a game; the promo
        // label ("MIDWEEK DEAL") becomes a badge. Sale pages keep the label.
        name: gameName ?? i.name,
        badge: gameName ? i.name : undefined,
        image: i.header_image,
        url: appid > 0 ? undefined : url, // game banners navigate in-app
        banner: true,
      };
      const dedupeKey = `ban|${item.name}|${url ?? ''}`;
      if (spotlightSeen.has(dedupeKey)) continue;
      spotlightSeen.add(dedupeKey);
      spotlightItems.push(item);
    }
  }
  if (spotlightItems.length) {
    sections.push({ id: 'spotlights', name: spotlightName, items: spotlightItems });
  }

  return { sections };
}

// Genre rows shown on the front page (section id = `genre-<key>`; the UI
// resolves display names via i18n).
const HOME_GENRES = ['action', 'rpg', 'strategy', 'indie'];

/**
 * One genre row via getappsingenre. Its items can be bare {id} records, so
 * names/prices/images are hydrated through itemsMeta (cached per appid).
 */
async function genreRow(genre: string, lang: string): Promise<StoreSection | null> {
  const { l, cc } = region(lang);
  const data = await getJson<any>(
    `${STORE_API}/getappsingenre?genre=${encodeURIComponent(genre)}&l=${l}&cc=${cc}`
  );
  const tabs = data?.tabs ?? {};
  const rawItems: any[] = tabs.topsellers?.items?.length
    ? tabs.topsellers.items
    : tabs.newreleases?.items ?? [];

  const ids: number[] = [];
  for (const it of rawItems) {
    // type 0 = app; other types are bundles/packages whose ids are NOT appids
    // (feeding those to GetItems yields nothing and used to render as "App N").
    if (it?.type !== 0 && it?.type != null) continue;
    if (typeof it?.id === 'number' && !ids.includes(it.id)) ids.push(it.id);
    if (ids.length >= 12) break;
  }
  if (!ids.length) return null;

  const meta = await itemsMeta(ids, lang);
  // Items GetItems couldn't resolve are dropped entirely — no placeholder cards.
  const items = dedupeItems(ids.map((id) => meta[id]).filter((i): i is StoreItem => !!i));
  return items.length ? { id: `genre-${genre}`, name: '', items } : null;
}

// ===================== Search =====================

export interface ReviewFacts {
  /**
   * Reviews from the last 30 days — a SAMPLE (up to 100 most helpful): the
   * appreviews endpoint's query_summary is always all-time, so the recent
   * share is counted from the reviews it returns for day_range=30.
   */
  recentTotal: number | null;
  recentPositive: number | null;
  /** A few of the most helpful reviews, trimmed — public text, for the AI verdict. */
  snippets: { up: boolean; text: string }[];
}

/**
 * Review facts beyond the summary appdetails already carries: the 30-day
 * window (trend vs. all-time) and a handful of helpful review texts. Cached
 * like other dynamic store data.
 */
export async function appReviewsFacts(appid: number, lang: string, snippets = 0): Promise<ReviewFacts> {
  const { l } = region(lang);
  return cached(NS, `reviews:${l}:${appid}:${snippets}`, getStoreCacheTtlMs(), async () => {
    const base = `https://store.steampowered.com/appreviews/${appid}?json=1&purchase_type=all`;
    const [recent, helpful] = await Promise.all([
      getJson<any>(`${base}&language=all&filter=all&day_range=30&num_per_page=100&review_type=all`).catch(() => null),
      snippets > 0
        ? getJson<any>(`${base}&language=${l === 'russian' ? 'russian,english' : 'english'}&filter=all&num_per_page=${Math.min(20, snippets)}`).catch(() => null)
        : Promise.resolve(null),
    ]);
    const recentList: any[] = Array.isArray(recent?.reviews) ? recent.reviews : [];
    const reviews: any[] = Array.isArray(helpful?.reviews) ? helpful.reviews : [];
    return {
      recentTotal: recent ? recentList.length : null,
      recentPositive: recent ? recentList.filter((r) => r?.voted_up).length : null,
      snippets: reviews
        .filter((r) => typeof r?.review === 'string' && r.review.trim().length > 40)
        .slice(0, snippets)
        .map((r) => ({ up: !!r.voted_up, text: String(r.review).replace(/\s+/g, ' ').trim().slice(0, 400) })),
    };
  });
}

export async function storeSearch(term: string, lang: string): Promise<StoreItem[]> {
  const { l, cc } = region(lang);
  const key = `search:${lang}:${cc}:${term.trim().toLowerCase()}`;
  return cached(NS, key, getStoreCacheTtlMs(), async () => {
    const url = `${STORE_API}/storesearch/?term=${encodeURIComponent(term)}&l=${l}&cc=${cc}`;
    const data = await getJson<any>(url);
    return dedupeItems(
      (data?.items ?? []).map((raw: any): StoreItem => {
        const p = raw.price;
        return {
          appid: raw.id,
          name: raw.name ?? `App ${raw.id}`,
          image: raw.tiny_image ?? null,
          isFree: !p,
          price: p
            ? {
                currency: p.currency,
                initial: p.initial ?? null,
                final: p.final ?? null,
                discountPct: discountPct(p.initial, p.final),
              }
            : null,
        };
      })
    );
  });
}

// ===================== Browse by tags =====================

/** Everyday words → the Steam tag they mean (the tag list itself is matched case-insensitively). */
export const TAG_SYNONYMS: Record<string, string> = {
  erotic: 'Sexual Content',
  erotica: 'Sexual Content',
  nsfw: 'Sexual Content',
  adult: 'Sexual Content',
  'adult only': 'Sexual Content',
  sex: 'Sexual Content',
  porn: 'Hentai',
  coop: 'Co-op',
  'co op': 'Co-op',
  cooperative: 'Co-op',
  roguelike: 'Roguelike',
  roguelite: 'Roguelite',
  'rogue-like': 'Roguelike',
  'souls-like': 'Souls-like',
  soulslike: 'Souls-like',
  metroidvania: 'Metroidvania',
  'pixel art': 'Pixel Graphics',
  'pixel': 'Pixel Graphics',
  '2d': '2D',
  '3d': '3D',
  'first person': 'First-Person',
  'third person': 'Third Person',
  'story': 'Story Rich',
  'story-rich': 'Story Rich',
  'open-world': 'Open World',
  'single player': 'Singleplayer',
  'single-player': 'Singleplayer',
  cozy: 'Cozy',
  farming: 'Farming Sim',
  'deck builder': 'Deckbuilding',
  deckbuilder: 'Deckbuilding',
  // "mods" must not reach a plural fallback that turns it into "Mod", Steam's tag for products that ARE mods.
  mods: 'Moddable',
  'mod support': 'Moddable',
  modding: 'Moddable',
  // The "VR" user tag, which substring filters and the tag search both understand, rather than one of the
  // two official VR flags (which are not tag ids).
  'virtual reality': 'VR',
  'vr headset': 'VR',
};

export interface StoreBrowseResult {
  items: StoreItem[];
  /** The Steam tag names actually used. */
  tags: string[];
  /** Requested words that matched no Steam tag. */
  unknownTags: string[];
}

export type StoreBrowseSort = 'relevance' | 'reviews' | 'new' | 'price';

/**
 * Steam's own tag search (the storefront's search page in JSON form): games
 * carrying ALL the given tags, optionally on sale, sorted. Adult tags are
 * ordinary tags here — the mature-content cookies make sure age-gated titles
 * are not silently dropped. Appids come from the capsule URLs; the batched
 * metadata adds price, kind and tags.
 */
export async function storeBrowseByTags(
  wanted: string[],
  lang: string,
  opts: { onSaleOnly?: boolean; sort?: StoreBrowseSort; limit?: number } = {}
): Promise<StoreBrowseResult> {
  const names = await tagNames('en');
  const byName = new Map<string, { id: string; name: string }>();
  for (const [id, name] of Object.entries(names)) byName.set(name.toLowerCase(), { id, name });
  const tags: { id: string; name: string }[] = [];
  const unknownTags: string[] = [];
  for (const raw of wanted) {
    const w = raw.trim().toLowerCase();
    if (!w) continue;
    const hit = byName.get(w) ?? byName.get((TAG_SYNONYMS[w] ?? '').toLowerCase()) ?? byName.get(w.replace(/-/g, ' ')) ?? byName.get(w.replace(/\s+/g, '-'));
    if (hit) {
      if (!tags.some((t) => t.id === hit.id)) tags.push(hit);
    } else unknownTags.push(raw);
  }
  if (!tags.length) return { items: [], tags: [], unknownTags };
  const { l, cc } = region(lang);
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const sortBy = opts.sort === 'reviews' ? 'Reviews_DESC' : opts.sort === 'new' ? 'Released_DESC' : opts.sort === 'price' ? 'Price_ASC' : '';
  const key = `browse:${lang}:${cc}:${tags.map((t) => t.id).join(',')}:${opts.onSaleOnly ? 1 : 0}:${sortBy}:${limit}`;
  const items = await cached(NS, key, getStoreCacheTtlMs(), async () => {
    const url =
      `https://store.steampowered.com/search/results/?json=1&category1=998&count=${limit}&start=0` +
      `&tags=${tags.map((t) => t.id).join(',')}&cc=${cc}&l=${l}` +
      (opts.onSaleOnly ? '&specials=1' : '') +
      (sortBy ? `&sort_by=${sortBy}` : '');
    const data = await httpJson<any>(url, {
      headers: { 'User-Agent': BROWSER_UA, Cookie: 'birthtime=0; wants_mature_content=1; lastagecheckage=1-0-1990' },
    });
    const appids: number[] = [];
    for (const it of Array.isArray(data?.items) ? data.items : []) {
      const m = /\/apps\/(\d+)\//.exec(String(it?.logo ?? ''));
      if (m) appids.push(Number(m[1]));
    }
    const meta = await itemsMeta([...new Set(appids)], lang);
    return appids.map((id) => meta[id]).filter((x): x is StoreItem => !!x && (!x.kind || x.kind === 'game') && !x.comingSoon);
  });
  return { items, tags: tags.map((t) => t.name), unknownTags };
}

/**
 * Finds a game's Steam appid by title (used for games known only from EGS).
 * Strict normalized-title match — a wrong appid would produce bogus details
 * and price comparisons, so "not found" beats "maybe". Cached (null too).
 */
export async function findSteamAppId(title: string, lang: string): Promise<number | null> {
  const { cc } = region(lang);
  const key = `findapp:${lang}:${cc}:${normName(title)}`;
  // The title→appid mapping never changes — any cached hit (even stale) is valid.
  const hit = cacheGet<number>(NS, key, TTL_STATIC_MS);
  if (hit) return hit.data === 0 ? null : hit.data;

  let items: StoreItem[];
  try {
    items = await storeSearch(title, lang);
  } catch {
    return null; // transient — not cached
  }
  const want = normName(title);
  const found = items.find((i) => i.appid > 0 && normName(i.name) === want);
  cacheSet(NS, key, found?.appid ?? 0); // 0 = legit "not on Steam"
  return found?.appid ?? null;
}

// ===================== Wishlist =====================

/**
 * Wishlist rows only (fast, one request). Metadata is hydrated separately via
 * wishlistMeta so huge wishlists load progressively as the user scrolls.
 * force=true also drops cached metadata so prices refresh.
 */
export async function wishlistEntries(steamId: string, force = false): Promise<WishlistEntry[]> {
  try {
    return await cached(
      NS,
      `wl:${steamId}`,
      getStoreCacheTtlMs(),
      async () => {
        const data = await getJson<any>(
          `${WEB_API}/IWishlistService/GetWishlist/v1/?steamid=${encodeURIComponent(steamId)}`
        );
        return (data?.response?.items ?? []).map(
          (e: any): WishlistEntry => ({
            appid: e.appid,
            priority: e.priority ?? 0,
            dateAdded: e.date_added ?? 0,
          })
        );
      },
      { force }
    );
  } catch {
    return []; // private profile / bad id — show as empty (not cached)
  }
}


/** Drops cached wishlist rows — called after an add/remove mutation so the
 *  change survives navigation instead of being masked by the 1 h cache. */
export function invalidateWishlist(): void {
  cachePurge(NS, 'wl:');
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Batch metadata (localized name, price, discount, capsule image) for the
 * given appids via IStoreBrowseService/GetItems. Cached per appid+lang, so
 * scroll-driven hydration only ever fetches what's still missing. Used by the
 * wishlist and by section pages.
 */
export async function itemsMeta(
  appids: number[],
  lang: string,
  force = false
): Promise<Record<number, StoreItem>> {
  const { l, cc } = region(lang);
  const result: Record<number, StoreItem> = {};

  // Fresh hits are used as is; stale ones are served now and refreshed in the
  // background; genuinely missing ids are fetched before returning.
  const missing: number[] = [];
  const stale: number[] = [];
  for (const appid of appids) {
    const hit = force
      ? null
      : cacheGet<StoreItem>(NS, `meta:${lang}:${cc}:${appid}`, getStoreCacheTtlMs());
    if (hit) {
      result[appid] = withDerivedComingSoon(hit.data);
      if (!hit.fresh) stale.push(appid);
    } else {
      missing.push(appid);
    }
  }
  if (stale.length) void fetchMetaBatch(stale, l, cc, lang).catch(() => {});
  Object.assign(result, await fetchMetaBatch(missing, l, cc, lang));

  // Unresolved appids are simply absent from the result — callers decide how
  // to handle them (the wishlist renders its own fallback; genre rows drop them).
  return result;
}

// Appids currently being fetched. The renderer hydrates from scroll position,
// so without this a slow batch would be re-requested on every scroll tick.
const metaInFlight = new Set<number>();

/** Fetches + caches one batch of appids; returns what GetItems resolved. */
async function fetchMetaBatch(
  ids: number[],
  l: string,
  cc: string,
  lang: string
): Promise<Record<number, StoreItem>> {
  const result: Record<number, StoreItem> = {};
  const pending = ids.filter((id) => !metaInFlight.has(id));
  if (!pending.length) return result;
  pending.forEach((id) => metaInFlight.add(id));

  try {
    return await fetchMetaChunks(pending, l, cc, lang, result);
  } finally {
    pending.forEach((id) => metaInFlight.delete(id));
  }
}

async function fetchMetaChunks(
  ids: number[],
  l: string,
  cc: string,
  lang: string,
  result: Record<number, StoreItem>
): Promise<Record<number, StoreItem>> {
  const names = ids.length ? await tagNames(lang).catch(() => ({}) as Record<string, string>) : {};
  for (const chunk of chunks(ids, 100)) {
    const input = {
      ids: chunk.map((appid) => ({ appid })),
      context: { language: l, country_code: cc, steam_realm: 1 },
      data_request: { include_basic_info: true, include_assets: true, include_pricing: true, include_release: true, include_tag_count: 20, include_platforms: true, include_reviews: true },
    };
    try {
      const resp = await getJson<any>(
        `${WEB_API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`
      );
      for (const si of resp?.response?.store_items ?? []) {
        if (!si?.appid || !si?.name) continue;
        const bpo = si.best_purchase_option;
        const finalCents =
          bpo?.final_price_in_cents != null ? parseInt(bpo.final_price_in_cents, 10) : null;
        const initialCents =
          bpo?.original_price_in_cents != null ? parseInt(bpo.original_price_in_cents, 10) : null;
        const releaseUnix: number | undefined =
          typeof si.release?.steam_release_date === 'number' && si.release.steam_release_date > 0
            ? si.release.steam_release_date
            : undefined;
        const kind = itemKind(si);
        const tags = [...userTags(si, names), ...platformTags(si)];
        const reviews = reviewSummary(si);
        const item: StoreItem = {
          appid: si.appid,
          name: si.name,
          ...(kind ? { kind } : {}),
          tags,
          reviewPct: reviews.pct,
          reviewCount: reviews.count,
          metaV: META_VERSION,
          image: assetImage(si) ?? conventionCapsule(si.appid),
          isFree: si.is_free ?? false,
          // Steam's own flag when present; otherwise derived at read time from
          // releaseUnix (a cached boolean would keep saying "coming soon"
          // after the game shipped).
          comingSoon: si.release?.is_coming_soon ?? undefined,
          releaseUnix,
          price: bpo
            ? {
                final: finalCents,
                initial: initialCents,
                discountPct: bpo.discount_pct ?? discountPct(initialCents, finalCents),
                formattedFinal: bpo.formatted_final_price ?? null,
                formattedOriginal: bpo.formatted_original_price ?? null,
              }
            : null,
        };
        cacheSet(NS, `meta:${lang}:${cc}:${si.appid}`, item);
        result[si.appid] = withDerivedComingSoon(item);
      }
    } catch {
      /* keep going — items without metadata still render by appid */
    }
  }
  return result;
}

/** Fills in `comingSoon` from the release date when Steam didn't state it. */
function withDerivedComingSoon(item: StoreItem): StoreItem {
  if (item.comingSoon != null) return item;
  return item.releaseUnix != null
    ? { ...item, comingSoon: item.releaseUnix * 1000 > Date.now() }
    : item;
}

// ---------- GetItems field readers (shared by the metadata and fact batches) ----------

/** GetItems `type`: 0 game, 4 DLC, 11 soundtrack; anything else numeric is "other". */
function itemKind(si: any): StoreItem['kind'] {
  return si.type === 0 ? 'game' : si.type === 4 ? 'dlc' : si.type === 11 ? 'music' : typeof si.type === 'number' ? 'other' : undefined;
}

/** User tags in vote order (GetItems returns them weighted, most voted first). */
function userTags(si: any, names: Record<string, string>): string[] {
  return (Array.isArray(si.tags) ? (si.tags as { tagid: number }[]) : []).map((t) => names[String(t.tagid)]).filter((x): x is string => !!x);
}

/** Official platform flags as tags, so "Steam Deck Verified" or "VR Only" filter like any other tag. */
function platformTags(si: any): string[] {
  const out: string[] = [];
  const deck = si.platforms?.steam_deck_compat_category;
  if (deck === 3) out.push('Steam Deck Verified');
  else if (deck === 2) out.push('Steam Deck Playable');
  else if (deck === 1) out.push('Steam Deck Unsupported');
  const vr = si.platforms?.vr_support;
  if (vr?.vrhmd_only) out.push('VR Only');
  else if (vr?.vrhmd) out.push('VR Supported');
  return out;
}

/** All-language review summary (`include_reviews`); a percentage without reviews behind it means nothing. */
function reviewSummary(si: any): { pct: number | null; count: number | null } {
  const s = si.reviews?.summary_filtered;
  const count = typeof s?.review_count === 'number' ? s.review_count : null;
  const pct = typeof s?.percent_positive === 'number' && (count ?? 0) > 0 ? s.percent_positive : null;
  return { pct, count };
}

// ===================== Section pages =====================

// Maps our section ids to the storefront search filters (the same tabs the
// Steam site's search page uses). Spotlight sections have no full-page view.
// `under_budget` uses a region-appropriate price ceiling.
function sectionFilter(id: string, cc: string): string | null {
  switch (id) {
    case 'specials':
      return 'specials=1';
    case 'top_sellers':
      return 'filter=topsellers';
    case 'new_releases':
      return 'filter=popularnew';
    case 'coming_soon':
      return 'filter=popularcomingsoon';
    case 'under_budget': {
      // maxprice is denominated in the region's currency — roughly "$10-ish"
      // per region; unlisted regions use 10 (fits USD/EUR-scale currencies).
      const budgets: Record<string, number> = {
        RU: 500, UA: 250, KZ: 5000, TR: 400, JP: 1500, KR: 15000, IN: 800, CN: 70, BR: 60, PL: 45,
      };
      return `specials=1&maxprice=${budgets[cc] ?? 10}`;
    }
    default:
      return null;
  }
}

export interface StoreSectionPage {
  items: StoreItem[];
  /** True when another page is likely available (full page returned). */
  hasMore: boolean;
}

/**
 * Generic store-search listing (json mode returns only name+logo, so appids
 * are recovered from the logo URL and prices/images are hydrated through
 * itemsMeta). Bundles/packages keep an external URL instead. Used by section
 * pages and the personalized rows (e.g. `tags=<tagid>`).
 */
export async function searchItems(
  query: string,
  lang: string,
  start = 0,
  count = 50,
  comingSoonDefault = false
): Promise<StoreSectionPage> {
  const { l, cc } = region(lang);
  const url =
    `https://store.steampowered.com/search/results/?json=1&start=${start}&count=${count}` +
    `&${query}&l=${l}&cc=${cc}`;
  const data = await getJson<any>(url);
  const raw: any[] = data?.items ?? [];

  // json mode gives {name, logo}; the logo URL encodes what the row is.
  interface Parsed {
    name: string;
    logo: string | null;
    appid: number;
    url?: string;
  }
  const parsed: Parsed[] = [];
  for (const it of raw) {
    if (!it?.name) continue;
    const logo: string | null = it.logo ?? null;
    const app = logo?.match(/\/apps\/(\d+)\//);
    if (app) {
      parsed.push({ name: it.name, logo, appid: parseInt(app[1], 10) });
      continue;
    }
    const bundle = logo?.match(/\/bundles\/(\d+)\//);
    if (bundle) {
      parsed.push({
        name: it.name,
        logo,
        appid: 0,
        url: `https://store.steampowered.com/bundle/${bundle[1]}/`,
      });
      continue;
    }
    const sub = logo?.match(/\/subs\/(\d+)\//);
    if (sub) {
      parsed.push({
        name: it.name,
        logo,
        appid: 0,
        url: `https://store.steampowered.com/sub/${sub[1]}/`,
      });
    }
  }

  // Hydrate prices/images for real apps (cached per appid, batched inside).
  const appids = parsed.filter((p) => p.appid > 0).map((p) => p.appid);
  const meta = appids.length ? await itemsMeta(appids, lang) : {};

  const items = dedupeItems(
    parsed.map((p): StoreItem => {
      const m = p.appid > 0 ? meta[p.appid] : undefined;
      return {
        appid: p.appid,
        name: p.name, // search names are already localized via l=
        image: m?.image ?? p.logo,
        price: m?.price ?? null,
        isFree: m?.isFree ?? false,
        // In a coming-soon context everything is unreleased by definition —
        // items whose metadata lacks a date still get the "Coming soon" text.
        comingSoon: m?.comingSoon ?? (comingSoonDefault ? true : undefined),
        releaseUnix: m?.releaseUnix,
        url: p.url,
      };
    })
  );

  // Based on the RAW row count: dedupe/filtering can shrink `items`, but the
  // server still has more rows to give at the next offset.
  return { items, hasMore: raw.length >= count };
}

/** A full, paginated section listing (cached wrapper around searchItems). */
export async function storeSection(
  id: string,
  lang: string,
  start = 0,
  count = 50,
  sort: SectionSort = 'default'
): Promise<StoreSectionPage> {
  const { cc } = region(lang);
  const filter = sectionFilter(id, cc);
  if (!filter) throw new Error(`Unknown store section: ${id}`);

  const key = `section:${lang}:${cc}:${id}:${sort}:${start}:${count}`;
  return cached(NS, key, getStoreCacheTtlMs(), () => {
    const sortBy = SORT_BY[sort];
    const query = `${filter}${sortBy ? `&sort_by=${sortBy}` : ''}`;
    return searchItems(query, lang, start, count, id === 'coming_soon');
  });
}

// ===================== Tags (user tags, like the Steam page shows) =====================

/** Steam user tags: tagid → localized name; ~450 entries, static class (refreshed daily). {} on failure. */
export async function tagNames(lang: string): Promise<Record<string, string>> {
  try {
    return await cached(NS, `tags:${lang}`, TTL_STATIC_MS, async () => {
      const l = lang === 'ru' ? 'russian' : 'english';
      const json = await getJson<any>(`${WEB_API}/IStoreService/GetTagList/v1/?language=${l}`);
      const map: Record<string, string> = {};
      for (const tag of json?.response?.tags ?? []) {
        if (tag?.tagid && tag?.name) map[String(tag.tagid)] = tag.name;
      }
      // An empty list is a broken answer, not a fact — throwing keeps it out of the cache for a day
      // (fact cards and the tag resolver depend on it).
      if (!Object.keys(map).length) throw new Error('Empty tag list');
      return map;
    });
  } catch {
    return {}; // tags row is optional
  }
}

// ===================== Store categories + raw facts (profile grounding) =====================

/**
 * Steam's store category catalog in English: categoryid → display name and type (1 player modes,
 * 2 features, 3 controller support). Cached a day; type 0 (demo/DLC/mods) and untranslated
 * `#category_…` placeholders are left out. {} on failure.
 */
export async function categoryNames(): Promise<Record<number, { name: string; type: number }>> {
  try {
    return await cached(NS, 'categories:en', TTL_STATIC_MS, async () => {
      const input = encodeURIComponent(JSON.stringify({ language: 'english' }));
      const json = await getJson<any>(`${WEB_API}/IStoreBrowseService/GetStoreCategories/v1/?input_json=${input}`);
      const map: Record<number, { name: string; type: number }> = {};
      for (const c of json?.response?.categories ?? []) {
        const id = Number(c?.categoryid);
        const type = Number(c?.type);
        const name = typeof c?.display_name === 'string' ? c.display_name.trim() : '';
        if (!id || !type || !name || name.startsWith('#')) continue;
        map[id] = { name, type };
      }
      // An empty catalog is a broken answer, not a fact — throwing keeps it out of the cache.
      if (!Object.keys(map).length) throw new Error('Empty category catalog');
      return map;
    });
  } catch {
    return {};
  }
}

/** Raw store facts for a batch of appids (English text), for profile grounding. Not cached here. */
export interface SteamAppFacts {
  appid: number;
  name: string;
  type: StoreItem['kind'] | undefined;
  shortDescription: string | null;
  fullDescriptionBbcode: string | null;
  developers: string[];
  tags: string[];
  categories: string[];
  releaseYear: number | null;
  reviewPct: number | null;
  reviewCount: number | null;
}

// Full descriptions make GetItems answers big (~5 KB per app), so fact batches are smaller than the
// metadata ones and get a longer timeout.
const FACTS_CHUNK = 50;
const FACTS_TIMEOUT_MS = 30_000;
const FACTS_RETRY_MS = 3000;

/** HTTP 429/5xx, a timeout or a network failure — worth one more try; other 4xx are not. */
export function isTransientStoreError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const status = /HTTP (\d{3})/.exec(msg);
  if (status) return status[1] === '429' || status[1].startsWith('5');
  return true; // no status: network error, timeout (AbortError) or a garbled body
}

/**
 * steamAppFacts plus the appids whose chunk failed (a transient error after the retry, or any other
 * request-level error). Lets callers tell "Steam has no such app" (absent from a successful answer)
 * from "ask again later" (failed).
 */
export async function steamAppFactsReport(
  appids: number[]
): Promise<{ facts: Record<number, SteamAppFacts>; failed: number[] }> {
  const facts: Record<number, SteamAppFacts> = {};
  const failed: number[] = [];
  const ids = [...new Set(appids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return { facts, failed };
  const [names, cats] = await Promise.all([tagNames('en'), categoryNames()]);
  // Both catalogs come back {} only when Steam is unreachable; facts without tag or category names
  // would be stored as if the game had none, so report everything as failed instead.
  if (!Object.keys(names).length || !Object.keys(cats).length) return { facts, failed: ids };
  const cc = getRegions().steamCc;

  for (const chunk of chunks(ids, FACTS_CHUNK)) {
    const input = {
      ids: chunk.map((appid) => ({ appid })),
      context: { language: 'english', country_code: cc, steam_realm: 1 },
      data_request: {
        include_basic_info: true,
        include_full_description: true,
        include_tag_count: 20,
        include_release: true,
        include_reviews: true,
        include_platforms: true,
      },
    };
    const url = `${WEB_API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
    const get = (): Promise<any> => httpJson<any>(url, { headers: { 'User-Agent': BROWSER_UA }, timeoutMs: FACTS_TIMEOUT_MS });
    let resp: any;
    try {
      resp = await get();
    } catch (e) {
      // A hard 4xx (an edge 403 for a flagged IP, …) is not worth a retry, but it says nothing about
      // the ids themselves: only items missing from a successful answer mean "Steam has no such app".
      if (!isTransientStoreError(e)) {
        failed.push(...chunk);
        continue;
      }
      await new Promise((r) => setTimeout(r, FACTS_RETRY_MS));
      try {
        resp = await get();
      } catch {
        failed.push(...chunk); // skipped; the caller retries these another time
        continue;
      }
    }
    for (const si of resp?.response?.store_items ?? []) {
      // Unknown appids come back as { appid: 0, success: 15 } — nothing to record.
      if (!si?.appid || !si?.name) continue;
      const basic = si.basic_info ?? {};
      const release = si.release ?? {};
      // The original (pre-Steam) date where Steam knows it: a 1993 game re-released in 2007 is from 1993.
      const unix =
        typeof release.original_release_date === 'number' && release.original_release_date > 0
          ? release.original_release_date
          : typeof release.steam_release_date === 'number' && release.steam_release_date > 0
            ? release.steam_release_date
            : null;
      const reviews = reviewSummary(si);
      facts[si.appid] = {
        appid: si.appid,
        name: String(si.name),
        type: itemKind(si),
        shortDescription: typeof basic.short_description === 'string' && basic.short_description.trim() ? basic.short_description : null,
        fullDescriptionBbcode:
          typeof si.full_description_bbcode === 'string' && si.full_description_bbcode.trim() ? si.full_description_bbcode : null,
        developers: (Array.isArray(basic.developers) ? basic.developers : [])
          .map((d: any) => (typeof d?.name === 'string' ? d.name.trim() : ''))
          .filter(Boolean),
        tags: [...userTags(si, names), ...platformTags(si)],
        categories: categoryList(si.categories, cats),
        releaseYear: unix != null ? new Date(unix * 1000).getUTCFullYear() : null,
        reviewPct: reviews.pct,
        reviewCount: reviews.count,
      };
    }
  }
  return { facts, failed };
}

/**
 * Raw store facts for a batch of appids (English text), for profile grounding: batches of 50 via
 * GetItems, one retry after 3 s on 429/5xx/network errors; a failing chunk is skipped (its ids are
 * simply absent — use steamAppFactsReport to tell them from unknown apps).
 */
export async function steamAppFacts(appids: number[]): Promise<Record<number, SteamAppFacts>> {
  return (await steamAppFactsReport(appids)).facts;
}

/** Short descriptions live in a namespace of their own, so they never push metadata out of NS's entry cap. */
const ABOUT_NS = 'steamAbout';
const ABOUT_TTL_MS = 7 * 24 * 3600_000;

/**
 * Steam's short description (English) of each game, for the AI fit check: GetItems with the basic info only —
 * no full description, no tag or category catalogs — cached per appid for a week (an empty string = Steam has
 * none), so only games not asked about lately are fetched. Ids Steam does not know, or whose request fails,
 * are simply absent.
 */
export async function storeAbouts(appids: number[]): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  const missing: number[] = [];
  for (const id of new Set(appids.filter((x) => Number.isInteger(x) && x > 0))) {
    const hit = cacheGet<string>(ABOUT_NS, `about:${id}`, ABOUT_TTL_MS);
    if (!hit?.fresh) missing.push(id);
    else if (hit.data) out[id] = hit.data;
  }
  const { cc } = region('en');
  for (const chunk of chunks(missing, 100)) {
    const input = {
      ids: chunk.map((appid) => ({ appid })),
      context: { language: 'english', country_code: cc, steam_realm: 1 },
      data_request: { include_basic_info: true },
    };
    try {
      const resp = await getJson<any>(`${WEB_API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`);
      for (const si of resp?.response?.store_items ?? []) {
        // Unknown appids come back as { appid: 0, success: 15 } — nothing to record.
        if (!si?.appid || !si?.name) continue;
        const text = typeof si.basic_info?.short_description === 'string' ? si.basic_info.short_description.trim() : '';
        cacheSet(ABOUT_NS, `about:${si.appid}`, text);
        if (text) out[si.appid] = text;
      }
    } catch {
      /* skipped — the caller judges those games without a description */
    }
  }
  return out;
}

/** Category ids → names: player modes first (what profiles derive modes from), then controller, then features. */
function categoryList(raw: any, cats: Record<number, { name: string; type: number }>): string[] {
  const out: string[] = [];
  for (const group of ['supported_player_categoryids', 'controller_categoryids', 'feature_categoryids']) {
    for (const id of Array.isArray(raw?.[group]) ? raw[group] : []) {
      const name = cats[Number(id)]?.name;
      // Several ids share a display name (Steam Workshop / Steam China Workshop).
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

// ===================== Game details =====================

export interface GameDetails {
  appid: number;
  name: string;
  headerImage?: string | null;
  shortDescription?: string | null;
  developers: string[];
  publishers: string[];
  genres: string[];
  /** User-voted tags — what the Steam product page shows as "Popular tags". */
  tags: string[];
  releaseDate?: string | null;
  comingSoon?: boolean;
  price?: StorePrice | null;
  isFree?: boolean;
  platforms: string[];
  metacritic?: number | null;
  achievementsTotal?: number | null;
  screenshots: { thumb: string; full: string }[];
  movieWebm?: string | null;
  moviePoster?: string | null;
  reviewScoreDesc?: string | null;
  reviewTotalPositive?: number | null;
  reviewTotal?: number | null;
  currentPlayers?: number | null;
}

/**
 * Full page data for one game: appdetails (description, media, price) +
 * review summary + current player count. Reviews/players are best-effort.
 */
export async function appDetails(appid: number, lang: string): Promise<GameDetails> {
  const { l, cc } = region(lang);
  return cached(NS, `details:${lang}:${cc}:${appid}`, getStoreCacheTtlMs(), () =>
    fetchAppDetails(appid, lang, l, cc)
  );
}

async function fetchAppDetails(
  appid: number,
  lang: string,
  l: string,
  cc: string
): Promise<GameDetails> {
  const tagInput = encodeURIComponent(
    JSON.stringify({
      ids: [{ appid }],
      context: { language: l, country_code: cc, steam_realm: 1 },
      data_request: { include_tag_count: 10 },
    })
  );
  const [detailsDoc, reviewsDoc, playersDoc, tagsDoc] = await Promise.all([
    getJson<any>(`${STORE_API}/appdetails?appids=${appid}&l=${l}&cc=${cc}`),
    getJson<any>(
      `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`
    ).catch(() => null),
    getJson<any>(
      `${WEB_API}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`
    ).catch(() => null),
    getJson<any>(`${WEB_API}/IStoreBrowseService/GetItems/v1/?input_json=${tagInput}`).catch(
      () => null
    ),
  ]);

  // Weighted tagids → localized names (the "Popular tags" of the product page).
  const tagIds: { tagid: number }[] = tagsDoc?.response?.store_items?.[0]?.tags ?? [];
  const names = tagIds.length ? await tagNames(lang) : {};
  const tags = tagIds
    .map((t) => names[String(t.tagid)])
    .filter((x): x is string => !!x)
    .slice(0, 8);

  const entry = detailsDoc?.[appid];
  if (!entry?.success || !entry.data) throw new Error(`No store data for app ${appid}`);
  const d = entry.data;

  const po = d.price_overview;
  const platforms: string[] = [];
  if (d.platforms?.windows) platforms.push('Windows');
  if (d.platforms?.mac) platforms.push('macOS');
  if (d.platforms?.linux) platforms.push('Linux');

  const movie = Array.isArray(d.movies) && d.movies.length ? d.movies[0] : null;
  const summary = reviewsDoc?.query_summary;

  const details: GameDetails = {
    appid,
    name: d.name ?? `App ${appid}`,
    headerImage: d.header_image ?? null,
    shortDescription: d.short_description ?? null,
    developers: Array.isArray(d.developers) ? d.developers : [],
    publishers: Array.isArray(d.publishers) ? d.publishers : [],
    genres: Array.isArray(d.genres) ? d.genres.map((g: any) => g.description).filter(Boolean) : [],
    tags,
    releaseDate: d.release_date?.date ?? null,
    comingSoon: d.release_date?.coming_soon ?? false,
    isFree: d.is_free ?? false,
    price: po
      ? {
          currency: po.currency,
          initial: po.initial ?? null,
          final: po.final ?? null,
          discountPct: po.discount_percent > 0 ? po.discount_percent : undefined,
          formattedFinal: po.final_formatted ?? null,
          formattedOriginal: po.initial_formatted || null,
        }
      : null,
    platforms,
    metacritic: d.metacritic?.score ?? null,
    achievementsTotal: d.achievements?.total ?? null,
    screenshots: Array.isArray(d.screenshots)
      ? d.screenshots
          .slice(0, 12)
          .map((s: any) => ({ thumb: s.path_thumbnail, full: s.path_full }))
          .filter((s: any) => s.thumb && s.full)
      : [],
    movieWebm: movie?.webm?.max ?? movie?.mp4?.max ?? null,
    moviePoster: movie?.thumbnail ?? null,
    reviewScoreDesc: summary?.review_score_desc ?? null,
    reviewTotalPositive: summary?.total_positive ?? null,
    reviewTotal: summary?.total_reviews ?? null,
    currentPlayers: playersDoc?.response?.player_count ?? null,
  };

  return details;
}
