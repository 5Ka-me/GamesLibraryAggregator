import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const pexec = promisify(execFile);

// Detects which Steam games are installed by reading Steam's own files:
//   Steam path (registry / default) → libraryfolders.vdf (library roots) →
//   <root>/steamapps/appmanifest_<appid>.acf (one per installed app).

export async function steamInstallPath(): Promise<string | null> {
  // Current-user registry key set by Steam.
  try {
    const { stdout } = await pexec('reg', [
      'query',
      'HKCU\\Software\\Valve\\Steam',
      '/v',
      'SteamPath',
    ]);
    const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (match) {
      const p = match[1].trim().replace(/\//g, '\\');
      if (existsSync(p)) return p;
    }
  } catch {
    /* reg not available / key missing */
  }

  const fallback = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam');
  return existsSync(fallback) ? fallback : null;
}

function libraryRoots(steamPath: string): string[] {
  const roots = new Set<string>([steamPath]);
  const vdf =
    [join(steamPath, 'steamapps', 'libraryfolders.vdf'), join(steamPath, 'config', 'libraryfolders.vdf')].find(
      existsSync
    );
  if (vdf) {
    const text = readFileSync(vdf, 'utf8');
    for (const m of text.matchAll(/"path"\s*"([^"]+)"/g)) {
      roots.add(m[1].replace(/\\\\/g, '\\'));
    }
  }
  return [...roots];
}

/** Returns the set of installed Steam appids (as strings). */
export async function scanInstalledSteamAppIds(): Promise<string[]> {
  const steamPath = await steamInstallPath();
  if (!steamPath) return [];

  const ids = new Set<string>();
  for (const root of libraryRoots(steamPath)) {
    const dir = join(root, 'steamapps');
    if (!existsSync(dir)) continue;
    try {
      for (const file of readdirSync(dir)) {
        const m = file.match(/^appmanifest_(\d+)\.acf$/);
        if (m) ids.add(m[1]);
      }
    } catch {
      /* unreadable library folder */
    }
  }
  return [...ids];
}
