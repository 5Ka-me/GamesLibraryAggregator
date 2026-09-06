import { app } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { StoredEntry } from './localData';

// Daily playtime snapshots, recorded whenever a store sync lands. Steam and
// Epic only report lifetime totals, so the launcher keeps its own history:
// with two snapshots the Statistics page can say "+12 h since September 1st",
// and after a few months it has a real activity curve — computed locally,
// no extra requests. One snapshot per calendar day (a later sync the same day
// overwrites it), only games with playtime, keyed `S:<appid>` / `E:<catalogId>`.

export interface PlaytimeHistory {
  version: 1;
  /** day (YYYY-MM-DD, local time) → entry key → total minutes at that day. */
  days: Record<string, Record<string, number>>;
}

const RETENTION_DAYS = 400;

const file = (): string => join(app.getPath('userData'), 'playtime-history.json');

let cache: PlaytimeHistory | null = null;

function load(): PlaytimeHistory {
  if (cache) return cache;
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<PlaytimeHistory>;
      if (parsed && parsed.days && typeof parsed.days === 'object') {
        cache = { version: 1, days: parsed.days };
        return cache;
      }
    }
  } catch {
    /* corrupt → start over; it is derived data */
  }
  cache = { version: 1, days: {} };
  return cache;
}

function save(): void {
  const f = file();
  writeFileSync(`${f}.tmp`, JSON.stringify(cache), 'utf8');
  renameSync(`${f}.tmp`, f);
}

const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Epic is keyed by app name (what the renderer can recover from a launch link);
// the catalog item id never reaches the UI.
export const historyKey = (e: Pick<StoredEntry, 'source' | 'externalId' | 'appName'>): string =>
  e.source === 'Steam' ? `S:${e.externalId}` : `E:${e.appName ?? e.externalId}`;

/** Records today's snapshot from the full entry list (both stores). */
export function recordPlaytimeSnapshot(entries: StoredEntry[]): void {
  const snap: Record<string, number> = {};
  for (const e of entries) {
    if ((e.playtimeMinutes ?? 0) > 0) snap[historyKey(e)] = e.playtimeMinutes!;
  }
  if (Object.keys(snap).length === 0) return;
  const data = load();
  data.days[localDay(new Date())] = snap;
  // Prune beyond the retention window (keys sort chronologically).
  const days = Object.keys(data.days).sort();
  for (const d of days.slice(0, Math.max(0, days.length - RETENTION_DAYS))) delete data.days[d];
  try {
    save();
  } catch {
    /* best effort — history must never break a sync */
  }
}

export function getPlaytimeHistory(): PlaytimeHistory {
  const data = load();
  return { version: 1, days: { ...data.days } };
}
