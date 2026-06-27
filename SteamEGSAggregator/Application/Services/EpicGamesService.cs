using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Application.Interfaces;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using SteamEGSAggregator.Application.Configuration;
using SteamEGSAggregator.Application.Data;
using SteamEGSAggregator.Application.Models;
using SteamEGSAggregator.Application.Models.EpicGames;
using SteamEGSAggregator.Application.Models.Entities;

namespace Application.Services;

public class EpicGamesService(
    EpicGamesOptions options,
    IHttpClientFactory httpClientFactory,
    AppDbContext db,
    IGameWriter gameWriter,
    ICryptoService crypto,
    IWorkspaceContext workspace,
    ILogger<EpicGamesService> logger) : IEpicGamesService
{
    private const string CatalogHost = "catalog-public-service-prod06.ol.epicgames.com";
    private const string UserAgent = "UELauncher/14.0.8-22004686+++Portal+Release-Live Windows/10.0.19041.1.256.64bit";

    // ===================== Flow A: manual code paste =====================

    public string GetLoginUrl()
    {
        var redirect = Uri.EscapeDataString(
            $"https://www.epicgames.com/id/api/redirect?clientId={options.ClientId}&responseType=code");
        return $"https://www.epicgames.com/id/login?redirectUrl={redirect}";
    }

    public async Task<EpicAuthResultModel> AuthenticateWithCodeAsync(string authorizationCode, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(authorizationCode))
            return RequireLogin("Empty authorizationCode.");

        var token = await ExchangeAsync(new[]
        {
            new KeyValuePair<string, string>("grant_type", "authorization_code"),
            new KeyValuePair<string, string>("code", authorizationCode.Trim()),
            new KeyValuePair<string, string>("token_type", "eg1"),
        }, ct);

        await SaveSessionAsync(token, ct);
        return await SyncWithTokenAsync(token, ct);
    }

    // ===================== Flow B: import from installed EGL =====================

    public async Task<EpicAuthResultModel> ImportFromLauncherAsync(CancellationToken ct)
    {
        if (!OperatingSystem.IsWindows())
            return RequireLogin("Importing from the launcher is only available on Windows. Use the code login instead.");

        string refreshToken;
        try
        {
            refreshToken = ReadLauncherRefreshToken();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not read the login from Epic Games Launcher");
            return RequireLogin(
                "Could not find a saved login in the installed Epic Games Launcher. " +
                "Make sure the launcher is installed and you are signed in, or use the code login instead.");
        }

        EpicAuthResponseModel token;
        try
        {
            token = await RefreshAsync(refreshToken, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Imported token was rejected by Epic");
            return RequireLogin("The token imported from the launcher is invalid. Use the code login instead.");
        }

        await SaveSessionAsync(token, ct);
        return await SyncWithTokenAsync(token, ct);
    }

    /// <summary>
    /// Reads the refresh token from the GameUserSettings.ini of the installed Epic Games Launcher.
    /// The [RememberMe]/Data blob is encrypted with Windows DPAPI under the current user.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static string ReadLauncherRefreshToken()
    {
        var iniPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EpicGamesLauncher", "Saved", "Config", "Windows", "GameUserSettings.ini");

        if (!File.Exists(iniPath))
            throw new FileNotFoundException("GameUserSettings.ini not found", iniPath);

        // Minimal INI parsing: find the Data= line in the [RememberMe] section.
        string? base64 = null;
        var inSection = false;
        foreach (var raw in File.ReadLines(iniPath))
        {
            var line = raw.Trim();
            if (line.StartsWith('['))
            {
                inSection = line.Equals("[RememberMe]", StringComparison.OrdinalIgnoreCase);
                continue;
            }
            if (inSection && line.StartsWith("Data=", StringComparison.OrdinalIgnoreCase))
            {
                base64 = line["Data=".Length..].Trim().Trim('"');
                break;
            }
        }

        if (string.IsNullOrEmpty(base64))
            throw new InvalidOperationException("The [RememberMe]/Data section is empty — no saved launcher login.");

        var encrypted = Convert.FromBase64String(base64);
        var decrypted = ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser);
        var json = Encoding.UTF8.GetString(decrypted);

        using var doc = JsonDocument.Parse(json);
        // Structure: [ { "Region": "...", "Email": "...", "Token": "<refresh>" } ]
        var root = doc.RootElement;
        var entry = root.ValueKind == JsonValueKind.Array ? root[0] : root;
        var refresh = entry.GetProperty("Token").GetString();

        if (string.IsNullOrEmpty(refresh))
            throw new InvalidOperationException("The saved login has no Token.");

        return refresh;
    }

    // ===================== Sync using the saved session =====================

    public async Task<EpicAuthResultModel> SyncLibraryAsync(CancellationToken ct)
    {
        var accessToken = await GetValidAccessTokenAsync(ct);
        if (accessToken is null)
            return RequireLogin("No valid EGS session. Sign in with a code or import from the launcher.");

        var session = await db.EpicSessions.AsNoTracking()
            .FirstOrDefaultAsync(s => s.WorkspaceId == workspace.WorkspaceId, ct);
        var count = await FetchAndStoreLibraryAsync(accessToken, ct);
        return new EpicAuthResultModel
        {
            Success = true,
            DisplayName = session?.DisplayName,
            GameCount = count
        };
    }

    public async Task<EpicAccountDto> GetAccountAsync(CancellationToken ct)
    {
        var session = await db.EpicSessions.AsNoTracking()
            .FirstOrDefaultAsync(s => s.WorkspaceId == workspace.WorkspaceId, ct);
        var connected = session is not null && session.RefreshExpiresAt > DateTime.UtcNow;
        return new EpicAccountDto
        {
            Connected = connected,
            DisplayName = session?.DisplayName
        };
    }

    private async Task<EpicAuthResultModel> SyncWithTokenAsync(EpicAuthResponseModel token, CancellationToken ct)
    {
        var count = await FetchAndStoreLibraryAsync(token.AccessToken, ct);
        return new EpicAuthResultModel
        {
            Success = true,
            DisplayName = token.DisplayName,
            GameCount = count
        };
    }

    /// <summary>Returns a valid access token from the DB (refreshing it when needed), or null.</summary>
    private async Task<string?> GetValidAccessTokenAsync(CancellationToken ct)
    {
        var session = await db.EpicSessions.FirstOrDefaultAsync(s => s.WorkspaceId == workspace.WorkspaceId, ct);
        if (session is null) return null;

        var now = DateTime.UtcNow;
        if (session.AccessExpiresAt > now.AddSeconds(60))
            return crypto.Decrypt(session.AccessToken);

        if (session.RefreshExpiresAt <= now)
            return null; // refresh token expired — re-login required

        try
        {
            var refreshed = await RefreshAsync(crypto.Decrypt(session.RefreshToken), ct);
            await SaveSessionAsync(refreshed, ct);
            return refreshed.AccessToken;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to refresh the EGS token");
            return null;
        }
    }

    // ===================== OAuth helpers =====================

    private Task<EpicAuthResponseModel> RefreshAsync(string refreshToken, CancellationToken ct) =>
        ExchangeAsync(new[]
        {
            new KeyValuePair<string, string>("grant_type", "refresh_token"),
            new KeyValuePair<string, string>("refresh_token", refreshToken),
            new KeyValuePair<string, string>("token_type", "eg1"),
        }, ct);

    private async Task<EpicAuthResponseModel> ExchangeAsync(
        IEnumerable<KeyValuePair<string, string>> form, CancellationToken ct)
    {
        var client = httpClientFactory.CreateClient("epic");

        var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{options.ClientId}:{options.ClientSecret}"));
        using var request = new HttpRequestMessage(HttpMethod.Post, options.AuthTokenHost)
        {
            Content = new FormUrlEncodedContent(form)
        };
        request.Headers.TryAddWithoutValidation("Authorization", $"Basic {basic}");

        var response = await client.SendAsync(request, ct);
        var content = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Epic auth failed ({(int)response.StatusCode}): {content}");

        var result = JsonSerializer.Deserialize<EpicAuthResponseModel>(content)
                     ?? throw new InvalidOperationException("Empty response from Epic during token exchange.");
        return result;
    }

    private async Task SaveSessionAsync(EpicAuthResponseModel token, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var session = await db.EpicSessions.FirstOrDefaultAsync(s => s.WorkspaceId == workspace.WorkspaceId, ct)
                      ?? new EpicSession { WorkspaceId = workspace.WorkspaceId };

        session.AccountId = token.AccountId;
        session.DisplayName = token.DisplayName ?? session.DisplayName;
        session.AccessToken = crypto.Encrypt(token.AccessToken);
        session.RefreshToken = crypto.Encrypt(token.RefreshToken);
        session.AccessExpiresAt = (token.ExpiresAt ?? now.AddSeconds(token.ExpiresIn)).ToUniversalTime();
        session.RefreshExpiresAt = (token.RefreshExpiresAt ?? now.AddSeconds(token.RefreshExpires)).ToUniversalTime();
        session.UpdatedAt = now;

        if (session.Id == 0) db.EpicSessions.Add(session);
        await db.SaveChangesAsync(ct);
    }

    // ===================== Library + catalog =====================

    private async Task<int> FetchAndStoreLibraryAsync(string accessToken, CancellationToken ct)
    {
        var rawItems = await FetchRawLibraryAsync(accessToken, ct);
        logger.LogInformation("EGS: library records received — {Count}", rawItems.Count);

        var client = httpClientFactory.CreateClient("epic");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

        var count = 0;
        var seen = new HashSet<string>();

        foreach (var item in rawItems)
        {
            if (item.Namespace == "ue") continue;                 // Unreal Engine
            if (item.SandboxType == "PRIVATE") continue;          // private betas/alphas
            if (string.IsNullOrEmpty(item.CatalogItemId)) continue;
            if (!seen.Add(item.CatalogItemId)) continue;          // one game may appear in several records

            try
            {
                var details = await GetCatalogDetailsAsync(client, item, ct);
                if (details is null) continue;
                if (details.IsDlc) continue;
                if (details.Categories.Any(c =>
                        string.Equals(c.Path, "mods", StringComparison.OrdinalIgnoreCase)))
                    continue;

                // The store page link is resolved lazily on click (see GetStoreUrlAsync),
                // to avoid hitting Cloudflare with a burst of hundreds of requests.
                await gameWriter.UpsertAsync(
                    GameSource.Epic, details.CatalogItemId, details.Title,
                    details.ImageUrl, storeUrl: null, playtimeMinutes: null,
                    details.Namespace, details.AcquisitionDate, ct);
                count++;
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "EGS: skipping item {Id}", item.CatalogItemId);
            }
        }

        await db.SaveChangesAsync(ct);
        logger.LogInformation("EGS: games stored — {Count}", count);
        return count;
    }

    private async Task<List<LibraryItemModel>> FetchRawLibraryAsync(string token, CancellationToken ct)
    {
        var client = httpClientFactory.CreateClient("epic");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        var all = new List<LibraryItemModel>();
        string? cursor = null;

        do
        {
            var url = $"https://{options.LibraryHost}/library/api/public/items?includeMetadata=true";
            if (!string.IsNullOrEmpty(cursor)) url += $"&cursor={cursor}";

            var page = await client.GetFromJsonAsync<EpicLibraryResponseModel>(url, ct);
            if (page?.Records is { Count: > 0 }) all.AddRange(page.Records);
            cursor = page?.ResponseMetadata?.NextCursor;
        } while (!string.IsNullOrEmpty(cursor));

        return all;
    }

    private async Task<CatalogItemDetailsModel?> GetCatalogDetailsAsync(
        HttpClient client, LibraryItemModel item, CancellationToken ct)
    {
        var url = $"https://{CatalogHost}/catalog/api/shared/namespace/{item.Namespace}/items/{item.CatalogItemId}" +
                  "?includeMainGameDetails=true&country=US&locale=en-US";

        using var doc = await client.GetFromJsonAsync<JsonDocument>(url, ct);
        if (doc is null) return null;
        var root = doc.RootElement;

        var details = new CatalogItemDetailsModel
        {
            CatalogItemId = item.CatalogItemId,
            Namespace = item.Namespace,
            Title = root.TryGetProperty("title", out var t) ? t.GetString() ?? "" : "",
            AcquisitionDate = ParseDate(item.AcquisitionDate)
        };

        if (root.TryGetProperty("categories", out var cats) && cats.ValueKind == JsonValueKind.Array)
            foreach (var c in cats.EnumerateArray())
                if (c.TryGetProperty("path", out var p))
                    details.Categories.Add(new CategoryModel { Path = p.GetString() ?? "" });

        if (root.TryGetProperty("mainGameItem", out var mg) && mg.ValueKind != JsonValueKind.Null)
            details.IsDlc = true;

        if (root.TryGetProperty("keyImages", out var images) && images.ValueKind == JsonValueKind.Array)
            details.ImageUrl = ResizeEpicImage(PickImage(images));

        return details;
    }

    /// <summary>Shrinks the original EGS images (often 1-3 MB) to card size — they load much faster.</summary>
    private static string? ResizeEpicImage(string? url)
    {
        if (string.IsNullOrEmpty(url)) return null;
        if (!url.Contains("epicgames.com")) return url;
        if (url.Contains('?')) return url; // already has query params
        return $"{url}?h=400&w=300&resize=1&quality=medium";
    }

    /// <summary>
    /// Lazily resolves the EGS store page link (on click): a single Store GraphQL request per namespace,
    /// the result is cached in the DB (on every entry of that namespace in the current workspace).
    /// On failure — a search-by-title link (not cached, so it is retried later).
    /// </summary>
    public async Task<string> GetStoreUrlAsync(string ns, string title, CancellationToken ct)
    {
        var fallback = $"https://store.epicgames.com/en-US/browse?q={Uri.EscapeDataString(title)}&sortBy=relevancy&sortDir=DESC";

        // Already resolved before?
        var existing = await db.GameEntries
            .Where(e => e.Source == GameSource.Epic && e.Namespace == ns && e.StoreUrl != null
                        && e.Game.WorkspaceId == workspace.WorkspaceId)
            .Select(e => e.StoreUrl)
            .FirstOrDefaultAsync(ct);
        if (!string.IsNullOrEmpty(existing)) return existing;

        string? slug = null;
        try
        {
            slug = await FetchStoreSlugAsync(ns, title, ct);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "EGS slug: failed to resolve for namespace {Ns}", ns);
        }

        if (slug is null) return fallback; // not cached — retried on the next click

        var url = $"https://store.epicgames.com/en-US/p/{slug}";
        var entries = await db.GameEntries
            .Where(e => e.Source == GameSource.Epic && e.Namespace == ns
                        && e.Game.WorkspaceId == workspace.WorkspaceId)
            .ToListAsync(ct);
        foreach (var e in entries) e.StoreUrl = url;
        await db.SaveChangesAsync(ct);

        return url;
    }

    // Store GraphQL is throttled by Cloudflare on request bursts (403). Space the calls out in time
    // (minimum interval between requests) + retries with increasing backoff.
    private static readonly SemaphoreSlim StoreGate = new(1, 1);
    private static DateTime _lastStoreCall = DateTime.MinValue;
    private const int MinSpacingMs = 350;

    private async Task<string?> FetchStoreSlugAsync(string ns, string title, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                await ThrottleAsync(attempt, ct);
                return await TryFetchSlugOnceAsync(ns, title, ct); // null = request ok, but no slug found
            }
            catch when (attempt < 3)
            {
                // transient error (403/timeout) — retry (the pause is applied in ThrottleAsync)
            }
        }
    }

    private static async Task ThrottleAsync(int attempt, CancellationToken ct)
    {
        await StoreGate.WaitAsync(ct);
        try
        {
            var sinceLast = DateTime.UtcNow - _lastStoreCall;
            var wait = MinSpacingMs + 500 * attempt - (int)sinceLast.TotalMilliseconds;
            if (wait > 0) await Task.Delay(wait, ct);
            _lastStoreCall = DateTime.UtcNow;
        }
        finally
        {
            StoreGate.Release();
        }
    }

    private async Task<string?> TryFetchSlugOnceAsync(string ns, string title, CancellationToken ct)
    {
        const string query =
            "query($ns:String!){Catalog{catalogOffers(namespace:$ns,params:{count:100}){elements{" +
            "title productSlug urlSlug offerMappings{pageSlug} catalogNs{mappings{pageSlug pageType}}}}}}";

        var client = httpClientFactory.CreateClient("epicstore");
        using var resp = await client.PostAsJsonAsync("graphql", new { query, variables = new { ns } }, ct);
        resp.EnsureSuccessStatusCode(); // non-2xx => exception => retry

        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
        if (!doc.RootElement.TryGetProperty("data", out var data)) return null;
        var elements = data.GetProperty("Catalog").GetProperty("catalogOffers").GetProperty("elements");
        if (elements.ValueKind != JsonValueKind.Array || elements.GetArrayLength() == 0) return null;

        var wantNorm = GameWriter.Normalize(title);

        JsonElement chosen = elements[0];
        foreach (var el in elements.EnumerateArray())
        {
            var t = el.TryGetProperty("title", out var te) ? te.GetString() : null;
            if (t != null && GameWriter.Normalize(t) == wantNorm) { chosen = el; break; }
        }

        // Priority: productHome mapping -> urlSlug -> productSlug -> any pageSlug.
        string? productHome = null, anyMapping = null;
        if (chosen.TryGetProperty("catalogNs", out var cns) && cns.ValueKind == JsonValueKind.Object &&
            cns.TryGetProperty("mappings", out var maps) && maps.ValueKind == JsonValueKind.Array)
        {
            foreach (var m in maps.EnumerateArray())
            {
                var ps = m.TryGetProperty("pageSlug", out var p) ? p.GetString() : null;
                if (string.IsNullOrEmpty(ps)) continue;
                anyMapping ??= ps;
                if (m.TryGetProperty("pageType", out var pt) && pt.GetString() == "productHome")
                {
                    productHome = ps;
                    break;
                }
            }
        }

        if (productHome != null) return productHome;
        if (chosen.TryGetProperty("urlSlug", out var us) && us.GetString() is { Length: > 0 } u) return u;
        if (chosen.TryGetProperty("productSlug", out var prs) && prs.GetString() is { Length: > 0 } pr)
            return pr.TrimEnd('/').Split('/')[0];
        return anyMapping;
    }

    private static string? PickImage(JsonElement images)
    {
        // Prefer "tall" cover art, then any available image.
        string[] preferred = ["DieselGameBoxTall", "OfferImageTall", "Thumbnail", "DieselGameBox", "OfferImageWide"];
        var byType = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var img in images.EnumerateArray())
        {
            if (img.TryGetProperty("type", out var ty) && img.TryGetProperty("url", out var u))
            {
                var type = ty.GetString();
                var url = u.GetString();
                if (!string.IsNullOrEmpty(type) && !string.IsNullOrEmpty(url))
                    byType[type] = url;
            }
        }
        foreach (var p in preferred)
            if (byType.TryGetValue(p, out var url)) return url;
        return byType.Values.FirstOrDefault();
    }

    private static DateTime? ParseDate(string? value) =>
        DateTime.TryParse(value, CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var dt)
            ? dt
            : null;

    private EpicAuthResultModel RequireLogin(string message) => new()
    {
        Success = false,
        RequiresLogin = true,
        LoginUrl = GetLoginUrl(),
        Message = message
    };
}
