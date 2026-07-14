# GL Aggregator — desktop launcher

Electron desktop launcher for the merged Steam + EGS library — a Heroic/Playnite-style client.
Built with **electron-vite** (main / preload / React renderer) and shares UI, types and the API
client with the web app via the **`@app/shared`** workspace package.

See the [root README](../README.md) for features, quick start and configuration.

## Architecture

- **main/** (Node/TS) — everything OS-level and network-privileged:
  - `services/apiClient.ts` — proxies renderer calls to the .NET API (owns the workspace token → no CORS).
  - `services/secretStore.ts` — secrets encrypted at rest via `safeStorage` (Windows DPAPI).
  - `services/legendary.ts` — EGS downloads: bundled [legendary](https://github.com/derrod/legendary)
    CLI (auth / install / launch / uninstall, progress streamed to the UI over IPC).
  - `services/epicAuth.ts` — embedded EGS OAuth: Epic's official login page in a window, the
    authorization code authorizes both `legendary` and the cloud library sync.
  - `services/steamScan.ts` — installed Steam games via `libraryfolders.vdf` / `appmanifest_*.acf`.
  - `services/steamStore.ts` / `epicStore.ts` — storefront data (front page, sections, search,
    wishlist, game details; EGS offers/ratings via Epic's public GraphQL). Region-aware prices,
    cached in memory (`LAUNCHER_STORE_CACHE_TTL`).
  - `services/regions.ts` / `fxRates.ts` — per-store account regions; daily USD rates for the
    approximate cross-currency price comparison.
  - `services/steamLauncher.ts` — `steam://` deep links; store pages open in the Steam client when installed.
- **preload/** — a small typed `window.launcher` bridge (contextIsolation on).
- **renderer/** — React UI: library, store (home/sections/wishlist/search), unified game page
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

The .NET API must be running (default `http://localhost:5080`) — see the root README. Point the
launcher at a different backend on the Settings page or via `LAUNCHER_API_BASE`.

Env knobs:

| Variable | Default | Meaning |
|---|---|---|
| `LAUNCHER_API_BASE` | `http://localhost:5080` | Backend API base URL |
| `LAUNCHER_STORE_CACHE_TTL` | `300` | TTL (seconds) of the in-memory storefront cache (front page, wishlist, item metadata, search). The ↻ button always bypasses the cache. |

## Build / package (Windows)

```bash
npm run build:launcher    # compile main/preload/renderer into out/
npm run package:launcher  # + electron-builder → dist/ (NSIS installer)
```

Run `fetch:legendary` before packaging — `resources/bin/legendary.exe` is bundled into the
installer via `extraResources` (it is intentionally not committed to git).

## Why the launcher isn't in docker-compose

It's a desktop GUI app that needs a display, the OS keystore (DPAPI), the installed Steam client
and local disk access — none of which work as a container service. Build it natively;
`docker-compose` covers db + api + web.
