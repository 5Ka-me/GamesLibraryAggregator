# Steam + EGS Library Aggregator

A small web app that merges your **Steam** and **Epic Games Store** libraries into one searchable, themeable list. Multi-user: each device gets its own private, isolated workspace.

- **Backend:** ASP.NET Core (.NET 9) Web API + EF Core + PostgreSQL
- **Frontend:** React (CRA, TypeScript), served via nginx
- **Infra:** Docker Compose (Postgres, API, frontend, Adminer)

## Features

- One combined library; a game owned on both stores is shown once with **both source tags** and per-source playtime.
- Click a game to open its store page (Steam exact app page; EGS page resolved on demand and cached).
- Search with clear button, source filters, incremental (lazy) loading, lazy-loaded & downscaled cover art.
- Light/dark theme and EN/RU UI localization (default EN).
- Per-device **workspaces** with secret tokens; secrets encrypted at rest.

## Repository layout

```
.
├─ SteamEGSAggregator/        # .NET solution (API + Application library) + docker-compose.yml
│  ├─ Application/            # services, EF Core, entities, migrations
│  └─ SteamEGSAggregator/     # Web API (controllers, middlewares, Program.cs)
└─ steam-egs-aggregator/      # React frontend
```

## How the data is fetched

| Source | Method |
|--------|--------|
| **Steam** | Official Web API `IPlayerService/GetOwnedGames` (requires an API key + a public profile). |
| **EGS** | Epic's private "launcher" APIs (the same approach as the open-source [legendary](https://github.com/derrod/legendary)): exchange an `authorizationCode` → token → `library-service` → `catalog-service`. Epic has no public API for the owned library. |

**EGS login (two options):**
- **A — manual:** open the login link, sign in, copy the `authorizationCode` from the JSON, paste it into the app.
- **B — import:** read the saved login from an installed Epic Games Launcher (Windows DPAPI). Works only when the **backend runs on the host** (not in a container).

Exact EGS store links are resolved lazily on click via the public Store GraphQL and cached.

## Quick start (Docker)

```bash
cd SteamEGSAggregator
cp .env.example .env
# Edit .env — at minimum set SECURITY_ENCRYPTION_KEY:
#   openssl rand -base64 32
docker compose up -d --build
```

- Frontend: http://localhost:3000
- API / Swagger: http://localhost:8080/swagger

Need a database UI? Add the local overlay (starts Adminer at http://localhost:8090):

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

> EGS login option B (launcher import) does **not** work inside the container. For it, run the backend on the host (below).

## Local development

Requires .NET 9 SDK and Node 20+.

```bash
# 1) Database only
cd SteamEGSAggregator
docker compose up -d db

# 2) Backend on the host (enables EGS launcher import on Windows)
cp SteamEGSAggregator/appsettings.Development.json.example SteamEGSAggregator/appsettings.Development.json
# put a base64 32-byte key into Security:EncryptionKey
dotnet run --project SteamEGSAggregator/SteamEGSAggregator.csproj

# 3) Frontend
cd ../steam-egs-aggregator
npm install
REACT_APP_API_URL=http://localhost:5080 npm start
```

EF Core migrations are applied automatically on startup. To run them manually:

```bash
dotnet ef database update \
  --project Application/SteamEGSAggregator.Application.csproj \
  --startup-project SteamEGSAggregator/SteamEGSAggregator.csproj
```

## Configuration & secrets

Nothing secret is committed. Local secrets live in git-ignored files:

| What | Where | Notes |
|------|-------|-------|
| Docker env | `SteamEGSAggregator/.env` | from `.env.example` |
| Local dev config | `SteamEGSAggregator/SteamEGSAggregator/appsettings.Development.json` | from `appsettings.Development.json.example` |

Key settings:

- `SECURITY_ENCRYPTION_KEY` / `Security:EncryptionKey` — **required**, base64 32-byte AES key. Used to encrypt secrets (Steam API key, EGS tokens) at rest. Keep it stable; changing it makes existing encrypted values unreadable. The app refuses to start without it.
- `POSTGRES_*` — database name/user/password.
- `REACT_APP_API_URL` — backend URL baked into the frontend bundle at build time.

The Steam API key is **not** configured in files — each user enters it in the app's Settings page and it is stored encrypted, per workspace.

The `EpicGames:ClientId/ClientSecret` in `appsettings.json` are the public Epic Games Launcher client credentials (the same ones `legendary` ships) — not secret.

## Multi-user workspaces

- On first load the frontend calls `POST /api/workspace` and stores the returned secret token in `localStorage`; it is sent as `X-Workspace-Token` on every request. Only the SHA-256 hash is stored server-side.
- All data (`Games`, `GameEntries`, `EpicSession`, `SteamCredentials`) is scoped by `WorkspaceId` — different devices/users never see each other's data.
- On the Settings page you can view/copy your token, or paste an existing one to open the same workspace on another device.

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/workspace` | Create a workspace, return its token (no token required) |
| GET  | `/api/workspace/me` | Validate the current token |
| GET  | `/api/library` | Combined library |
| POST | `/api/library/sync` | Sync both sources |
| GET  | `/api/steam/account` | Steam account info |
| POST | `/api/steam/credentials` | Save & verify API key + SteamId |
| POST | `/api/steam/sync` | Load Steam → DB |
| GET  | `/api/epic/account` | EGS account info |
| GET  | `/api/epic/login-url` | Login link (flow A) |
| POST | `/api/epic/auth` | Exchange `authorizationCode` (flow A) |
| POST | `/api/epic/import-launcher` | Import from launcher (flow B) |
| POST | `/api/epic/sync` | Sync using the saved session |
| GET  | `/api/epic/store-url` | Resolve a game's exact EGS store link |

All `/api/*` endpoints except `POST /api/workspace` require a valid `X-Workspace-Token`.

## Production checklist

- Set your own `SECURITY_ENCRYPTION_KEY` (never reuse an example value).
- Do not expose PostgreSQL publicly; put the API behind an HTTPS reverse proxy.
- Restrict CORS in `Program.cs` to your domain (defaults to `http://localhost:3000`).
- Keep `appsettings.Development.json` and `.env` out of version control (already git-ignored).
