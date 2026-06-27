namespace SteamEGSAggregator.Application.Configuration;

public class EpicGamesOptions
{
    public static string SectionName = "EpicGames";

    public string ClientId { get; set; } = string.Empty;
    public string ClientSecret { get; set; } = string.Empty;
    public string LibraryHost { get; set; } = string.Empty;
    public string AuthTokenHost { get; set; } = string.Empty;
}
