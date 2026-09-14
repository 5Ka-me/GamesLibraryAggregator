import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';

// Non-secret launcher settings, persisted as plain JSON in userData.
const configFile = (): string => join(app.getPath('userData'), 'launcher-config.json');

interface LauncherConfig {
  /** Base folder where legendary installs EGS games (empty = legendary default). */
  installBasePath?: string;
  /** Local web bridge (127.0.0.1 read-only API); off unless enabled here. */
  bridgeEnabled?: boolean;
  /** chutes.ai model id for the AI search (see services/ai.ts for the default). */
  aiModel?: string;
  /** Cumulative AI usage, shown in Settings so the cost is never a surprise. */
  aiUsage?: { requests: number; promptTokens: number; completionTokens: number };
}

function read(): LauncherConfig {
  try {
    return existsSync(configFile()) ? JSON.parse(readFileSync(configFile(), 'utf8')) : {};
  } catch {
    return {};
  }
}

function write(cfg: LauncherConfig): void {
  writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * TTL of the "dynamic" cache class — anything carrying prices/discounts
 * (front page, sections, search, item metadata, details, EGS offers).
 * Stale entries are still served instantly and refreshed in the background
 * (see services/cache.ts); the ↻ button bypasses the cache regardless.
 * Knob: LAUNCHER_STORE_CACHE_TTL in seconds, default 3600.
 */
export function getStoreCacheTtlMs(): number {
  const sec = parseInt(process.env.LAUNCHER_STORE_CACHE_TTL ?? '', 10);
  return (Number.isFinite(sec) && sec > 0 ? sec : 3600) * 1000;
}

/**
 * The local web bridge is opt-in: there is no Settings toggle any more, so a
 * loopback server nobody asked for shouldn't run. Enable it for the web app
 * with `"bridgeEnabled": true` in launcher-config.json.
 */
export function getBridgeEnabled(): boolean {
  return read().bridgeEnabled ?? false;
}

export function setBridgeEnabled(enabled: boolean): void {
  const cfg = read();
  cfg.bridgeEnabled = enabled;
  write(cfg);
}

export function getInstallBasePath(): string {
  return read().installBasePath ?? '';
}

export function setInstallBasePath(path: string): void {
  const cfg = read();
  cfg.installBasePath = path.trim();
  write(cfg);
}

// ---------- AI search ----------

export function getAiModel(): string | null {
  const m = read().aiModel;
  return typeof m === 'string' && m.trim() ? m.trim() : null;
}

export function setAiModel(model: string): void {
  const cfg = read();
  const m = model.trim();
  if (m) cfg.aiModel = m;
  else delete cfg.aiModel;
  write(cfg);
}

export function getAiUsage(): { requests: number; promptTokens: number; completionTokens: number } {
  const u = read().aiUsage;
  return { requests: u?.requests ?? 0, promptTokens: u?.promptTokens ?? 0, completionTokens: u?.completionTokens ?? 0 };
}

export function addAiUsage(promptTokens: number, completionTokens: number): void {
  const cfg = read();
  const u = getAiUsage();
  cfg.aiUsage = { requests: u.requests + 1, promptTokens: u.promptTokens + promptTokens, completionTokens: u.completionTokens + completionTokens };
  write(cfg);
}
