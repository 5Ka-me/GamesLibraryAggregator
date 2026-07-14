import { shell } from 'electron';
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

// Detected once per run — installing Steam mid-session is rare enough.
let steamClientDetected: boolean | null = null;

/**
 * Opens a game's store page in the Steam desktop client when it's installed,
 * otherwise falls back to the web store in the default browser.
 */
export async function openSteamStorePage(appid: number): Promise<void> {
  if (steamClientDetected === null) {
    steamClientDetected = (await steamInstallPath()) !== null;
  }
  await shell.openExternal(
    steamClientDetected
      ? `steam://store/${appid}`
      : `https://store.steampowered.com/app/${appid}/`
  );
}
