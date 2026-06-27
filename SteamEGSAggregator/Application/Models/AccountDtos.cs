namespace SteamEGSAggregator.Application.Models;

public class SteamAccountDto
{
    public bool Configured { get; set; }
    public string? SteamId { get; set; }
    public string? PersonaName { get; set; }
}

public class EpicAccountDto
{
    public bool Connected { get; set; }
    public string? DisplayName { get; set; }
}

/// <summary>Request to save Steam credentials.</summary>
public class SteamCredentialsRequest
{
    public string ApiKey { get; set; } = string.Empty;
    public string SteamId { get; set; } = string.Empty;
}
