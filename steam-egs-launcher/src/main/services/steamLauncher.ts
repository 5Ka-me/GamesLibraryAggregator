import { shell } from 'electron';
import { execFile } from 'node:child_process';
import { steamInstallPath } from './steamScan';

// M1 launch/install model: hand OS protocol deep links to the installed native
// clients (Steam / Epic Games Launcher). Only whitelisted schemes are allowed
// so the renderer can't ask the OS to open arbitrary protocols.
const ALLOWED_SCHEMES = ['steam:', 'com.epicgames.launcher:'];

export async function openDeepLink(url: string): Promise<void> {
  const lower = url.toLowerCase();
  if (!ALLOWED_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
    throw new Error(`Blocked deep link: ${url}`);
  }
  await shell.openExternal(url);
}

// Detected once per run — installing a client mid-session is rare enough.
let steamClientDetected: boolean | null = null;
let epicLauncherDetected: boolean | null = null;

async function steamClientInstalled(): Promise<boolean> {
  if (steamClientDetected === null) steamClientDetected = (await steamInstallPath()) !== null;
  return steamClientDetected;
}

/** The Epic Games Launcher registers its URL protocol on install; legendary does not. */
async function epicLauncherInstalled(): Promise<boolean> {
  if (epicLauncherDetected === null) {
    epicLauncherDetected =
      process.platform === 'win32' &&
      (await new Promise<boolean>((resolve) => {
        execFile('reg', ['query', 'HKCR\\com.epicgames.launcher'], { windowsHide: true }, (err) => resolve(!err));
      }));
  }
  return epicLauncherDetected;
}

/**
 * Opens a game's store page in the Steam desktop client when it's installed,
 * otherwise falls back to the web store in the default browser.
 */
export async function openSteamStorePage(appid: number): Promise<void> {
  await shell.openExternal(
    (await steamClientInstalled()) ? `steam://store/${appid}` : `https://store.steampowered.com/app/${appid}/`
  );
}

const STEAM_WEB_HOSTS = new Set(['store.steampowered.com', 'steamcommunity.com', 'help.steampowered.com']);
const EPIC_STORE_HOSTS = new Set(['store.epicgames.com', 'www.epicgames.com']);
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2,4})?$/i;

/** https://store.epicgames.com/en-US/p/some-game → com.epicgames.launcher://store/p/some-game */
export function epicStoreDeepLink(url: URL): string | null {
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'www.epicgames.com') {
    if (parts[0] !== 'store') return null;
    parts.shift();
  }
  if (parts[0] && LOCALE_SEGMENT.test(parts[0])) parts.shift();
  if (!parts.length) return null;
  return `com.epicgames.launcher://store/${parts.map((p) => encodeURIComponent(decodeURIComponent(p))).join('/')}`;
}

/**
 * The single place web links leave the app. Steam pages open in the Steam
 * client and Epic store pages in the Epic Games Launcher when those are
 * installed; everything else — and the stores when no client is present —
 * goes to the default browser. The caller has already checked http(s).
 */
export async function openWebUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === 'https:' && STEAM_WEB_HOSTS.has(host) && (await steamClientInstalled())) {
    await shell.openExternal(`steam://openurl/${parsed.toString()}`);
    return;
  }
  if (parsed.protocol === 'https:' && EPIC_STORE_HOSTS.has(host) && (await epicLauncherInstalled())) {
    const deep = epicStoreDeepLink(parsed);
    if (deep) {
      await shell.openExternal(deep);
      return;
    }
  }
  await shell.openExternal(url);
}
