# GL Aggregator — desktop launcher

**Standalone** Electron desktop launcher for the merged Steam + EGS library — no backend, no
database, no Docker. Everything runs in-process (Heroic-style): the library lives in a local JSON
store, secrets in the OS keystore, and all Steam/Epic traffic goes straight from the main process
to the official services. Built with **electron-vite** (main / preload / React renderer) and shares
UI, types and the API client with the web app via the **`@app/shared`** workspace package.

See the [root README](../README.md) for features, quick start and configuration.

## Architecture

- **main/** (Node/TS) — everything OS-level and network-privileged:
  - `services/apiClient.ts` — the **local API router**: the same `/api/*` contract the .NET backend
    used to serve, dispatched to in-process implementations (the renderer and `@app/shared` are
    completely unaware the backend is gone).
  - `services/localData.ts` — the local library database: one JSON file in `userData`
    (atomic writes, prune on re-sync, no-clobber playtime). No secrets in it.
  - `services/library.ts` — the merge read-model: entries from both stores grouped by normalized
    title into the exact `GameDto` shape the backend used to return.
  - `services/secretStore.ts` — Epic OAuth session + optional Steam API key, encrypted at rest via
    `safeStorage` (Windows DPAPI).
  - `services/steamSync.ts` — Steam library / recently-played / achievements. Library and recent
    games use the official Web API (web-session token or API key); achievements use the Web API
    with an API key, otherwise the profile's community achievement XML (as the signed-in user, so
    private profiles work) merged with the public `IPlayerService/GetGameAchievements` schema.
    Whole-library achievement progress comes from one batched `IPlayerService/GetAchievementsProgress`
    call per 100 games. Steam sync also keeps last-launch, two-week and Steam Deck minutes.
  - `services/playtimeHistory.ts` — one playtime snapshot per day (written on every sync,
    `%APPDATA%/steam-egs-launcher/playtime-history.json`, 400 days) so the Statistics page can show
    real deltas — the stores only report lifetime totals.
  - `services/epicSync.ts` — EGS OAuth (code exchange, auto-refresh), library + catalog + playtime
    via the same private Epic Launcher endpoints legendary uses; games-only filtering; import of an
    installed Epic Games Launcher session (DPAPI).
  - `services/legendary.ts` — EGS downloads: bundled [legendary](https://github.com/derrod/legendary)
    CLI (auth / install / launch / uninstall, progress streamed to the UI over IPC).
  - `services/epicAuth.ts` — embedded EGS OAuth: Epic's official login page in a window, the
    authorization code authorizes both `legendary` and the local library sync.
  - `services/steamScan.ts` — installed Steam games via `libraryfolders.vdf` / `appmanifest_*.acf`.
  - `services/validate.ts` / `services/http.ts` — the trust boundary: every renderer argument that
    reaches a spawned CLI, an authenticated Steam request or the OS shell is validated here, and
    all plain HTTP goes through one helper with a timeout and a consistent user agent.
  - `services/cache.ts` — the unified **memory + disk cache** (`userData/cache/`) with
    stale-while-revalidate: expired data is served instantly while a fresh copy loads in the
    background. TTL classes: priced/storefront data 1 h (`LAUNCHER_STORE_CACHE_TTL`), static data
    (tags, FX rates) 24 h, player progress (achievements, recent) 10 min.
  - `services/autoSync.ts` — silent background library sync (on startup + every
    `LAUNCHER_AUTOSYNC_HOURS`); the renderer picks the changes up via a `library:changed` event.
  - `services/bridge.ts` — the **local web bridge**: an HTTP server on `127.0.0.1:17832` that lets
    the web app on the same machine read the launcher's data. A website must be **paired** first
    (the launcher shows an approval dialog; the origin gets a bearer token, revocable in Settings);
    the surface is a read-only GET whitelist (library, accounts, recent, achievements, installed
    state) — no syncs, no launches, no secrets. Demo: [`docs/bridge-demo.html`](../docs/bridge-demo.html).
  - `services/steamStore.ts` / `epicStore.ts` — storefront data (front page, sections, search,
    wishlist, game details; EGS offers/ratings via Epic's public GraphQL). Region-aware prices,
    everything through the unified cache.
  - `services/regions.ts` / `fxRates.ts` — per-store account regions; daily USD rates for the
    approximate cross-currency price comparison.
  - `services/steamLauncher.ts` — `steam://` deep links; store pages open in the Steam client when installed.
- **preload/** — a small typed `window.launcher` bridge (contextIsolation on).
- **renderer/** — React UI: library, store (home/sections/wishlist/search), random-game reel, statistics (Replay-style overview + the whole library as Steam's profile games list, batched), unified game page
  (`GameView`, also embedded in the library's split view). The shell is Steam-like: the title bar is
  drawn by the renderer (`TopBar` — section nav, update chip, profile → Settings) as a drag region with
  Windows' own min/max/close buttons overlaid in app colours (`titleBarStyle: 'hidden'` +
  `titleBarOverlay`). The library defaults to a split view — game list with icons on the left, Home
  pane or the selected game's page on the right, its key art behind the whole area; Settings can
  switch it back to the cover grid
  (platform tabs, launch & install, price comparison, achievements, screenshot lightbox),
  statistics, settings.

Steam launching/installing is delegated to the official Steam client via deep links; **EGS is
self-managed** through `legendary` (no Epic Games Launcher required).

## Develop

From the **repo root** (npm workspaces):

```bash
npm install
cd steam-egs-launcher && npm run fetch:legendary && cd ..   # once: EGS download engine
npm run dev:launcher
```

No backend needed — sign in to Steam/Epic on the Settings page and everything syncs locally.

Env knobs:

| Variable | Default | Meaning |
|---|---|---|
| `LAUNCHER_STORE_CACHE_TTL` | `3600` | TTL (seconds) of the "dynamic" cache class — anything with prices (front page, sections, wishlist metadata, search, details). Stale data is served instantly and refreshed in the background; ↻ always fetches live. |
| `LAUNCHER_AUTOSYNC_HOURS` | `6` | Background library re-sync interval (both stores). `0` disables autosync. |
| `LAUNCHER_BRIDGE_PORT` | `17832` | Port of the local web bridge (loopback only). The bridge is **off by default**; enable it with `"bridgeEnabled": true` in `%APPDATA%/steam-egs-launcher/launcher-config.json`. The web app reads the same port from `REACT_APP_BRIDGE_PORT`. |

## Build / package / release (Windows)

```bash
npm run build:launcher    # compile main/preload/renderer into out/
npm run package:launcher  # + electron-builder → dist/GL-Aggregator-Setup-<version>.exe (NSIS)
```

Run `fetch:legendary` before packaging — `resources/bin/legendary.exe` is bundled into the
installer via `extraResources` (it is intentionally not committed to git).

The app icon lives in `resources/icon.ico` / `icon.png` and is generated (dependency-free) by
`npm run gen:icon` — replace the script's artwork or drop in your own files any time.

The installer is a **one-click, per-user NSIS** build (`%LOCALAPPDATA%\Programs\GL Aggregator`,
no UAC, no wizard). Updates download in the background; the sidebar shows a card above the
profile ("New version X is out — Restart"), and the button installs silently and relaunches.
Ignored updates are applied on the next quit.

### Releasing an update

Auto-update is wired to **GitHub Releases** of this repo (electron-updater; the repo must stay
public). One command from the repo root, on a clean `main`:

```bash
npm run release 0.3.0
```

It sets the launcher version, commits `release v0.3.0`, tags `v0.3.0` and pushes. The tag push
runs `.github/workflows/release.yml` on a Windows runner: typecheck → fetch `legendary.exe` →
`electron-builder --publish always` → the release is published immediately with generated notes
and the installer, `latest.yml` and blockmap attached — installed launchers pick it up on their
next check. No tokens on your machine; the workflow uses the repository's own `GITHUB_TOKEN`.

The old local path still exists as `npm run release:local` inside `steam-egs-launcher/`
(needs `GH_TOKEN` with `contents: write`), but CI is the intended way.

Installed apps check ~20 s after startup, download in the background and show a quiet
"Restart to update" banner (Settings → Updates has a manual check). Nothing is code-signed yet,
so SmartScreen shows a warning on first install — expected for an unsigned open-source app.

## Data & secrets on disk

| What | Where | Protection |
|---|---|---|
| Library (games, playtimes, account names, regions) | `%APPDATA%/steam-egs-launcher/library.json` | plain JSON (no secrets) |
| Store/FX cache (7-day retention, capped) | `%APPDATA%/steam-egs-launcher/cache/*.json` | plain JSON (public storefront data) |
| Epic OAuth session, Steam API key | `%APPDATA%/steam-egs-launcher/secrets.bin` | OS keystore (DPAPI) via `safeStorage` |
| Steam web session | Electron partition `persist:steam` | Chromium cookie encryption |
| Bridge pairing tokens (per website origin) | `%APPDATA%/steam-egs-launcher/secrets.bin` | OS keystore (DPAPI) via `safeStorage` |
| Steam webapi_token | main-process memory only | never written to disk |

## Why the launcher isn't in docker-compose

It's a desktop GUI app that needs a display, the OS keystore (DPAPI), the installed Steam client
and local disk access — none of which work as a container service. Build it natively;
`docker-compose` covers db + api + web (the **web** stack — the launcher doesn't use it).
