namespace SteamEGSAggregator.Application.Models.Entities;

public enum GameSource
{
    Steam = 0,
    Epic = 1
}

/// <summary>
/// A single game that merges entries from different stores by normalized title.
/// The per-source entries live in <see cref="Entries"/>.
/// </summary>
public class Game
{
    public int Id { get; set; }

    /// <summary>Owner (workspace).</summary>
    public Guid WorkspaceId { get; set; }

    /// <summary>Display title (taken from the first source).</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>Source-matching key: lowercase + letters/digits only.</summary>
    public string NormalizedTitle { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }

    public List<GameEntry> Entries { get; set; } = new();
}
