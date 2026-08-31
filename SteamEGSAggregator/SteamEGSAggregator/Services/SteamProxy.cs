using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using SteamEGSAggregator.Models;

namespace SteamEGSAggregator.Services;

/// <summary>Steam is not sharing the account's game details (private profile).</summary>
public class SteamProfilePrivateException() : Exception("Steam returned no games for this account.");

/// <summary>
/// Steam Web API proxy with the single server-side key. Responses are cached
/// in memory (stateless otherwise). The GameDto shape matches what the shared
/// frontend expects, so the same UI renders web and launcher data.
/// </summary>
public class SteamProxy(IHttpClientFactory httpFactory, IMemoryCache cache, IConfiguration config)
{
    private static readonly TimeSpan LibraryTtl = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan PersonaTtl = TimeSpan.FromHours(1);

    // One shared server-side key serves every visitor, so concurrent requests
    // for the same data must collapse into a single upstream call. Caching the
    // TASK (not the value) is what makes GetOrCreateAsync stampede-proof.
    private readonly ConcurrentDictionary<string, object> _locks = new();

    private HttpClient Http => httpFactory.CreateClient("steam");

    private string Key()
    {
        var key = config["Steam:ApiKey"];
        if (string.IsNullOrWhiteSpace(key))
        {
            throw new InvalidOperationException("Server Steam API key is not configured (STEAM_API_KEY).");
        }
        return key;
    }

    /// <summary>Cached fetch where concurrent callers share one upstream call.</summary>
    private Task<T> CachedAsync<T>(string key, TimeSpan ttl, Func<CancellationToken, Task<T>> fetch, CancellationToken ct)
    {
        if (cache.TryGetValue(key, out Task<T>? hit) && hit is not null) return hit;

        lock (_locks.GetOrAdd(key, _ => new object()))
        {
            if (cache.TryGetValue(key, out hit) && hit is not null) return hit;

            // Not linked to `ct`: the shared task must outlive the request that
            // happened to start it, otherwise one disconnect fails the others.
            var task = fetch(CancellationToken.None);
            cache.Set(key, task, ttl);
            // A failed lookup must not be cached — drop it so the next caller retries.
            _ = task.ContinueWith(t =>
            {
                if (t.IsFaulted || t.IsCanceled) cache.Remove(key);
                _locks.TryRemove(key, out _);
            }, TaskScheduler.Default);
            return task;
        }
    }

    /// <summary>Display name for the signed-in user; null when unavailable.</summary>
    public async Task<string?> GetPersonaAsync(string steamId, CancellationToken ct = default)
    {
        try
        {
            return await CachedAsync($"persona:{steamId}", PersonaTtl, async token =>
            {
                var url = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/" +
                          $"?key={Uri.EscapeDataString(Key())}&steamids={steamId}";
                using var doc = JsonDocument.Parse(await Http.GetStringAsync(url, token));
                if (!doc.RootElement.TryGetProperty("response", out var response) ||
                    !response.TryGetProperty("players", out var players) ||
                    players.GetArrayLength() == 0 ||
                    !players[0].TryGetProperty("personaname", out var name))
                {
                    return null;
                }
                return name.GetString();
            }, ct);
        }
        catch
        {
            return null; // the persona is cosmetic — never fail a request over it
        }
    }

    /// <summary>The user's Steam library, mapped to the shared game shape.</summary>
    public Task<List<GameDto>> GetLibraryAsync(string steamId, CancellationToken ct = default) =>
        CachedAsync($"lib:{steamId}", LibraryTtl, token => FetchLibraryAsync(steamId, token), ct);

    private async Task<List<GameDto>> FetchLibraryAsync(string steamId, CancellationToken ct)
    {
        var url = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/" +
                  $"?key={Uri.EscapeDataString(Key())}&steamid={steamId}" +
                  "&include_appinfo=true&include_played_free_games=true&format=json";
        using var res = await Http.GetAsync(url, ct);
        if (!res.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"Steam API failed: HTTP {(int)res.StatusCode}");
        }

        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
        // GetOwnedGames answers an empty object for private profiles (and for
        // genuinely empty accounts — Steam doesn't distinguish the two).
        if (!doc.RootElement.TryGetProperty("response", out var response) ||
            !response.TryGetProperty("games", out var games) ||
            games.ValueKind != JsonValueKind.Array)
        {
            throw new SteamProfilePrivateException();
        }

        var list = new List<GameDto>();
        foreach (var g in games.EnumerateArray())
        {
            // One malformed entry must not fail the whole library.
            if (!g.TryGetProperty("appid", out var appIdEl) || !appIdEl.TryGetInt64(out var appId)) continue;
            var name = g.TryGetProperty("name", out var n) ? n.GetString() : null;
            var minutes = g.TryGetProperty("playtime_forever", out var pt) && pt.TryGetInt32(out var m)
                ? m
                : (int?)null;
            list.Add(GameDto.SteamGame(appId, string.IsNullOrWhiteSpace(name) ? $"App {appId}" : name, minutes));
        }
        return list.OrderBy(g => g.Title, StringComparer.OrdinalIgnoreCase).ToList();
    }
}
