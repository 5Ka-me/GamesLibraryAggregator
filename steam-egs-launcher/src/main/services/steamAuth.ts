import { app, BrowserWindow, session, type Session } from 'electron';
import { ownedGameFromApi, storeSteamLibrary } from './steamSync';
import { clearStore } from './localData';
import { clearSteamApiKey } from './secretStore';
import { httpJson } from './http';

/** Official Steam Web API host (shared with steamSync/steamStore). */
export const STEAM_WEB_API = 'https://api.steampowered.com';

// Secure Steam web sign-in. The user authenticates (password + Steam Guard) on
// Valve's OWN pages inside an isolated window; we never see or touch the
// password. From the resulting session we read the SteamID and mint a short
// Web API access token — kept ONLY in main-process memory, never written to
// disk, never handed to the renderer.
//
// Security posture (best effort against remote/passive threats; a keylogger
// running as the same OS user is out of scope for any app):
//   - dedicated session partition, isolated from the app;
//   - login window: sandboxed, no preload, nodeIntegration off, no access to
//     our IPC; top-level navigation locked to Steam domains;
//   - webapi_token lives in memory only, re-minted from the live session;
//   - the renderer receives only results (SteamID, persona, game count).

const STEAM_DOMAINS = [
  'steampowered.com',
  'steamcommunity.com',
  'steamstatic.com',
  'akamaihd.net',
  // reCAPTCHA / Steam Guard occasionally pull these:
  'google.com',
  'gstatic.com',
  'recaptcha.net',
];

const LOGIN_URL = 'https://store.steampowered.com/login/';

interface SteamProfile {
  steamId: string;
  personaName?: string;
  country?: string;
}

// The Web API token is tied to one signed-in session — cache it per partition
// so switching accounts can't hand out the previous account's token.
let cachedToken: { partition: string; value: string; at: number } | null = null;
const TOKEN_TTL_MS = 30 * 60_000;

const PERSIST_PARTITION = 'persist:steam';
/** Non-persistent partition — Electron recreates it per app run. */
const MEMORY_PARTITION = 'steam-mem';

// Partition of the most recent successful login this run (in-memory logins
// aren't discoverable otherwise).
let activePartition: string | null = null;

const partitionName = (remember: boolean): string =>
  remember ? PERSIST_PARTITION : MEMORY_PARTITION;

function steamSession(remember: boolean): Session {
  return session.fromPartition(partitionName(remember));
}

/**
 * The signed-in Steam session (persisted or in-memory), or null when the user
 * isn't signed in. Used by the personalized-store service.
 */
export async function getActiveSteamSession(): Promise<Session | null> {
  for (const name of activePartitionNames()) {
    const ses = session.fromPartition(name);
    if (await readSteamId(ses)) return ses;
  }
  return null;
}

const activePartitionNames = (): string[] => [
  ...new Set([activePartition, PERSIST_PARTITION, MEMORY_PARTITION].filter(Boolean) as string[]),
];

function isSteamUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return STEAM_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** Reads the SteamID from the steamLoginSecure cookie (`<steamid>||<jwt>`). */
async function readSteamId(ses: Session): Promise<string | null> {
  const cookies = await ses.cookies.get({ name: 'steamLoginSecure' });
  for (const c of cookies) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(c.value);
    } catch {
      continue; // malformed cookie value — must not throw inside a listener
    }
    const id = decoded.split('||')[0];
    if (/^\d{17}$/.test(id)) return id;
  }
  return null;
}

/** Opens the login window and resolves once a valid session cookie appears. */
function openLogin(remember: boolean): Promise<string> {
  const ses = steamSession(remember);

  return new Promise<string>((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      title: 'Sign in to Steam',
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        // No preload: the Steam page has zero access to our code.
      },
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) {
        win.removeAllListeners('closed');
        win.destroy();
      }
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error('Steam sign-in timed out.'))),
      10 * 60_000
    );

    // Lock top-level navigation to Steam (blocks phishing redirects / stray links).
    const guard = (e: Electron.Event, url: string) => {
      if (!isSteamUrl(url)) e.preventDefault();
    };
    win.webContents.on('will-navigate', guard);
    win.webContents.on('will-redirect', guard);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const check = (): void => {
      if (settled || win.isDestroyed()) return;
      void readSteamId(ses).then((id) => {
        if (id) finish(() => resolve(id));
      });
    };
    win.webContents.on('did-navigate', check);
    win.webContents.on('did-frame-navigate', check);

    win.on('closed', () => finish(() => reject(new Error('Steam sign-in window was closed.'))));
    void win.loadURL(LOGIN_URL);
  });
}

const STORE_ORIGIN = 'https://store.steampowered.com';
const COMMUNITY_ORIGIN = 'https://steamcommunity.com';

const formHeaders = (origin: string) => ({
  'Content-Type': 'application/x-www-form-urlencoded',
  Origin: origin,
  Referer: `${origin}/`,
});

/** Expiry (ms) of the `steamLoginSecure` access token set for `origin`, or 0 when absent/unreadable. */
async function accessTokenExpiry(ses: Session, origin: string): Promise<number> {
  const [cookie] = await ses.cookies.get({ url: `${origin}/`, name: 'steamLoginSecure' });
  if (!cookie) return 0;
  try {
    const jwt = decodeURIComponent(cookie.value).split('||')[1] ?? '';
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Renews the `steamLoginSecure` access token of one Steam origin from the
 * long-lived refresh cookie on login.steampowered.com — the same two-step
 * exchange Steam's own page script performs when a tab finds its token
 * expired. The access token lives about a day; the refresh cookie for months.
 * Without this, a remembered sign-in silently stopped working after a day
 * (every Web API call failed while Settings still said "signed in").
 *
 * Cookies must be opted into explicitly: Electron's `ses.fetch` treats a
 * request carrying a foreign `Origin` header as cross-origin and drops them.
 */
async function refreshSession(ses: Session, origin: string = STORE_ORIGIN): Promise<boolean> {
  try {
    const res = await ses.fetch('https://login.steampowered.com/jwt/ajaxrefresh', {
      method: 'POST',
      credentials: 'include',
      headers: formHeaders(origin),
      body: new URLSearchParams({ redir: `${origin}/` }).toString(),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as {
      success?: boolean;
      steamID?: string;
      login_url?: string;
      nonce?: string;
      auth?: string;
      transfer_info?: { url: string; params: Record<string, string> }[];
    };
    if (!json?.success) return false;
    // Either a list of per-domain transfers or a single primary-domain one.
    const transfers =
      json.transfer_info?.length
        ? json.transfer_info
        : json.login_url && json.nonce && json.auth
          ? [{ url: json.login_url, params: { nonce: json.nonce, auth: json.auth } }]
          : [];
    if (transfers.length === 0) return false;
    // Each transfer sets the fresh cookie on one Steam domain (store, community, …).
    const results = await Promise.all(
      transfers.map((t) =>
        ses
          .fetch(t.url, {
            method: 'POST',
            credentials: 'include',
            headers: formHeaders(origin),
            body: new URLSearchParams({ ...t.params, steamID: json.steamID ?? '' }).toString(),
          })
          .then((r) => r.ok)
          .catch(() => false)
      )
    );
    return results.some(Boolean);
  } catch {
    return false;
  }
}

/** One attempt at the Web API token from the current store session. */
async function fetchWebApiToken(ses: Session): Promise<string | null> {
  const res = await ses.fetch('https://store.steampowered.com/pointssummary/ajaxgetasyncconfig', {
    credentials: 'include',
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { webapi_token?: string } };
  return json?.data?.webapi_token ?? null;
}

/**
 * Web API access token for one session partition (memory-cached, 30 min).
 * An expired store token is refreshed once before giving up.
 */
async function mintToken(ses: Session, partition: string): Promise<string | null> {
  if (cachedToken?.partition === partition && Date.now() - cachedToken.at < TOKEN_TTL_MS) {
    return cachedToken.value;
  }
  try {
    let token = await fetchWebApiToken(ses);
    if (!token && (await refreshSession(ses))) token = await fetchWebApiToken(ses);
    if (!token) return null;
    cachedToken = { partition, value: token, at: Date.now() };
    return token;
  } catch {
    return null;
  }
}

/**
 * Fetches a steamcommunity.com URL as the signed-in user (so private profiles
 * work), refreshing the community access token first when it has expired.
 * Falls back to an anonymous request when nobody is signed in — public
 * profiles are readable either way.
 */
export async function communityFetch(url: string): Promise<Response> {
  const ses = await getActiveSteamSession();
  if (!ses) return fetch(url);
  if ((await accessTokenExpiry(ses, COMMUNITY_ORIGIN)) < Date.now() + 60_000) {
    await refreshSession(ses, COMMUNITY_ORIGIN);
  }
  return ses.fetch(url, { credentials: 'include' });
}

/**
 * Web API token from whichever Steam session is signed in (silent). Used by
 * the local Steam services (recent games, achievements) so a web-signed-in
 * user needs no API key. Null when not signed in.
 */
export async function getWebApiToken(): Promise<string | null> {
  for (const name of activePartitionNames()) {
    if (cachedToken?.partition === name && Date.now() - cachedToken.at < TOKEN_TTL_MS) {
      return cachedToken.value;
    }
    const ses = session.fromPartition(name);
    if (await readSteamId(ses)) return mintToken(ses, name);
  }
  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

async function fetchProfile(steamId: string, token: string): Promise<SteamProfile> {
  const profile: SteamProfile = { steamId };
  try {
    const json = await httpJson<any>(
      `${STEAM_WEB_API}/ISteamUser/GetPlayerSummaries/v2/` +
        `?access_token=${encodeURIComponent(token)}&steamids=${encodeURIComponent(steamId)}`
    );
    const p = json?.response?.players?.[0];
    if (p) {
      profile.personaName = p.personaname;
      if (typeof p.loccountrycode === 'string') profile.country = p.loccountrycode;
    }
  } catch {
    /* persona is optional */
  }
  return profile;
}

async function fetchOwnedGames(steamId: string, token: string): Promise<any[]> {
  const json = await httpJson<any>(
    `${STEAM_WEB_API}/IPlayerService/GetOwnedGames/v1/` +
      `?access_token=${encodeURIComponent(token)}&steamid=${encodeURIComponent(steamId)}` +
      '&include_appinfo=true&include_played_free_games=true&format=json'
  );
  return json?.response?.games ?? [];
}

export interface SteamLoginResult {
  success: boolean;
  steamId?: string;
  personaName?: string;
  gameCount?: number;
  message?: string;
}

/**
 * Full sign-in: authenticate → mint token → fetch profile + library → store
 * the library locally (no API key involved). Returns a summary.
 */
export async function steamLogin(remember: boolean): Promise<SteamLoginResult> {
  // A previous account's token must never be reused for the new sign-in.
  cachedToken = null;
  const steamId = await openLogin(remember);
  activePartition = partitionName(remember);
  const token = await mintToken(steamSession(remember), activePartition);
  if (!token) {
    return { success: false, message: 'Signed in, but could not obtain a Steam Web API token.' };
  }

  const [profile, games] = await Promise.all([
    fetchProfile(steamId, token),
    fetchOwnedGames(steamId, token),
  ]);

  storeSteamLibrary(steamId, games.map(ownedGameFromApi), profile.personaName, profile.country);

  return {
    success: true,
    steamId,
    personaName: profile.personaName,
    gameCount: games.length,
  };
}

/**
 * Whether a persisted Steam session is still usable (silent, no window). A
 * cookie alone isn't proof — its token may have expired — so this actually
 * obtains (refreshing if needed) the Web API token the services depend on.
 */
export async function steamStatus(): Promise<{ loggedIn: boolean; steamId?: string }> {
  const ses = steamSession(true);
  const id = await readSteamId(ses);
  if (!id) return { loggedIn: false };
  const token = await mintToken(ses, PERSIST_PARTITION);
  return token ? { loggedIn: true, steamId: id } : { loggedIn: false };
}

/**
 * Signs out of Steam completely: session cookies, the in-memory token, the
 * stored account/API key and the Steam half of the library. Leaving any of it
 * behind used to keep the "signed out" account visible in the UI, served over
 * the bridge, and re-synced by the background job.
 */
export async function steamLogout(): Promise<void> {
  cachedToken = null;
  activePartition = null;
  await Promise.all([
    steamSession(true).clearStorageData(),
    steamSession(false).clearStorageData(),
  ]);
  clearSteamApiKey();
  clearStore('Steam');
}

// Drop the token from memory when the app quits (defensive).
app.on('before-quit', () => {
  cachedToken = null;
});
