namespace SteamEGSAggregator.Application.Models;

/// <summary>A recently played Steam game (last 2 weeks).</summary>
public class SteamRecentGameDto
{
    public int AppId { get; set; }
    public string Name { get; set; } = string.Empty;
    public int Playtime2Weeks { get; set; }
    public int PlaytimeForever { get; set; }
    public string? IconUrl { get; set; }
}

/// <summary>One achievement of a game, merged from player state, schema and global stats.</summary>
public class SteamAchievementDto
{
    /// <summary>Internal api name (stable id).</summary>
    public string Name { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public string? IconGray { get; set; }
    public bool Unlocked { get; set; }
    public DateTime? UnlockTime { get; set; }
    /// <summary>Share of players worldwide who unlocked it (0–100).</summary>
    public double? GlobalPct { get; set; }
}

/// <summary>Player achievements for one game.</summary>
public class SteamGameAchievementsDto
{
    /// <summary>False when the game has no achievements or the data is unavailable (private profile).</summary>
    public bool Available { get; set; }
    public string? GameName { get; set; }
    public int Total { get; set; }
    public int Unlocked { get; set; }
    public List<SteamAchievementDto> Achievements { get; set; } = new();
}
