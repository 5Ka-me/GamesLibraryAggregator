// Downloads the latest legendary.exe (Windows) into resources/bin/.
// Run: npm run fetch:legendary  (from steam-egs-launcher)
//
// legendary is the open-source EGS CLI (https://github.com/derrod/legendary).
// It is intentionally NOT committed to git — this script fetches it on demand.
//
// We use GitHub's stable "latest release" download URL (a 302 redirect to the
// asset) instead of the REST API, which is rate-limited/403s for unauthenticated
// requests.

import { mkdirSync, writeFileSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'resources', 'bin');
const outFile = join(outDir, 'legendary.exe');

const DOWNLOAD_URL = 'https://github.com/derrod/legendary/releases/latest/download/legendary.exe';

async function main() {
  mkdirSync(outDir, { recursive: true });

  console.log(`Downloading legendary.exe → ${outFile}`);
  const res = await fetch(DOWNLOAD_URL, {
    headers: { 'User-Agent': 'steam-egs-launcher' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(
      `Download failed: HTTP ${res.status}. ` +
        `Download legendary.exe manually from https://github.com/derrod/legendary/releases/latest ` +
        `and place it in ${outDir}`
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outFile, buf);

  const kb = Math.round(statSync(outFile).size / 1024);
  console.log(`Done ✅  (${kb} KB)`);
}

main().catch((e) => {
  console.error('fetch-legendary failed:', e.message);
  process.exitCode = 1; // let the event loop drain cleanly (avoids libuv assert on abrupt exit)
});
