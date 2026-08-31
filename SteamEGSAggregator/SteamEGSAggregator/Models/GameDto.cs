namespace SteamEGSAggregator.Models;

/// <summary>
/// One per-store entry of a game — the exact JSON shape the shared frontend
/// consumes (see packages/shared/src/api/client.ts). The web backend only
/// ever produces Steam entries; the Epic fields exist so the type stays
/// identical to what the launcher's local API and bridge serve.
/// </summary>
public class GameEntryDto
{
    public string Source { get; set; } = "Steam";
    public string? IconUrl { get; set; }
    public string? StoreUrl { get; set; }
    public string? Namespace { get; set; }
    public int? PlaytimeMinutes { get; set; }
    public DateTime? AcquisitionDate { get; set; }
    public string? LaunchUrl { get; set; }
    public string? InstallUrl { get; set; }
}

/// <summary>A game with its per-store entries (Steam-only on the web backend).</summary>
public class GameDto
{
    public string Title { get; set; } = string.Empty;
    public string? IconUrl { get; set; }
    public List<string> Sources { get; set; } = new();
    public List<GameEntryDto> Entries { get; set; } = new();

    public static GameDto SteamGame(long appId, string title, int? playtimeMinutes)
    {
        var entry = new GameEntryDto
        {
            Source = "Steam",
            // Vertical cover by CDN convention — same one the launcher stores.
            IconUrl = $"https://cdn.cloudflare.steamstatic.com/steam/apps/{appId}/library_600x900.jpg",
            StoreUrl = $"https://store.steampowered.com/app/{appId}",
            PlaytimeMinutes = playtimeMinutes,
            LaunchUrl = $"steam://rungameid/{appId}",
            InstallUrl = $"steam://install/{appId}",
        };
        return new GameDto
        {
            Title = title,
            IconUrl = entry.IconUrl,
            Sources = ["Steam"],
            Entries = [entry],
        };
    }
}
