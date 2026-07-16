namespace SteamEGSAggregator.Application.Models;

public class SteamAccountDto
{
    public bool Configured { get; set; }
    public string? SteamId { get; set; }
    public string? PersonaName { get; set; }
    /// <summary>Store region (ISO alpha-2) for prices; null → fallback US.</summary>
    public string? Country { get; set; }
}

public class EpicAccountDto
{
    public bool Connected { get; set; }
    public string? DisplayName { get; set; }
    /// <summary>Account country (ISO alpha-2) for prices; null → fallback US.</summary>
    public string? Country { get; set; }
}

/// <summary>Request to override a store region.</summary>
public class RegionRequest
{
    public string Country { get; set; } = string.Empty;
}

/// <summary>Request to save Steam credentials.</summary>
public class SteamCredentialsRequest
{
    public string ApiKey { get; set; } = string.Empty;
    public string SteamId { get; set; } = string.Empty;
}

/// <summary>
/// Library synced by the desktop launcher after a Steam web sign-in (no API key
/// on the server). The launcher fetched the games with its own session token
/// and hands the already-resolved list to the cloud DB.
/// </summary>
public class SteamExternalSyncRequest
{
    public string SteamId { get; set; } = string.Empty;
    public string? PersonaName { get; set; }
    public string? Country { get; set; }
    public List<ExternalGameDto> Games { get; set; } = new();
}

public class ExternalGameDto
{
    public int AppId { get; set; }
    public string? Name { get; set; }
    public int PlaytimeForever { get; set; }
}
