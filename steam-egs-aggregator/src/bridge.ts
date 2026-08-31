import type { Game } from '@app/shared';

// Client of the desktop launcher's local bridge (see
// steam-egs-launcher/src/main/services/bridge.ts). When the launcher runs on
// this machine, the web app can read its FULL merged library (both stores,
// playtime, installed state) instead of the Steam-only web view.
//
// Protocol: GET /bridge/ping → launcher present; POST /bridge/pair → the
// launcher asks the user and returns a bearer token (kept in localStorage);
// data lives under /bridge/api/* mirroring the shared API contract.

// Must match the launcher's LAUNCHER_BRIDGE_PORT (default 17832).
const BRIDGE = `http://127.0.0.1:${process.env.REACT_APP_BRIDGE_PORT || '17832'}`;
const TOKEN_KEY = 'bridgeToken';
const PAIR_TIMEOUT_MS = 2 * 60_000; // the launcher waits for a human to click

export const bridgeToken = (): string | null => localStorage.getItem(TOKEN_KEY);

/** The launcher answers on this machine. */
export async function bridgeAvailable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(`${BRIDGE}/bridge/ping`, { signal: ctrl.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Ask the launcher for access (it shows an approval dialog to the user). */
export async function bridgePair(): Promise<boolean> {
  const ctrl = new AbortController();
  // The launcher blocks on a modal dialog; without a cap an ignored dialog
  // would leave the UI stuck on "…" indefinitely.
  const timer = setTimeout(() => ctrl.abort(), PAIR_TIMEOUT_MS);
  try {
    const res = await fetch(`${BRIDGE}/bridge/pair`, { method: 'POST', signal: ctrl.signal });
    if (!res.ok) return false;
    const json = (await res.json()) as { token?: string };
    if (!json.token) return false;
    localStorage.setItem(TOKEN_KEY, json.token);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Forget the pairing on this side (revoking fully is done in the launcher). */
export function bridgeDisconnect(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function bridgeGet<T>(path: string): Promise<T> {
  const token = bridgeToken();
  if (!token) throw new Error('not paired');
  const res = await fetch(`${BRIDGE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    // Pairing revoked in the launcher — drop the stale token.
    bridgeDisconnect();
    throw new Error('not paired');
  }
  if (!res.ok) throw new Error(`bridge request failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The launcher's merged library (both stores). */
export const bridgeLibrary = (): Promise<Game[]> => bridgeGet<Game[]>('/bridge/api/library');
