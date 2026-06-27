using System.Text.Json.Serialization;

namespace SteamEGSAggregator.Application.Models.EpicGames
{
    public class LibraryItemModel
    {
        [JsonPropertyName("appName")]
        public string AppName { get; set; }

        [JsonPropertyName("catalogItemId")]
        public string CatalogItemId { get; set; }

        [JsonPropertyName("namespace")]
        public string Namespace { get; set; }

        [JsonPropertyName("country")]
        public string Country { get; set; }

        [JsonPropertyName("platform")]
        public List<string> Platform { get; set; }

        [JsonPropertyName("productId")]
        public string ProductId { get; set; }

        [JsonPropertyName("sandboxName")]
        public string SandboxName { get; set; }

        [JsonPropertyName("recordType")]
        public string RecordType { get; set; }

        [JsonPropertyName("acquisitionDate")]
        public string AcquisitionDate { get; set; }

        [JsonPropertyName("sandboxType")]
        public string SandboxType { get; set; } // Important for filtering
    }
}
