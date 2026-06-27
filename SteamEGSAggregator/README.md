# SteamEGSAggregator — backend

ASP.NET Core (.NET 9) Web API + EF Core + PostgreSQL. This folder also holds `docker-compose.yml`
(Postgres, API, frontend, Adminer).

See the [root README](../README.md) for the full overview, setup, configuration and API reference.

## Quick reference

```bash
# from this folder
cp .env.example .env          # set SECURITY_ENCRYPTION_KEY (openssl rand -base64 32)
docker compose up -d --build  # db + api + frontend

# Optional: add Adminer (DB UI at :8090) for local development
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

Run the backend on the host (needed for EGS launcher import / option B):

```bash
cp SteamEGSAggregator/appsettings.Development.json.example SteamEGSAggregator/appsettings.Development.json
dotnet run --project SteamEGSAggregator/SteamEGSAggregator.csproj
```
