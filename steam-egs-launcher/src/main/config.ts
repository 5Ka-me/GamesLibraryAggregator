import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';

// Base URL of the .NET API the launcher talks to. Overridable via env or the
// Settings page; persisted (unencrypted — it isn't a secret) in userData.
const DEFAULT_API_BASE = 'http://localhost:5080';

const configFile = (): string => join(app.getPath('userData'), 'launcher-config.json');

interface LauncherConfig {
  apiBase?: string;
  /** Base folder where legendary installs EGS games (empty = legendary default). */
  installBasePath?: string;
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

export function getApiBase(): string {
  return process.env.LAUNCHER_API_BASE || read().apiBase || DEFAULT_API_BASE;
}

export function setApiBase(url: string): void {
  const cfg = read();
  cfg.apiBase = url.trim();
  write(cfg);
}

/**
 * TTL for the in-memory Steam-store cache (front page, wishlist, item
 * metadata, search). One knob for everything: LAUNCHER_STORE_CACHE_TTL in
 * seconds, default 300. The ↻ button bypasses the cache regardless.
 */
export function getStoreCacheTtlMs(): number {
  const sec = parseInt(process.env.LAUNCHER_STORE_CACHE_TTL ?? '', 10);
  return (Number.isFinite(sec) && sec > 0 ? sec : 300) * 1000;
}

export function getInstallBasePath(): string {
  return read().installBasePath ?? '';
}

export function setInstallBasePath(path: string): void {
  const cfg = read();
  cfg.installBasePath = path.trim();
  write(cfg);
}
