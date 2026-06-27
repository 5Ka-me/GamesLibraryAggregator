namespace SteamEGSAggregator.Application.Models.EpicGames
{
    /// <summary>Result of an EGS auth/sync attempt, returned to the frontend.</summary>
    public class EpicAuthResultModel
    {
        public bool Success { get; set; }

        /// <summary>true if user login is required (no valid session and import failed).</summary>
        public bool RequiresLogin { get; set; }

        public string? DisplayName { get; set; }

        public int GameCount { get; set; }

        /// <summary>Manual login link (flow A) — returned when RequiresLogin = true.</summary>
        public string? LoginUrl { get; set; }

        public string? Message { get; set; }
    }
}
