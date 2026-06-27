// Base URL of the backend (.NET API). Can be overridden via REACT_APP_API_URL.
const API_BASE = process.env.REACT_APP_API_URL ?? 'http://localhost:5080';
const TOKEN_KEY = 'workspaceToken';

export type Source = 'Steam' | 'Epic';

export interface GameEntry {
  source: Source;
  iconUrl?: string | null;
  storeUrl?: string | null;
  namespace?: string | null;
  playtimeMinutes?: number | null;
  acquisitionDate?: string | null;
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
}

export interface EpicAccount {
  connected: boolean;
  displayName?: string | null;
}

// ===================== Workspace token management =====================

export const workspace = {
  getToken: () => localStorage.getItem(TOKEN_KEY),
  setToken: (t: string) => localStorage.setItem(TOKEN_KEY, t.trim()),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

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

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const token = await ensureToken();
  const headers = new Headers(init.headers);
  headers.set('X-Workspace-Token', token);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401 && retry) {
    // The token is no longer valid (e.g. the DB was recreated) — create a new one and retry once.
    workspace.clear();
    return request<T>(path, init, false);
  }
  return parse<T>(res);
}

const getJson = <T,>(path: string) => request<T>(path);
const postJson = <T,>(path: string, body?: unknown) =>
  request<T>(path, {
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

  // Epic
  getEpicAccount: () => getJson<EpicAccount>('/api/epic/account'),
  getEpicLoginUrl: () => getJson<{ loginUrl: string }>('/api/epic/login-url'),
  authEpicWithCode: (authorizationCode: string) =>
    postJson<EpicAuthResult>('/api/epic/auth', { authorizationCode }),
  importEpicLauncher: () => postJson<EpicAuthResult>('/api/epic/import-launcher'),
  syncEpic: () => postJson<EpicAuthResult>('/api/epic/sync'),
  resolveEpicStoreUrl: (ns: string, title: string) =>
    getJson<{ url: string }>(
      `/api/epic/store-url?ns=${encodeURIComponent(ns)}&title=${encodeURIComponent(title)}`
    ),
};
