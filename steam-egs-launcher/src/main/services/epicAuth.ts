import { BrowserWindow } from 'electron';
import { apiFetch } from './apiClient';
import * as legendary from './legendary';

// Embedded EGS OAuth. We open Epic's login page in a BrowserWindow and read the
// `authorizationCode` that Epic's redirect endpoint returns as JSON.
//
// The launcher client id is the public Epic Games Launcher id (the same one
// legendary and the cloud API use). An authorizationCode is single-use, so we
// mint TWO codes from the same signed-in session:
//   1. one for `legendary auth` (local downloads),
//   2. one for the cloud API `/api/epic/auth` (library sync).

const CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const REDIRECT_URL = `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`;
const LOGIN_URL = `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(REDIRECT_URL)}`;

// Persisted partition so cookies survive between the two code captures (and app runs).
const PARTITION = 'persist:epic';

export interface EpicAuthResult {
  success: boolean;
  requiresLogin: boolean;
  displayName?: string | null;
  gameCount: number;
  loginUrl?: string | null;
  message?: string | null;
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
        nodeIntegration: false,
        contextIsolation: true,
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

    const tryExtract = async (): Promise<void> => {
      if (settled || win.isDestroyed()) return;
      if (!win.webContents.getURL().includes('/id/api/redirect')) return;
      try {
        const text: string = await win.webContents.executeJavaScript('document.body.innerText');
        const json = JSON.parse(text);
        if (json?.authorizationCode) {
          finish(() => resolve(json.authorizationCode as string));
        }
      } catch {
        /* page not the JSON payload yet */
      }
    };

    win.webContents.on('did-navigate', tryExtract);
    win.webContents.on('did-frame-navigate', tryExtract);
    win.webContents.on('did-finish-load', tryExtract);
    win.on('closed', () =>
      finish(() => reject(new Error('Epic login window was closed before completing.')))
    );

    win.loadURL(interactive ? LOGIN_URL : REDIRECT_URL);
  });
}

/**
 * Full embedded login: authenticates legendary locally and syncs the EGS
 * library through the cloud API. Returns the cloud auth/sync result.
 */
export async function login(): Promise<EpicAuthResult> {
  // 1) Interactive login → first code → legendary (local downloads).
  const code1 = await captureCode(true);
  await legendary.auth(code1);

  // 2) Reuse the signed-in session → second code → cloud library sync.
  const code2 = await captureCode(false);
  return apiFetch<EpicAuthResult>('/api/epic/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorizationCode: code2 }),
  });
}
