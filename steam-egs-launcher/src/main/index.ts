import { app, BrowserWindow, session, shell } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';
import { registerIpc } from './ipc';
import { setEventTarget } from './services/events';
import { startAutoSync } from './services/autoSync';
import { startBridge } from './services/bridge';
import { startUpdater } from './services/updater';
import { isWebUrl } from './services/validate';
import { getBridgeEnabled } from './config';

// Locked-down CSP for the packaged app (renderer is local; store cover art comes
// from Steam/Epic CDNs over https; all API traffic goes through IPC, not fetch).
// Skipped in dev because the Vite dev server needs inline/eval and a websocket.
function applyCsp(): void {
  const CSP =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; media-src https:; connect-src 'self'; font-src 'self' data:; " +
    // The window must never navigate away from the local app: the preload
    // bridge is bound to the WebContents, so a remote document loaded here
    // would inherit `window.launcher` (see also the will-navigate guard).
    "form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });
}

// Same id electron-builder stamps on the Start-menu/desktop shortcuts, so the
// taskbar groups the window with its shortcut and shows the shortcut's icon
// (without it Windows falls back to per-exe identity and can show a blank icon).
app.setAppUserModelId('com.5ka.steamegslauncher');

function createWindow(): void {
  // Window/taskbar icon. The packaged exe carries it as a resource; in dev the
  // .ico is read from the repo (absent from the packaged layout — hence the
  // existence check instead of a hardcoded branch).
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(app.getAppPath(), 'resources', 'icon.ico');

  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#161d29',
    // Steam-style chrome: the renderer draws the title bar (nav + profile) as a
    // drag region; Windows keeps drawing the min/max/close buttons on top of it
    // in the app's colours, so Snap Layouts and accessibility keep working.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#131922', symbolColor: '#94a6bd', height: 40 },
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  // Background services (download progress) push events to this window.
  setEventTarget(win);

  // Surface renderer/preload load failures (helps diagnose a blank window).
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`)
  );
  win.webContents.on('preload-error', (_e, path, err) =>
    console.error(`[preload] error in ${path}:`, err)
  );
  win.webContents.on('render-process-gone', (_e, details) =>
    console.error('[renderer] process gone:', details)
  );

  // Any http(s) window.open() (e.g. store pages) goes to the user's real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // In dev, electron-vite serves the renderer over HTTP; in prod, load the built file.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const appOrigin = devUrl ? new URL(devUrl).origin : null;

  // The app window may only ever show our own renderer. Without this, one stray
  // top-level navigation would hand `window.launcher` (local API, installs,
  // bridge control) to a remote page — the preload is bound to the WebContents,
  // not to a document origin.
  const lockNavigation = (e: Electron.Event, url: string): void => {
    const allowed = appOrigin
      ? url.startsWith(appOrigin)
      : url.startsWith('file://') || url.startsWith('devtools://');
    if (!allowed) {
      e.preventDefault();
      if (isWebUrl(url)) void shell.openExternal(url); // treat it as "open outside"
    }
  };
  win.webContents.on('will-navigate', lockNavigation);
  win.webContents.on('will-redirect', lockNavigation);
  // A renderer must not gain Node privileges by attaching a webview.
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'right' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app
  .whenReady()
  .then(() => {
    if (app.isPackaged) applyCsp();
    registerIpc();
    createWindow();
    startAutoSync();
    startUpdater();
    if (getBridgeEnabled()) startBridge();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((err) => {
    // Without this the app would just show a blank window and log nothing.
    console.error('[main] startup failed:', err);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
