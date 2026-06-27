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
            await gameWriter.UpsertAsync(
                GameSource.Steam,
                s.AppId.ToString(),
                s.Name ?? $"App {s.AppId}",
                string.IsNullOrEmpty(s.FullIconUrl) ? null : s.FullIconUrl,
                storeUrl: $"https://store.steampowered.com/app/{s.AppId}",
                s.PlaytimeForever,
                ns: null,
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
            PersonaName = row?.PersonaName
        };
    }

    public async Task<SteamAccountDto> SaveCredentialsAsync(SteamCredentialsRequest request, CancellationToken ct)
    {
        var apiKey = request.ApiKey?.Trim() ?? "";
        var steamId = request.SteamId?.Trim() ?? "";
        if (string.IsNullOrEmpty(apiKey) || string.IsNullOrEmpty(steamId))
            throw new InvalidOperationException("Provide both the API key and SteamId.");

        var personaName = await FetchPersonaNameAsync(apiKey, steamId, ct);

        var creds = await db.SteamCredentials.FirstOrDefaultAsync(c => c.WorkspaceId == workspace.WorkspaceId, ct)
                    ?? new SteamCredentials { WorkspaceId = workspace.WorkspaceId };
        creds.ApiKey = crypto.Encrypt(apiKey);
        creds.SteamId = steamId;
        creds.PersonaName = personaName;
        creds.UpdatedAt = DateTime.UtcNow;
        if (creds.Id == 0) db.SteamCredentials.Add(creds);
        await db.SaveChangesAsync(ct);

        return new SteamAccountDto { Configured = true, SteamId = steamId, PersonaName = personaName };
    }

    private async Task<(string apiKey, string steamId)?> GetCredentialsAsync(CancellationToken ct)
    {
        var row = await db.SteamCredentials.AsNoTracking()
            .FirstOrDefaultAsync(c => c.WorkspaceId == workspace.WorkspaceId, ct);
        if (row is null || string.IsNullOrEmpty(row.ApiKey) || string.IsNullOrEmpty(row.SteamId))
            return null;
        return (crypto.Decrypt(row.ApiKey), row.SteamId);
    }

    private async Task<string?> FetchPersonaNameAsync(string apiKey, string steamId, CancellationToken ct)
    {
        try
        {
            var url = "http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/" +
                      $"?key={apiKey}&steamids={steamId}";
            var client = httpClientFactory.CreateClient("steam");
            using var doc = await client.GetFromJsonAsync<JsonDocument>(url, ct);
            var players = doc?.RootElement.GetProperty("response").GetProperty("players");
            if (players is { ValueKind: JsonValueKind.Array } p && p.GetArrayLength() > 0)
                return p[0].TryGetProperty("personaname", out var pn) ? pn.GetString() : null;
            return null;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to fetch the Steam persona name (invalid key or SteamId?)");
            throw new InvalidOperationException("Failed to validate the Steam key. Check the API key and SteamId.");
        }
    }
}
