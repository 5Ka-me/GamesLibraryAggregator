# GL Aggregator — backend

ASP.NET Core (.NET 9) Web API + EF Core + PostgreSQL. This folder also holds `docker-compose.yml`
(Postgres, API, web frontend, optional Adminer).

See the [root README](../README.md) for the full overview, configuration and API reference.

## Structure

- `Application/` — services (Steam/EGS sync, stats, crypto, workspaces), entities, EF Core migrations.
- `SteamEGSAggregator/` — Web API host: controllers, middlewares (`X-Workspace-Token` scoping), `Program.cs`.

Key services:

| Service | Responsibility |
|---------|----------------|
| `SteamService` | Library sync (GetOwnedGames), profile validation, recent games, achievements, store region |
| `EpicGamesService` | OAuth (code / launcher import), library+catalog sync, playtime, store-link resolution, region |
| `GameWriter` | Merges entries from both stores into one game by normalized title |
| `LibraryService` / `WorkspaceService` | Combined library, workspace tokens (SHA-256 hashes only) |
| `CryptoService` | AES-GCM encryption of stored secrets (`Security:EncryptionKey`) |

## Quick reference

```bash
# from this folder
cp .env.example .env          # set SECURITY_ENCRYPTION_KEY (openssl rand -base64 32)
docker compose up -d --build  # db + api + web frontend

# Optional: Adminer (DB UI at :8090) for local development
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

Run the backend on the host (needed for the EGS "import from installed launcher" flow):

```bash
docker compose up -d db
cp SteamEGSAggregator/appsettings.Development.json.example SteamEGSAggregator/appsettings.Development.json
dotnet run --project SteamEGSAggregator/SteamEGSAggregator.csproj   # → http://localhost:5080
```

Migrations apply automatically on startup; manually:

```bash
dotnet ef database update \
  --project Application/SteamEGSAggregator.Application.csproj \
  --startup-project SteamEGSAggregator/SteamEGSAggregator.csproj
```
