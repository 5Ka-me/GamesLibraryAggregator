import type { Session } from 'electron';
import { getActiveSteamSession } from './steamAuth';
import { itemsMeta, searchItems, type StoreItem, type StoreSection } from './steamStore';
import { apiFetch } from './apiClient';
import { getStoreCacheTtlMs } from '../config';

// Personalized store rows, available once the user signed in through Steam:
//   - the real Discovery Queue (generated via the store session, CSRF-guarded);
//   - "Because you played <game>" — Steam's more-like-this for the user's most
//     played titles (from the aggregator library);
//   - "Because you like <tag>" — the account's recommended tags from
//     dynamicstore/userdata, turned into top-seller rows.
// Everything the user already owns is filtered out. All data flows stay in the
// main process; the renderer only receives ready-made sections.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const ROW_SIZE = 12;

interface UserData {
  recommendedTags: { tagid: number; name: string }[];
  ownedApps: Set<number>;
}

let cache: { at: number; lang: string; sections: StoreSection[] } | null = null;

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

/** The account's actual Discovery Queue (a fresh one per call). */
async function discoveryRow(ses: Session, lang: string): Promise<StoreSection | null> {
  const sid = await getSessionId(ses);
  if (!sid) return null;

  const res = await ses.fetch('https://store.steampowered.com/explore/generatenewdiscoveryqueue', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://store.steampowered.com',
      Referer: 'https://store.steampowered.com/explore/',
    },
    body: `sessionid=${encodeURIComponent(sid)}&queuetype=0`,
  });
  if (!res.ok) return null;

  const json = await res.json().catch(() => null);
  const queue: number[] = Array.isArray(json?.queue) ? json.queue : [];
  if (!queue.length) return null;

  const ids = queue.slice(0, ROW_SIZE);
  const meta = await itemsMeta(ids, lang);
  const items = ids.map((id) => meta[id]).filter((i): i is StoreItem => !!i);
  return items.length ? { id: 'personal-discovery', name: '', items } : null;
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

/** The user's most played Steam games from the aggregator library. */
async function topPlayedSteam(count: number): Promise<{ appid: number; title: string }[]> {
  try {
    const games = await apiFetch<any[]>('/api/library');
    const rows: { appid: number; title: string; minutes: number }[] = [];
    for (const g of games ?? []) {
      for (const e of g.entries ?? []) {
        if (e.source !== 'Steam' || !(e.playtimeMinutes > 0)) continue;
        const m = String(e.launchUrl ?? '').match(/rungameid\/(\d+)/);
        if (m) rows.push({ appid: parseInt(m[1], 10), title: g.title, minutes: e.playtimeMinutes });
      }
    }
    rows.sort((a, b) => b.minutes - a.minutes);
    return rows.slice(0, count);
  } catch {
    return [];
  }
}

/** "Because you played <game>" — Steam's more-like-this page, appids scraped. */
async function moreLikeRow(
  game: { appid: number; title: string },
  lang: string,
  owned: Set<number>
): Promise<StoreSection | null> {
  try {
    const res = await fetch(`https://store.steampowered.com/recommended/morelike/app/${game.appid}/`, {
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) return null;
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
  if (!force && cache && cache.lang === lang && Date.now() - cache.at < getStoreCacheTtlMs()) {
    return cache.sections;
  }

  const ses = await getActiveSteamSession();
  if (!ses) return [];

  const userData = await fetchUserData(ses);
  const owned = userData?.ownedApps ?? new Set<number>();

  const [discovery, played] = await Promise.all([
    discoveryRow(ses, lang).catch(() => null),
    topPlayedSteam(2),
  ]);
  const [gameRows, tagRows] = await Promise.all([
    Promise.all(played.map((g) => moreLikeRow(g, lang, owned))),
    Promise.all((userData?.recommendedTags ?? []).slice(0, 3).map((t) => tagRow(t, lang, owned))),
  ]);

  const sections = [discovery, ...gameRows, ...tagRows].filter((s): s is StoreSection => !!s);
  cache = { at: Date.now(), lang, sections };
  return sections;
}
