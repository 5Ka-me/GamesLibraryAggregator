import { app, BrowserWindow, session, type Session } from 'electron';
import { apiFetch } from './apiClient';

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

let cachedToken: { value: string; at: number } | null = null;
const TOKEN_TTL_MS = 30 * 60_000;

// Partition of the most recent successful login this run (in-memory logins
// aren't discoverable otherwise).
let activePartition: string | null = null;

/** In-memory (non-persistent) partition, recreated per app run. */
function memPartition(): string {
  return 'steam-mem';
}

function steamSession(remember: boolean): Session {
  return session.fromPartition(remember ? 'persist:steam' : memPartition());
}

/**
 * The signed-in Steam session (persisted or in-memory), or null when the user
 * isn't signed in. Used by the personalized-store service.
 */
export async function getActiveSteamSession(): Promise<Session | null> {
  const names = [...new Set([activePartition, 'persist:steam', memPartition()].filter(Boolean))] as string[];
  for (const name of names) {
    const ses = session.fromPartition(name);
    if (await readSteamId(ses)) return ses;
  }
  return null;
}

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
    const decoded = decodeURIComponent(c.value);
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

    const check = async () => {
      if (settled || win.isDestroyed()) return;
      const id = await readSteamId(ses);
      if (id) finish(() => resolve(id));
    };
    win.webContents.on('did-navigate', check);
    win.webContents.on('did-frame-navigate', check);

    win.on('closed', () => finish(() => reject(new Error('Steam sign-in window was closed.'))));
    win.loadURL(LOGIN_URL);
  });
}

/** Web API access token from the signed-in store session (memory-cached). */
async function getAccessToken(remember: boolean): Promise<string | null> {
  if (cachedToken && Date.now() - cachedToken.at < TOKEN_TTL_MS) return cachedToken.value;
  try {
    const res = await steamSession(remember).fetch(
      'https://store.steampowered.com/pointssummary/ajaxgetasyncconfig'
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { webapi_token?: string } };
    const token = json?.data?.webapi_token;
    if (!token) return null;
    cachedToken = { value: token, at: Date.now() };
    return token;
  } catch {
    return null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

async function fetchProfile(steamId: string, token: string): Promise<SteamProfile> {
  const profile: SteamProfile = { steamId };
  try {
    const res = await fetch(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?access_token=${token}&steamids=${steamId}`
    );
    if (res.ok) {
      const p = (await res.json())?.response?.players?.[0];
      if (p) {
        profile.personaName = p.personaname;
        if (typeof p.loccountrycode === 'string') profile.country = p.loccountrycode;
      }
    }
  } catch {
    /* persona is optional */
  }
  return profile;
}

async function fetchOwnedGames(steamId: string, token: string): Promise<any[]> {
  const res = await fetch(
    'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/' +
      `?access_token=${token}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true&format=json`
  );
  if (!res.ok) throw new Error(`GetOwnedGames failed: HTTP ${res.status}`);
  return (await res.json())?.response?.games ?? [];
}

export interface SteamLoginResult {
  success: boolean;
  steamId?: string;
  personaName?: string;
  gameCount?: number;
  message?: string;
}

/**
 * Full sign-in: authenticate → mint token → fetch profile + library → push the
 * library to the cloud DB (no API key involved). Returns a summary.
 */
export async function steamLogin(remember: boolean): Promise<SteamLoginResult> {
  const steamId = await openLogin(remember);
  activePartition = remember ? 'persist:steam' : memPartition();
  const token = await getAccessToken(remember);
  if (!token) {
    return { success: false, message: 'Signed in, but could not obtain a Steam Web API token.' };
  }

  const [profile, games] = await Promise.all([
    fetchProfile(steamId, token),
    fetchOwnedGames(steamId, token),
  ]);

  await apiFetch('/api/steam/sync-games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      steamId,
      personaName: profile.personaName,
      country: profile.country,
      games: games.map((g) => ({
        appId: g.appid,
        name: g.name,
        playtimeForever: g.playtime_forever ?? 0,
      })),
    }),
  });

  return {
    success: true,
    steamId,
    personaName: profile.personaName,
    gameCount: games.length,
  };
}

/** Whether a persisted Steam session is still valid (silent, no window). */
export async function steamStatus(): Promise<{ loggedIn: boolean; steamId?: string }> {
  const id = await readSteamId(steamSession(true));
  return id ? { loggedIn: true, steamId: id } : { loggedIn: false };
}

/** Clears the Steam session (cookies + storage) and the in-memory token. */
export async function steamLogout(): Promise<void> {
  cachedToken = null;
  activePartition = null;
  await steamSession(true).clearStorageData();
  await steamSession(false).clearStorageData();
}

// Drop the token from memory when the app quits (defensive).
app.on('before-quit', () => {
  cachedToken = null;
});
