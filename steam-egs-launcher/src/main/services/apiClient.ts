import { buildLibrary } from './library';
import { getEntries, setEpicStoreUrl } from './localData';
import { resolveEpicStoreUrl } from './epicStore';
import { ACHIEVEMENTS_PATH_RE } from './bridge';
import {
  epicAccount,
  epicAuthWithCode,
  epicImportFromLauncher,
  epicLogout,
  epicSync,
  LOGIN_URL,
  setEpicCountry,
} from './epicSync';
import {
  saveSteamCredentials,
  setSteamCountry,
  steamAccount,
  steamAchievements,
  steamRecent,
  syncSteamLibrary,
} from './steamSync';
import { requireAppId } from './validate';

// The launcher's local API: the `/api/*` contract the renderer and the shared
// client speak, dispatched to in-process implementations (library in userData,
// syncs in the services). The launcher has no backend — this module is what
// used to be an HTTP call to one.

export interface ApiRequestInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export async function apiFetch<T = unknown>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const url = new URL(path, 'http://local');
  const method = (init.method ?? 'GET').toUpperCase();
  const body = init.body ? (JSON.parse(init.body) as Record<string, string>) : {};
  const route = `${method} ${url.pathname}`;

  const result = await dispatch(route, url, body);
  return result as T;
}

async function dispatch(
  route: string,
  url: URL,
  body: Record<string, string>
): Promise<unknown> {
  switch (route) {
    // ----- library -----
    case 'GET /api/library':
      return buildLibrary();

    // ----- Steam -----
    case 'GET /api/steam/account':
      return steamAccount();
    case 'POST /api/steam/credentials':
      return saveSteamCredentials(body.apiKey ?? '', body.steamId ?? '');
    case 'POST /api/steam/sync':
      return syncSteamLibrary();
    case 'POST /api/steam/region':
      return setSteamCountry(body.country ?? '');
    case 'GET /api/steam/recent':
      return steamRecent();

    // ----- Epic -----
    case 'GET /api/epic/account':
      return epicAccount();
    case 'GET /api/epic/login-url':
      return { loginUrl: LOGIN_URL };
    case 'POST /api/epic/auth':
      return epicAuthWithCode(body.authorizationCode ?? '');
    case 'POST /api/epic/import-launcher':
      return epicImportFromLauncher();
    case 'POST /api/epic/sync':
      return epicSync();
    case 'POST /api/epic/region':
      return setEpicCountry(body.country ?? '');
    case 'POST /api/epic/logout':
      return epicLogout();
    case 'GET /api/epic/store-url':
      return epicStoreUrl(url.searchParams.get('ns') ?? '', url.searchParams.get('title') ?? '');
  }

  const achievements = url.pathname.match(ACHIEVEMENTS_PATH_RE);
  if (achievements && route.startsWith('GET ')) {
    return steamAchievements(
      requireAppId(achievements[1]),
      url.searchParams.get('lang') ?? undefined
    );
  }

  throw new Error(`Unknown local API route: ${route}`);
}

/** Lazy Epic product-URL resolution with the namespace-level cache. */
async function epicStoreUrl(ns: string, title: string): Promise<{ url: string }> {
  const fallback =
    `https://store.epicgames.com/browse?q=${encodeURIComponent(title)}` +
    '&sortBy=relevancy&sortDir=DESC';
  if (!ns) return { url: fallback };

  const cached = getEntries().find(
    (e) => e.source === 'Epic' && e.namespace === ns && e.storeUrl
  )?.storeUrl;
  if (cached) return { url: cached };

  const resolved = await resolveEpicStoreUrl(ns, title);
  if (!resolved) return { url: fallback }; // transient — retried on next click
  setEpicStoreUrl(ns, resolved);
  return { url: resolved };
}
