import { getSteamApiKey, setSteamApiKey } from './secretStore';
import { getSteamAccount, replaceEntries, updateSteamAccount, type StoredEntry } from './localData';
import { getWebApiToken, STEAM_WEB_API } from './steamAuth';
import { cached, TTL_PROGRESS_MS } from './cache';
import { httpJson } from './http';
import { normalizeCountry } from './validate';

// Steam account, library, recent games and achievements (the launcher's own
// implementation — the app has no backend). Two auth paths:
//   - web sign-in (preferred): a short-lived webapi_token minted from the
//     Steam session in main-process memory (steamAuth.ts);
//   - API key (Advanced fallback): stored encrypted in the OS keystore.
// Official Web API endpoints accept either `key=` or `access_token=`.

const API = STEAM_WEB_API;

export interface SteamAccountInfo {
  configured: boolean;
  steamId?: string | null;
  personaName?: string | null;
  country?: string | null;
}

export interface SteamRecentGame {
  appId: number;
  name: string;
  playtime2Weeks: number;
  playtimeForever: number;
  iconUrl: string | null;
}

export interface SteamAchievement {
  name: string;
  displayName: string | null;
  description: string | null;
  icon: string | null;
  iconGray: string | null;
  unlocked: boolean;
  unlockTime: string | null;
  globalPct: number | null;
  hidden: boolean;
}

export interface SteamGameAchievements {
  available: boolean;
  gameName?: string | null;
  total: number;
  unlocked: number;
  achievements: SteamAchievement[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** `key=` (API key) or `access_token=` (web sign-in) — whichever is available. */
async function authParam(): Promise<string> {
  const key = getSteamApiKey();
  if (key) return `key=${encodeURIComponent(key)}`;
  const token = await getWebApiToken();
  if (token) return `access_token=${encodeURIComponent(token)}`;
  throw new Error('Steam is not connected — sign in to Steam or save an API key in Settings.');
}

const getJson = (url: string): Promise<any> => httpJson<any>(url);

const coverUrl = (appId: number): string =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;

// ---------- account ----------

export function steamAccount(): SteamAccountInfo {
  const acc = getSteamAccount();
  return {
    configured: !!acc.steamId,
    steamId: acc.steamId ?? null,
    personaName: acc.personaName ?? null,
    country: acc.country ?? null,
  };
}

export function setSteamCountry(country: string): SteamAccountInfo {
  if (!getSteamAccount().steamId) throw new Error('Connect Steam first.');
  updateSteamAccount({ country: normalizeCountry(country) });
  return steamAccount();
}

/** Persist account metadata; country fills only when not already known. */
function saveAccountMeta(steamId: string, personaName?: string | null, country?: string | null): void {
  const current = getSteamAccount();
  let detected: string | undefined;
  try {
    if (country) detected = normalizeCountry(country);
  } catch {
    /* Steam's profile country is user-editable free text — ignore junk */
  }
  updateSteamAccount({
    steamId,
    personaName: personaName?.trim() ? personaName : current.personaName,
    country: current.country ?? detected ?? null,
  });
}

// ---------- credentials (Advanced fallback) ----------

export async function saveSteamCredentials(apiKey: string, steamId: string): Promise<SteamAccountInfo> {
  const key = apiKey.trim();
  const id = steamId.trim();
  if (!key || !id) throw new Error('Both the API key and SteamId are required.');

  let persona: string | undefined;
  let country: string | undefined;
  try {
    const json = await getJson(
      `${API}/ISteamUser/GetPlayerSummaries/v2/` +
        `?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(id)}`
    );
    const p = json?.response?.players?.[0];
    persona = p?.personaname;
    country = p?.loccountrycode;
  } catch {
    throw new Error('Failed to validate the Steam key. Check the API key and SteamId.');
  }

  setSteamApiKey(key);
  saveAccountMeta(id, persona, country);
  return steamAccount();
}

// ---------- library sync ----------

interface OwnedGame {
  appId: number;
  name: string;
  playtimeForever: number;
}

/** Store a full owned-games listing (from either auth path) as the Steam library. */
export function storeSteamLibrary(
  steamId: string,
  games: OwnedGame[],
  personaName?: string | null,
  country?: string | null
): number {
  if (!steamId) throw new Error('SteamId is required.');
  saveAccountMeta(steamId, personaName, country);
  const entries: StoredEntry[] = games.map((g) => ({
    source: 'Steam',
    externalId: String(g.appId),
    title: g.name?.trim() || `App ${g.appId}`,
    iconUrl: coverUrl(g.appId),
    playtimeMinutes: g.playtimeForever > 0 ? g.playtimeForever : null,
  }));
  const count = replaceEntries('Steam', entries);
  // Only a sync that actually stored something counts as fresh — otherwise a
  // hiccup would silence the autosync for a whole interval.
  if (count > 0) updateSteamAccount({ lastSyncAt: new Date().toISOString() });
  return count;
}

/** GetOwnedGames sync via the API key (the Advanced "Sync Steam" button). */
export async function syncSteamLibrary(): Promise<{ count: number }> {
  const { steamId } = getSteamAccount();
  if (!steamId) throw new Error('Steam API key and SteamId are not set.');
  const auth = await authParam();
  const json = await getJson(
    `${API}/IPlayerService/GetOwnedGames/v1/?${auth}&steamid=${encodeURIComponent(steamId)}` +
      '&include_appinfo=true&include_played_free_games=true&format=json'
  );
  const games: OwnedGame[] = ((json?.response?.games ?? []) as any[]).map((g) => ({
    appId: g.appid,
    name: g.name,
    playtimeForever: g.playtime_forever ?? 0,
  }));
  return { count: storeSteamLibrary(steamId, games) };
}

// ---------- recently played ----------

export async function steamRecent(): Promise<SteamRecentGame[]> {
  const { steamId } = getSteamAccount();
  if (!steamId) throw new Error('Steam is not connected.');
  // Player progress class: short TTL, stale served while refreshing.
  return cached('steam', `recent:${steamId}`, TTL_PROGRESS_MS, () => fetchRecent(steamId));
}

async function fetchRecent(steamId: string): Promise<SteamRecentGame[]> {
  const auth = await authParam();
  const json = await getJson(
    `${API}/IPlayerService/GetRecentlyPlayedGames/v1/?${auth}&steamid=${encodeURIComponent(steamId)}&format=json`
  );
  return ((json?.response?.games ?? []) as any[]).map((g) => ({
    appId: g.appid,
    name: g.name ?? `App ${g.appid}`,
    playtime2Weeks: g.playtime_2weeks ?? 0,
    playtimeForever: g.playtime_forever ?? 0,
    iconUrl: g.img_icon_url
      ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`
      : null,
  }));
}

// ---------- achievements ----------

export async function steamAchievements(appId: number, lang?: string): Promise<SteamGameAchievements> {
  const { steamId } = getSteamAccount();
  if (!steamId) throw new Error('Steam is not connected.');
  return cached('steam', `ach:${steamId}:${lang ?? 'en'}:${appId}`, TTL_PROGRESS_MS, () =>
    fetchAchievements(steamId, appId, lang)
  );
}

async function fetchAchievements(
  steamId: string,
  appId: number,
  lang?: string
): Promise<SteamGameAchievements> {
  const auth = await authParam();
  const l = lang === 'ru' ? 'russian' : 'english';

  // 1) Player achievements — the only required call; anything wrong → unavailable.
  let player: any;
  try {
    player = (
      await getJson(
        `${API}/ISteamUserStats/GetPlayerAchievements/v1/?appid=${appId}&${auth}&steamid=${encodeURIComponent(steamId)}&l=${l}`
      )
    )?.playerstats;
  } catch {
    return { available: false, total: 0, unlocked: 0, achievements: [] };
  }
  if (!player?.success || !Array.isArray(player?.achievements)) {
    return { available: false, total: 0, unlocked: 0, achievements: [] };
  }

  // 2) Schema (names/icons/hidden flag) — best effort.
  const schema = new Map<
    string,
    { name?: string; desc?: string; icon?: string; iconGray?: string; hidden: boolean }
  >();
  try {
    const game = (
      await getJson(`${API}/ISteamUserStats/GetSchemaForGame/v2/?${auth}&appid=${appId}&l=${l}`)
    )?.game;
    for (const a of game?.availableGameStats?.achievements ?? []) {
      if (a?.name) {
        schema.set(a.name, {
          name: a.displayName,
          desc: a.description,
          icon: a.icon,
          iconGray: a.icongray,
          hidden: a.hidden === 1,
        });
      }
    }
  } catch {
    /* best effort */
  }

  // 3) Global rarity — best effort; percent arrives as number OR string.
  const globalPct = new Map<string, number>();
  try {
    const rows = (
      await getJson(
        `${API}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appId}`
      )
    )?.achievementpercentages?.achievements;
    for (const row of rows ?? []) {
      const pct = typeof row?.percent === 'string' ? parseFloat(row.percent) : row?.percent;
      if (row?.name && Number.isFinite(pct)) globalPct.set(row.name, pct);
    }
  } catch {
    /* best effort */
  }

  const achievements: SteamAchievement[] = (player.achievements as any[]).map((a) => {
    const meta = schema.get(a.apiname);
    // The schema blanks hidden achievements' descriptions, but the player
    // endpoint often still localizes them — prefer whichever is non-empty.
    return {
      name: a.apiname,
      displayName: meta?.name ?? a.name ?? a.apiname,
      description: meta?.desc || a.description || null,
      icon: meta?.icon ?? null,
      iconGray: meta?.iconGray ?? null,
      unlocked: a.achieved === 1,
      unlockTime: a.unlocktime > 0 ? new Date(a.unlocktime * 1000).toISOString() : null,
      globalPct: globalPct.get(a.apiname) ?? null,
      hidden: meta?.hidden ?? false,
    };
  });

  return {
    available: true,
    gameName: player.gameName ?? null,
    total: achievements.length,
    unlocked: achievements.filter((a) => a.unlocked).length,
    achievements,
  };
}
