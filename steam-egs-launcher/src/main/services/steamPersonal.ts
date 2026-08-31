import type { Session } from 'electron';
import { getActiveSteamSession } from './steamAuth';
import { invalidateWishlist, itemsMeta, searchItems, type StoreItem, type StoreSection } from './steamStore';
import { getEntries, getSteamAccount } from './localData';
import { getStoreCacheTtlMs } from '../config';
import { cached } from './cache';
import { BROWSER_UA, httpFetch } from './http';

// Personalized store rows, available once the user signed in through Steam:
//   - the real Discovery Queue (generated via the store session, CSRF-guarded);
//   - "Because you played <game>" — Steam's more-like-this for the user's most
//     played titles (from the local library);
//   - "Because you like <tag>" — the account's recommended tags from
//     dynamicstore/userdata, turned into top-seller rows.
// Everything the user already owns is filtered out. All data flows stay in the
// main process; the renderer only receives ready-made sections.

const ROW_SIZE = 12;

interface UserData {
  recommendedTags: { tagid: number; name: string }[];
  ownedApps: Set<number>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The CSRF `sessionid` cookie (created on first store page load if absent). */
async function getSessionId(ses: Session): Promise<string | null> {
  const read = async () =>
    (await ses.cookies.get({ name: 'sessionid', domain: 'store.steampowered.com' }))[0]?.value ??
    null;
  let sid = await read();
  if (!sid) {
    try {
      await ses.fetch('https://store.steampowered.com/');
    } catch {
      /* offline */
    }
    sid = await read();
  }
  return sid;
}

/** Recommended tags + owned appids for the signed-in account. */
async function fetchUserData(ses: Session): Promise<UserData | null> {
  try {
    const res = await ses.fetch(
      `https://store.steampowered.com/dynamicstore/userdata/?v=${Date.now()}`,
      { headers: { 'Cache-Control': 'no-cache' } }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const tags = Array.isArray(json?.rgRecommendedTags) ? json.rgRecommendedTags : [];
    const owned = Array.isArray(json?.rgOwnedApps) ? json.rgOwnedApps : [];
    // An anonymous/expired session returns empty arrays — treat as "no data".
    if (!owned.length && !tags.length) return null;
    return { recommendedTags: tags, ownedApps: new Set(owned) };
  } catch {
    return null;
  }
}

/**
 * The account's actual Discovery Queue. NOT cached and NOT called from the
 * home page — every call consumes/creates a queue on the Steam side, so it
 * runs only when the user explicitly asks (the Discovery Queue tab).
 * Returns [] when not signed in.
 */
export async function generateDiscoveryQueue(lang: string): Promise<StoreItem[]> {
  const ses = await getActiveSteamSession();
  if (!ses) return [];
  const sid = await getSessionId(ses);
  if (!sid) return [];

  const res = await ses.fetch('https://store.steampowered.com/explore/generatenewdiscoveryqueue', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://store.steampowered.com',
      Referer: 'https://store.steampowered.com/explore/',
    },
    body: `sessionid=${encodeURIComponent(sid)}&queuetype=0`,
  });
  if (!res.ok) return [];

  const json = await res.json().catch(() => null);
  const queue: number[] = Array.isArray(json?.queue) ? json.queue : [];
  if (!queue.length) return [];

  const meta = await itemsMeta(queue, lang);
  return queue.map((id) => meta[id]).filter((i): i is StoreItem => !!i);
}

/** CSRF-guarded wishlist mutation via the signed-in store session. */
async function wishlistMutation(endpoint: 'addtowishlist' | 'removefromwishlist', appid: number): Promise<boolean> {
  const ses = await getActiveSteamSession();
  if (!ses) return false;
  const sid = await getSessionId(ses);
  if (!sid) return false;

  try {
    const res = await ses.fetch(`https://store.steampowered.com/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://store.steampowered.com',
        Referer: `https://store.steampowered.com/app/${appid}/`,
      },
      body: `sessionid=${encodeURIComponent(sid)}&appid=${appid}`,
    });
    if (!res.ok) return false;
    const json = await res.json().catch(() => null);
    const ok = json?.success === true;
    if (ok) invalidateWishlist();
    return ok;
  } catch {
    return false;
  }
}

/** Adds a game to the account's Steam wishlist. */
export const addToWishlist = (appid: number): Promise<boolean> =>
  wishlistMutation('addtowishlist', appid);

/** Removes a game from the account's Steam wishlist. */
export const removeFromWishlist = (appid: number): Promise<boolean> =>
  wishlistMutation('removefromwishlist', appid);

/** "Popular New Releases" minus what the user already owns. */
async function popularNewRow(lang: string, owned: Set<number>): Promise<StoreSection | null> {
  try {
    const page = await searchItems('filter=popularnew', lang, 0, 24);
    const items = page.items.filter((i) => i.appid > 0 && !owned.has(i.appid)).slice(0, ROW_SIZE);
    return items.length ? { id: 'personal-popular-new', name: '', items } : null;
  } catch {
    return null;
  }
}

/** "Because you like <tag>" — the tag's top sellers minus what's owned. */
async function tagRow(
  tag: { tagid: number; name: string },
  lang: string,
  owned: Set<number>
): Promise<StoreSection | null> {
  try {
    const page = await searchItems(`tags=${tag.tagid}&filter=topsellers`, lang, 0, 24);
    const items = page.items.filter((i) => i.appid > 0 && !owned.has(i.appid)).slice(0, ROW_SIZE);
    return items.length ? { id: `personal-tag-${tag.tagid}`, name: tag.name, items } : null;
  } catch {
    return null;
  }
}

/** The user's most played Steam games, straight from the local library. */
function topPlayedSteam(count: number): { appid: number; title: string }[] {
  return getEntries()
    .filter((e) => e.source === 'Steam' && (e.playtimeMinutes ?? 0) > 0)
    .sort((a, b) => (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0))
    .slice(0, count)
    .map((e) => ({ appid: Number(e.externalId), title: e.title }))
    .filter((g) => Number.isInteger(g.appid) && g.appid > 0);
}

/** "Because you played <game>" — Steam's more-like-this page, appids scraped. */
async function moreLikeRow(
  game: { appid: number; title: string },
  lang: string,
  owned: Set<number>
): Promise<StoreSection | null> {
  try {
    const res = await httpFetch(
      `https://store.steampowered.com/recommended/morelike/app/${game.appid}/`,
      { headers: { 'User-Agent': BROWSER_UA } }
    );
    const html = await res.text();
    const ids = [...new Set([...html.matchAll(/data-ds-appid="(\d+)"/g)].map((m) => parseInt(m[1], 10)))]
      .filter((id) => id !== game.appid && !owned.has(id))
      .slice(0, ROW_SIZE);
    if (!ids.length) return null;

    const meta = await itemsMeta(ids, lang);
    const items = ids.map((id) => meta[id]).filter((i): i is StoreItem => !!i);
    return items.length ? { id: `personal-game-${game.appid}`, name: game.title, items } : null;
  } catch {
    return null;
  }
}

/**
 * All personalized rows for the store home. Empty when not signed in.
 * Section names carry the raw tag/game title — the renderer localizes the
 * full row headings.
 */
export async function personalSections(lang: string, force = false): Promise<StoreSection[]> {
  const ses = await getActiveSteamSession();
  if (!ses) return [];
  // Keyed by account: these rows are derived from the signed-in user's owned
  // apps and tags, and the cache outlives a sign-out (it is disk-backed).
  const steamId = getSteamAccount().steamId ?? 'anon';
  return cached(
    'personal',
    `sections:${steamId}:${lang}`,
    getStoreCacheTtlMs(),
    () => buildSections(ses, lang),
    { force }
  );
}

async function buildSections(ses: Session, lang: string): Promise<StoreSection[]> {
  const userData = await fetchUserData(ses);
  const owned = userData?.ownedApps ?? new Set<number>();

  const popularNew = await popularNewRow(lang, owned).catch(() => null);
  const played = topPlayedSteam(2);
  const [gameRows, tagRows] = await Promise.all([
    Promise.all(played.map((g) => moreLikeRow(g, lang, owned))),
    Promise.all((userData?.recommendedTags ?? []).slice(0, 3).map((t) => tagRow(t, lang, owned))),
  ]);

  return [popularNew, ...gameRows, ...tagRows].filter((s): s is StoreSection => !!s);
}
