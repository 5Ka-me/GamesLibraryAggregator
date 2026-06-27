using System.Text.Json.Serialization;

namespace SteamEGSAggregator.Application.Models.EpicGames
{
    public class ResponseMetadataModel
    {
        [JsonPropertyName("nextCursor")]
        public string? NextCursor { get; set; }
    }
}
