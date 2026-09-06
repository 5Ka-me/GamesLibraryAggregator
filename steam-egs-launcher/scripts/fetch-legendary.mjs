// Downloads legendary.exe (Windows) into resources/bin/.
// Run: npm run fetch:legendary  (from steam-egs-launcher)
//
// legendary is the open-source EGS CLI (https://github.com/legendary-gl/legendary,
// formerly derrod/legendary). It is intentionally NOT committed to git — this
// script fetches it on demand, also on the release runner.
//
// The version is pinned: a release must bundle the CLI the app was tested
// with, not whatever "latest" happens to be that day (0.21.0 also renamed the
// asset, which silently broke the old latest/legendary.exe link). Bump
// LEGENDARY_VERSION deliberately after checking legendary.ts still parses its
// output.
import { mkdirSync, writeFileSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'resources', 'bin');
const outFile = join(outDir, 'legendary.exe');

const LEGENDARY_VERSION = process.env.LEGENDARY_VERSION || '0.20.34';
// Asset name changed in 0.21.0 (legendary_windows_x64.exe); older tags ship legendary.exe.
const CANDIDATES = ['legendary_windows_x64.exe', 'legendary.exe'].map(
  (name) => `https://github.com/legendary-gl/legendary/releases/download/${LEGENDARY_VERSION}/${name}`
);

async function main() {
  mkdirSync(outDir, { recursive: true });
  if (process.env.LEGENDARY_SKIP_IF_PRESENT && existsSync(outFile)) {
    console.log(`legendary.exe already present at ${outFile} — skipping`);
    return;
  }
  console.log(`Downloading legendary ${LEGENDARY_VERSION} → ${outFile}`);
  let lastStatus = 0;
  for (const url of CANDIDATES) {
    const res = await fetch(url, { headers: { 'User-Agent': 'steam-egs-launcher' }, redirect: 'follow' });
    if (!res.ok) {
      lastStatus = res.status;
      continue;
    }
    writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
    const kb = Math.round(statSync(outFile).size / 1024);
    console.log(`Done ✅  ${url} (${kb} KB)`);
    return;
  }
  throw new Error(
    `Download failed (last HTTP ${lastStatus}) for legendary ${LEGENDARY_VERSION}. ` +
      `Check https://github.com/legendary-gl/legendary/releases and place legendary.exe in ${outDir}`
  );
}

main().catch((e) => {
  console.error('fetch-legendary failed:', e.message);
  process.exitCode = 1; // let the event loop drain cleanly (avoids libuv assert on abrupt exit)
});
