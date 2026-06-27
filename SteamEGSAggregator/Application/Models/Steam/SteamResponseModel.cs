using System.Text.Json.Serialization;

namespace SteamEGSAggregator.Application.Models.Steam
{
    public class SteamResponseModel
    {
        [JsonPropertyName("response")]
        public SteamOwnedGamesResponseModel? Response { get; set; }
    }
}
