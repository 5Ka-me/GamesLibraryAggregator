using System.Text.Json.Serialization;

namespace SteamEGSAggregator.Application.Models.EpicGames
{
    public class EpicLibraryResponseModel
    {
        [JsonPropertyName("records")]
        public List<LibraryItemModel> Records { get; set; } = new();

        [JsonPropertyName("responseMetadata")]
        public ResponseMetadataModel ResponseMetadata { get; set; }
    }
}
