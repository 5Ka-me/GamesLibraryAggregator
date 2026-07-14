using System.Net.Http.Json;
using System.Text.Json;
using Application.Interfaces;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using SteamEGSAggregator.Application.Data;
using SteamEGSAggregator.Application.Models;
using SteamEGSAggregator.Application.Models.Entities;
using SteamEGSAggregator.Application.Models.Steam;

namespace Application.Services;

public class SteamService(
    IHttpClientFactory httpClientFactory,
    AppDbContext db,
    IGameWriter gameWriter,
    ICryptoService crypto,
    IWorkspaceContext workspace,
    ILogger<SteamService> logger) : ISteamService
{
    public async Task<int> SyncLibraryAsync(CancellationToken ct)
    {
        var creds = await GetCredentialsAsync(ct);
        if (creds is null)
            throw new InvalidOperationException("Steam API key and SteamId are not set. Provide them on the settings page.");

        var (apiKey, steamId) = creds.Value;
        var url = "http://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/" +
                  $"?key={apiKey}&steamid={steamId}&format=json&include_appinfo=1&include_played_free_games=1";

        var client = httpClientFactory.CreateClient("steam");
        var response = await client.GetFromJsonAsync<SteamResponseModel>(url, ct);
        var games = response?.Response?.Games ?? new List<SteamGameModel>();
        logger.LogInformation("Steam: games received — {Count}", games.Count);

        foreach (var s in games)
        {
            // Tall library cover by CDN convention (same visual format as the EGS
            // covers). GetOwnedGames itself only provides a 32×32 icon; the UI
            // falls back to header.jpg for the rare app without library art.
            var cover = $"https://cdn.cloudflare.steamstatic.com/steam/apps/{s.AppId}/library_600x900.jpg";
            await gameWriter.UpsertAsync(
                GameSource.Steam,
                s.AppId.ToString(),
                s.Name ?? $"App {s.AppId}",
                cover,
                storeUrl: $"https://store.steampowered.com/app/{s.AppId}",
                s.PlaytimeForever,
                ns: null,
                appName: null,
                acquisitionDate: null,
                ct);
        }

        await db.SaveChangesAsync(ct);
        return games.Count;
    }

    public async Task<SteamAccountDto> GetAccountAsync(CancellationToken ct)
    {
        var row = await db.SteamCredentials.AsNoTracking()
            .FirstOrDefaultAsync(c => c.WorkspaceId == workspace.WorkspaceId, ct);

        return new SteamAccountDto
        {
            Configured = row is not null,
            SteamId = row?.SteamId,
            PersonaName = row?.PersonaName,
            Country = row?.Country
        };
    }

    public async Task<SteamAccountDto> SaveCredentialsAsync(SteamCredentialsRequest request, CancellationToken ct)
    {
        var apiKey = request.ApiKey?.Trim() ?? "";
        var steamId = request.SteamId?.Trim() ?? "";
        if (string.IsNullOrEmpty(apiKey) || string.IsNullOrEmpty(steamId))
            throw new InvalidOperationException("Provide both the API key and SteamId.");

        var (personaName, country) = await FetchProfileAsync(apiKey, steamId, ct);

        var creds = await db.SteamCredentials.FirstOrDefaultAsync(c => c.WorkspaceId == workspace.WorkspaceId, ct)
                    ?? new SteamCredentials { WorkspaceId = workspace.WorkspaceId };
        creds.ApiKey = crypto.Encrypt(apiKey);
        creds.SteamId = steamId;
        creds.PersonaName = personaName;
        // Detection never clobbers a manual override.
        if (string.IsNullOrEmpty(creds.Country) && !string.IsNullOrEmpty(country))
            creds.Country = country;
        creds.UpdatedAt = DateTime.UtcNow;
        if (creds.Id == 0) db.SteamCredentials.Add(creds);
        await db.SaveChangesAsync(ct);

        return new SteamAccountDto
        {
            Configured = true, SteamId = steamId, PersonaName = personaName, Country = creds.Country
        };
    }

    public async Task<SteamAccountDto> SetRegionAsync(string country, CancellationToken ct)
    {
        var normalized = NormalizeCountry(country);
        var creds = await db.SteamCredentials.FirstOrDefaultAsync(c => c.WorkspaceId == workspace.WorkspaceId, ct)
                    ?? throw new InvalidOperationException("Save the Steam credentials first.");
        creds.Country = normalized;
        creds.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return new SteamAccountDto
        {
            Configured = true, SteamId = creds.SteamId, PersonaName = creds.PersonaName, Country = creds.Country
        };
    }

    internal static string NormalizeCountry(string country)
    {
        var c = country.Trim().ToUpperInvariant();
        if (c.Length != 2 || c.Any(ch => ch is < 'A' or > 'Z'))
            throw new InvalidOperationException("Country must be a 2-letter ISO code (e.g. UA, KZ, US).");
        return c;
    }

    public async Task<List<SteamRecentGameDto>> GetRecentGamesAsync(CancellationToken ct)
    {
        var creds = await GetCredentialsAsync(ct);
        if (creds is null)
            throw new InvalidOperationException("Steam API key and SteamId are not set. Provide them on the settings page.");

        var (apiKey, steamId) = creds.Value;
        var url = "http://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v0001/" +
                  $"?key={apiKey}&steamid={steamId}&format=json";

        var client = httpClientFactory.CreateClient("steam");
        var response = await client.GetFromJsonAsync<SteamResponseModel>(url, ct);
        var games = response?.Response?.Games ?? new List<SteamGameModel>();

        return games.Select(g => new SteamRecentGameDto
        {
            AppId = g.AppId,
            Name = g.Name ?? $"App {g.AppId}",
            Playtime2Weeks = g.Playtime2Weeks ?? 0,
            PlaytimeForever = g.PlaytimeForever,
            IconUrl = string.IsNullOrEmpty(g.FullIconUrl) ? null : g.FullIconUrl
        }).ToList();
    }

    public async Task<SteamGameAchievementsDto> GetAchievementsAsync(int appId, string? lang, CancellationToken ct)
    {
        var creds = await GetCredentialsAsync(ct);
        if (creds is null)
            throw new InvalidOperationException("Steam API key and SteamId are not set. Provide them on the settings page.");

        var (apiKey, steamId) = creds.Value;
        var l = lang == "ru" ? "russian" : "english";
        var client = httpClientFactory.CreateClient("steam");

        // 1) Player state. Games without achievements (or private stats) return success=false / 400.
        JsonDocument playerDoc;
        try
        {
            playerDoc = (await client.GetFromJsonAsync<JsonDocument>(
                "http://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/" +
                $"?appid={appId}&key={apiKey}&steamid={steamId}&l={l}", ct))!;
        }
        catch
        {
            return new SteamGameAchievementsDto { Available = false };
        }

        using var player = playerDoc;
        var stats = player.RootElement.GetProperty("playerstats");
        if (!stats.TryGetProperty("success", out var ok) || !ok.GetBoolean() ||
            !stats.TryGetProperty("achievements", out var playerAch) ||
            playerAch.ValueKind != JsonValueKind.Array)
        {
            return new SteamGameAchievementsDto { Available = false };
        }

        // 2) Schema (names/descriptions/icons) + 3) global unlock rates — best effort.
        var schema = new Dictionary<string, (string? name, string? desc, string? icon, string? gray)>(
            StringComparer.OrdinalIgnoreCase);
        try
        {
            using var doc = await client.GetFromJsonAsync<JsonDocument>(
                "http://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/" +
                $"?key={apiKey}&appid={appId}&l={l}", ct);
            if (doc!.RootElement.TryGetProperty("game", out var game) &&
                game.TryGetProperty("availableGameStats", out var ags) &&
                ags.TryGetProperty("achievements", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var a in arr.EnumerateArray())
                {
                    var name = a.GetProperty("name").GetString();
                    if (name is null) continue;
                    schema[name] = (
                        a.TryGetProperty("displayName", out var dn) ? dn.GetString() : null,
                        a.TryGetProperty("description", out var de) ? de.GetString() : null,
                        a.TryGetProperty("icon", out var ic) ? ic.GetString() : null,
                        a.TryGetProperty("icongray", out var ig) ? ig.GetString() : null);
                }
            }
        }
        catch { /* schema is optional */ }

        var globalPct = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using var doc = await client.GetFromJsonAsync<JsonDocument>(
                "http://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/" +
                $"?gameid={appId}", ct);
            if (doc!.RootElement.TryGetProperty("achievementpercentages", out var ap) &&
                ap.TryGetProperty("achievements", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var a in arr.EnumerateArray())
                {
                    var name = a.GetProperty("name").GetString();
                    if (name is null || !a.TryGetProperty("percent", out var p)) continue;
                    // percent arrives as number or string depending on the game
                    var pct = p.ValueKind == JsonValueKind.String
                        ? double.TryParse(p.GetString(), System.Globalization.CultureInfo.InvariantCulture, out var d) ? d : 0
                        : p.GetDouble();
                    globalPct[name] = pct;
                }
            }
        }
        catch { /* global stats are optional */ }

        var result = new SteamGameAchievementsDto
        {
            Available = true,
            GameName = stats.TryGetProperty("gameName", out var gn) ? gn.GetString() : null
        };

        foreach (var a in playerAch.EnumerateArray())
        {
            var apiName = a.GetProperty("apiname").GetString() ?? "";
            var unlocked = a.TryGetProperty("achieved", out var ach) && ach.GetInt32() == 1;
            var unlockTs = a.TryGetProperty("unlocktime", out var ut) ? ut.GetInt64() : 0;
            var meta = schema.TryGetValue(apiName, out var s) ? s : default;

            result.Achievements.Add(new SteamAchievementDto
            {
                Name = apiName,
                DisplayName = meta.name ?? apiName,
                Description = meta.desc,
                Icon = meta.icon,
                IconGray = meta.gray,
                Unlocked = unlocked,
                UnlockTime = unlockTs > 0 ? DateTimeOffset.FromUnixTimeSeconds(unlockTs).UtcDateTime : null,
                GlobalPct = globalPct.TryGetValue(apiName, out var pct) ? pct : null
            });
        }

        result.Total = result.Achievements.Count;
        result.Unlocked = result.Achievements.Count(x => x.Unlocked);
        // Rarest first among unlocked? Keep schema order but surface unlocked count; UI sorts as needed.
        return result;
    }

    private async Task<(string apiKey, string steamId)?> GetCredentialsAsync(CancellationToken ct)
    {
        var row = await db.SteamCredentials.AsNoTracking()
            .FirstOrDefaultAsync(c => c.WorkspaceId == workspace.WorkspaceId, ct);
        if (row is null || string.IsNullOrEmpty(row.ApiKey) || string.IsNullOrEmpty(row.SteamId))
            return null;
        return (crypto.Decrypt(row.ApiKey), row.SteamId);
    }

    private async Task<(string? personaName, string? country)> FetchProfileAsync(
        string apiKey, string steamId, CancellationToken ct)
    {
        try
        {
            var url = "http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/" +
                      $"?key={apiKey}&steamids={steamId}";
            var client = httpClientFactory.CreateClient("steam");
            using var doc = await client.GetFromJsonAsync<JsonDocument>(url, ct);
            var players = doc?.RootElement.GetProperty("response").GetProperty("players");
            if (players is { ValueKind: JsonValueKind.Array } p && p.GetArrayLength() > 0)
            {
                var name = p[0].TryGetProperty("personaname", out var pn) ? pn.GetString() : null;
                // Profile country — user-set and optional, so it's only a default.
                var country = p[0].TryGetProperty("loccountrycode", out var cc) ? cc.GetString() : null;
                return (name, country);
            }
            return (null, null);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to fetch the Steam persona name (invalid key or SteamId?)");
            throw new InvalidOperationException("Failed to validate the Steam key. Check the API key and SteamId.");
        }
    }
}
