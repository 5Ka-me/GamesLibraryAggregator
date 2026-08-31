import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';

// Non-secret launcher settings, persisted as plain JSON in userData.
const configFile = (): string => join(app.getPath('userData'), 'launcher-config.json');

interface LauncherConfig {
  /** Base folder where legendary installs EGS games (empty = legendary default). */
  installBasePath?: string;
  /** Local web bridge (127.0.0.1 read-only API); on by default. */
  bridgeEnabled?: boolean;
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

export function getBridgeEnabled(): boolean {
  return read().bridgeEnabled ?? true;
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
