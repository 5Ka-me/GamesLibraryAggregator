// Shared API client. The low-level transport is injectable so the same `api`
// surface works both in the browser (direct HTTP to the web backend, session
// cookie auth) and inside the Electron launcher (calls proxied over IPC to the
// main process, which implements the same contract locally).

import type { Source } from '../sources';

export type { Source };

export interface GameEntry {
  source: Source;
  iconUrl?: string | null;
  storeUrl?: string | null;
  namespace?: string | null;
  playtimeMinutes?: number | null;
  acquisitionDate?: string | null;
  /** Steam only: last launch, ISO. */
  lastPlayedAt?: string | null;
  /** Steam only: minutes in the last two weeks. */
  playtime2WeeksMinutes?: number | null;
  /** Steam only: lifetime minutes on Steam Deck. */
  playtimeDeckMinutes?: number | null;
  /** Small square icon for list rows (Steam client icon); absent until synced. */
  smallIconUrl?: string | null;
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
  /** Steam avatar URL (medium) when known. */
  avatarUrl?: string | null;
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
  /** Hidden in the schema (spoiler) — masked in the UI until clicked. */
  hidden?: boolean;
}

export interface SteamGameAchievements {
  available: boolean;
  /** When unavailable: no usable Steam sign-in vs. Steam has no data for this game/profile. */
  reason?: 'auth' | 'unavailable';
  gameName?: string | null;
  total: number;
  unlocked: number;
  achievements: SteamAchievement[];
}

/** Whole-library achievement progress row (IPlayerService/GetAchievementsProgress). */
export interface SteamAchievementProgress {
  appId: number;
  unlocked: number;
  total: number;
  /** 0–100. */
  percentage: number;
  allUnlocked: boolean;
}

/** Daily playtime snapshots kept by the launcher (see main/services/playtimeHistory.ts). */
export interface PlaytimeHistory {
  version: 1;
  /** YYYY-MM-DD → `S:<appid>` | `E:<catalogItemId>` → total minutes that day. */
  days: Record<string, Record<string, number>>;
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

const API_BASE = envBase ?? 'http://localhost:5080';

// ===================== Default HTTP transport (browser) =====================

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
  if (res.status === 204) return undefined as T; // No Content (e.g. logout)
  return res.json() as Promise<T>;
}

// Auth is a signed HTTP-only session cookie set by the Steam OpenID sign-in —
// nothing to attach here beyond credentials.
const httpTransport: ApiTransport = async <T>(path: string, init: ApiRequestInit = {}): Promise<T> => {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method,
    body: init.body,
    headers: init.headers,
    credentials: 'include',
  });
  return parse<T>(res);
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

/** Who am I (web session). */
export interface Me {
  authenticated: boolean;
  steamId?: string | null;
  personaName?: string | null;
}

/** The backend's Steam OpenID sign-in entry point (browser navigation target). */
export function steamLoginUrl(): string {
  return `${API_BASE}/auth/steam/login`;
}

export const api = {
  getCombinedLibrary: () => getJson<Game[]>('/api/library'),

  // Web session (browser only; the launcher is its own auth world).
  getMe: () => getJson<Me>('/api/me'),
  logout: () => postJson<void>('/auth/logout'),

  // ---- Launcher-only below ----
  // These are served by the launcher's in-process router (IPC transport), NOT
  // by the web backend — calling them from the browser would 404.

  // Steam
  getSteamAccount: () => getJson<SteamAccount>('/api/steam/account'),
  saveSteamCredentials: (apiKey: string, steamId: string) =>
    postJson<SteamAccount>('/api/steam/credentials', { apiKey, steamId }),
  syncSteam: () => postJson<{ count: number }>('/api/steam/sync'),
  setSteamRegion: (country: string) => postJson<SteamAccount>('/api/steam/region', { country }),
  getSteamRecent: () => getJson<SteamRecentGame[]>('/api/steam/recent'),
  /** Launcher only: unlocked/total for many Steam games in a few batched requests. */
  getSteamAchievementsProgress: (appIds: number[]) =>
    postJson<SteamAchievementProgress[]>('/api/steam/achievements/progress', { appIds: appIds.join(',') }),
  /** Launcher only: the daily playtime snapshots the launcher records on each sync. */
  getPlaytimeHistory: () => getJson<PlaytimeHistory>('/api/stats/playtime-history'),
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
  logoutEpic: () => postJson<void>('/api/epic/logout'),
  setEpicRegion: (country: string) => postJson<EpicAccount>('/api/epic/region', { country }),
  resolveEpicStoreUrl: (ns: string, title: string) =>
    getJson<{ url: string }>(
      `/api/epic/store-url?ns=${encodeURIComponent(ns)}&title=${encodeURIComponent(title)}`
    ),
};
