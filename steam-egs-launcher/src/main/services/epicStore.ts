// Epic Games Store public GraphQL (store.epicgames.com/graphql). Provides
// offer details (description, images, price) for the game page's Epic tab and
// the Steam↔Epic price comparison.
//
// IMPORTANT: Cloudflare in front of this endpoint blocks non-browser TLS
// fingerprints (Node fetch/undici and even .NET get 403). Electron's Chromium
// network stack passes, so requests go through session.fetch with a Chrome-like
// UA (verified: direct 200). If a 403 ever appears, a hidden window loads the
// store once to settle the challenge cookie, then the request is retried.

import { BrowserWindow, session, type Session } from 'electron';
import { normalizeTitle } from '@app/shared';
import { getStoreCacheTtlMs } from '../config';
import { cached } from './cache';
import { getRegions } from './regions';

const GRAPHQL_URL = 'https://store.epicgames.com/graphql';
const PARTITION = 'persist:epicstore';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface EpicPrice {
  /** Prices in cents. */
  final: number | null;
  initial: number | null;
  discountPct?: number;
  formattedFinal?: string | null;
  formattedOriginal?: string | null;
  currency?: string;
}

export interface EpicDetails {
  title: string;
  namespace?: string | null;
  description?: string | null;
  developer?: string | null;
  publisher?: string | null;
  genres: string[];
  platforms: string[];
  /** EGS community rating, 0–5 (RatingsPolls). */
  rating?: number | null;
  releaseDate?: string | null;
  /** Wide cover for the header. */
  image?: string | null;
  /** Gallery images (key images incl. screenshots when present). */
  images: string[];
  price?: EpicPrice | null;
  isFree?: boolean;
  /** Product page URL (buy link). */
  storeUrl?: string | null;
}

// Cache namespace (userData/cache/epicStore.json); null results ARE cached —
// a game absent from EGS shouldn't be re-searched on every visit.
const NS = 'epicStore';

// Locale follows the UI language; the country (→ currency, regional prices)
// comes from the local EGS account country (fallback US).
function region(lang: string): { country: string; locale: string } {
  return { country: getRegions().epicCc, locale: lang === 'ru' ? 'ru' : 'en-US' };
}

// Same key cross-store matching uses everywhere (see @app/shared/matching).
const normalize = normalizeTitle;

/* eslint-disable @typescript-eslint/no-explicit-any */

function epicSession(): Session {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(CHROME_UA);
  return ses;
}

// In-flight priming run, so concurrent 403s wait for the same challenge
// instead of retrying before the cookie exists. Cleared afterwards: the
// challenge cookie expires, and the recovery path must stay available.
let priming: Promise<void> | null = null;

/** Loads the store once in a hidden window so a Cloudflare challenge can settle. */
function primeCloudflare(): Promise<void> {
  priming ??= (async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION } });
    try {
      win.webContents.setUserAgent(CHROME_UA);
      await win.loadURL('https://store.epicgames.com/');
      await new Promise((r) => setTimeout(r, 6000));
    } catch {
      /* best effort */
    } finally {
      win.destroy();
      priming = null;
    }
  })();
  return priming;
}

async function graphqlOnce(query: string, variables: Record<string, unknown>): Promise<Response> {
  return epicSession().fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': CHROME_UA,
      Origin: 'https://store.epicgames.com',
      Referer: 'https://store.epicgames.com/',
    },
    body: JSON.stringify({ query, variables }),
  });
}

async function graphql(query: string, variables: Record<string, unknown>): Promise<any> {
  let res = await graphqlOnce(query, variables);
  if (res.status === 403) {
    // Chromium's fingerprint normally passes; if CF still challenges, settle
    // the challenge cookie in a hidden window and retry once.
    await primeCloudflare();
    res = await graphqlOnce(query, variables);
  }
  if (!res.ok) throw new Error(`Epic GraphQL failed: HTTP ${res.status}`);
  return await res.json();
}

const ELEMENT_FIELDS = `
  title
  namespace
  description
  effectiveDate
  keyImages { type url }
  seller { name }
  developerDisplayName
  publisherDisplayName
  tags { name groupName }
  productSlug
  urlSlug
  categories { path }
  catalogNs { mappings(pageType: "productHome") { pageSlug } }
  price(country: $country) {
    totalPrice {
      discountPrice
      originalPrice
      currencyCode
      fmtPrice(locale: $locale) { originalPrice discountPrice }
    }
  }
`;

const RATING_QUERY = `
  query($sandboxId: String!, $locale: String!) {
    RatingsPolls { getProductResult(sandboxId: $sandboxId, locale: $locale) { averageRating } }
  }
`;

const OFFERS_QUERY = `
  query($ns: String!, $country: String!, $locale: String!) {
    Catalog {
      catalogOffers(namespace: $ns, params: { count: 75, country: $country, locale: $locale }) {
        elements { ${ELEMENT_FIELDS} }
      }
    }
  }
`;

const SEARCH_QUERY = `
  query($keywords: String!, $country: String!, $locale: String!) {
    Catalog {
      searchStore(
        keywords: $keywords, country: $country, locale: $locale, count: 10,
        category: "games/edition/base|bundles/games|editors|software/edition/base"
      ) {
        elements { ${ELEMENT_FIELDS} }
      }
    }
  }
`;

function pickElement(elements: any[], title: string): any | null {
  if (!elements?.length) return null;
  const want = normalize(title);
  // Exact normalized-title match only — a wrong match would produce a bogus
  // price comparison, which is worse than none.
  return elements.find((el) => el?.title && normalize(el.title) === want) ?? null;
}

function mapElement(el: any): EpicDetails {
  const images: string[] = [];
  let wide: string | null = null;
  for (const img of el.keyImages ?? []) {
    if (!img?.url) continue;
    if (!wide && (img.type === 'OfferImageWide' || img.type === 'DieselStoreFrontWide')) wide = img.url;
    if (['Screenshot', 'featuredMedia'].includes(img.type)) {
      if (!images.includes(img.url)) images.push(img.url);
    }
  }

  const tags: { name?: string; groupName?: string }[] = el.tags ?? [];
  const byGroup = (group: string) =>
    tags.filter((t) => t.groupName === group && t.name).map((t) => t.name as string);

  const tp = el.price?.totalPrice;
  const final = tp?.discountPrice ?? null;
  const initial = tp?.originalPrice ?? null;
  const price: EpicPrice | null = tp
    ? {
        final,
        initial,
        discountPct:
          initial != null && final != null && initial > final && initial > 0
            ? Math.round((1 - final / initial) * 100)
            : undefined,
        formattedFinal: tp.fmtPrice?.discountPrice ?? null,
        formattedOriginal: tp.fmtPrice?.originalPrice ?? null,
        currency: tp.currencyCode,
      }
    : null;

  const slug =
    el.catalogNs?.mappings?.[0]?.pageSlug ??
    (el.productSlug ? String(el.productSlug).split('/')[0] : null) ??
    el.urlSlug ??
    null;

  return {
    title: el.title,
    namespace: el.namespace ?? null,
    description: el.description ?? null,
    developer: el.developerDisplayName ?? el.seller?.name ?? null,
    publisher: el.publisherDisplayName ?? el.seller?.name ?? null,
    genres: byGroup('genre'),
    platforms: byGroup('platform'),
    rating: null, // filled separately (RatingsPolls)
    releaseDate: el.effectiveDate ? String(el.effectiveDate).slice(0, 10) : null,
    image: wide ?? images[0] ?? null,
    images,
    price,
    isFree: final === 0,
    storeUrl: slug ? `https://store.epicgames.com/p/${slug}` : null,
  };
}

/** EGS community rating (0–5) via RatingsPolls; best effort. */
async function fetchRating(namespace: string, locale: string): Promise<number | null> {
  try {
    const resp = await graphql(RATING_QUERY, { sandboxId: namespace, locale });
    const avg = resp?.data?.RatingsPolls?.getProductResult?.averageRating;
    return typeof avg === 'number' ? avg : null;
  } catch {
    return null;
  }
}

/**
 * Gallery fallback for products whose offer carries no screenshots: the new
 * EGS product pages embed their media in the page state — extract the
 * spt-assets image URLs straight from the HTML (verified: 10–13 per game).
 */
async function fetchHtmlGallery(storeUrl: string): Promise<string[]> {
  try {
    const res = await epicSession().fetch(storeUrl, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/html' },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const urls = [
      ...new Set(
        [...html.matchAll(/https:\/\/cdn1\.epicgames\.com\/spt-assets\/[^"'\\\s)]+?\.(?:jpg|jpeg|png|webp)/g)].map(
          (m) => m[0]
        )
      ),
    ];
    return urls.slice(0, 12);
  } catch {
    return [];
  }
}

/**
 * Product-page URL for a library game — resolved lazily on click (avoids a
 * Cloudflare 403 burst during sync). Prefers the offer whose normalized title
 * matches; falls back to the namespace's first offer. Null when unresolvable
 * (the caller decides on a search-page fallback and skips caching it).
 */
export async function resolveEpicStoreUrl(ns: string, title: string): Promise<string | null> {
  try {
    const { country, locale } = region('en');
    const resp = await graphql(OFFERS_QUERY, { ns, country, locale });
    const elements = resp?.data?.Catalog?.catalogOffers?.elements ?? [];
    const el = pickElement(elements, title) ?? elements[0] ?? null;
    return (el ? mapElement(el).storeUrl : null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Epic offer details for a game: by namespace when known (library games),
 * otherwise a title search with exact normalized-title matching. Returns null
 * when nothing convincingly matches. Cached (null results too — a game absent
 * from EGS shouldn't be re-searched on every visit).
 */
export async function epicStoreDetails(
  title: string,
  ns: string | null,
  lang: string
): Promise<EpicDetails | null> {
  const { country, locale } = region(lang);
  const key = `epic:${lang}:${country}:${ns ?? ''}:${normalize(title)}`;
  try {
    return await cached(NS, key, getStoreCacheTtlMs(), () =>
      fetchDetails(title, ns, country, locale)
    );
  } catch {
    return null; // transient (throttling etc.) — not cached, retried next visit
  }
}

/** Resolves the offer; throws on transient failures so they aren't cached. */
async function fetchDetails(
  title: string,
  ns: string | null,
  country: string,
  locale: string
): Promise<EpicDetails | null> {
  let data: EpicDetails | null = null;

  let sawErrors = false;
  if (ns) {
    try {
      const resp = await graphql(OFFERS_QUERY, { ns, country, locale });
      if (resp?.errors?.length && !resp?.data) sawErrors = true;
      const el = pickElement(resp?.data?.Catalog?.catalogOffers?.elements ?? [], title);
      if (el) data = mapElement(el);
    } catch {
      sawErrors = true; // fall through to the title search
    }
  }
  if (!data) {
    const resp = await graphql(SEARCH_QUERY, { keywords: title, country, locale });
    if (resp?.errors?.length && !resp?.data) sawErrors = true;
    const el = pickElement(resp?.data?.Catalog?.searchStore?.elements ?? [], title);
    if (el) data = mapElement(el);
  }
  // A GraphQL-level failure isn't a legit "not on EGS" — don't cache it.
  if (!data && sawErrors) throw new Error('Epic GraphQL degraded');

  if (data) {
    // Rating + gallery enrichment (parallel, best effort).
    const [rating, htmlGallery] = await Promise.all([
      data.namespace ? fetchRating(data.namespace, locale) : Promise.resolve(null),
      data.images.length < 3 && data.storeUrl ? fetchHtmlGallery(data.storeUrl) : Promise.resolve([]),
    ]);
    data.rating = rating;
    for (const url of htmlGallery) {
      if (!data.images.includes(url)) data.images.push(url);
    }
  }

  return data;
}
