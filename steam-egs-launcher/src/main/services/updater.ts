import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { emit } from './events';

// Auto-update via GitHub Releases (see publish: in electron-builder.yml).
// Deliberately quiet: the check runs shortly after startup, the download
// happens in the background, and the renderer only ever shows a small
// "restart to update" banner — the app never restarts itself. Settings has a
// manual check button; in dev (unpackaged) everything is a no-op.

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'downloading'; version: string; pct: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

let state: UpdateState = { status: 'idle' };

function setState(next: UpdateState): void {
  state = next;
  emit('update:state', state);
}

export function updateState(): UpdateState {
  return state;
}

export function appVersion(): string {
  return app.getVersion();
}

let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = true;
  // If the user ignores the banner, the update still lands on next quit.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => setState({ status: 'idle' }));
  autoUpdater.on('update-available', (info) =>
    setState({ status: 'downloading', version: info.version, pct: 0 })
  );
  autoUpdater.on('download-progress', (p) => {
    if (state.status === 'downloading') {
      setState({ ...state, pct: Math.round(p.percent) });
    }
  });
  autoUpdater.on('update-downloaded', (info) =>
    setState({ status: 'ready', version: info.version })
  );
  autoUpdater.on('error', (err) => {
    // Routine when offline — log, show a quiet error only on manual checks.
    console.warn('[updater]', err.message);
    setState({ status: 'error', message: err.message });
  });
}

/** Manual check from Settings. Resolves when the check itself finished. */
export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) return state; // dev build — nothing to update
  wire();
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    /* state already set via the error event */
  }
  return state;
}

/** Restart into the downloaded update (the banner's button). */
export function installUpdate(): void {
  if (state.status === 'ready') autoUpdater.quitAndInstall();
}

/** Silent startup check (delayed so it never competes with first paint). */
export function startUpdater(): void {
  if (!app.isPackaged) return;
  wire();
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => undefined);
  }, 20_000);
}
