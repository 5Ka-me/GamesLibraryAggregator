namespace SteamEGSAggregator.Application.Models.Entities;

/// <summary>Steam credentials provided by the user via the UI (a single row).</summary>
public class SteamCredentials
{
    public int Id { get; set; }

    public Guid WorkspaceId { get; set; }

    public string ApiKey { get; set; } = string.Empty;
    public string SteamId { get; set; } = string.Empty;

    /// <summary>Steam persona name, fetched on save/sync.</summary>
    public string? PersonaName { get; set; }

    /// <summary>
    /// Store region (ISO 3166-1 alpha-2) used for storefront prices. Auto-filled
    /// from the profile's loccountrycode when empty; the user can override it.
    /// </summary>
    public string? Country { get; set; }

    public DateTime UpdatedAt { get; set; }
}
