import { app } from 'electron';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TAG_CHIPS, normalizeTitle, type TagChip } from '@app/shared';
import { emit } from './events';
import { getEntries, getSteamAccount } from './localData';
import { applyFind, libKey, libraryView, needsProgress, needsStoreTags, type FindArgs, type GameRef, type LibGame } from './libraryIndex';
import { steamInstallPath } from './steamScan';
import { accountIdFromSteamId64, parseSteamCollections } from './steamCollections';

// Steam-like collections over the merged library. Rules:
//   - A member is a GAME, not a store copy: it is stored as the refs of every
//     store entry it has (Steam appid, Epic app name) plus the normalized title
//     as a fallback key, so a game bought on both stores is one member and new
//     sources plug in without a migration.
//   - Two origins: "local" (created here) and "steam" (imported from the Steam
//     client's cloud-storage files). Steam-origin collections stay editable —
//     games from any store can be added — and are shown as "(edited)" once
//     their members differ from the Steam snapshot; "reset" restores it.
//   - Two kinds: "manual" (explicit members) and "dynamic" (a saved FindArgs
//     rule, re-evaluated on every resolve — the assistant's filter language).
//   - "favorite" and "hidden" are built-in local collections. Hidden games
//     leave the library list, the reel and statistics.

export type CollectionOrigin = 'local' | 'steam';
export type CollectionKind = 'manual' | 'dynamic';
export type SystemCollection = 'favorite' | 'hidden';
export type CollectionRule = Pick<FindArgs, 'sources' | 'installed' | 'played' | 'achievements' | 'lastPlayed' | 'titleContains' | 'tags' | 'chips' | 'steamTags'>;

export interface Member {
  refs: GameRef[];
  /** normalizeTitle(title): fallback when no ref matches (a store copy was removed, a new source appears). */
  title: string;
}

export interface Collection {
  id: string;
  name: string;
  origin: CollectionOrigin;
  kind: CollectionKind;
  rule?: CollectionRule;
  members: Member[];
  /** Present for Steam-origin collections: what Steam had at the last import. */
  steam?: { id: string; members: Member[]; dynamic: boolean; importedAt: string };
  order: number;
  createdAt: string;
  updatedAt: string;
}

/** What the renderer sends to identify a game: its store handles plus the title. */
export interface GameHandle {
  title: string;
  refs: GameRef[];
}

/** A collection with its current members resolved to the renderer's game keys. */
export interface ResolvedCollection {
  id: string;
  name: string;
  origin: CollectionOrigin;
  kind: CollectionKind;
  system: SystemCollection | null;
  /** Steam-origin collection whose members no longer match the Steam snapshot. */
  edited: boolean;
  /** Dynamic in Steam (filter by Steam tags); only the explicit additions could be imported. */
  steamDynamic: boolean;
  rule?: CollectionRule;
  order: number;
  keys: string[];
}

interface CollectionsFile {
  version: 1;
  collections: Collection[];
}

const file = (): string => join(app.getPath('userData'), 'collections.json');
let cache: CollectionsFile | null = null;

const now = () => new Date().toISOString();
const SYSTEM_IDS: SystemCollection[] = ['favorite', 'hidden'];

function load(): CollectionsFile {
  if (cache) return cache;
  let parsed: Partial<CollectionsFile> | null = null;
  try {
    if (existsSync(file())) parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<CollectionsFile>;
  } catch {
    /* corrupt → start over */
  }
  const collections = Array.isArray(parsed?.collections) ? parsed!.collections.filter((c) => c && typeof c.id === 'string') : [];
  // The two built-ins always exist, in front of everything else.
  for (const [i, id] of SYSTEM_IDS.entries()) {
    if (!collections.some((c) => c.id === id)) {
      collections.push({ id, name: id, origin: 'local', kind: 'manual', members: [], order: i - 10, createdAt: now(), updatedAt: now() });
    }
  }
  cache = { version: 1, collections };
  return cache;
}

function save(): void {
  const f = file();
  writeFileSync(`${f}.tmp`, JSON.stringify(cache), 'utf8');
  renameSync(`${f}.tmp`, f);
  emit('collections:changed', null);
}

const isSystem = (id: string): id is SystemCollection => (SYSTEM_IDS as string[]).includes(id);
const newId = () => `c-${randomBytes(5).toString('hex')}`;

// ---------- membership ----------

const refKey = (r: GameRef) => `${r.source}:${r.id}`;
const memberKeys = (m: Member): string[] => (m.refs.length ? m.refs.map(refKey) : m.title ? [`t:${m.title}`] : []);

function memberMatches(m: Member, g: LibGame): boolean {
  if (m.refs.some((r) => g.refs.some((x) => x.source === r.source && x.id === r.id))) return true;
  return !!m.title && m.title === g.key;
}

const sameMembers = (a: Member[], b: Member[]): boolean => {
  const ka = new Set(a.flatMap(memberKeys));
  const kb = new Set(b.flatMap(memberKeys));
  return ka.size === kb.size && [...ka].every((k) => kb.has(k));
};

function handleToMember(h: GameHandle): Member {
  const refs = (Array.isArray(h.refs) ? h.refs : [])
    .filter((r): r is GameRef => !!r && typeof r.source === 'string' && typeof r.id === 'string' && r.id.length > 0 && r.id.length < 200)
    .slice(0, 8);
  return { refs, title: normalizeTitle(String(h.title ?? '')).slice(0, 200) };
}

const handleMatchesMember = (h: Member, m: Member): boolean =>
  h.refs.some((r) => m.refs.some((x) => x.source === r.source && x.id === r.id)) || (!!h.title && h.title === m.title);

// ---------- read ----------

export function listCollections(): Collection[] {
  return [...load().collections].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

async function viewFor(cols: Collection[]): Promise<LibGame[]> {
  const dyn = cols.filter((c) => c.kind === 'dynamic' && c.rule).map((c) => c.rule!);
  return libraryView(dyn.some(needsProgress), dyn.some(needsStoreTags));
}

function membersOf(c: Collection, view: LibGame[], hiddenKeys: Set<string>): LibGame[] {
  if (c.kind === 'dynamic') return applyFind(view, { ...(c.rule ?? {}), sort: 'alpha' }).filter((g) => !hiddenKeys.has(g.key));
  return view.filter((g) => c.members.some((m) => memberMatches(m, g)));
}

export async function resolveCollections(): Promise<ResolvedCollection[]> {
  const cols = listCollections();
  const view = await viewFor(cols);
  const hidden = cols.find((c) => c.id === 'hidden');
  const hiddenKeys = new Set((hidden ? membersOf(hidden, view, new Set()) : []).map((g) => g.key));
  return cols.map((c) => ({
    id: c.id,
    name: c.name,
    origin: c.origin,
    kind: c.kind,
    system: isSystem(c.id) ? c.id : null,
    edited: !!c.steam && !sameMembers(c.members, c.steam.members),
    steamDynamic: !!c.steam?.dynamic,
    ...(c.rule ? { rule: c.rule } : {}),
    order: c.order,
    keys: membersOf(c, view, hiddenKeys).map(libKey),
  }));
}

/** Normalized-title keys of hidden games (the assistant's tools leave them out). */
export async function hiddenTitleKeys(): Promise<Set<string>> {
  const hidden = load().collections.find((c) => c.id === 'hidden');
  if (!hidden || !hidden.members.length) return new Set();
  const view = await libraryView(false);
  return new Set(membersOf(hidden, view, new Set()).map((g) => g.key));
}

/** How many games a dynamic rule would match right now (the editor's live preview). */
export async function previewRule(rule: CollectionRule): Promise<number> {
  const view = await libraryView(needsProgress(rule), needsStoreTags(rule));
  return applyFind(view, { ...rule, sort: 'alpha' }).length;
}

// ---------- write ----------

function cleanRule(raw: unknown): CollectionRule {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);
  const sources = Array.isArray(r.sources) ? r.sources.filter((s): s is 'Steam' | 'Epic' => s === 'Steam' || s === 'Epic') : [];
  const chips = Array.isArray(r.chips) ? r.chips.filter((c): c is TagChip => typeof c === 'string' && (TAG_CHIPS as string[]).includes(c)).slice(0, 6) : [];
  return {
    ...(sources.length ? { sources } : {}),
    ...(typeof r.installed === 'boolean' ? { installed: r.installed } : {}),
    ...(pick(r.played, ['never', '<1h', '1-10h', '10-50h', '50h+', 'any_played'] as const) ? { played: pick(r.played, ['never', '<1h', '1-10h', '10-50h', '50h+', 'any_played'] as const) } : {}),
    ...(pick(r.achievements, ['none', 'started', 'half', 'almost', 'perfect', 'has_any'] as const) ? { achievements: pick(r.achievements, ['none', 'started', 'half', 'almost', 'perfect', 'has_any'] as const) } : {}),
    ...(pick(r.lastPlayed, ['last_2_weeks', 'last_90_days', 'over_180_days_ago', 'never'] as const) ? { lastPlayed: pick(r.lastPlayed, ['last_2_weeks', 'last_90_days', 'over_180_days_ago', 'never'] as const) } : {}),
    ...(str(r.titleContains, 80) ? { titleContains: str(r.titleContains, 80) } : {}),
    ...(r.tags && typeof r.tags === 'object' ? { tags: r.tags as CollectionRule['tags'] } : {}),
    ...(chips.length ? { chips } : {}),
    ...(Array.isArray(r.steamTags) && r.steamTags.some((x) => typeof x === 'string' && x.trim())
      ? { steamTags: r.steamTags.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim().slice(0, 40)).slice(0, 6) }
      : {}),
  };
}

const cleanName = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
  if (!s) throw new Error('Collection name is required');
  return s;
};

export function createCollection(input: { name: unknown; kind?: unknown; rule?: unknown }): Collection {
  const data = load();
  const kind: CollectionKind = input.kind === 'dynamic' ? 'dynamic' : 'manual';
  const c: Collection = {
    id: newId(),
    name: cleanName(input.name),
    origin: 'local',
    kind,
    ...(kind === 'dynamic' ? { rule: cleanRule(input.rule) } : {}),
    members: [],
    order: Math.max(0, ...data.collections.map((x) => x.order)) + 1,
    createdAt: now(),
    updatedAt: now(),
  };
  data.collections.push(c);
  save();
  return c;
}

export function updateCollection(id: string, patch: { name?: unknown; rule?: unknown; kind?: unknown; order?: unknown }): Collection {
  const c = load().collections.find((x) => x.id === id);
  if (!c) throw new Error('No such collection');
  if (patch.name !== undefined && !isSystem(id)) c.name = cleanName(patch.name);
  if (patch.kind === 'manual' || patch.kind === 'dynamic') {
    if (isSystem(id)) throw new Error('Built-in collections stay manual');
    c.kind = patch.kind;
    if (c.kind === 'manual') delete c.rule;
  }
  if (patch.rule !== undefined && c.kind === 'dynamic') c.rule = cleanRule(patch.rule);
  if (typeof patch.order === 'number' && Number.isFinite(patch.order)) c.order = patch.order;
  c.updatedAt = now();
  save();
  return c;
}

export function deleteCollection(id: string): void {
  if (isSystem(id)) throw new Error('Built-in collections cannot be deleted');
  const data = load();
  const before = data.collections.length;
  data.collections = data.collections.filter((x) => x.id !== id);
  if (data.collections.length !== before) save();
}

/** Reorders by the given id list; ids not listed keep their relative order after it. */
export function reorderCollections(ids: unknown): void {
  if (!Array.isArray(ids)) return;
  const data = load();
  let order = 0;
  for (const id of ids) {
    const c = data.collections.find((x) => x.id === id && !isSystem(x.id));
    if (c) c.order = order++;
  }
  save();
}

/** Adds or removes one game; a dynamic collection can't take manual members. */
export function setMembership(id: string, handle: GameHandle, member: boolean): void {
  const c = load().collections.find((x) => x.id === id);
  if (!c) throw new Error('No such collection');
  if (c.kind === 'dynamic') throw new Error('Dynamic collections are filled by their rule');
  const h = handleToMember(handle);
  if (!h.refs.length && !h.title) throw new Error('Cannot identify the game');
  const idx = c.members.findIndex((m) => handleMatchesMember(h, m));
  if (member && idx < 0) c.members.push(h);
  else if (!member && idx >= 0) c.members.splice(idx, 1);
  else return;
  // A game can't be favourite and hidden at once — mirror Steam.
  if (member && (id === 'favorite' || id === 'hidden')) {
    const other = load().collections.find((x) => x.id === (id === 'favorite' ? 'hidden' : 'favorite'));
    if (other) other.members = other.members.filter((m) => !handleMatchesMember(h, m));
  }
  c.updatedAt = now();
  save();
}

/** Ids of the collections this game is a manual member of (for menus). */
export function membershipOf(handle: GameHandle): string[] {
  const h = handleToMember(handle);
  return load()
    .collections.filter((c) => c.kind === 'manual' && c.members.some((m) => handleMatchesMember(h, m)))
    .map((c) => c.id);
}

/** Adds owned games by title to a manual collection (the assistant's tool); creates the collection when asked. */
export async function addTitles(name: string, titles: string[], createIfMissing: boolean): Promise<{ collection: Collection | null; added: string[]; alreadyIn: string[]; notFound: string[] }> {
  const data = load();
  const wanted = normalizeTitle(name);
  let c = data.collections.find((x) => !isSystem(x.id) && normalizeTitle(x.name) === wanted) ?? null;
  if (!c) {
    if (!createIfMissing) return { collection: null, added: [], alreadyIn: [], notFound: titles };
    c = createCollection({ name, kind: 'manual' });
  }
  if (c.kind === 'dynamic') throw new Error('Dynamic collections are filled by their rule');
  const view = await libraryView(false);
  const added: string[] = [];
  const alreadyIn: string[] = [];
  const notFound: string[] = [];
  for (const t of titles) {
    const key = normalizeTitle(t);
    const g = view.find((x) => x.key === key);
    if (!g) {
      notFound.push(t);
      continue;
    }
    const m: Member = { refs: g.refs, title: g.key };
    if (c.members.some((x) => handleMatchesMember(m, x))) alreadyIn.push(g.title);
    else {
      c.members.push(m);
      added.push(g.title);
    }
  }
  if (added.length) {
    c.updatedAt = now();
    save();
  }
  return { collection: c, added, alreadyIn, notFound };
}

/** Name, kind and a few titles per user collection — what the assistant's tool reports. */
export async function collectionSummaries(): Promise<{ name: string; kind: CollectionKind; origin: CollectionOrigin; count: number; sample: string[] }[]> {
  const cols = listCollections().filter((c) => !isSystem(c.id));
  const view = await viewFor(cols);
  return cols.map((c) => {
    const games = membersOf(c, view, new Set());
    return { name: c.name, kind: c.kind, origin: c.origin, count: games.length, sample: games.slice(0, 6).map((g) => g.title) };
  });
}

// ---------- Steam import ----------

export interface SteamImportResult {
  /** Where the collections were read from; null when no Steam client data was found. */
  path: string | null;
  imported: number;
  updated: number;
  favorites: number;
  hidden: number;
}

function steamCollectionFiles(steamPath: string): { dir: string; base: string; modified: string | null }[] {
  const userdata = join(steamPath, 'userdata');
  if (!existsSync(userdata)) return [];
  const { steamId } = getSteamAccount();
  const preferred = steamId ? accountIdFromSteamId64(steamId) : null;
  const dirs = readdirSync(userdata, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
  const out: { dir: string; base: string; modified: string | null }[] = [];
  for (const d of dirs) {
    const dir = join(userdata, d, 'config', 'cloudstorage');
    const base = join(dir, 'cloud-storage-namespace-1.json');
    if (!existsSync(base)) continue;
    const modified = join(dir, 'cloud-storage-namespace-1.modified.json');
    out.push({ dir, base, modified: existsSync(modified) ? modified : null });
  }
  return out;
}

/**
 * Reads the Steam client's collections and merges them in. Existing
 * Steam-origin collections get a new snapshot: Steam's additions are added,
 * Steam's removals removed, the user's local extra members are kept.
 * Steam's favourites/hidden are merged into the built-ins.
 */
export async function importSteamCollections(): Promise<SteamImportResult> {
  const result: SteamImportResult = { path: null, imported: 0, updated: 0, favorites: 0, hidden: 0 };
  const steamPath = await steamInstallPath();
  if (!steamPath) return result;
  const candidates = steamCollectionFiles(steamPath);
  // The signed-in account first; otherwise the first userdata folder that has any collection.
  let parsed: ReturnType<typeof parseSteamCollections> = [];
  for (const cand of candidates) {
    try {
      const list = parseSteamCollections(readFileSync(cand.base, 'utf8'), cand.modified ? readFileSync(cand.modified, 'utf8') : null);
      if (list.length) {
        parsed = list;
        result.path = cand.dir;
        break;
      }
      if (!result.path) result.path = cand.dir;
    } catch {
      /* unreadable folder — try the next */
    }
  }
  if (!parsed.length) return result;

  const titleByAppid = new Map<string, string>();
  for (const e of getEntries()) if (e.source === 'Steam') titleByAppid.set(e.externalId, normalizeTitle(e.title));
  const toMembers = (appids: number[]): Member[] => appids.map((a) => ({ refs: [{ source: 'Steam', id: String(a) }], title: titleByAppid.get(String(a)) ?? '' }));
  const data = load();
  const stamp = now();

  for (const sc of parsed) {
    const members = toMembers(sc.added.filter((a) => !sc.removed.includes(a)));
    if (sc.id === 'favorite' || sc.id === 'hidden') {
      const sys = data.collections.find((c) => c.id === sc.id)!;
      let n = 0;
      for (const m of members) {
        if (!sys.members.some((x) => handleMatchesMember(m, x))) {
          sys.members.push(m);
          n++;
        }
      }
      if (sc.id === 'favorite') result.favorites += n;
      else result.hidden += n;
      if (n) sys.updatedAt = stamp;
      continue;
    }
    const existing = data.collections.find((c) => c.steam?.id === sc.id);
    if (existing && existing.steam) {
      const oldKeys = new Set(existing.steam.members.flatMap(memberKeys));
      const newKeys = new Set(members.flatMap(memberKeys));
      // Keep local extras (not in the old snapshot), drop what Steam removed, add what Steam added.
      const kept = existing.members.filter((m) => {
        const keys = memberKeys(m);
        const wasSteam = keys.some((k) => oldKeys.has(k));
        return !wasSteam || keys.some((k) => newKeys.has(k));
      });
      for (const m of members) if (!kept.some((x) => handleMatchesMember(m, x))) kept.push(m);
      existing.members = kept;
      existing.name = existing.name === existing.steam.id ? sc.name : existing.name;
      existing.steam = { id: sc.id, members, dynamic: sc.dynamic, importedAt: stamp };
      existing.updatedAt = stamp;
      result.updated++;
    } else {
      data.collections.push({
        id: newId(),
        name: sc.name,
        origin: 'steam',
        kind: 'manual',
        members,
        steam: { id: sc.id, members, dynamic: sc.dynamic, importedAt: stamp },
        order: Math.max(0, ...data.collections.map((x) => x.order)) + 1,
        createdAt: stamp,
        updatedAt: stamp,
      });
      result.imported++;
    }
  }
  save();
  return result;
}

/** Puts a Steam-origin collection back to what Steam had at the last import. */
export function resetToSteam(id: string): void {
  const c = load().collections.find((x) => x.id === id);
  if (!c?.steam) throw new Error('Not a Steam collection');
  c.members = c.steam.members.map((m) => ({ refs: [...m.refs], title: m.title }));
  c.updatedAt = now();
  save();
}
