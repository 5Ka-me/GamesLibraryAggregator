using SteamEGSAggregator.Application.Models.Entities;

namespace SteamEGSAggregator.Application.Models;

/// <summary>A game entry for a specific source (for the frontend).</summary>
public class GameEntryDto
{
    public string Source { get; set; } = string.Empty;
    public string? IconUrl { get; set; }
    public string? StoreUrl { get; set; }
    public string? Namespace { get; set; }
    public int? PlaytimeMinutes { get; set; }
    public DateTime? AcquisitionDate { get; set; }

    /// <summary>Protocol deep-link to launch the game via its native client.</summary>
    public string? LaunchUrl { get; set; }

    /// <summary>Protocol deep-link to install/download the game via its native client.</summary>
    public string? InstallUrl { get; set; }
}

/// <summary>A merged game: one or more sources (tags).</summary>
public class GameDto
{
    public string Title { get; set; } = string.Empty;

    /// <summary>Image from any source that has one.</summary>
    public string? IconUrl { get; set; }

    /// <summary>Source tags, e.g. ["Steam", "Epic"].</summary>
    public List<string> Sources { get; set; } = new();

    /// <summary>Per-source details (separate playtime, etc.).</summary>
    public List<GameEntryDto> Entries { get; set; } = new();

    public static GameDto FromEntity(Game g)
    {
        var entries = g.Entries
            .OrderBy(e => e.Source)
            .Select(e => new GameEntryDto
            {
                Source = e.Source.ToString(),
                IconUrl = e.IconUrl,
                StoreUrl = e.StoreUrl,
                Namespace = e.Namespace,
                PlaytimeMinutes = e.PlaytimeMinutes,
                AcquisitionDate = e.AcquisitionDate,
                LaunchUrl = BuildLaunchUrl(e),
                InstallUrl = BuildInstallUrl(e)
            })
            .ToList();

        return new GameDto
        {
            Title = g.Title,
            IconUrl = entries.FirstOrDefault(e => !string.IsNullOrEmpty(e.IconUrl))?.IconUrl,
            Sources = entries.Select(e => e.Source).Distinct().ToList(),
            Entries = entries
        };
    }

    // Native-client deep links (handled by the OS protocol handler when Steam/EGS is installed).
    private static string? BuildLaunchUrl(GameEntry e) => e.Source switch
    {
        GameSource.Steam => $"steam://rungameid/{e.ExternalId}",
        GameSource.Epic => EpicAppsUri(e, "launch&silent=true"),
        _ => null
    };

    private static string? BuildInstallUrl(GameEntry e) => e.Source switch
    {
        GameSource.Steam => $"steam://install/{e.ExternalId}",
        GameSource.Epic => EpicAppsUri(e, "install"),
        _ => null
    };

    private static string? EpicAppsUri(GameEntry e, string action) =>
        string.IsNullOrEmpty(e.Namespace) || string.IsNullOrEmpty(e.AppName)
            ? null
            : $"com.epicgames.launcher://apps/{e.Namespace}%3A{e.ExternalId}%3A{e.AppName}?action={action}";
}
