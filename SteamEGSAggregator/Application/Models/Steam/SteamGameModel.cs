using System.Text.Json.Serialization;

namespace SteamEGSAggregator.Application.Models.Steam
{
    public class SteamGameModel
    {
        [JsonPropertyName("appid")]
        public int AppId { get; set; }

        [JsonPropertyName("name")]
        public string? Name { get; set; }

        [JsonPropertyName("playtime_forever")]
        public int PlaytimeForever { get; set; }

        [JsonPropertyName("img_icon_url")]
        public string? ImgIconUrl { get; set; }

        public string FullIconUrl => string.IsNullOrEmpty(ImgIconUrl)
            ? string.Empty
            : $"http://media.steampowered.com/steamcommunity/public/images/apps/{AppId}/{ImgIconUrl}.jpg";
    }
}
