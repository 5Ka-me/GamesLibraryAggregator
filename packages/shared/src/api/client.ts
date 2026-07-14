// Shared API client. The low-level transport is injectable so the same `api`
// surface works both in the browser (direct HTTP + workspace token in
// localStorage) and inside the Electron launcher (calls proxied to the main
// process, which owns the token and talks to the .NET API without CORS).

import type { Source } from '../sources';

export type { Source };

export interface GameEntry {
  source: Source;
  iconUrl?: string | null;
  storeUrl?: string | null;
  namespace?: string | null;
  playtimeMinutes?: number | null;
  acquisitionDate?: string | null;
  launchUrl?: string | null;
  installUrl?: string | null;
}

export interface Game {
  title: string;
  iconUrl?: string | null;
  sources: Source[];
  entries: GameEntry[];
}

export interface EpicAuthResult {
  success: boolean;
  requiresLogin: boolean;
  displayName?: string | null;
  gameCount: number;
  loginUrl?: string | null;
  message?: string | null;
}

export interface SteamAccount {
  configured: boolean;
  steamId?: string | null;
  personaName?: string | null;
  /** Store region (ISO alpha-2) used for prices; null → US fallback. */
  country?: string | null;
}

export interface EpicAccount {
  connected: boolean;
  displayName?: string | null;
  /** Account country (ISO alpha-2) used for prices; null → US fallback. */
  country?: string | null;
}

export interface SteamRecentGame {
  appId: number;
  name: string;
  playtime2Weeks: number;
  playtimeForever: number;
  iconUrl?: string | null;
}

export interface SteamAchievement {
  name: string;
  displayName?: string | null;
  description?: string | null;
  icon?: string | null;
  iconGray?: string | null;
  unlocked: boolean;
  unlockTime?: string | null;
  globalPct?: number | null;
}

export interface SteamGameAchievements {
  available: boolean;
  gameName?: string | null;
  total: number;
  unlocked: number;
  achievements: SteamAchievement[];
}

// Minimal, structured-clone-safe request shape (so it can cross the IPC bridge).
export interface ApiRequestInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/** A transport turns a request into a parsed JSON response (or throws). */
export type ApiTransport = <T>(path: string, init?: ApiRequestInit) => Promise<T>;

// ===================== Configuration =====================

// In the CRA web build, `process.env.REACT_APP_API_URL` is inlined at build
// time. In the Electron renderer (Vite) `process` is undefined — but there the
// HTTP transport is never used (a proxy transport is injected), so the default
// is harmless.
const envBase =
  typeof process !== 'undefined' && process.env ? process.env.REACT_APP_API_URL : undefined;

let API_BASE = envBase ?? 'http://localhost:5080';

/** Override the backend base URL at runtime (used by the launcher/tests). */
export function configureApiBase(url: string): void {
  API_BASE = url;
}

// ===================== Workspace token (browser) =====================

const TOKEN_KEY = 'workspaceToken';
const hasLocalStorage = typeof localStorage !== 'undefined';

export const workspace = {
  getToken: () => (hasLocalStorage ? localStorage.getItem(TOKEN_KEY) : null),
  setToken: (t: string) => {
    if (hasLocalStorage) localStorage.setItem(TOKEN_KEY, t.trim());
  },
  clear: () => {
    if (hasLocalStorage) localStorage.removeItem(TOKEN_KEY);
  },
};

// ===================== Default HTTP transport =====================

let creating: Promise<string> | null = null;

async function ensureToken(): Promise<string> {
  const existing = workspace.getToken();
  if (existing) return existing;
  if (!creating) {
    creating = fetch(`${API_BASE}/api/workspace`, { method: 'POST' })
      .then((r) => {
        if (!r.ok) throw new Error(`workspace create failed: ${r.status}`);
        return r.json();
      })
      .then((d: { token: string }) => {
        workspace.setToken(d.token);
        creating = null;
        return d.token;
      })
      .catch((e) => {
        creating = null;
        throw e;
      });
  }
  return creating;
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = await res.text();
    try {
      detail = JSON.parse(detail).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(detail || `${res.status}`);
  }
  return res.json() as Promise<T>;
}

const httpTransport: ApiTransport = async <T>(path: string, init: ApiRequestInit = {}): Promise<T> => {
  const run = async (retry: boolean): Promise<T> => {
    const token = await ensureToken();
    const headers = new Headers(init.headers);
    headers.set('X-Workspace-Token', token);

    const res = await fetch(`${API_BASE}${path}`, {
      method: init.method,
      body: init.body,
      headers,
    });
    if (res.status === 401 && retry) {
      // The token is no longer valid (e.g. the DB was recreated) — recreate and retry once.
      workspace.clear();
      return run(false);
    }
    return parse<T>(res);
  };
  return run(true);
};

let transport: ApiTransport = httpTransport;

/** Replace the transport (the launcher injects an IPC proxy to the main process). */
export function configureTransport(t: ApiTransport): void {
  transport = t;
}

const getJson = <T,>(path: string) => transport<T>(path);
const postJson = <T,>(path: string, body?: unknown) =>
  transport<T>(path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

export const api = {
  getCombinedLibrary: () => getJson<Game[]>('/api/library'),

  // Steam
  getSteamAccount: () => getJson<SteamAccount>('/api/steam/account'),
  saveSteamCredentials: (apiKey: string, steamId: string) =>
    postJson<SteamAccount>('/api/steam/credentials', { apiKey, steamId }),
  syncSteam: () => postJson<{ count: number }>('/api/steam/sync'),
  setSteamRegion: (country: string) => postJson<SteamAccount>('/api/steam/region', { country }),
  getSteamRecent: () => getJson<SteamRecentGame[]>('/api/steam/recent'),
  getSteamAchievements: (appId: number, lang?: string) =>
    getJson<SteamGameAchievements>(
      `/api/steam/achievements/${appId}${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`
    ),

  // Epic
  getEpicAccount: () => getJson<EpicAccount>('/api/epic/account'),
  getEpicLoginUrl: () => getJson<{ loginUrl: string }>('/api/epic/login-url'),
  authEpicWithCode: (authorizationCode: string) =>
    postJson<EpicAuthResult>('/api/epic/auth', { authorizationCode }),
  importEpicLauncher: () => postJson<EpicAuthResult>('/api/epic/import-launcher'),
  syncEpic: () => postJson<EpicAuthResult>('/api/epic/sync'),
  setEpicRegion: (country: string) => postJson<EpicAccount>('/api/epic/region', { country }),
  resolveEpicStoreUrl: (ns: string, title: string) =>
    getJson<{ url: string }>(
      `/api/epic/store-url?ns=${encodeURIComponent(ns)}&title=${encodeURIComponent(title)}`
    ),
};
