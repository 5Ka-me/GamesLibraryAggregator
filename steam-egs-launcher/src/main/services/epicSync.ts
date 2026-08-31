import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import {
  clearEpicSession,
  getEpicSession,
  setEpicSession,
  type EpicSessionSecret,
} from './secretStore';
import {
  clearStore,
  getEpicAccount,
  replaceEntries,
  updateEpicAccount,
  type StoredEntry,
} from './localData';
import { httpJson } from './http';
import { normalizeCountry } from './validate';

// EGS account + library sync (the launcher's own implementation — the app has
// no backend). Talks to the same private Epic Launcher endpoints legendary
// uses: these are NOT behind Cloudflare's browser check, unlike
// store.epicgames.com, so plain fetch works as long as the launcher
// User-Agent is sent. Tokens live in the OS keystore via secretStore; library
// entries land in localData.

const execFileAsync = promisify(execFile);

// Public Epic Games Launcher client credentials (the same pair legendary and
// every other open-source launcher ships) — not a secret.
const CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';

const AUTH_TOKEN_URL =
  'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token';
const ACCOUNT_URL = 'https://account-public-service-prod03.ol.epicgames.com/account/api/public/account';
const LIBRARY_HOST = 'library-service.live.use1a.on.epicgames.com';
const CATALOG_HOST = 'catalog-public-service-prod06.ol.epicgames.com';
const LAUNCHER_UA =
  'UELauncher/14.0.8-22004686+++Portal+Release-Live Windows/10.0.19041.1.256.64bit';

/** Host that serves Epic's login + code-redirect pages (auth window is locked to it). */
export const EPIC_LOGIN_HOST = 'www.epicgames.com';
export const REDIRECT_URL = `https://${EPIC_LOGIN_HOST}/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`;
export const LOGIN_URL = `https://${EPIC_LOGIN_HOST}/id/login?redirectUrl=${encodeURIComponent(REDIRECT_URL)}`;

export interface EpicAuthResult {
  success: boolean;
  requiresLogin: boolean;
  displayName?: string | null;
  gameCount: number;
  loginUrl?: string | null;
  message?: string | null;
}

const requireLogin = (message: string): EpicAuthResult => ({
  success: false,
  requiresLogin: true,
  gameCount: 0,
  loginUrl: LOGIN_URL,
  message,
});

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------- OAuth ----------

interface EpicTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: string;
  refresh_expires?: number;
  refresh_expires_at?: string;
  account_id: string;
  displayName?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<EpicTokenResponse> {
  const res = await fetch(AUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': LAUNCHER_UA,
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  // The body can echo the submitted code/token — never put it in the message.
  if (!res.ok) throw new Error(`Epic authentication failed (HTTP ${res.status}).`);
  return (await res.json()) as EpicTokenResponse;
}

const exchangeCode = (code: string) =>
  tokenRequest({ grant_type: 'authorization_code', code: code.trim(), token_type: 'eg1' });

const refreshToken = (token: string) =>
  tokenRequest({ grant_type: 'refresh_token', refresh_token: token, token_type: 'eg1' });

// Epic omits the lifetime fields on some responses; falling back to "now"
// would mark a perfectly good session as expired, so assume the documented
// defaults instead (1 h access / 30 d refresh).
const DEFAULT_ACCESS_TTL_S = 3600;
const DEFAULT_REFRESH_TTL_S = 30 * 24 * 3600;

function expiryIso(explicit: string | undefined, seconds: number | undefined, fallbackS: number): string {
  if (explicit) return explicit;
  const ttl = typeof seconds === 'number' && seconds > 0 ? seconds : fallbackS;
  return new Date(Date.now() + ttl * 1000).toISOString();
}

function saveSession(token: EpicTokenResponse): EpicSessionSecret {
  const session: EpicSessionSecret = {
    accountId: token.account_id,
    displayName: token.displayName ?? getEpicSession()?.displayName ?? null,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    accessExpiresAt: expiryIso(token.expires_at, token.expires_in, DEFAULT_ACCESS_TTL_S),
    refreshExpiresAt: expiryIso(token.refresh_expires_at, token.refresh_expires, DEFAULT_REFRESH_TTL_S),
  };
  setEpicSession(session);
  return session;
}

const msUntil = (iso: string): number => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t - Date.now() : -1; // unparsable → treat as expired
};

// Epic rotates the refresh token on every use, so two concurrent refreshes
// (autosync + a manual sync, say) would invalidate each other and silently log
// the user out. All refreshes funnel through this single in-flight promise.
let refreshing: Promise<EpicSessionSecret | null> | null = null;

/** Valid access token from the stored session (auto-refresh, 60 s margin). */
async function getValidAccessToken(): Promise<{ token: string; accountId: string } | null> {
  const session = getEpicSession();
  if (!session) return null;
  if (msUntil(session.accessExpiresAt) > 60_000) {
    return { token: session.accessToken, accountId: session.accountId };
  }
  if (msUntil(session.refreshExpiresAt) <= 0) return null;

  refreshing ??= (async () => {
    try {
      // Re-read: another caller may have refreshed while we waited.
      const current = getEpicSession();
      if (!current) return null;
      if (msUntil(current.accessExpiresAt) > 60_000) return current;
      return saveSession(await refreshToken(current.refreshToken));
    } catch {
      return null; // refresh failed → re-login required
    } finally {
      refreshing = null;
    }
  })();

  const refreshed = await refreshing;
  return refreshed ? { token: refreshed.accessToken, accountId: refreshed.accountId } : null;
}

// ---------- account country (fill only if empty) ----------

async function detectCountry(accountId: string, token: string): Promise<void> {
  if (getEpicAccount().country) return; // never clobber (incl. manual override)
  try {
    const json = await httpJson<any>(`${ACCOUNT_URL}/${encodeURIComponent(accountId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': LAUNCHER_UA },
    });
    if (typeof json?.country === 'string' && /^[A-Za-z]{2}$/.test(json.country)) {
      updateEpicAccount({ country: json.country.toUpperCase() });
    }
  } catch {
    /* best effort */
  }
}

// ---------- library ----------

interface LibraryRecord {
  appName?: string;
  catalogItemId?: string;
  namespace?: string;
  acquisitionDate?: string;
  sandboxType?: string;
}

/** Hard stop for the cursor loop — a repeating cursor must not spin forever. */
const MAX_LIBRARY_PAGES = 100;

async function fetchRawLibrary(token: string): Promise<LibraryRecord[]> {
  const records: LibraryRecord[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIBRARY_PAGES; page++) {
    const url =
      `https://${LIBRARY_HOST}/library/api/public/items?includeMetadata=true` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const json = await httpJson<any>(url, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': LAUNCHER_UA },
    });
    records.push(...(json?.records ?? []));

    cursor = json?.responseMetadata?.nextCursor || undefined;
    if (!cursor || seenCursors.has(cursor)) return records;
    seenCursors.add(cursor);
  }
  console.warn(`[epic] library paging stopped at ${MAX_LIBRARY_PAGES} pages`);
  return records;
}

interface CatalogDetails {
  title: string;
  imageUrl: string | null;
  isDlc: boolean;
  categories: string[];
}

// keyImages preference — same order the backend used.
const IMAGE_PREFERENCE = [
  'DieselGameBoxTall',
  'OfferImageTall',
  'Thumbnail',
  'DieselGameBox',
  'OfferImageWide',
];

function pickImage(keyImages: any[]): string | null {
  const byType = new Map<string, string>();
  for (const img of keyImages ?? []) {
    if (img?.type && img?.url && !byType.has(img.type)) byType.set(img.type, img.url);
  }
  for (const type of IMAGE_PREFERENCE) {
    const url = byType.get(type);
    if (url) return resizeEpicImage(url);
  }
  const first = byType.values().next();
  return first.done ? null : resizeEpicImage(first.value);
}

function resizeEpicImage(url: string): string {
  return url.includes('epicgames.com') && !url.includes('?')
    ? `${url}?h=400&w=300&resize=1&quality=medium`
    : url;
}

async function fetchCatalogDetails(
  token: string,
  namespace: string,
  catalogItemId: string
): Promise<CatalogDetails | null> {
  const url =
    `https://${CATALOG_HOST}/catalog/api/shared/namespace/${encodeURIComponent(namespace)}` +
    `/items/${encodeURIComponent(catalogItemId)}` +
    `?includeMainGameDetails=true&country=US&locale=en-US`;
  let json: any;
  try {
    json = await httpJson<any>(url, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': LAUNCHER_UA },
    });
  } catch {
    return null;
  }
  if (!json?.title) return null;
  return {
    title: json.title,
    imageUrl: pickImage(json.keyImages),
    isDlc: json.mainGameItem != null,
    categories: (json.categories ?? [])
      .map((c: any) => String(c?.path ?? ''))
      .filter(Boolean),
  };
}

async function fetchPlaytime(token: string, accountId: string): Promise<Map<string, number>> {
  const minutes = new Map<string, number>();
  if (!accountId) return minutes;
  try {
    const rows = await httpJson<any[]>(
      `https://${LIBRARY_HOST}/library/api/public/playtime/account/${encodeURIComponent(accountId)}/all`,
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': LAUNCHER_UA } }
    );
    for (const row of rows ?? []) {
      const artifactId = row?.artifactId;
      const seconds = Number(row?.totalTime ?? 0);
      if (typeof artifactId === 'string' && seconds > 0) {
        minutes.set(artifactId.toLowerCase(), Math.floor(seconds / 60));
      }
    }
  } catch {
    /* playtime is best effort — never blocks the sync */
  }
  return minutes;
}

/** True for entries legendary would call a game (not UE/DLC/mod/asset). */
function isGame(details: CatalogDetails): boolean {
  if (details.isDlc) return false;
  const paths = details.categories.map((p) => p.toLowerCase());
  if (paths.includes('mods')) return false;
  return paths.some((p) => p === 'games' || p.startsWith('games/'));
}

/** Map N items through fn with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Full library sync with the given access token → stored entry count. */
async function syncLibrary(token: string, accountId: string): Promise<number> {
  const raw = await fetchRawLibrary(token);

  // Pre-catalog filters: UE marketplace, private sandboxes, dups.
  const seen = new Set<string>();
  const candidates = raw.filter((item) => {
    if (item.namespace === 'ue') return false;
    if (item.sandboxType === 'PRIVATE') return false;
    if (!item.catalogItemId) return false;
    if (seen.has(item.catalogItemId)) return false;
    seen.add(item.catalogItemId);
    return true;
  });

  const playtime = await fetchPlaytime(token, accountId);

  // Catalog details: one request per item; small pool — fast but polite.
  const detailed = await mapLimit(candidates, 4, async (item) => {
    try {
      const details = await fetchCatalogDetails(token, item.namespace!, item.catalogItemId!);
      return details && isGame(details) ? { item, details } : null;
    } catch {
      return null; // one broken item must not abort the sync
    }
  });

  const entries: StoredEntry[] = [];
  for (const hit of detailed) {
    if (!hit) continue;
    const { item, details } = hit;
    entries.push({
      source: 'Epic',
      externalId: item.catalogItemId!,
      title: details.title,
      iconUrl: details.imageUrl,
      namespace: item.namespace ?? null,
      appName: item.appName ?? null,
      playtimeMinutes: item.appName ? playtime.get(item.appName.toLowerCase()) ?? null : null,
      acquisitionDate: item.acquisitionDate ?? null,
    });
  }

  const count = replaceEntries('Epic', entries);
  // Only a sync that actually stored something counts as fresh — otherwise a
  // hiccup would silence the autosync for a whole interval.
  if (count > 0) updateEpicAccount({ lastSyncAt: new Date().toISOString() });
  return count;
}

// ---------- public API (mirrors the backend endpoints) ----------

export interface EpicAccountInfo {
  connected: boolean;
  displayName?: string | null;
  country?: string | null;
}

export function epicAccount(): EpicAccountInfo {
  const session = getEpicSession();
  return {
    connected: !!session && msUntil(session.refreshExpiresAt) > 0,
    displayName: session?.displayName ?? null,
    country: getEpicAccount().country ?? null,
  };
}

export function setEpicCountry(country: string): EpicAccountInfo {
  updateEpicAccount({ country: normalizeCountry(country) });
  return epicAccount();
}

/** Exchange an authorization code, persist the session and sync the library. */
export async function epicAuthWithCode(authorizationCode: string): Promise<EpicAuthResult> {
  if (!authorizationCode?.trim()) return requireLogin('Authorization code is required.');
  const session = saveSession(await exchangeCode(authorizationCode));
  updateEpicAccount({ accountId: session.accountId, displayName: session.displayName ?? null });
  await detectCountry(session.accountId, session.accessToken);
  const count = await syncLibrary(session.accessToken, session.accountId);
  return {
    success: true,
    requiresLogin: false,
    displayName: session.displayName,
    gameCount: count,
  };
}

/** Re-sync using the saved session (auto-refresh). */
export async function epicSync(): Promise<EpicAuthResult> {
  const auth = await getValidAccessToken();
  if (!auth) return requireLogin('Epic session expired — sign in again.');
  await detectCountry(auth.accountId, auth.token);
  const count = await syncLibrary(auth.token, auth.accountId);
  return {
    success: true,
    requiresLogin: false,
    displayName: getEpicSession()?.displayName,
    gameCount: count,
  };
}

/** Signs out of Epic: drops the stored OAuth session and the EGS library. */
export function epicLogout(): void {
  clearEpicSession();
  clearStore('Epic');
}

// ---------- import from the installed Epic Games Launcher ----------

/**
 * Reads the EGL "remember me" refresh token from GameUserSettings.ini and
 * decrypts it with Windows DPAPI (same user scope EGL encrypted it with).
 * DPAPI isn't reachable from Node directly — .NET via PowerShell is.
 */
async function readEglRefreshToken(): Promise<string | null> {
  const ini = join(
    process.env.LOCALAPPDATA ?? '',
    'EpicGamesLauncher',
    'Saved',
    'Config',
    'Windows',
    'GameUserSettings.ini'
  );
  if (!process.env.LOCALAPPDATA || !existsSync(ini)) return null;

  const text = readFileSync(ini, 'utf8');
  const section = text.split(/\[RememberMe\]/i)[1];
  const match = section?.match(/^\s*Data\s*=\s*"?([A-Za-z0-9+/=]+)"?/m);
  if (!match) return null;

  // The blob comes from a file any process on the machine can write, so it is
  // NEVER interpolated into the script: PowerShell reads it from an
  // environment variable, which cannot be parsed as code.
  const script =
    'Add-Type -AssemblyName System.Security; ' +
    '$b=[Convert]::FromBase64String($env:GL_DPAPI_BLOB); ' +
    '[Text.Encoding]::UTF8.GetString(' +
    "[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, GL_DPAPI_BLOB: match[1] }, timeout: 30_000 }
  );

  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Unexpected Epic Games Launcher session format.');
  const token = (parsed[0] as { Token?: unknown } | undefined)?.Token;
  return typeof token === 'string' && token ? token : null;
}

/** Sign in by importing the session of the installed Epic Games Launcher. */
export async function epicImportFromLauncher(): Promise<EpicAuthResult> {
  let token: string | null;
  try {
    token = await readEglRefreshToken();
  } catch (e) {
    // Distinguish "nothing to import" from "import broke" — they used to look
    // identical to the user.
    console.error('[epic] reading the Epic Games Launcher session failed:', e);
    return requireLogin('Could not read the Epic Games Launcher session (see the log for details).');
  }
  if (!token) {
    return requireLogin(
      'Could not read a saved Epic Games Launcher session (is EGL installed and signed in with "Remember me"?).'
    );
  }
  const session = saveSession(await refreshToken(token));
  updateEpicAccount({ accountId: session.accountId, displayName: session.displayName ?? null });
  await detectCountry(session.accountId, session.accessToken);
  const count = await syncLibrary(session.accessToken, session.accountId);
  return {
    success: true,
    requiresLogin: false,
    displayName: session.displayName,
    gameCount: count,
  };
}
