import { app } from 'electron';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import { emit } from './events';
import { getInstallBasePath } from '../config';

// Wraps the bundled `legendary` CLI for EGS
// download management. legendary writes logs to stderr and machine-readable
// output to stdout with `--json`.

const CLIENT_BINARY = process.platform === 'win32' ? 'legendary.exe' : 'legendary';

/** Absolute path to the bundled legendary binary (dev vs packaged). */
function legendaryPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', CLIENT_BINARY)
    : join(app.getAppPath(), 'resources', 'bin', CLIENT_BINARY);
}

export function isLegendaryAvailable(): boolean {
  return existsSync(legendaryPath());
}

/** Keep legendary's config/auth isolated inside the app's userData. */
function legendaryEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LEGENDARY_CONFIG_PATH: join(app.getPath('userData'), 'legendary'),
  };
}

function ensureAvailable(): void {
  if (!isLegendaryAvailable()) {
    throw new Error(
      `legendary binary not found at ${legendaryPath()}. ` +
        'Run "npm run fetch:legendary" in steam-egs-launcher (or add legendary.exe to resources/bin).'
    );
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run legendary to completion, capturing stdout/stderr. */
function run(args: string[]): Promise<RunResult> {
  ensureAvailable();
  return new Promise((resolve, reject) => {
    const child = spawn(legendaryPath(), args, { env: legendaryEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runJson<T>(args: string[]): Promise<T> {
  const { stdout, stderr, code } = await run([...args, '--json']);
  if (code !== 0 && !stdout.trim()) {
    throw new Error(stderr.trim() || `legendary exited with code ${code}`);
  }
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`Failed to parse legendary output: ${stderr.trim() || stdout.slice(0, 200)}`);
  }
}

// ===================== Auth =====================

export async function auth(authorizationCode: string): Promise<void> {
  const { code, stderr } = await run(['auth', '--code', authorizationCode.trim()]);
  if (code !== 0) throw new Error(stderr.trim() || `legendary auth failed (${code})`);
}

// ===================== Library / installed =====================

export interface InstalledGame {
  app_name: string;
  title: string;
  version?: string;
  install_path?: string;
}

export async function listInstalled(): Promise<InstalledGame[]> {
  if (!isLegendaryAvailable()) return [];
  try {
    return await runJson<InstalledGame[]>(['list-installed']);
  } catch {
    return [];
  }
}

// ===================== Install / uninstall / launch =====================

const running = new Map<string, ChildProcessWithoutNullStreams>();

const PROGRESS_RE = /(\d+(?:\.\d+)?)%/;

/** Install (download) a game by legendary app name, streaming progress to the renderer. */
export function install(appName: string, title?: string): void {
  ensureAvailable();
  if (running.has(appName)) return; // already in progress

  emit('legendary:progress', { appName, title, pct: 0, status: 'running' });

  const args = ['install', appName, '--yes'];
  // Only an absolute, existing folder is passed through — a relative or bogus
  // value would be read by legendary as another flag or silently ignored.
  const basePath = getInstallBasePath();
  if (basePath && isAbsolute(basePath) && existsSync(basePath)) {
    args.push('--base-path', basePath);
  } else if (basePath) {
    console.warn(`[legendary] ignoring install folder (not an existing absolute path): ${basePath}`);
  }

  const child = spawn(legendaryPath(), args, { env: legendaryEnv() });
  running.set(appName, child);

  const onLine = (buf: Buffer) => {
    const match = buf.toString().match(PROGRESS_RE);
    if (match) {
      emit('legendary:progress', {
        appName,
        title,
        pct: Math.min(100, parseFloat(match[1])),
        status: 'running',
      });
    }
  };
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine); // legendary prints progress on stderr

  child.on('error', (err) => {
    running.delete(appName);
    emit('legendary:progress', { appName, title, pct: 0, status: 'error', error: err.message });
  });
  child.on('close', (code) => {
    running.delete(appName);
    emit('legendary:progress', {
      appName,
      title,
      pct: code === 0 ? 100 : 0,
      status: code === 0 ? 'done' : 'error',
      error: code === 0 ? undefined : `legendary install exited with code ${code}`,
    });
  });
}

export function cancelInstall(appName: string): void {
  const child = running.get(appName);
  if (child) {
    child.kill();
    running.delete(appName);
    emit('legendary:progress', { appName, pct: 0, status: 'error', error: 'Cancelled' });
  }
}

export async function uninstall(appName: string): Promise<void> {
  const { code, stderr } = await run(['uninstall', appName, '--yes']);
  if (code !== 0) throw new Error(stderr.trim() || `legendary uninstall failed (${code})`);
}

/** Launch an installed game (detached so it outlives the launcher). */
export function launch(appName: string): void {
  ensureAvailable();
  const child = spawn(legendaryPath(), ['launch', appName], {
    env: legendaryEnv(),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
