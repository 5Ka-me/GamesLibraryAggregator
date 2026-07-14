import { app, BrowserWindow, session, shell } from 'electron';
import { join } from 'path';
import { registerIpc } from './ipc';
import { setEventTarget } from './services/events';

// Locked-down CSP for the packaged app (renderer is local; store cover art comes
// from Steam/Epic CDNs over https; all API traffic goes through IPC, not fetch).
// Skipped in dev because the Vite dev server needs inline/eval and a websocket.
function applyCsp(): void {
  const CSP =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; media-src https:; connect-src 'self'; font-src 'self' data:";
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#121212',
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
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // In dev, electron-vite serves the renderer over HTTP; in prod, load the built file.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'right' });
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  if (app.isPackaged) applyCsp();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
