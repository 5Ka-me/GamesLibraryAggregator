import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { BrowserWindow, dialog } from 'electron';
import { apiFetch } from './apiClient';
import { getBridgePairings, removeBridgePairing, setBridgePairing } from './secretStore';
import { scanInstalledSteamAppIds } from './steamScan';
import { isPairableOrigin } from './validate';
import * as legendary from './legendary';

// Local bridge: a tiny HTTP server on 127.0.0.1 that lets the web app read
// the launcher's data when it runs on the same machine ("launcher detected →
// full library in the browser").
//
// Security model. Browsers set the Origin header themselves, so a web page
// cannot claim to be someone else; local native processes can read this
// process's memory anyway and are out of scope. On top of that:
//   - listens on the loopback interface ONLY, and rejects requests whose Host
//     isn't loopback (defence in depth against DNS rebinding);
//   - only real http(s) origins can pair: opaque origins (`null` from
//     sandboxed frames and data: documents), file:// and extension schemes are
//     refused, because every such context shares one indistinguishable origin
//     string and a single approval would grant them all;
//   - a paired origin gets a random bearer token (persisted in the OS keystore,
//     revocable in Settings) required on every data request;
//   - the exposed surface is a read-only GET whitelist — no syncs, no
//     launches, no secrets — and errors are not echoed back verbatim.

const DEFAULT_PORT = 17832;

export function bridgePort(): number {
  const p = parseInt(process.env.LAUNCHER_BRIDGE_PORT ?? '', 10);
  return Number.isFinite(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
}

/**
 * Read-only paths a paired site may fetch. `/api/*` entries are forwarded to
 * the local API; `/api/installed` is bridge-only (install state isn't part of
 * that contract). Keep in sync with the router in apiClient.ts.
 */
const GET_WHITELIST = new Set([
  '/api/library',
  '/api/steam/account',
  '/api/epic/account',
  '/api/steam/recent',
]);
export const ACHIEVEMENTS_PATH_RE = /^\/api\/steam\/achievements\/(\d+)$/;

let server: Server | null = null;

// ---------- CORS / PNA ----------

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(origin ? corsHeaders(origin) : {}),
  });
  res.end(JSON.stringify(body));
}

/** The request must be addressed to our loopback listener, not a rebound name. */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

// ---------- pairing ----------

// Pairings are read on every request, and reading them means a synchronous
// DPAPI decrypt — cached here so an unauthenticated request flood can't stall
// the main thread. Invalidated whenever we write.
let pairingCache: Record<string, string> | null = null;

function pairings(): Record<string, string> {
  if (!pairingCache) pairingCache = getBridgePairings();
  return pairingCache;
}

function savePairing(origin: string, token: string): void {
  setBridgePairing(origin, token);
  pairingCache = null;
}

function isPaired(origin: string, token: string | null): boolean {
  if (!token) return false;
  const stored = pairings()[origin];
  if (!stored) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// One pairing dialog at a time per origin; a denial is remembered for a while
// so a page can't re-prompt in a loop.
const pendingAsks = new Map<string, Promise<boolean>>();
const deniedUntil = new Map<string, number>();
const DENY_COOLDOWN_MS = 5 * 60_000;

async function askUser(origin: string): Promise<boolean> {
  let ask = pendingAsks.get(origin);
  if (!ask) {
    ask = (async () => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      const opts = {
        type: 'question' as const,
        buttons: ['Allow / Разрешить', 'Deny / Отклонить'],
        defaultId: 1,
        cancelId: 1,
        title: 'GL Aggregator',
        message: 'Allow this website to read your game library?',
        detail:
          `${origin}\n\n` +
          'Разрешить этому сайту читать вашу библиотеку игр? ' +
          'Доступ только на чтение (библиотека, статистика, ачивки); отозвать можно в Настройках.',
      };
      const { response } = win
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts);
      return response === 0;
    })().finally(() => pendingAsks.delete(origin));
    pendingAsks.set(origin, ask);
  }
  return ask;
}

async function handlePair(origin: string, res: ServerResponse): Promise<void> {
  // Already paired → hand the same token back (the site lost its localStorage).
  const existing = pairings()[origin];
  if (existing) {
    json(res, 200, { token: existing }, origin);
    return;
  }
  const cooldown = deniedUntil.get(origin) ?? 0;
  if (Date.now() < cooldown) {
    json(res, 429, { error: 'pairing denied recently' }, origin);
    return;
  }
  if (!(await askUser(origin))) {
    deniedUntil.set(origin, Date.now() + DENY_COOLDOWN_MS);
    json(res, 403, { error: 'pairing denied' }, origin);
    return;
  }
  const token = randomBytes(32).toString('base64url');
  savePairing(origin, token);
  json(res, 200, { token }, origin);
}

// ---------- request handling ----------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopbackHost(req.headers.host)) {
    json(res, 421, { error: 'wrong host' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const rawOrigin = req.headers.origin ?? '';
  // Only real web origins are ever echoed back or used as a pairing key.
  const origin = isPairableOrigin(rawOrigin) ? rawOrigin : '';

  // Preflight (incl. Chrome's Private Network Access check). Reflecting the
  // origin here grants nothing — real handlers enforce pairing themselves.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...(origin ? corsHeaders(origin) : {}),
      'Access-Control-Allow-Private-Network': 'true',
    });
    res.end();
    return;
  }

  // Presence probe — the only endpoint any origin may read.
  if (req.method === 'GET' && url.pathname === '/bridge/ping') {
    json(res, 200, { app: 'gl-aggregator', bridge: 1 }, origin || undefined);
    return;
  }

  if (!origin) {
    json(res, 403, { error: 'a browser origin (http/https) is required' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/bridge/pair') {
    await handlePair(origin, res);
    return;
  }

  // Everything below: paired origins only.
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!isPaired(origin, token)) {
    json(res, 401, { error: 'not paired' }, origin);
    return;
  }

  if (req.method !== 'GET') {
    json(res, 405, { error: 'method not allowed' }, origin);
    return;
  }
  const apiPath = url.pathname.startsWith('/bridge/') ? url.pathname.slice('/bridge'.length) : '';

  // Installed state (local-only info, not part of the /api contract).
  if (apiPath === '/api/installed') {
    const [steam, epic] = await Promise.all([
      scanInstalledSteamAppIds().catch(() => [] as string[]),
      legendary.listInstalled().catch(() => []),
    ]);
    json(res, 200, { steamAppIds: steam, epic }, origin);
    return;
  }

  if (!GET_WHITELIST.has(apiPath) && !ACHIEVEMENTS_PATH_RE.test(apiPath)) {
    json(res, 404, { error: 'not found' }, origin);
    return;
  }

  try {
    const data = await apiFetch(`${apiPath}${url.search}`);
    json(res, 200, data, origin);
  } catch (e) {
    // Internal messages can name local configuration — log, don't forward.
    console.error('[bridge] request failed:', e);
    json(res, 502, { error: 'request failed' }, origin);
  }
}

// ---------- lifecycle / settings surface ----------

/** Starts the loopback listener. Resolves once it is actually bound (or failed). */
export function startBridge(): Promise<void> {
  if (server) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const srv = createServer((req, res) => {
      void handle(req, res).catch((e) => {
        console.error('[bridge] handler crashed:', e);
        if (!res.headersSent) json(res, 500, { error: 'internal error' });
        else res.end();
      });
    });

    const fail = (err: unknown): void => {
      console.error('[bridge] server error:', err);
      // Always release the socket — a half-dead listener that `stopBridge`
      // can no longer reach would keep serving paired origins forever.
      srv.close();
      if (server === srv) server = null;
      resolve();
    };
    srv.once('error', fail);
    srv.listen(bridgePort(), '127.0.0.1', () => {
      srv.removeListener('error', fail);
      srv.on('error', (err) => console.error('[bridge] server error:', err));
      server = srv;
      console.log(`[bridge] listening on 127.0.0.1:${bridgePort()}`);
      resolve();
    });
  });
}

export function stopBridge(): Promise<void> {
  const srv = server;
  server = null;
  if (!srv) return Promise.resolve();
  return new Promise<void>((resolve) => srv.close(() => resolve()));
}

export interface BridgeStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  origins: string[];
}

export function bridgeStatus(enabled: boolean): BridgeStatus {
  return {
    enabled,
    running: server !== null,
    port: bridgePort(),
    origins: Object.keys(pairings()).sort(),
  };
}

export function revokeBridgeOrigin(origin: string): void {
  removeBridgePairing(origin);
  pairingCache = null;
}
