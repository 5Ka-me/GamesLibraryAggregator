import { getEpicAccount, getSteamAccount } from './localData';
import { syncSteamLibrary } from './steamSync';
import { epicSync, epicAccount } from './epicSync';

// Silent background library sync, Heroic-style: shortly after startup and
// then periodically, each connected store is re-synced when its last sync is
// older than the interval. New purchases and playtime show up on their own;
// the manual Sync buttons in Settings still work and reset the timer (they
// update lastSyncAt through the same sync functions).
//
// Knob: LAUNCHER_AUTOSYNC_HOURS (default 6; 0 disables autosync entirely).

const STARTUP_DELAY_MS = 15_000; // let the window load first
const CHECK_EVERY_MS = 30 * 60_000; // staleness re-check cadence

function intervalMs(): number {
  const hours = parseFloat(process.env.LAUNCHER_AUTOSYNC_HOURS ?? '');
  return (Number.isFinite(hours) && hours >= 0 ? hours : 6) * 3600_000;
}

function stale(lastSyncAt: string | undefined, ivl: number): boolean {
  if (!lastSyncAt) return true;
  const at = new Date(lastSyncAt).getTime();
  // An unparsable timestamp must mean "sync now", not "never sync again"
  // (NaN comparisons are false, which used to disable autosync permanently).
  if (!Number.isFinite(at)) return true;
  return Date.now() - at > ivl;
}

let running = false;

async function runOnce(): Promise<void> {
  const ivl = intervalMs();
  if (ivl === 0 || running) return;
  running = true;
  let changed = false;
  try {
    if (getSteamAccount().steamId && stale(getSteamAccount().lastSyncAt, ivl)) {
      try {
        await syncSteamLibrary();
        changed = true;
      } catch {
        /* silent — retried on the next check */
      }
    }
    if (epicAccount().connected && stale(getEpicAccount().lastSyncAt, ivl)) {
      try {
        await epicSync();
        changed = true;
      } catch {
        /* silent */
      }
    }
  } finally {
    running = false;
  }
  // (the library store itself emits 'library:changed' on every write)
}

/** Starts the background sync loop (call once after app ready). */
export function startAutoSync(): void {
  if (intervalMs() === 0) return;
  setTimeout(() => void runOnce(), STARTUP_DELAY_MS);
  setInterval(() => void runOnce(), CHECK_EVERY_MS);
}
