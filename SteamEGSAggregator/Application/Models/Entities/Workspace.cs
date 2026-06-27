namespace SteamEGSAggregator.Application.Models.Entities;

/// <summary>
/// An isolated workspace (one device/user).
/// Access is via a secret token; only its SHA-256 hash is stored in the DB.
/// </summary>
public class Workspace
{
    public Guid Id { get; set; }

    /// <summary>Base64(SHA-256(token)). The raw token is never stored.</summary>
    public string TokenHash { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; }
    public DateTime LastSeenAt { get; set; }
}
