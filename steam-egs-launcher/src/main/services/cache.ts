import { app } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';

// Unified cache for everything the launcher fetches from Steam/Epic/FX:
// memory + disk (userData/cache/<namespace>.json), so a restart doesn't
// re-hammer the stores, with **stale-while-revalidate** semantics — an
// expired entry is served instantly while a fresh copy is fetched in the
// background for the next read. The UI's ↻ button passes force=true, which
// always fetches live data.
//
// Values must be JSON-serializable (everything we cache is plain data).

interface Entry {
  at: number;
  data: unknown;
}

/** Entries older than this are dropped when a namespace loads from disk. */
const DISK_MAX_AGE_MS = 7 * 24 * 3600_000;
/** Per-namespace entry cap (newest win) — bounds the disk files. */
const MAX_ENTRIES = 2000;
const SAVE_DEBOUNCE_MS = 3000;

// Common TTL classes (the "dynamic" class lives in config.getStoreCacheTtlMs).
export const TTL_STATIC_MS = 24 * 3600_000; // descriptions, tags, FX — changes rarely
export const TTL_PROGRESS_MS = 10 * 60_000; // player progress (achievements, recent)

interface Namespace {
  entries: Map<string, Entry>;
  saveTimer: NodeJS.Timeout | null;
}

const namespaces = new Map<string, Namespace>();
const inflight = new Map<string, Promise<unknown>>();

const cacheDir = (): string => join(app.getPath('userData'), 'cache');
const cacheFile = (ns: string): string => join(cacheDir(), `${ns}.json`);

function loadNamespace(name: string): Namespace {
  let ns = namespaces.get(name);
  if (ns) return ns;
  ns = { entries: new Map(), saveTimer: null };
  try {
    if (existsSync(cacheFile(name))) {
      const parsed = JSON.parse(readFileSync(cacheFile(name), 'utf8')) as {
        entries?: Record<string, Entry>;
      };
      const cutoff = Date.now() - DISK_MAX_AGE_MS;
      for (const [key, entry] of Object.entries(parsed?.entries ?? {})) {
        if (entry && typeof entry.at === 'number' && entry.at > cutoff) {
          ns.entries.set(key, entry);
        }
      }
    }
  } catch {
    /* corrupt cache file — start empty, it's only a cache */
  }
  namespaces.set(name, ns);
  return ns;
}

function persist(name: string, ns: Namespace): void {
  // Cap by recency so hot namespaces (per-appid metadata) don't grow forever.
  let entries = [...ns.entries.entries()];
  if (entries.length > MAX_ENTRIES) {
    entries = entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    ns.entries = new Map(entries);
  }
  try {
    mkdirSync(cacheDir(), { recursive: true });
    const file = cacheFile(name);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ entries: Object.fromEntries(entries) }), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* disk persistence is best effort — memory still works */
  }
}

function scheduleSave(name: string): void {
  const ns = namespaces.get(name);
  if (!ns || ns.saveTimer) return;
  ns.saveTimer = setTimeout(() => {
    ns.saveTimer = null;
    persist(name, ns);
  }, SAVE_DEBOUNCE_MS);
}

// Flush pending writes on quit so a short session still leaves a warm cache.
app.on('before-quit', () => {
  for (const [name, ns] of namespaces) {
    if (ns.saveTimer) {
      clearTimeout(ns.saveTimer);
      ns.saveTimer = null;
      persist(name, ns);
    }
  }
});

// ---------- primitives (for batch-style callers like itemsMeta) ----------

/** Raw lookup: the entry with its freshness, or null when absent entirely. */
export function cacheGet<T>(
  ns: string,
  key: string,
  ttlMs: number
): { data: T; fresh: boolean } | null {
  const entry = loadNamespace(ns).entries.get(key);
  if (!entry) return null;
  // Math.abs: a clock that moved backwards would otherwise make every entry
  // look fresh forever.
  return { data: entry.data as T, fresh: Math.abs(Date.now() - entry.at) <= ttlMs };
}

export function cacheSet(ns: string, key: string, data: unknown): void {
  loadNamespace(ns).entries.set(key, { at: Date.now(), data });
  scheduleSave(ns);
}

/** Drop entries of a namespace (optionally only keys with the prefix). */
export function cachePurge(ns: string, prefix?: string): void {
  const space = loadNamespace(ns);
  if (!prefix) space.entries.clear();
  else for (const key of space.entries.keys()) if (key.startsWith(prefix)) space.entries.delete(key);
  scheduleSave(ns);
}

// ---------- the main wrapper ----------

/**
 * Cached fetch with stale-while-revalidate:
 *  - fresh hit → returned as is;
 *  - stale hit → returned immediately, a background refresh updates the cache
 *    (refresh errors keep the stale value — better old data than none);
 *  - miss (or force) → fetched live; only successful results are stored, so
 *    transient failures never poison the cache.
 * Concurrent calls for the same key share one in-flight fetch.
 */
export async function cached<T>(
  ns: string,
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  opts: { force?: boolean } = {}
): Promise<T> {
  const hit = opts.force ? null : cacheGet<T>(ns, key, ttlMs);
  if (hit?.fresh) return hit.data;

  const flightKey = `${ns}|${key}`;
  const run = (): Promise<T> => {
    // A forced refresh must reach the network — joining a fetch that started
    // before the user pressed ↻ would defeat the point.
    const existing = opts.force ? undefined : (inflight.get(flightKey) as Promise<T> | undefined);
    if (existing) return existing;

    const flight = fetcher()
      .then((data) => {
        cacheSet(ns, key, data);
        return data;
      })
      .finally(() => {
        if (inflight.get(flightKey) === flight) inflight.delete(flightKey);
      });
    inflight.set(flightKey, flight);
    return flight;
  };

  if (hit) {
    // Stale: serve instantly, revalidate in the background.
    void run().catch(() => {});
    return hit.data;
  }
  return run();
}
