import { BrowserWindow } from 'electron';
import {
  epicAuthWithCode,
  EPIC_LOGIN_HOST,
  LOGIN_URL,
  REDIRECT_URL,
  type EpicAuthResult,
} from './epicSync';
import * as legendary from './legendary';

// Embedded EGS OAuth. We open Epic's login page in a BrowserWindow and read the
// `authorizationCode` that Epic's redirect endpoint returns as JSON.
//
// The client id is the public Epic Games Launcher one (shared with epicSync,
// which performs the token exchange). An authorizationCode is single-use, so
// we mint TWO codes from the same signed-in session:
//   1. one for `legendary auth` (local downloads),
//   2. one for the local library sync (epicSync.ts).
//
// Security: the window is sandboxed, has no preload (Epic's page can't see our
// IPC) and is locked to Epic's own host — a code is only ever read from a
// document served by epicgames.com, never from a redirect target.

export type { EpicAuthResult };

// Persisted partition so cookies survive between the two code captures (and app runs).
const PARTITION = 'persist:epic';

/** Hosts the login flow legitimately visits (Epic + its CAPTCHA providers). */
const ALLOWED_HOSTS = [
  'epicgames.com',
  'unrealengine.com',
  'google.com',
  'gstatic.com',
  'recaptcha.net',
  'hcaptcha.com',
  'arkoselabs.com',
];

function isAllowedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return ALLOWED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** True only for Epic's own code-redirect endpoint. */
function isRedirectPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === EPIC_LOGIN_HOST && parsed.pathname === '/id/api/redirect';
  } catch {
    return false;
  }
}

/**
 * Open a window and resolve with a fresh authorizationCode.
 * @param interactive show the window and load the login page (first, user-facing capture);
 *                    when false, load the redirect endpoint headlessly reusing the session.
 */
function captureCode(interactive: boolean): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      show: interactive,
      autoHideMenuBar: true,
      title: 'Sign in to Epic Games',
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        // No preload: Epic's page has zero access to our code.
      },
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) {
        win.removeAllListeners('closed');
        win.destroy();
      }
      fn();
    };

    // Headless capture must not hang forever if the session isn't valid.
    const timer = setTimeout(
      () => finish(() => reject(new Error('Timed out waiting for Epic authorization code.'))),
      interactive ? 5 * 60_000 : 30_000
    );

    // Lock navigation to Epic (blocks a redirect to a page that could serve a
    // look-alike JSON payload, and stray links generally).
    const guard = (e: Electron.Event, url: string): void => {
      if (!isAllowedUrl(url)) e.preventDefault();
    };
    win.webContents.on('will-navigate', guard);
    win.webContents.on('will-redirect', guard);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const tryExtract = async (): Promise<void> => {
      if (settled || win.isDestroyed()) return;
      if (!isRedirectPage(win.webContents.getURL())) return;
      try {
        const text: string = await win.webContents.executeJavaScript('document.body.innerText');
        const code = (JSON.parse(text) as { authorizationCode?: unknown }).authorizationCode;
        if (typeof code === 'string' && code) finish(() => resolve(code));
      } catch {
        /* page not the JSON payload yet */
      }
    };

    win.webContents.on('did-navigate', () => void tryExtract());
    win.webContents.on('did-frame-navigate', () => void tryExtract());
    win.webContents.on('did-finish-load', () => void tryExtract());
    win.on('closed', () =>
      finish(() => reject(new Error('Epic login window was closed before completing.')))
    );

    void win.loadURL(interactive ? LOGIN_URL : REDIRECT_URL);
  });
}

/**
 * Full embedded login: syncs the EGS library into the local store and, when
 * the bundled `legendary` is present, authorizes it for downloads too.
 */
export async function login(): Promise<EpicAuthResult> {
  // 1) Interactive login → first code → library sync (the part that always works).
  const code1 = await captureCode(true);
  const result = await epicAuthWithCode(code1);

  // 2) Reuse the signed-in session → second code → legendary (local downloads).
  //    Best effort: a missing/failing legendary must not undo the sign-in — the
  //    library is already there, only downloads are unavailable.
  if (legendary.isLegendaryAvailable()) {
    try {
      await legendary.auth(await captureCode(false));
    } catch (e) {
      console.error('[epic] legendary authorization failed:', e);
    }
  }
  return result;
}
