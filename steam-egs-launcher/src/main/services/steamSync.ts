import { getSteamApiKey, setSteamApiKey } from './secretStore';
import { getSteamAccount, replaceEntries, updateSteamAccount, type StoredEntry } from './localData';
import { communityFetch, getWebApiToken, STEAM_WEB_API } from './steamAuth';
import { cached, TTL_PROGRESS_MS } from './cache';
import { BROWSER_UA, httpFetch, httpJson } from './http';
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
  avatarUrl?: string | null;
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
  /** When unavailable: no usable Steam sign-in vs. Steam has no data for this game/profile. */
  reason?: 'auth' | 'unavailable';
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
    avatarUrl: acc.avatarUrl ?? null,
    country: acc.country ?? null,
  };
}

export function setSteamCountry(country: string): SteamAccountInfo {
  if (!getSteamAccount().steamId) throw new Error('Connect Steam first.');
  updateSteamAccount({ country: normalizeCountry(country) });
  return steamAccount();
}

/** Persist account metadata; country fills only when not already known. */
function saveAccountMeta(
  steamId: string,
  personaName?: string | null,
  country?: string | null,
  avatarUrl?: string | null
): void {
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
    avatarUrl: avatarUrl?.trim() ? avatarUrl : current.avatarUrl,
    country: current.country ?? detected ?? null,
  });
}

export interface SteamProfileMeta {
  persona?: string;
  country?: string;
  avatarUrl?: string;
}

/**
 * Persona name, avatar and store country — best effort. GetPlayerSummaries
 * only accepts an API key (a web-session token gets HTTP 400), so signed-in
 * users fall back to the public community profile XML, which carries the
 * persona and avatar for any account (no country there, which is fine: the
 * region is auto-detected once and user-editable).
 */
export async function fetchProfileMeta(auth: string, steamId: string): Promise<SteamProfileMeta> {
  const meta: SteamProfileMeta = {};
  if (auth.startsWith('key=')) {
    try {
      const json = await getJson(
        `${API}/ISteamUser/GetPlayerSummaries/v2/?${auth}&steamids=${encodeURIComponent(steamId)}`
      );
      const p = json?.response?.players?.[0];
      if (typeof p?.personaname === 'string') meta.persona = p.personaname;
      if (typeof p?.loccountrycode === 'string') meta.country = p.loccountrycode;
      if (typeof p?.avatarmedium === 'string') meta.avatarUrl = p.avatarmedium;
    } catch {
      /* fall through to the community profile */
    }
  }
  if (!meta.persona) {
    try {
      const res = await httpFetch(`https://steamcommunity.com/profiles/${encodeURIComponent(steamId)}/?xml=1`, {
        headers: { 'User-Agent': BROWSER_UA },
      });
      const xml = await res.text();
      const tag = (name: string): string | undefined =>
        xml.match(new RegExp(`<${name}><!\\[CDATA\\[([^\\]]*)\\]\\]></${name}>`))?.[1]?.trim() || undefined;
      meta.persona = tag('steamID') ?? meta.persona;
      meta.avatarUrl = tag('avatarMedium') ?? meta.avatarUrl;
    } catch {
      /* profile card keeps what it had */
    }
  }
  return meta;
}

// ---------- credentials (Advanced fallback) ----------

export async function saveSteamCredentials(apiKey: string, steamId: string): Promise<SteamAccountInfo> {
  const key = apiKey.trim();
  const id = steamId.trim();
  if (!key || !id) throw new Error('Both the API key and SteamId are required.');

  let persona: string | undefined;
  let country: string | undefined;
  let avatarUrl: string | undefined;
  try {
    const json = await getJson(
      `${API}/ISteamUser/GetPlayerSummaries/v2/` +
        `?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(id)}`
    );
    const p = json?.response?.players?.[0];
    persona = p?.personaname;
    country = p?.loccountrycode;
    avatarUrl = typeof p?.avatarmedium === 'string' ? p.avatarmedium : undefined;
  } catch {
    throw new Error('Failed to validate the Steam key. Check the API key and SteamId.');
  }

  setSteamApiKey(key);
  saveAccountMeta(id, persona, country, avatarUrl);
  return steamAccount();
}

// ---------- library sync ----------

interface OwnedGame {
  appId: number;
  name: string;
  playtimeForever: number;
  /** Unix seconds of the last launch (0/absent = never). */
  rtimeLastPlayed?: number;
  playtime2Weeks?: number;
  playtimeDeck?: number;
  iconHash?: string;
}

/** Maps a raw GetOwnedGames row (either auth path) to the fields we keep. */
export function ownedGameFromApi(g: any): OwnedGame {
  return {
    appId: g.appid,
    name: g.name,
    playtimeForever: g.playtime_forever ?? 0,
    rtimeLastPlayed: g.rtime_last_played ?? 0,
    playtime2Weeks: g.playtime_2weeks ?? 0,
    playtimeDeck: g.playtime_deck_forever ?? 0,
    iconHash: typeof g.img_icon_url === 'string' && g.img_icon_url ? g.img_icon_url : undefined,
  };
}

/** Store a full owned-games listing (from either auth path) as the Steam library. */
export function storeSteamLibrary(
  steamId: string,
  games: OwnedGame[],
  personaName?: string | null,
  country?: string | null,
  avatarUrl?: string | null
): number {
  if (!steamId) throw new Error('SteamId is required.');
  saveAccountMeta(steamId, personaName, country, avatarUrl);
  const entries: StoredEntry[] = games.map((g) => ({
    source: 'Steam',
    externalId: String(g.appId),
    title: g.name?.trim() || `App ${g.appId}`,
    iconUrl: coverUrl(g.appId),
    playtimeMinutes: g.playtimeForever > 0 ? g.playtimeForever : null,
    lastPlayedAt: g.rtimeLastPlayed ? new Date(g.rtimeLastPlayed * 1000).toISOString() : null,
    playtime2WeeksMinutes: g.playtime2Weeks ? g.playtime2Weeks : null,
    playtimeDeckMinutes: g.playtimeDeck ? g.playtimeDeck : null,
    iconHash: g.iconHash ?? null,
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
  const games: OwnedGame[] = ((json?.response?.games ?? []) as any[]).map(ownedGameFromApi);
  // Refresh the profile card (name, avatar) with every sync — the token path
  // only learned it at login, and personas change.
  const meta = await fetchProfileMeta(auth, steamId);
  return { count: storeSteamLibrary(steamId, games, meta.persona, meta.country, meta.avatarUrl) };
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

// ---------- achievement progress (whole library, batched) ----------

export interface SteamAchievementProgress {
  appId: number;
  unlocked: number;
  total: number;
  /** 0–100. */
  percentage: number;
  allUnlocked: boolean;
}

const PROGRESS_BATCH = 100;

/**
 * Unlocked/total per game for many games at once — IPlayerService accepts the
 * web-session token (unlike ISteamUserStats), so this needs no API key. ~100
 * appids per POST; each batch is cached like other player progress.
 */
export async function steamAchievementsProgress(appIds: number[]): Promise<SteamAchievementProgress[]> {
  const { steamId } = getSteamAccount();
  if (!steamId || appIds.length === 0) return [];
  let auth: string;
  try {
    auth = await authParam();
  } catch {
    return [];
  }
  const ids = [...new Set(appIds)].sort((a, b) => a - b);
  const out: SteamAchievementProgress[] = [];
  for (let i = 0; i < ids.length; i += PROGRESS_BATCH) {
    const chunk = ids.slice(i, i + PROGRESS_BATCH);
    const key = `achprog:${steamId}:${chunk[0]}-${chunk[chunk.length - 1]}:${chunk.length}`;
    try {
      out.push(...(await cached('steam', key, TTL_PROGRESS_MS, () => fetchProgress(steamId, chunk, auth))));
    } catch {
      /* one failed batch shouldn't hide the others */
    }
  }
  return out;
}

async function fetchProgress(steamId: string, appIds: number[], auth: string): Promise<SteamAchievementProgress[]> {
  const [authKey, authValue] = auth.split('=');
  const form = new URLSearchParams({ [authKey]: decodeURIComponent(authValue), steamid: steamId });
  appIds.forEach((id, i) => form.set(`appids[${i}]`, String(id)));
  const json = await httpJson<any>(`${API}/IPlayerService/GetAchievementsProgress/v1/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return ((json?.response?.achievement_progress ?? []) as any[])
    .filter((p) => Number.isInteger(p?.appid))
    .map((p) => ({
      appId: p.appid,
      unlocked: p.unlocked ?? 0,
      total: p.total ?? 0,
      percentage: typeof p.percentage === 'number' ? p.percentage : 0,
      allUnlocked: p.all_unlocked === true,
    }));
}

// ---------- achievements ----------

const NO_ACHIEVEMENTS = (reason: 'auth' | 'unavailable'): SteamGameAchievements => ({
  available: false,
  reason,
  total: 0,
  unlocked: 0,
  achievements: [],
});

export async function steamAchievements(appId: number, lang?: string): Promise<SteamGameAchievements> {
  const { steamId } = getSteamAccount();
  if (!steamId) return NO_ACHIEVEMENTS('auth');
  // Resolved outside the cache: a missing sign-in is a transient state that
  // must not be remembered as "this game has no achievements".
  let auth: string;
  try {
    auth = await authParam();
  } catch {
    return NO_ACHIEVEMENTS('auth');
  }
  // ISteamUserStats only accepts an API key (a web-session token gets HTTP
  // 400), so signed-in users without a key take the community route instead.
  const viaWebApi = auth.startsWith('key=');
  return cached('steam', `ach:${steamId}:${lang ?? 'en'}:${appId}`, TTL_PROGRESS_MS, () =>
    viaWebApi
      ? fetchAchievementsWebApi(steamId, appId, auth, lang)
      : fetchAchievementsCommunity(steamId, appId, lang)
  );
}

const steamLang = (lang?: string): string => (lang === 'ru' ? 'russian' : 'english');

/**
 * Key-free path: the profile's achievement XML on steamcommunity.com (unlock
 * state, times, names, icons — as the signed-in user, so private profiles
 * work) merged with the public IPlayerService schema (hidden flag, global
 * unlock percentage, authoritative list incl. not-yet-unlocked hidden ones).
 */
async function fetchAchievementsCommunity(
  steamId: string,
  appId: number,
  lang?: string
): Promise<SteamGameAchievements> {
  const l = steamLang(lang);

  let xml: string;
  try {
    const res = await communityFetch(
      `https://steamcommunity.com/profiles/${encodeURIComponent(steamId)}/stats/${appId}/achievements/?xml=1&l=${l}`
    );
    if (!res.ok) return NO_ACHIEVEMENTS('unavailable');
    xml = await res.text();
  } catch {
    return NO_ACHIEVEMENTS('unavailable');
  }
  if (/<error>/.test(xml)) return NO_ACHIEVEMENTS('unavailable');

  interface XmlAch {
    unlocked: boolean;
    name: string | null;
    desc: string | null;
    icon: string | null;
    iconGray: string | null;
    unlockTime: string | null;
  }
  const tag = (block: string, name: string): string | null => {
    const m = block.match(new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
    return m ? m[1].trim() || null : null;
  };
  const fromXml = new Map<string, XmlAch>(); // key: lower-cased api name
  for (const m of xml.matchAll(/<achievement(\s[^>]*)?>([\s\S]*?)<\/achievement>/g)) {
    const block = m[2];
    const apiname = tag(block, 'apiname');
    if (!apiname) continue;
    const ts = parseInt(tag(block, 'unlockTimestamp') ?? '', 10);
    fromXml.set(apiname.toLowerCase(), {
      unlocked: /closed="1"/.test(m[1] ?? ''),
      name: tag(block, 'name'),
      desc: tag(block, 'description'),
      icon: tag(block, 'iconClosed'),
      iconGray: tag(block, 'iconOpen'),
      unlockTime: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null,
    });
  }
  if (fromXml.size === 0) return NO_ACHIEVEMENTS('unavailable');

  // Schema — best effort (public endpoint, no auth).
  interface SchemaAch {
    internal_name?: string;
    localized_name?: string;
    localized_desc?: string;
    icon?: string;
    icon_gray?: string;
    hidden?: boolean;
    player_percent_unlocked?: string | number;
  }
  let schema: SchemaAch[] = [];
  try {
    const json = await getJson(`${API}/IPlayerService/GetGameAchievements/v1/?appid=${appId}&language=${l}`);
    if (Array.isArray(json?.response?.achievements)) schema = json.response.achievements;
  } catch {
    /* best effort */
  }
  const iconUrl = (file?: string): string | null =>
    file ? `https://shared.fastly.steamstatic.com/community_assets/images/apps/${appId}/${file}` : null;

  const achievements: SteamAchievement[] = [];
  const seen = new Set<string>();
  for (const s of schema) {
    if (!s.internal_name) continue;
    const key = s.internal_name.toLowerCase();
    seen.add(key);
    const x = fromXml.get(key);
    const pct = typeof s.player_percent_unlocked === 'string' ? parseFloat(s.player_percent_unlocked) : s.player_percent_unlocked;
    achievements.push({
      name: s.internal_name,
      displayName: s.localized_name ?? x?.name ?? s.internal_name,
      description: s.localized_desc || x?.desc || null,
      icon: x?.icon ?? iconUrl(s.icon),
      iconGray: x?.iconGray ?? iconUrl(s.icon_gray),
      unlocked: x?.unlocked ?? false,
      unlockTime: x?.unlockTime ?? null,
      globalPct: Number.isFinite(pct) ? (pct as number) : null,
      hidden: s.hidden === true,
    });
  }
  // Anything the schema didn't list (or the whole list when it failed).
  for (const [key, x] of fromXml) {
    if (seen.has(key)) continue;
    achievements.push({
      name: key,
      displayName: x.name ?? key,
      description: x.desc,
      icon: x.icon,
      iconGray: x.iconGray,
      unlocked: x.unlocked,
      unlockTime: x.unlockTime,
      globalPct: null,
      hidden: false,
    });
  }

  return {
    available: true,
    gameName: tag(xml, 'gameName'),
    total: achievements.length,
    unlocked: achievements.filter((a) => a.unlocked).length,
    achievements,
  };
}

/** API-key path: the official ISteamUserStats trio (player, schema, global %). */
async function fetchAchievementsWebApi(
  steamId: string,
  appId: number,
  auth: string,
  lang?: string
): Promise<SteamGameAchievements> {
  const l = steamLang(lang);

  // 1) Player achievements — the only required call; anything wrong → unavailable.
  let player: any;
  try {
    player = (
      await getJson(
        `${API}/ISteamUserStats/GetPlayerAchievements/v1/?appid=${appId}&${auth}&steamid=${encodeURIComponent(steamId)}&l=${l}`
      )
    )?.playerstats;
  } catch {
    return NO_ACHIEVEMENTS('unavailable');
  }
  if (!player?.success || !Array.isArray(player?.achievements)) {
    return NO_ACHIEVEMENTS('unavailable');
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
