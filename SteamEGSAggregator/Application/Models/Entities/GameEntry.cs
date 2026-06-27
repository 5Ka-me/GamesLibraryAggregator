namespace SteamEGSAggregator.Application.Models.Entities;

/// <summary>A game entry in a specific store (Steam or EGS).</summary>
public class GameEntry
{
    public int Id { get; set; }

    public int GameId { get; set; }
    public Game Game { get; set; } = null!;

    public GameSource Source { get; set; }

    /// <summary>Steam appid (as a string) or EGS catalogItemId.</summary>
    public string ExternalId { get; set; } = string.Empty;

    public string? IconUrl { get; set; }

    /// <summary>Link to the game's store page.</summary>
    public string? StoreUrl { get; set; }

    /// <summary>Playtime in minutes (Steam); usually null for EGS.</summary>
    public int? PlaytimeMinutes { get; set; }

    /// <summary>EGS namespace.</summary>
    public string? Namespace { get; set; }

    public DateTime? AcquisitionDate { get; set; }

    public DateTime UpdatedAt { get; set; }
}
