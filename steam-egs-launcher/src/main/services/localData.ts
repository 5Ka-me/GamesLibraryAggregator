import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { recordPlaytimeSnapshot } from './playtimeHistory';

// Local library database — the launcher's replacement for the cloud Postgres.
// One JSON file in userData holding the per-store library entries and account
// metadata. Loaded once into memory; every mutation is persisted atomically
// (write to a temp file, then rename) so a crash mid-write can't corrupt it.
//
// NO secrets live here: Epic tokens and the Steam API key are kept encrypted
// in the OS keystore (see secretStore.ts). This file is plain data — titles,
// playtimes, account display names, regions.

export type EntrySource = 'Steam' | 'Epic';

/** One owned game on one store — the local mirror of the backend GameEntry. */
export interface StoredEntry {
  source: EntrySource;
  /** Steam: appid as string. Epic: catalog item id. */
  externalId: string;
  title: string;
  iconUrl?: string | null;
  namespace?: string | null;
  /** Epic app name (legendary's install/launch id, == playtime artifactId). */
  appName?: string | null;
  /** Epic product page URL — resolved lazily on click and cached here. */
  storeUrl?: string | null;
  playtimeMinutes?: number | null;
  /** ISO date the entry was first seen (acquisition proxy). */
  acquisitionDate?: string | null;
  /** Steam: last launch (rtime_last_played). Epic doesn't report it. */
  lastPlayedAt?: string | null;
  /** Steam: minutes in the last two weeks (present only when played recently). */
  playtime2WeeksMinutes?: number | null;
  /** Steam: minutes on Steam Deck (lifetime). */
  playtimeDeckMinutes?: number | null;
}

export interface SteamAccountData {
  steamId?: string | null;
  personaName?: string | null;
  /**
   * Store region (ISO alpha-2) for prices; null → US fallback. Auto-detection
   * only ever fills an empty value, so a region set in Settings sticks.
   */
  country?: string | null;
  /** ISO timestamp of the last successful library sync (drives autosync). */
  lastSyncAt?: string;
}

export interface EpicAccountData {
  accountId?: string | null;
  displayName?: string | null;
  /** See SteamAccountData.country. */
  country?: string | null;
  /** ISO timestamp of the last successful library sync (drives autosync). */
  lastSyncAt?: string;
}

interface DataFile {
  version: 1;
  steam: SteamAccountData;
  epic: EpicAccountData;
  entries: StoredEntry[];
}

const EMPTY: DataFile = { version: 1, steam: {}, epic: {}, entries: [] };

const dataFile = (): string => join(app.getPath('userData'), 'library.json');

let cache: DataFile | null = null;

function load(): DataFile {
  if (cache) return cache;
  try {
    if (existsSync(dataFile())) {
      const parsed = JSON.parse(readFileSync(dataFile(), 'utf8')) as Partial<DataFile>;
      if (parsed && Array.isArray(parsed.entries)) {
        cache = {
          version: 1,
          steam: parsed.steam ?? {},
          epic: parsed.epic ?? {},
          entries: parsed.entries,
        };
        return cache;
      }
    }
  } catch {
    /* unreadable/corrupt → start fresh; the stores are the source of truth */
  }
  cache = structuredClone(EMPTY);
  return cache;
}

/** Atomic persist: a crash can leave a stale file, never a truncated one. */
function save(): void {
  const file = dataFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  renameSync(tmp, file);
}

// ---------- accounts ----------

export function getSteamAccount(): SteamAccountData {
  return { ...load().steam };
}

export function updateSteamAccount(patch: Partial<SteamAccountData>): SteamAccountData {
  const data = load();
  data.steam = { ...data.steam, ...patch };
  save();
  return { ...data.steam };
}

export function getEpicAccount(): EpicAccountData {
  return { ...load().epic };
}

export function updateEpicAccount(patch: Partial<EpicAccountData>): EpicAccountData {
  const data = load();
  data.epic = { ...data.epic, ...patch };
  save();
  return { ...data.epic };
}

// ---------- library entries ----------

export function getEntries(): StoredEntry[] {
  return load().entries.map((e) => ({ ...e }));
}

/**
 * Replace all entries of one store with a fresh sync result (games no longer
 * owned are pruned). Preserves per-entry data the stores report unreliably:
 *  - playtime is never clobbered by a smaller/absent value (a sync source
 *    without playtime must not erase what another sync recorded);
 *  - the original acquisitionDate (first-seen) is kept.
 */
export function replaceEntries(source: EntrySource, fresh: StoredEntry[]): number {
  // An empty sync result is far more likely a store hiccup than a genuinely
  // emptied account — never wipe the library over it (explicit logout does).
  if (fresh.length === 0) return 0;
  const data = load();
  const prev = new Map(
    data.entries.filter((e) => e.source === source).map((e) => [e.externalId, e])
  );
  const now = new Date().toISOString();

  const merged = fresh.map((e) => {
    const old = prev.get(e.externalId);
    const best = Math.max(old?.playtimeMinutes ?? 0, e.playtimeMinutes ?? 0);
    // Last launch only ever moves forward.
    const lastPlayedAt =
      [old?.lastPlayedAt, e.lastPlayedAt].filter((x): x is string => !!x).sort().pop() ?? null;
    return {
      ...e,
      source,
      playtimeMinutes: best > 0 ? best : e.playtimeMinutes ?? null,
      acquisitionDate: old?.acquisitionDate ?? e.acquisitionDate ?? now,
      lastPlayedAt,
    };
  });

  data.entries = [...data.entries.filter((e) => e.source !== source), ...merged];
  save();
  recordPlaytimeSnapshot(data.entries);
  return merged.length;
}

/** Cache a lazily-resolved Epic product URL on every entry of the namespace. */
export function setEpicStoreUrl(namespace: string, url: string): void {
  const data = load();
  let touched = false;
  for (const e of data.entries) {
    if (e.source === 'Epic' && e.namespace === namespace && e.storeUrl !== url) {
      e.storeUrl = url;
      touched = true;
    }
  }
  if (touched) save();
}

/** Wipe everything for one store (logout). */
export function clearStore(source: EntrySource): void {
  const data = load();
  data.entries = data.entries.filter((e) => e.source !== source);
  if (source === 'Steam') data.steam = {};
  else data.epic = {};
  save();
}
