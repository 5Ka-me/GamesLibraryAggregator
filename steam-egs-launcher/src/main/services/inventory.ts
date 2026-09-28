import { app } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFoil, parseMoney, qualityRank, rarityRank, stackKey, tagOf } from '@app/shared';
import { communityFetch, getWebApiToken, steamStatus } from './steamAuth';
import { getSteamAccount } from './localData';
import { getRegions } from './regions';
import { cached, cacheGet, cacheList, cacheSet } from './cache';
import { emit } from './events';
import { BROWSER_UA } from './http';

// The signed-in user's Steam inventory, strictly read-only.
//
// Where the data comes from (measured, see docs):
//   - the list of games with item counts: one request, the inventory page's
//     g_rgAppContextData (as the signed-in user, so a private inventory works);
//   - items: IEconService/GetInventoryItemsWithDescriptions with the web
//     session's access token — one request per game (≤ 2 000 items per page,
//     paged by last_assetid), a separate rate limit from the community site,
//     so a whole inventory loads in seconds;
//   - fallback without a sign-in: steamcommunity.com/inventory, which blocks an
//     IP for ~1.5 min after ~10 quick requests — so requests are spaced and a
//     429 pauses the queue.
// Nothing here calls a write endpoint: no selling, trading, crafting or gems.

const STALE_MS = 6 * 3600_000;
const PAGE = 2000;
const MAX_PAGES = 25;
const WEBAPI = 'https://api.steampowered.com/IEconService/GetInventoryItemsWithDescriptions/v1/';
const COMMUNITY = 'https://steamcommunity.com';
const COMMUNITY_GAP_MS = 5_000;
const RATE_PAUSE_MS = 100_000;
const PRICE_NS = 'invPrice';
const PRICE_TTL_MS = 24 * 3600_000;
const CARD_NS = 'invCardSet';
const CARDSET_TTL_MS = 7 * 24 * 3600_000;
const CARDSET_GAP_MS = 6_000;
const MAX_LINES = 30;

// ---------- types (shared with the renderer through preload) ----------

export interface InvContext {
  id: string;
  name: string;
  count: number;
}

export interface InvApp {
  appid: number;
  name: string;
  icon: string | null;
  /** Number of assets Steam reports for the game (stacks count once). */
  count: number;
  contexts: InvContext[];
}

export interface InvTag {
  cat: string;
  catName: string;
  internal: string;
  name: string;
  color: string | null;
}

export interface InvLine {
  text: string;
  color: string | null;
  /** Steam's line id: exterior_wear, sticker_info, keychain_info, description, … */
  kind: string | null;
}

export interface InvClass {
  key: string;
  name: string;
  marketName: string | null;
  hashName: string | null;
  type: string;
  icon: string | null;
  iconLarge: string | null;
  nameColor: string | null;
  bgColor: string | null;
  tradable: boolean;
  marketable: boolean;
  commodity: boolean;
  tags: InvTag[];
  lines: InvLine[];
  ownerLines: InvLine[];
  /** Name tags and similar warnings Steam attaches ("Name Tag: ''…''"). */
  fraud: string[];
  /** The owner-only line that dates a trade or market hold, when there is one. */
  lock: string | null;
}

export interface InvAsset {
  id: string;
  ctx: string;
  cls: string;
  amount: number;
  /** CS2: wear rating (float) and pattern template. */
  wear?: number;
  pattern?: number;
}

export interface InvAppData {
  appid: number;
  fetchedAt: string;
  lang: string;
  source: 'webapi' | 'community';
  /** Assets (stacks of commodities count once), as Steam counts them. */
  total: number;
  assets: InvAsset[];
  classes: Record<string, InvClass>;
}

export interface InvOverview {
  steamId: string | null;
  signedIn: boolean;
  apps: InvApp[];
  listAt: string | null;
  listError: string | null;
  /** fetchedAt per appid that has items on disk (maybe stale). */
  loaded: Record<number, string>;
  loading: number[];
  errors: Record<number, string>;
}

export interface InvAppState {
  data: InvAppData | null;
  loading: boolean;
  error: string | null;
}

export interface InvPrice {
  lowest: string | null;
  median: string | null;
  volume: number | null;
  /** Numeric lowest (or median) price for sorting. */
  value: number | null;
  listed: boolean;
  at: string;
}

export interface CardSet {
  size: number;
  cards: { name: string; icon: string | null }[];
  at: string;
}

export interface CardSetsState {
  sets: Record<number, CardSet>;
  pending: number;
  total: number;
}

export interface InvChange {
  appid?: number;
  list?: boolean;
  cards?: boolean;
}

// ---------- disk copy ----------

interface InventoryFile {
  version: 1;
  steamId: string | null;
  list: { apps: InvApp[]; fetchedAt: string; lang: string } | null;
  apps: Record<string, InvAppData>;
}

const file = (): string => join(app.getPath('userData'), 'inventory.json');
let store: InventoryFile | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): InventoryFile {
  if (store) return store;
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<InventoryFile>;
      if (parsed && parsed.version === 1 && parsed.apps && typeof parsed.apps === 'object') {
        store = { version: 1, steamId: parsed.steamId ?? null, list: parsed.list ?? null, apps: parsed.apps };
        return store;
      }
    }
  } catch {
    /* corrupt → start over; it is a copy of Steam's data */
  }
  store = { version: 1, steamId: null, list: null, apps: {} };
  return store;
}

function persist(): void {
  if (!store) return;
  const f = file();
  writeFileSync(`${f}.tmp`, JSON.stringify(store), 'utf8');
  renameSync(`${f}.tmp`, f);
}

function saveSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 800);
}

app.on('before-quit', () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    persist();
  }
});

function resetFor(steamId: string): void {
  store = { version: 1, steamId, list: null, apps: {} };
  saveSoon();
}

const changed = (e: InvChange): void => emit('inventory:changed', e);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const steamLang = (lang: string): string => (lang === 'ru' ? 'russian' : 'english');
const nowIso = (): string => new Date().toISOString();

// ---------- identity ----------

interface Identity {
  steamId: string | null;
  signedIn: boolean;
}
let idCache: { at: number; value: Identity } | null = null;

/** The SteamID whose inventory is shown: the web sign-in first, else the account the library syncs. */
async function identity(fresh = false): Promise<Identity> {
  if (!fresh && idCache && Date.now() - idCache.at < 60_000) return idCache.value;
  const [st, token] = await Promise.all([
    steamStatus().catch(() => ({ loggedIn: false }) as { loggedIn: boolean; steamId?: string }),
    getWebApiToken().catch(() => null),
  ]);
  const steamId = (st.loggedIn && st.steamId) || getSteamAccount().steamId || null;
  const value = { steamId: steamId && /^\d{17}$/.test(steamId) ? steamId : null, signedIn: !!token };
  idCache = { at: Date.now(), value };
  return value;
}

// ---------- parsing ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1';
const hex = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);
const iconHash = (v: unknown): string | null => (typeof v === 'string' && /^[\w\-.~%]{8,4000}$/.test(v) ? v : null);

/** Steam description HTML → plain text (the renderer never gets markup from Steam). */
function htmlText(v: string): string {
  return v
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function toLine(x: any): InvLine | null {
  const text = htmlText(String(x?.value ?? '')).slice(0, 600);
  return text ? { text, color: hex(x?.color), kind: str(x?.name) } : null;
}

function toTag(x: any): InvTag | null {
  const cat = str(x?.category);
  const internal = str(x?.internal_name);
  if (!cat || !internal) return null;
  return {
    cat,
    catName: str(x?.localized_category_name) ?? cat,
    internal,
    name: str(x?.localized_tag_name) ?? internal,
    color: hex(x?.color),
  };
}

function toClass(d: any): InvClass | null {
  if (!d || d.classid == null) return null;
  const lines = arr(d.descriptions).map(toLine).filter((x): x is InvLine => !!x).slice(0, MAX_LINES);
  const ownerLines = arr(d.owner_descriptions).map(toLine).filter((x): x is InvLine => !!x).slice(0, MAX_LINES);
  const tradable = truthy(d.tradable);
  const marketable = truthy(d.marketable);
  const lock = !tradable || !marketable ? ownerLines.find((l) => /\b(19|20)\d\d\b/.test(l.text))?.text ?? null : null;
  return {
    key: `${d.classid}_${d.instanceid ?? '0'}`,
    name: str(d.name) ?? str(d.market_name) ?? 'Item',
    marketName: str(d.market_name),
    hashName: str(d.market_hash_name),
    type: str(d.type) ?? '',
    icon: iconHash(d.icon_url),
    iconLarge: iconHash(d.icon_url_large),
    nameColor: hex(d.name_color),
    bgColor: hex(d.background_color),
    tradable,
    marketable,
    commodity: truthy(d.commodity),
    tags: arr(d.tags).map(toTag).filter((x): x is InvTag => !!x),
    lines,
    ownerLines,
    fraud: arr(d.fraudwarnings).map((x) => htmlText(String(x))).filter(Boolean).slice(0, 5),
    lock,
  };
}

function normalize(appid: number, pages: any[], lang: string, source: InvAppData['source']): InvAppData {
  const classes: Record<string, InvClass> = {};
  const props = new Map<string, { wear?: number; pattern?: number }>();
  for (const p of pages) {
    for (const d of arr(p?.descriptions)) {
      const c = toClass(d);
      if (c) classes[c.key] = c;
    }
    for (const ap of arr(p?.asset_properties)) {
      const v: { wear?: number; pattern?: number } = {};
      for (const q of arr(ap?.asset_properties)) {
        if (Number(q?.propertyid) === 2 && q?.float_value != null) v.wear = Number(q.float_value);
        if (Number(q?.propertyid) === 1 && q?.int_value != null) v.pattern = Number(q.int_value);
      }
      props.set(String(ap?.assetid), v);
    }
  }
  const seen = new Set<string>();
  const assets: InvAsset[] = [];
  for (const p of pages) {
    for (const a of arr(p?.assets)) {
      const id = String(a?.assetid ?? '');
      const key = `${a?.classid}_${a?.instanceid ?? '0'}`;
      if (!id || seen.has(`${a?.contextid}:${id}`) || !classes[key]) continue;
      seen.add(`${a?.contextid}:${id}`);
      const pr = props.get(id);
      assets.push({
        id,
        ctx: String(a?.contextid ?? ''),
        cls: key,
        amount: Math.max(1, Number(a?.amount) || 1),
        ...(pr?.wear !== undefined && Number.isFinite(pr.wear) ? { wear: pr.wear } : {}),
        ...(pr?.pattern !== undefined && Number.isFinite(pr.pattern) ? { pattern: pr.pattern } : {}),
      });
    }
  }
  return { appid, fetchedAt: nowIso(), lang, source, total: assets.length, assets, classes };
}

/** Pulls the object literal assigned after `marker` out of a page, respecting strings. */
function extractObject(html: string, marker: string): any | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---------- Steam requests ----------

class InvError extends Error {}
const errCode = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 120);

async function fetchAppList(steamId: string, lang: string): Promise<InvApp[]> {
  const res = await communityFetch(`${COMMUNITY}/profiles/${steamId}/inventory/?l=${steamLang(lang)}`, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 429) throw new InvError('INV_RATE');
  if (!res.ok) throw new InvError(`INV_HTTP_${res.status}`);
  const html = await res.text();
  const data = extractObject(html, 'g_rgAppContextData');
  if (!data || typeof data !== 'object') {
    if (/profile_private_info|inventory is currently private|This profile is private/i.test(html)) throw new InvError('INV_PRIVATE');
    throw new InvError('INV_LIST');
  }
  return Object.values(data as Record<string, any>)
    .map((a) => ({
      appid: Number(a?.appid) || 0,
      name: str(a?.name) ?? String(a?.appid ?? ''),
      icon: typeof a?.icon === 'string' && a.icon.startsWith('https://') ? a.icon : null,
      count: Number(a?.asset_count) || 0,
      contexts: Object.values((a?.rgContexts ?? {}) as Record<string, any>)
        .map((c) => ({ id: String(c?.id ?? ''), name: str(c?.name) ?? '', count: Number(c?.asset_count) || 0 }))
        .filter((c) => /^\d+$/.test(c.id) && c.count > 0),
    }))
    .filter((a) => a.appid > 0 && a.count > 0 && a.contexts.length > 0)
    .sort((x, y) => y.count - x.count);
}

async function fetchWebApi(token: string, steamId: string, appid: number, ctx: string, lang: string): Promise<any[]> {
  const pages: any[] = [];
  let start: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url: string =
      `${WEBAPI}?access_token=${encodeURIComponent(token)}&steamid=${steamId}&appid=${appid}&contextid=${ctx}` +
      `&get_descriptions=true&get_asset_properties=true&language=${steamLang(lang)}&count=${PAGE}` +
      (start ? `&start_assetid=${start}` : '');
    const res: Response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 401 || res.status === 403) throw new InvError('INV_TOKEN');
    if (res.status === 429) throw new InvError('INV_RATE');
    if (!res.ok) throw new InvError(`INV_HTTP_${res.status}`);
    const r: any = ((await res.json()) as any)?.response ?? {};
    pages.push(r);
    if (!truthy(r.more_items) || !r.last_assetid) break;
    start = String(r.last_assetid);
  }
  return pages;
}

let communityPauseUntil = 0;

async function fetchCommunity(steamId: string, appid: number, ctx: string, lang: string): Promise<any[]> {
  const pages: any[] = [];
  let start: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const wait = communityPauseUntil - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await communityFetch(
      `${COMMUNITY}/inventory/${steamId}/${appid}/${ctx}?l=${steamLang(lang)}&count=${PAGE}${start ? `&start_assetid=${start}` : ''}`,
      { signal: AbortSignal.timeout(30_000) }
    );
    if (res.status === 429) {
      communityPauseUntil = Date.now() + RATE_PAUSE_MS;
      throw new InvError('INV_RATE');
    }
    if (res.status === 403) throw new InvError('INV_PRIVATE');
    if (!res.ok) throw new InvError(`INV_HTTP_${res.status}`);
    const j = (await res.json().catch(() => null)) as any;
    if (!j) throw new InvError('INV_PRIVATE'); // Steam answers `null` for a private inventory
    pages.push(j);
    if (!truthy(j.more_items) || !j.last_assetid) break;
    start = String(j.last_assetid);
    await sleep(1_500);
  }
  return pages;
}

// ---------- the loading queue ----------

let currentLang = 'en';
let forcedAt = 0;
let listError: string | null = null;
let listInflight: Promise<void> | null = null;
const active = new Set<number>();
const errors = new Map<number, string>();
const retries = new Map<number, number>();
const waiters = new Map<number, { promise: Promise<void>; resolve: () => void }>();
let queue: number[] = [];
let pumping = false;

function waiterFor(appid: number): Promise<void> {
  let w = waiters.get(appid);
  if (!w) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    w = { promise, resolve };
    waiters.set(appid, w);
  }
  return w.promise;
}

function isStale(d: InvAppData | undefined, lang: string): boolean {
  if (!d) return true;
  const at = Date.parse(d.fetchedAt);
  return d.lang !== lang || !Number.isFinite(at) || Date.now() - at > STALE_MS || at < forcedAt;
}

/** Queues games for loading; `front` puts them ahead (the game the user is looking at). */
function schedule(appids: number[], front = false): void {
  for (const a of appids) {
    waiterFor(a);
    if (active.has(a)) continue;
    queue = queue.filter((x) => x !== a);
    if (front) queue.unshift(a);
    else queue.push(a);
  }
  void pump();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const id = await identity();
      if (!id.steamId) {
        for (const a of queue) waiters.get(a)?.resolve();
        queue = [];
        break;
      }
      const token = await getWebApiToken().catch(() => null);
      // The Web API takes a few games at once; the community fallback one at a time with a gap.
      const batch = queue.splice(0, token ? 3 : 1);
      await Promise.all(batch.map((a) => loadApp(a, id.steamId!, token)));
      if (!token && queue.length) await sleep(COMMUNITY_GAP_MS);
    }
  } finally {
    pumping = false;
  }
}

async function loadApp(appid: number, steamId: string, token: string | null): Promise<void> {
  const f = load();
  const info = f.list?.apps.find((a) => a.appid === appid);
  active.add(appid);
  changed({ appid });
  try {
    if (!info) throw new InvError('INV_LIST');
    const lang = currentLang;
    const pages: any[] = [];
    let source: InvAppData['source'] = token ? 'webapi' : 'community';
    for (const ctx of info.contexts) {
      let got: any[] | null = null;
      if (token) {
        try {
          got = await fetchWebApi(token, steamId, appid, ctx.id, lang);
        } catch (e) {
          if (errCode(e) === 'INV_PRIVATE') throw e;
          source = 'community'; // token expired or the Web API refused: read it the public way
        }
      }
      if (!got) got = await fetchCommunity(steamId, appid, ctx.id, lang);
      pages.push(...got);
    }
    if (load().steamId !== steamId) return; // the account changed while loading
    load().apps[String(appid)] = normalize(appid, pages, lang, source);
    errors.delete(appid);
    retries.delete(appid);
    saveSoon();
  } catch (e) {
    const code = errCode(e);
    errors.set(appid, code);
    if (code === 'INV_RATE') {
      const n = (retries.get(appid) ?? 0) + 1;
      retries.set(appid, n);
      if (n <= 3) setTimeout(() => schedule([appid]), RATE_PAUSE_MS);
    }
  } finally {
    active.delete(appid);
    const w = waiters.get(appid);
    waiters.delete(appid);
    w?.resolve();
    changed({ appid });
  }
}

function refreshList(steamId: string, lang: string): Promise<void> {
  if (!listInflight) {
    listInflight = (async () => {
      try {
        const apps = await fetchAppList(steamId, lang);
        const f = load();
        if (f.steamId !== steamId) return;
        f.list = { apps, fetchedAt: nowIso(), lang };
        for (const k of Object.keys(f.apps)) if (!apps.some((a) => String(a.appid) === k)) delete f.apps[k];
        listError = null;
        saveSoon();
      } catch (e) {
        listError = errCode(e);
      } finally {
        listInflight = null;
        changed({ list: true });
      }
    })();
  }
  return listInflight;
}

function scheduleStale(lang: string): void {
  const f = load();
  const stale = (f.list?.apps ?? []).filter((a) => isStale(f.apps[String(a.appid)], lang)).map((a) => a.appid);
  if (stale.length) schedule(stale);
}

function overviewNow(id: Identity): InvOverview {
  const f = load();
  const loaded: Record<number, string> = {};
  for (const [k, d] of Object.entries(f.apps)) loaded[Number(k)] = d.fetchedAt;
  return {
    steamId: id.steamId,
    signedIn: id.signedIn,
    apps: f.list?.apps ?? [],
    listAt: f.list?.fetchedAt ?? null,
    listError,
    loaded,
    loading: [...new Set([...active, ...queue])],
    errors: Object.fromEntries(errors),
  };
}

// ---------- public API ----------

/**
 * The game list and loading state. Serves the disk copy at once; refreshes the
 * list and every game older than 6 hours (or in another language) in the
 * background. `force` refreshes everything now.
 */
export async function inventoryOverview(lang: string, force = false): Promise<InvOverview> {
  currentLang = lang;
  const id = await identity(force);
  if (!id.steamId) return overviewNow(id);
  const f = load();
  if (f.steamId !== id.steamId) resetFor(id.steamId);
  if (force) forcedAt = Date.now();
  const list = load().list;
  const listAt = list ? Date.parse(list.fetchedAt) : NaN;
  const listFresh = !!list && list.lang === lang && Number.isFinite(listAt) && Date.now() - listAt < STALE_MS && listAt >= forcedAt;
  if (!list) await refreshList(id.steamId, lang);
  else if (!listFresh) void refreshList(id.steamId, lang).then(() => scheduleStale(lang));
  scheduleStale(lang);
  return overviewNow(id);
}

/** One game's items from the disk copy; queues it first in line when missing or stale. */
export function inventoryApp(appid: number, lang: string): InvAppState {
  currentLang = lang;
  const d = load().apps[String(appid)];
  if (isStale(d, lang)) schedule([appid], true);
  return { data: d ?? null, loading: active.has(appid) || queue.includes(appid), error: errors.get(appid) ?? null };
}

/** Waits (bounded) until the given games are loaded — for the assistant's tool. */
async function ensureLoaded(appids: number[], lang: string, timeoutMs: number): Promise<void> {
  currentLang = lang;
  const f = load();
  const need = appids.filter((a) => !f.apps[String(a)]);
  if (!need.length) return;
  schedule(need, true);
  await Promise.race([Promise.all(need.map(waiterFor)), sleep(timeoutMs)]);
}

// ---------- prices (on demand, cached a day) ----------

const EURO = new Set(['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK']);
const CURRENCY: Record<string, number> = {
  US: 1, GB: 2, CH: 4, RU: 5, PL: 6, BR: 7, JP: 8, NO: 9, ID: 10, MY: 11, PH: 12, SG: 13, TH: 14, VN: 15, KR: 16,
  UA: 18, MX: 19, CA: 20, AU: 21, NZ: 22, CN: 23, IN: 24, CL: 25, PE: 26, CO: 27, ZA: 28, HK: 29, TW: 30, SA: 31,
  AE: 32, IL: 35, KZ: 37, KW: 38, QA: 39, CR: 40, UY: 41,
};

/** Steam's wallet currency id for the account's store region (USD where Steam prices in dollars). */
function currencyId(): number {
  const cc = getRegions().steamCc;
  return EURO.has(cc) ? 3 : CURRENCY[cc] ?? 1;
}

async function fetchPrice(appid: number, hashName: string, cur: number): Promise<InvPrice> {
  const res = await fetch(
    `${COMMUNITY}/market/priceoverview/?appid=${appid}&currency=${cur}&market_hash_name=${encodeURIComponent(hashName)}`,
    { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(20_000) }
  );
  if (res.status === 429) throw new InvError('INV_PRICE_RATE');
  const j = (await res.json().catch(() => null)) as any;
  if (!j) throw new InvError(`INV_HTTP_${res.status}`);
  const at = nowIso();
  if (!j.success) return { lowest: null, median: null, volume: null, value: null, listed: false, at };
  const lowest = str(j.lowest_price);
  const median = str(j.median_price);
  const vol = j.volume != null ? Number(String(j.volume).replace(/[^\d]/g, '')) : NaN;
  return { lowest, median, volume: Number.isFinite(vol) ? vol : null, value: parseMoney(lowest) ?? parseMoney(median), listed: !!(lowest || median), at };
}

/** Steam Market price of one item in the account's currency; cached 24 h. */
export function inventoryPrice(appid: number, hashName: string, force = false): Promise<InvPrice> {
  const cur = currencyId();
  return cached(PRICE_NS, `${cur}|${appid}|${hashName}`, PRICE_TTL_MS, () => fetchPrice(appid, hashName, cur), { force });
}

/** Every price already known in the current currency, keyed "appid|market_hash_name". */
export function inventoryPrices(): Record<string, InvPrice> {
  const prefix = `${currencyId()}|`;
  const out: Record<string, InvPrice> = {};
  for (const e of cacheList<InvPrice>(PRICE_NS, prefix)) out[e.key.slice(prefix.length)] = e.data;
  return out;
}

// ---------- trading card sets ----------

let cardQueue: number[] = [];
let cardActive: number | null = null;
let cardPumping = false;

/** Games whose trading cards are in the Steam inventory (from the disk copy). */
function cardGames(): number[] {
  const steam = load().apps['753'];
  if (!steam) return [];
  const games = new Set<number>();
  for (const c of Object.values(steam.classes)) {
    if (!c.tags.some((t) => t.internal === 'item_class_2')) continue;
    const g = c.tags.find((t) => t.cat === 'Game')?.internal.match(/^app_(\d+)$/);
    if (g) games.add(Number(g[1]));
  }
  return [...games];
}

async function fetchCardSet(steamId: string, game: number, lang: string): Promise<CardSet> {
  const res = await communityFetch(`${COMMUNITY}/profiles/${steamId}/gamecards/${game}/?l=${steamLang(lang)}`, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 429) throw new InvError('INV_RATE');
  if (!res.ok) throw new InvError(`INV_HTTP_${res.status}`);
  const html = await res.text();
  const cards: CardSet['cards'] = [];
  for (const block of html.split('<div class="badge_card_set_card ').slice(1)) {
    const img = /economy\/image\/([\w\-.~%]+)/.exec(block);
    const title = /badge_card_set_title[^>]*>([\s\S]*?)<div style="clear: right">/.exec(block);
    const name = title ? htmlText(title[1].replace(/<div class="badge_card_set_text_qty">[\s\S]*?<\/div>/, '')) : '';
    cards.push({ name, icon: img ? img[1] : null });
  }
  return { size: cards.length, cards, at: nowIso() };
}

async function pumpCards(steamId: string, lang: string): Promise<void> {
  if (cardPumping) return;
  cardPumping = true;
  try {
    while (cardQueue.length) {
      const wait = communityPauseUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const game = cardQueue.shift()!;
      cardActive = game;
      try {
        cacheSet(CARD_NS, `${steamLang(lang)}|${game}`, await fetchCardSet(steamId, game, lang));
      } catch (e) {
        if (errCode(e) === 'INV_RATE') {
          communityPauseUntil = Date.now() + RATE_PAUSE_MS;
          cardQueue.push(game);
        }
      } finally {
        cardActive = null;
        changed({ cards: true });
      }
      if (cardQueue.length) await sleep(CARDSET_GAP_MS);
    }
  } finally {
    cardPumping = false;
  }
}

/**
 * Set size and card list per game for the Steam trading cards the user holds.
 * Known sets come from the cache (a week); missing ones load in the background
 * from each game's card page, one request every few seconds.
 */
export async function inventoryCardSets(lang: string): Promise<CardSetsState> {
  const id = await identity();
  const games = cardGames();
  const sets: Record<number, CardSet> = {};
  const missing: number[] = [];
  for (const g of games) {
    const hit = cacheGet<CardSet>(CARD_NS, `${steamLang(lang)}|${g}`, CARDSET_TTL_MS);
    if (hit) sets[g] = hit.data;
    if (!hit?.fresh) missing.push(g);
  }
  if (id.steamId && missing.length) {
    for (const g of missing) if (!cardQueue.includes(g) && cardActive !== g) cardQueue.push(g);
    void pumpCards(id.steamId, lang);
  }
  return { sets, pending: cardQueue.length + (cardActive !== null ? 1 : 0), total: games.length };
}

// ---------- the assistant's read-only view ----------

interface ToolStack {
  appid: number;
  game: string;
  cls: InvClass;
  qty: number;
  newest: number;
}

function stacksOf(appids: number[]): ToolStack[] {
  const f = load();
  const names = new Map((f.list?.apps ?? []).map((a) => [a.appid, a.name]));
  const byKey = new Map<string, ToolStack>();
  for (const appid of appids) {
    const d = f.apps[String(appid)];
    if (!d) continue;
    for (const a of d.assets) {
      const cls = d.classes[a.cls];
      if (!cls) continue;
      const key = stackKey(appid, cls);
      const s = byKey.get(key) ?? { appid, game: names.get(appid) ?? String(appid), cls, qty: 0, newest: 0 };
      s.qty += a.amount;
      s.newest = Math.max(s.newest, Number(a.id) || 0);
      byKey.set(key, s);
    }
  }
  return [...byKey.values()];
}

const lower = (s: string) => s.toLowerCase();

/** Per-game counts for the assistant. */
export async function inventoryToolOverview(lang: string): Promise<unknown> {
  const ov = await inventoryOverview(lang);
  if (!ov.steamId) return { error: 'Steam is not connected in the launcher' };
  if (!ov.apps.length) return { error: ov.listError ? `could not read the inventory (${ov.listError})` : 'the inventory is empty' };
  await ensureLoaded(ov.apps.map((a) => a.appid), lang, 20_000);
  const f = load();
  return {
    games: ov.apps.map((a) => {
      const d = f.apps[String(a.appid)];
      const classes = d ? d.assets.map((x) => d.classes[x.cls]).filter(Boolean) : [];
      return {
        game: a.name,
        items: a.count,
        ...(d ? { tradable: classes.filter((c) => c.tradable).length, marketable: classes.filter((c) => c.marketable).length } : { note: 'not loaded yet' }),
      };
    }),
    totalItems: ov.apps.reduce((s, a) => s + a.count, 0),
  };
}

/** Searches the inventory for the assistant; optionally prices up to 10 candidates. */
export async function inventoryToolFind(a: any, lang: string): Promise<unknown> {
  const ov = await inventoryOverview(lang);
  if (!ov.steamId) return { error: 'Steam is not connected in the launcher' };
  const game = str(a?.game);
  const apps = game
    ? ov.apps.filter((x) => String(x.appid) === game || lower(x.name).includes(lower(game)))
    : ov.apps;
  if (!apps.length) return { error: game ? `no inventory for "${game}"`: 'the inventory is empty', games: ov.apps.map((x) => x.name) };
  await ensureLoaded(apps.map((x) => x.appid), lang, 20_000);

  const q = str(a?.query)?.toLowerCase() ?? null;
  const wantTags = arr(a?.tags).filter((x): x is string => typeof x === 'string' && !!x.trim()).map(lower).slice(0, 6);
  let list = stacksOf(apps.map((x) => x.appid)).filter((s) => {
    const c = s.cls;
    if (typeof a?.tradable === 'boolean' && c.tradable !== a.tradable) return false;
    if (typeof a?.marketable === 'boolean' && c.marketable !== a.marketable) return false;
    if (wantTags.length && !wantTags.every((w) => c.tags.some((t) => lower(t.name).includes(w) || lower(t.internal).includes(w)))) return false;
    if (q) {
      const hay = lower([c.name, c.type, c.hashName ?? '', ...c.tags.map((t) => t.name), ...c.lines.slice(0, 6).map((l) => l.text)].join(' '));
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const sort = str(a?.sort) ?? 'rarity';
  const byRarity = (x: ToolStack, y: ToolStack) => rarityRank(y.cls.tags) - rarityRank(x.cls.tags) || qualityRank(y.cls.tags) - qualityRank(x.cls.tags);
  if (sort === 'name') list.sort((x, y) => x.cls.name.localeCompare(y.cls.name));
  else if (sort === 'quantity') list.sort((x, y) => y.qty - x.qty);
  else if (sort === 'newest') list.sort((x, y) => y.newest - x.newest);
  else list.sort(byRarity);

  // Prices: known ones are free; with withPrices, up to 10 more are fetched (Steam limits ~20/min).
  const known = inventoryPrices();
  const priceOf = (s: ToolStack): InvPrice | undefined => (s.cls.hashName ? known[`${s.appid}|${s.cls.hashName}`] : undefined);
  if (a?.withPrices === true || sort === 'price') {
    let fetched = 0;
    for (const s of list) {
      if (fetched >= 10) break;
      if (!s.cls.marketable || !s.cls.hashName || priceOf(s)) continue;
      try {
        known[`${s.appid}|${s.cls.hashName}`] = await inventoryPrice(s.appid, s.cls.hashName);
        fetched++;
        await sleep(1_200);
      } catch {
        break; // rate-limited: answer with what is known
      }
    }
  }
  if (sort === 'price') list.sort((x, y) => (priceOf(y)?.value ?? -1) - (priceOf(x)?.value ?? -1));

  const limit = Math.min(40, Math.max(1, Number(a?.limit) || 20));
  const total = list.length;
  list = list.slice(0, limit);
  return {
    total,
    shown: list.length,
    items: list.map((s) => {
      const c = s.cls;
      const price = priceOf(s);
      return {
        name: c.name,
        game: s.game,
        type: c.type,
        ...(tagOf(c.tags, 'Rarity') || tagOf(c.tags, 'droprate') ? { rarity: (tagOf(c.tags, 'Rarity') ?? tagOf(c.tags, 'droprate'))!.name } : {}),
        ...(tagOf(c.tags, 'Quality') ? { quality: tagOf(c.tags, 'Quality')!.name } : {}),
        ...(tagOf(c.tags, 'Exterior') ? { exterior: tagOf(c.tags, 'Exterior')!.name } : {}),
        ...(isFoil(c.tags) ? { foil: true } : {}),
        quantity: s.qty,
        tradable: c.tradable,
        marketable: c.marketable,
        ...(c.lock ? { hold: c.lock } : {}),
        ...(price?.listed ? { price: price.lowest ?? price.median } : price ? { price: 'not listed' } : {}),
        tags: c.tags.filter((t) => !/^(Game|cardborder|item_class|misc)$/i.test(t.cat)).slice(0, 6).map((t) => `${t.catName}: ${t.name}`),
      };
    }),
  };
}

