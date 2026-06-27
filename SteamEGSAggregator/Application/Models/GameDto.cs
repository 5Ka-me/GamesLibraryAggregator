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
                AcquisitionDate = e.AcquisitionDate
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
}
