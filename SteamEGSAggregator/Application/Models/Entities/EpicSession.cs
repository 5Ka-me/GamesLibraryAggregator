namespace SteamEGSAggregator.Application.Models.Entities;

/// <summary>
/// Saved EGS session. A single row is stored (the last successful login),
/// so it survives restarts and the access token is refreshed automatically using the refresh token.
/// </summary>
public class EpicSession
{
    public int Id { get; set; }

    public Guid WorkspaceId { get; set; }

    public string AccountId { get; set; } = string.Empty;

    public string? DisplayName { get; set; }

    public string AccessToken { get; set; } = string.Empty;

    public string RefreshToken { get; set; } = string.Empty;

    public DateTime AccessExpiresAt { get; set; }

    public DateTime RefreshExpiresAt { get; set; }

    public DateTime UpdatedAt { get; set; }
}
