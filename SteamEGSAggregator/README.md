# GL Aggregator — web backend

A **stateless** ASP.NET Core (.NET 9) proxy for the browser version of the library. No database:
the only state is the cookie-signing keys (a Docker volume) and an in-memory response cache.

See the [root README](../README.md) for the full overview and configuration.

## What it does

- **"Sign in through Steam"** — OpenID 2.0 (`/auth/steam/login` → `/auth/steam/callback`): proves
  the visitor's SteamID64 and sets a signed HTTP-only session cookie. The site never sees a
  password; users never enter API keys or tokens.
- **Steam library proxy** (`/api/library`) — `GetOwnedGames` with one **server-side** Steam Web API
  key, mapped to the same `GameDto` shape the desktop launcher uses. Requires public game details;
  cached in memory for 10 minutes per user.
- `/api/me`, `POST /auth/logout` — session info and sign-out.

Everything richer (EGS, playtime from both stores, installed state, achievements) comes from the
**desktop launcher's local bridge** when the launcher runs on the same machine — the web frontend
detects it and asks to connect; this backend is not involved in that path.

## Files

- `SteamEGSAggregator/Program.cs` — minimal API: auth endpoints, cookie configuration, CORS.
- `SteamEGSAggregator/Services/SteamOpenId.cs` — the two OpenID 2.0 steps (redirect + verification).
- `SteamEGSAggregator/Services/SteamProxy.cs` — Steam Web API calls + memory cache.
- `SteamEGSAggregator/Models/GameDto.cs` — the shared frontend's game shape (Steam entries only).

## Quick reference

```bash
# from this folder — docker (api + web frontend)
cp .env.example .env          # REQUIRED: set STEAM_API_KEY
docker compose up -d --build  # api :8080, web :3000
```

Run on the host instead:

```bash
cp SteamEGSAggregator/appsettings.Development.json.example SteamEGSAggregator/appsettings.Development.json
# put your Steam Web API key into Steam:ApiKey
dotnet run --project SteamEGSAggregator/SteamEGSAggregator.csproj   # → http://localhost:5080
```

| Setting | Env | Meaning |
|---|---|---|
| `Steam:ApiKey` | `STEAM_API_KEY` | **Required.** Server-side Steam Web API key. |
| `Web:Origin` | `WEB_ORIGIN` | Web-app origin (CORS with credentials + post-login redirect). |
| `PublicUrl` | `API_PUBLIC_URL` | Address the browser reaches this API at (OpenID return URL). |
| `DataProtection:KeysPath` | — | Dir for cookie-signing keys (Docker mounts a volume; empty = ephemeral). |
