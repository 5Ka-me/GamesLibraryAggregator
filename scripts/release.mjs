// Cuts a release from the command line:
//
//   npm run release 0.3.0
//
// Sets the launcher version, commits "release v0.3.0", tags v0.3.0 and pushes
// branch + tag. The tag push triggers .github/workflows/release.yml, which
// builds the installer on GitHub's Windows runner and publishes the release —
// no tokens or builds on this machine.
//
// Refuses to run with uncommitted changes, off the main branch, behind the
// remote, or when the tag already exists, so a half-done release can't happen.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER_PKG = join(ROOT, 'steam-egs-launcher', 'package.json');
const REPO_URL = 'https://github.com/5Ka-me/GamesLibraryAggregator';

const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: ROOT, stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8', ...opts })
    ?.toString()
    .trim();
const out = (cmd) => sh(cmd, { quiet: true });
const fail = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

const version = process.argv[2]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail('Usage: npm run release <semver>   e.g. npm run release 0.3.0');
}
const tag = `v${version}`;

// ----- preflight -----
const current = JSON.parse(readFileSync(LAUNCHER_PKG, 'utf8')).version;
if (current === version) fail(`Launcher is already at ${version} — pick a new version.`);

const branch = out('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') fail(`Releases are cut from main (you are on ${branch}).`);

if (out('git status --porcelain')) fail('Working tree has uncommitted changes — commit or stash first.');

sh('git fetch origin --tags --quiet', { quiet: true });
const behind = Number(out('git rev-list --count HEAD..origin/main'));
if (behind > 0) fail(`main is ${behind} commit(s) behind origin/main — pull first.`);

if (out(`git tag --list ${tag}`)) fail(`Tag ${tag} already exists locally.`);
if (out(`git ls-remote --tags origin refs/tags/${tag}`)) fail(`Tag ${tag} already exists on origin.`);

// ----- bump, commit, tag, push -----
console.log(`\n→ ${current} → ${version}`);
sh(`npm version ${version} --workspace steam-egs-launcher --no-git-tag-version`);
sh('git add steam-egs-launcher/package.json package-lock.json');
sh(`git commit --quiet -m "release ${tag}"`);
sh(`git tag -a ${tag} -m "GL Aggregator ${tag}"`);
sh('git push --quiet origin main');
sh(`git push --quiet origin ${tag}`);

console.log(`
✔ ${tag} pushed. GitHub Actions is building the installer:
  ${REPO_URL}/actions
The release appears here when it is done (a few minutes):
  ${REPO_URL}/releases/tag/${tag}
`);
