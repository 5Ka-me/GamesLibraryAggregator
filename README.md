# GL Aggregator

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/desktop-Windows-blue.svg)]()
[![.NET 9](https://img.shields.io/badge/backend-.NET%209-512BD4.svg)]()
[![Electron](https://img.shields.io/badge/launcher-Electron-47848F.svg)]()
[![React](https://img.shields.io/badge/UI-React%2019-61DAFB.svg)]()

**One launcher for your Steam and Epic Games Store libraries.** A desktop app
plus a companion web app: merged game library, an integrated Steam store with cross-store price
comparison, self-managed EGS downloads, playtime & achievements statistics.

- [Features](#features)
- [Repository layout](#repository-layout)
- [How the data is fetched](#how-the-data-is-fetched)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API endpoints](#api-endpoints)
- [Development](#development)
- [Disclaimer](#disclaimer)
- [Credits](#credits)

## Features

**Library**
- One merged library: a game owned on both stores is a single card with per-store tags, playtime and install state.
- Filters: All / Steam / Epic (AND semantics — both selected shows games owned on *both* stores), Installed, live search.
- Launch installed games right from the card; full install/uninstall management on the game page.

**Game page** (unified for every game — owned or not)
- Steam / Epic tabs: description, genres, developer/publisher, screenshots (in-app lightbox viewer with zoom), trailers, review score & current players (Steam), 5-star rating (EGS).
- Per-platform **Launch & install** section: Play / Install for owned platforms (EGS downloads via `legendary` with live progress), Buy + price for the others.
- **Cross-store price comparison** in your regional currencies, converted to USD (`≈`) when the currencies differ.
- Steam achievements with unlock progress and global rarity.

**Store**
- Steam front page: featured, specials, top sellers, new releases, coming soon, deals under a budget, genre rows, spotlight banners.
- Full paginated section pages, live search-as-you-type, wishlist with Steam-like sorting/filters.
- Items you already own are badged (`✓ Steam` / `✓ EGS`).

**Statistics**
- Games / total hours / top-10 by playtime across both stores (per-platform filter), Steam last-2-weeks activity.
- EGS playtime is fetched from Epic's own services — both stores count.

**Web app** — a lightweight browser version of the library: "Sign in through Steam" (no keys or
tokens to enter) shows the Steam library; with the desktop launcher running on the same machine it
connects to the launcher's local bridge and shows the **full** merged library (both stores,
playtime, installed games).

**Regional prices** — currencies follow each store account's region (auto-detected, overridable in Settings), USD fallback.

## Repository layout

npm-workspaces monorepo:

```
.
├─ steam-egs-launcher/        # Electron desktop launcher (main / preload / React renderer)
├─ steam-egs-aggregator/      # React web app (CRA), served via nginx in Docker
├─ packages/shared/           # shared TS: API client, UI components, i18n, theming
└─ SteamEGSAggregator/        # ASP.NET Core (.NET 9) stateless web backend (no database)
```

The **desktop launcher is fully standalone** (Heroic-style): the library lives in a local JSON
store, all Steam/Epic traffic goes straight from its main process to the official services, and
secrets stay in the OS keystore (DPAPI). The **.NET backend serves the web app only** — a stateless
Steam proxy (OpenID sign-in + one server-side API key), optional and not needed for the launcher.
On a machine where the launcher runs, the web app reads the launcher's data directly through its
**local bridge** (`127.0.0.1:17832`, user-approved pairing).

## How the data is fetched

| Source | Method |
|--------|--------|
| Steam library | Official Web API `IPlayerService/GetOwnedGames` (launcher: web sign-in token, works for private profiles; web app: OpenID sign-in + server-side key, public profiles) |
| Steam store/details | Public storefront endpoints (`featuredcategories`, `appdetails`, search, `IStoreBrowseService`) |
| Steam stats | `GetRecentlyPlayedGames`, `GetPlayerAchievements` + schema + global percentages |
| EGS library & playtime | Epic's launcher APIs (the [legendary](https://github.com/derrod/legendary) approach): OAuth code → token → library/catalog/playtime services |
| EGS store/details | Public Store GraphQL (offers, search, ratings) via the launcher's Chromium network stack |
| EGS downloads | Bundled [legendary](https://github.com/derrod/legendary) CLI (fetched at build time, not committed) |
| Steam install state | Local `libraryfolders.vdf` / `appmanifest_*.acf` scan |
| FX rates | [open.er-api.com](https://open.er-api.com) daily USD rates (price comparison only) |

Epic sign-in happens in an embedded window on Epic's official login page; the authorization code is
exchanged both for the local library sync and for `legendary` downloads. There is no public Epic API
for the owned library — the launcher uses the same private endpoints the Epic Games Launcher itself calls.

## Quick start

### Prerequisites

- **Windows 10/11** (the desktop launcher is Windows-only for now)
- **Node.js 20+** — enough for the launcher alone
- **.NET 9 SDK** + **Docker** only if you also want the web stack
- A **Steam Web API key** ([get one here](https://steamcommunity.com/dev/apikey)) — only for
  hosting the web stack (one server-side key); the launcher doesn't need one

### 1. Desktop launcher (standalone — no backend needed)

```bash
npm install                                  # repo root — installs all workspaces
cd steam-egs-launcher && npm run fetch:legendary && cd ..   # EGS download engine (once)
npm run dev:launcher
```

First run: open **Settings** → **Sign in to Steam** (web sign-in, no API key) and **Sign in to
Epic (in-app)** — the libraries sync into a local store and everything lights up.

Package a Windows installer:

```bash
npm run package:launcher                     # → steam-egs-launcher/dist/GL-Aggregator-Setup-*.exe
```

Installed launchers **auto-update from GitHub Releases** of this repo (quiet background download,
"Restart to update" banner). See the [launcher README](steam-egs-launcher/README.md) for the
release flow.

### 2. Web stack (optional — Docker, no database)

```bash
cd SteamEGSAggregator
cp .env.example .env
# REQUIRED: set STEAM_API_KEY in .env (steamcommunity.com/dev/apikey)
docker compose up -d --build
```

- Web app: http://localhost:3000 · API/Swagger: http://localhost:8080/swagger
- Visitors just press **Sign in through Steam** — nobody enters keys or tokens.
- With the desktop launcher running on the same machine, the web app offers to **connect to the
  launcher** (approval dialog) and shows the full merged library through its local bridge.

### 3. Backend on the host (alternative to the API container)

```bash
cd SteamEGSAggregator
cp SteamEGSAggregator/appsettings.Development.json.example SteamEGSAggregator/appsettings.Development.json
# put your Steam Web API key into Steam:ApiKey
dotnet run --project SteamEGSAggregator/SteamEGSAggregator.csproj   # → http://localhost:5080
```

## Configuration

Nothing secret is committed. Local secrets live in git-ignored files
(`SteamEGSAggregator/.env`, `appsettings.Development.json`).

| Setting | Where | Notes |
|---------|-------|-------|
| `STEAM_API_KEY` | `SteamEGSAggregator/.env` / appsettings | **Required for the web stack.** The server-side Steam Web API key. |
| `WEB_ORIGIN` / `API_PUBLIC_URL` | `SteamEGSAggregator/.env` | Browser-facing origins of the web app / API (CORS, OpenID return URL) |
| `REACT_APP_API_URL` | web build arg | Backend URL baked into the web bundle |
| `LAUNCHER_STORE_CACHE_TTL` | launcher env | Storefront (priced-data) cache TTL in seconds (default 3600; disk-persisted, stale-while-revalidate) |
| `LAUNCHER_AUTOSYNC_HOURS` | launcher env | Background library re-sync interval in hours (default 6; 0 disables) |
| `LAUNCHER_BRIDGE_PORT` | launcher env | Local web-bridge port (default 17832, loopback only) |
| `REACT_APP_BRIDGE_PORT` | web build arg | Bridge port the web app probes (must match the launcher's) |

Per-user launcher settings (store regions, EGS install folder) are managed on the
launcher's Settings page.

## API endpoints (web backend)

Auth is a signed HTTP-only session cookie set by the Steam sign-in.

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/auth/steam/login` | Redirect to Steam's "Sign in through Steam" (OpenID 2.0) |
| GET  | `/auth/steam/callback` | Verify the assertion, set the session cookie |
| POST | `/auth/logout` | Clear the session |
| GET  | `/api/me` | `{ authenticated, steamId, personaName }` |
| GET  | `/api/library` | The signed-in user's Steam library (server-side key, 10-min cache) |

**Launcher bridge endpoints** (served by the desktop launcher on `127.0.0.1:17832`, read-only,
pairing-gated): `/bridge/ping`, `POST /bridge/pair`, `/bridge/api/library`,
`/bridge/api/steam/account`, `/bridge/api/epic/account`, `/bridge/api/steam/recent`,
`/bridge/api/steam/achievements/{appId}`, `/bridge/api/installed` — see
[docs/bridge-demo.html](docs/bridge-demo.html).

## Development

```bash
npm run build:shared      # compile packages/shared (needed by launcher typecheck & web build)
npm run dev:web           # CRA dev server on :3000
npm run dev:launcher      # electron-vite dev
npm run build:web         # production web bundle
npm run build:launcher    # compile the launcher (main/preload/renderer)
```

The .NET solution builds with `dotnet build SteamEGSAggregator/SteamEGSAggregator.sln`.

## Disclaimer

This is an unofficial, non-commercial project. It is **not affiliated with, endorsed by, or
connected to Valve Corporation or Epic Games, Inc.** Steam is a trademark of Valve Corporation;
Epic Games and the Epic Games Store are trademarks of Epic Games, Inc. The app accesses the users'
own accounts and libraries via the same endpoints the official clients use; use at your own risk
and in accordance with the stores' terms of service.

## Credits

- [legendary](https://github.com/derrod/legendary) — the open-source Epic Games launcher CLI used
  as the EGS download engine (downloaded at build time; GPL-3.0, invoked as a separate process).

## License

[MIT](LICENSE) © 5Ka-me
