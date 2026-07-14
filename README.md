# GL Aggregator

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/desktop-Windows-blue.svg)]()
[![.NET 9](https://img.shields.io/badge/backend-.NET%209-512BD4.svg)]()
[![Electron](https://img.shields.io/badge/launcher-Electron-47848F.svg)]()
[![React](https://img.shields.io/badge/UI-React%2019-61DAFB.svg)]()

**One launcher for your Steam and Epic Games Store libraries.** A Heroic/Playnite-style desktop app
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

**Web app** — a lightweight browser version of the library (sync, search, filters, store links), multi-user via private workspace tokens.

**Regional prices** — currencies follow each store account's region (auto-detected, overridable in Settings), USD fallback.

## Repository layout

npm-workspaces monorepo:

```
.
├─ steam-egs-launcher/        # Electron desktop launcher (main / preload / React renderer)
├─ steam-egs-aggregator/      # React web app (CRA), served via nginx in Docker
├─ packages/shared/           # shared TS: API client, UI components, i18n, theming
└─ SteamEGSAggregator/        # ASP.NET Core (.NET 9) API + EF Core + PostgreSQL
   ├─ Application/            # services, entities, migrations
   └─ SteamEGSAggregator/     # Web API host; docker-compose.yml lives next to it
```

The launcher talks to the API over HTTP through its main process (no CORS), runs all OS-level work
locally (installs, launches, library scans) and keeps secrets in the OS keystore (DPAPI).

## How the data is fetched

| Source | Method |
|--------|--------|
| Steam library | Official Web API `IPlayerService/GetOwnedGames` (user's API key, public profile) |
| Steam store/details | Public storefront endpoints (`featuredcategories`, `appdetails`, search, `IStoreBrowseService`) |
| Steam stats | `GetRecentlyPlayedGames`, `GetPlayerAchievements` + schema + global percentages |
| EGS library & playtime | Epic's launcher APIs (the [legendary](https://github.com/derrod/legendary) approach): OAuth code → token → library/catalog/playtime services |
| EGS store/details | Public Store GraphQL (offers, search, ratings) via the launcher's Chromium network stack |
| EGS downloads | Bundled [legendary](https://github.com/derrod/legendary) CLI (fetched at build time, not committed) |
| Steam install state | Local `libraryfolders.vdf` / `appmanifest_*.acf` scan |
| FX rates | [open.er-api.com](https://open.er-api.com) daily USD rates (price comparison only) |

Epic sign-in happens in an embedded window on Epic's official login page; the authorization code is
exchanged both for the cloud library sync and for `legendary` downloads. There is no public Epic API
for the owned library — the launcher uses the same private endpoints the Epic Games Launcher itself calls.

## Quick start

### Prerequisites

- **Windows 10/11** (the desktop launcher is Windows-only for now)
- **Node.js 20+**, **.NET 9 SDK**, **Docker** (for PostgreSQL / the web stack)
- A **Steam Web API key** ([get one here](https://steamcommunity.com/dev/apikey)) with a public profile

### 1. Backend + web (Docker)

```bash
cd SteamEGSAggregator
cp .env.example .env
# REQUIRED: set SECURITY_ENCRYPTION_KEY in .env (openssl rand -base64 32)
docker compose up -d --build
```

- Web app: http://localhost:3000 · API/Swagger: http://localhost:8080/swagger

> EGS "import from installed launcher" (option B) doesn't work inside a container — for that, run
> the backend on the host (step below). The embedded OAuth in the desktop launcher works either way.

### 2. Backend on the host (alternative to the API container)

```bash
cd SteamEGSAggregator
docker compose up -d db
cp SteamEGSAggregator/appsettings.Development.json.example SteamEGSAggregator/appsettings.Development.json
# put a base64 32-byte key into Security:EncryptionKey
dotnet run --project SteamEGSAggregator/SteamEGSAggregator.csproj   # → http://localhost:5080
```

EF Core migrations apply automatically on startup.

### 3. Desktop launcher

```bash
npm install                                  # repo root — installs all workspaces
cd steam-egs-launcher && npm run fetch:legendary && cd ..   # EGS download engine (once)
npm run dev:launcher                         # dev mode (expects the API on :5080)
```

First run: open **Settings** → save your Steam API key + SteamID64, press **Sign in to Epic
(in-app)** — the library syncs and everything lights up.

Package a Windows installer:

```bash
npm run package:launcher                     # → steam-egs-launcher/dist/*.exe (NSIS)
```

## Configuration

Nothing secret is committed. Local secrets live in git-ignored files
(`SteamEGSAggregator/.env`, `appsettings.Development.json`).

| Setting | Where | Notes |
|---------|-------|-------|
| `SECURITY_ENCRYPTION_KEY` | backend env / appsettings | **Required.** Base64 32-byte AES key; encrypts stored secrets. Keep it stable. |
| `POSTGRES_*` | `SteamEGSAggregator/.env` | Database name/user/password for Docker |
| `REACT_APP_API_URL` | web build arg | Backend URL baked into the web bundle |
| `LAUNCHER_API_BASE` | launcher env | Backend URL (default `http://localhost:5080`; also editable in Settings) |
| `LAUNCHER_STORE_CACHE_TTL` | launcher env | Storefront cache TTL in seconds (default 300) |

Per-user settings (Steam API key, store regions, EGS install folder) are managed on the Settings
page. The Epic client credentials in `appsettings.json` are the public Epic Games Launcher ones —
not a secret.

## API endpoints

All `/api/*` endpoints except `POST /api/workspace` require the `X-Workspace-Token` header.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/workspace` | Create a workspace, returns its secret token |
| GET  | `/api/workspace/me` | Validate the current token |
| GET  | `/api/library` | Combined library |
| POST | `/api/library/sync` | Sync both sources |
| GET/POST | `/api/steam/account`, `/api/steam/credentials` | Steam account info / save & verify the key |
| POST | `/api/steam/sync` | Load the Steam library |
| POST | `/api/steam/region` | Override the Steam store region |
| GET  | `/api/steam/recent` | Games played in the last 2 weeks |
| GET  | `/api/steam/achievements/{appId}` | Player achievements + global rarity |
| GET  | `/api/epic/account`, `/api/epic/login-url` | EGS account info / login link |
| POST | `/api/epic/auth`, `/api/epic/import-launcher`, `/api/epic/sync` | Auth (code / launcher import) and sync |
| POST | `/api/epic/region` | Override the EGS store region |
| GET  | `/api/epic/store-url` | Resolve a game's exact EGS store link |

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
