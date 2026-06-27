using System.Text.Json.Serialization;

namespace SteamEGSAggregator.Application.Models.EpicGames
{
    /// <summary>Epic response from /account/api/oauth/token.</summary>
    public class EpicAuthResponseModel
    {
        [JsonPropertyName("access_token")]
        public string AccessToken { get; set; } = string.Empty;

        [JsonPropertyName("refresh_token")]
        public string RefreshToken { get; set; } = string.Empty;

        [JsonPropertyName("expires_in")]
        public int ExpiresIn { get; set; }

        [JsonPropertyName("expires_at")]
        public DateTime? ExpiresAt { get; set; }

        [JsonPropertyName("refresh_expires")]
        public int RefreshExpires { get; set; }

        [JsonPropertyName("refresh_expires_at")]
        public DateTime? RefreshExpiresAt { get; set; }

        [JsonPropertyName("account_id")]
        public string AccountId { get; set; } = string.Empty;

        [JsonPropertyName("displayName")]
        public string? DisplayName { get; set; }
    }
}
