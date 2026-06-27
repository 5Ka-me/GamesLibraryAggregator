using System.Text.Json.Serialization;

namespace SteamEGSAggregator.Application.Models.Steam
{
    public class SteamOwnedGamesResponseModel
    {
        [JsonPropertyName("game_count")]
        public int GameCount { get; set; }

        [JsonPropertyName("games")]
        public List<SteamGameModel> Games { get; set; } = new();
    }
}
