// Steam storefront data for the in-app Store page. All requests run in the
// main process (no CORS). Endpoints are Valve's public-but-undocumented
// storefront APIs — the same ones the Steam site itself uses:
//   - /api/featured + /api/featuredcategories  → front-page sections
//   - /api/storesearch                          → search by title
//   - IWishlistService/GetWishlist              → wishlist appids (public profiles)
//   - IStoreBrowseService/GetItems              → batch name/price/discount for appids
//
// Everything is cached in-memory with a single TTL (LAUNCHER_STORE_CACHE_TTL,
// default 300 s) so hopping wishlist → home → wishlist doesn't refetch; the UI
// refresh button passes force=true to bypass the cache. Wishlist metadata is
// fetched lazily in batches driven by the renderer's scroll position, so large
// wishlists don't hammer the API upfront.

import { getStoreCacheTtlMs } from '../config';
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
}

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
// comes from the Steam account region stored in the backend (fallback US).
async function region(lang: string): Promise<{ l: string; cc: string }> {
  const { steamCc } = await getRegions();
  return { l: lang === 'ru' ? 'russian' : 'english', cc: steamCc };
}

// ===================== TTL cache =====================

const cache = new Map<string, { at: number; data: unknown }>();

function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > getStoreCacheTtlMs()) {
    cache.delete(key);
    return null;
  }
  return hit.data as T;
}

function cacheSet(key: string, data: unknown): void {
  cache.set(key, { at: Date.now(), data });
}

function cachePurge(prefix: string): void {
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

// ===================== helpers =====================

async function getJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (!res.ok) throw new Error(`Steam store request failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function discountPct(initial?: number | null, final?: number | null): number | undefined {
  if (initial != null && final != null && initial > final && initial > 0) {
    return Math.round((1 - final / initial) * 100);
  }
  return undefined;
}

const normName = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

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

// ===================== Front page =====================

export async function storeHome(lang: string, force = false): Promise<StoreHome> {
  const { l, cc } = await region(lang);
  const key = `home:${lang}:${cc}`;
  if (!force) {
    const cached = cacheGet<StoreHome>(key);
    if (cached) return cached;
  }
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

  const data = { sections };
  cacheSet(key, data);
  return data;
}

// Genre rows shown on the front page (section id = `genre-<key>`; the UI
// resolves display names via i18n).
const HOME_GENRES = ['action', 'rpg', 'strategy', 'indie'];

/**
 * One genre row via getappsingenre. Its items can be bare {id} records, so
 * names/prices/images are hydrated through itemsMeta (cached per appid).
 */
async function genreRow(genre: string, lang: string): Promise<StoreSection | null> {
  const { l, cc } = await region(lang);
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

export async function storeSearch(term: string, lang: string): Promise<StoreItem[]> {
  const { l, cc } = await region(lang);
  const key = `search:${lang}:${cc}:${term.trim().toLowerCase()}`;
  const cached = cacheGet<StoreItem[]>(key);
  if (cached) return cached;
  const url = `${STORE_API}/storesearch/?term=${encodeURIComponent(term)}&l=${l}&cc=${cc}`;
  const data = await getJson<any>(url);
  const items = dedupeItems(
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
  cacheSet(key, items);
  return items;
}

/**
 * Finds a game's Steam appid by title (used for games known only from EGS).
 * Strict normalized-title match — a wrong appid would produce bogus details
 * and price comparisons, so "not found" beats "maybe". Cached (null too).
 */
export async function findSteamAppId(title: string, lang: string): Promise<number | null> {
  const { cc } = await region(lang);
  const key = `findapp:${lang}:${cc}:${normName(title)}`;
  const cached = cacheGet<number | 0>(key);
  if (cached !== null) return cached === 0 ? null : cached;

  let items: StoreItem[];
  try {
    items = await storeSearch(title, lang);
  } catch {
    return null; // transient — not cached
  }
  const want = normName(title);
  const hit = items.find((i) => i.appid > 0 && normName(i.name) === want);
  cacheSet(key, hit?.appid ?? 0); // 0 = legit "not on Steam" (cache can't hold null)
  return hit?.appid ?? null;
}

// ===================== Wishlist =====================

/**
 * Wishlist rows only (fast, one request). Metadata is hydrated separately via
 * wishlistMeta so huge wishlists load progressively as the user scrolls.
 * force=true also drops cached metadata so prices refresh.
 */
export async function wishlistEntries(steamId: string, force = false): Promise<WishlistEntry[]> {
  const key = `wl:${steamId}`;
  if (force) {
    cache.delete(key);
    cachePurge('meta:');
  } else {
    const cached = cacheGet<WishlistEntry[]>(key);
    if (cached) return cached;
  }

  let entries: WishlistEntry[] = [];
  try {
    const data = await getJson<any>(
      `${WEB_API}/IWishlistService/GetWishlist/v1/?steamid=${encodeURIComponent(steamId)}`
    );
    entries = (data?.response?.items ?? []).map((e: any) => ({
      appid: e.appid,
      priority: e.priority ?? 0,
      dateAdded: e.date_added ?? 0,
    }));
  } catch {
    return []; // private profile / bad id — show as empty
  }
  cacheSet(key, entries);
  return entries;
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
  lang: string
): Promise<Record<number, StoreItem>> {
  const { l, cc } = await region(lang);
  const result: Record<number, StoreItem> = {};

  const missing: number[] = [];
  for (const appid of appids) {
    const cached = cacheGet<StoreItem>(`meta:${lang}:${cc}:${appid}`);
    if (cached) result[appid] = cached;
    else missing.push(appid);
  }

  for (const chunk of chunks(missing, 100)) {
    const input = {
      ids: chunk.map((appid) => ({ appid })),
      context: { language: l, country_code: cc, steam_realm: 1 },
      data_request: { include_assets: true, include_pricing: true },
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
        const item: StoreItem = {
          appid: si.appid,
          name: si.name,
          image: assetImage(si) ?? conventionCapsule(si.appid),
          isFree: si.is_free ?? false,
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
        cacheSet(`meta:${lang}:${cc}:${si.appid}`, item);
        result[si.appid] = item;
      }
    } catch {
      /* keep going — items without metadata still render by appid */
    }
  }

  // Unresolved appids are simply absent from the result — callers decide how
  // to handle them (the wishlist renders its own fallback; genre rows drop them).
  return result;
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
 * A full, paginated section listing via store search (json mode returns only
 * name+logo, so appids are recovered from the logo URL and prices/images are
 * hydrated through itemsMeta). Bundles/packages keep an external URL instead.
 */
export async function storeSection(
  id: string,
  lang: string,
  start = 0,
  count = 50
): Promise<StoreSectionPage> {
  const { l, cc } = await region(lang);
  const filter = sectionFilter(id, cc);
  if (!filter) throw new Error(`Unknown store section: ${id}`);

  const key = `section:${lang}:${cc}:${id}:${start}:${count}`;
  const cached = cacheGet<StoreSectionPage>(key);
  if (cached) return cached;
  const url =
    `https://store.steampowered.com/search/results/?json=1&start=${start}&count=${count}` +
    `&${filter}&l=${l}&cc=${cc}`;
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
        url: p.url,
      };
    })
  );

  const page = { items, hasMore: raw.length >= count };
  cacheSet(key, page);
  return page;
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
  const { l, cc } = await region(lang);
  const key = `details:${lang}:${cc}:${appid}`;
  const cached = cacheGet<GameDetails>(key);
  if (cached) return cached;

  const [detailsDoc, reviewsDoc, playersDoc] = await Promise.all([
    getJson<any>(`${STORE_API}/appdetails?appids=${appid}&l=${l}&cc=${cc}`),
    getJson<any>(
      `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`
    ).catch(() => null),
    getJson<any>(
      `${WEB_API}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`
    ).catch(() => null),
  ]);

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

  cacheSet(key, details);
  return details;
}
