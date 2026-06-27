namespace SteamEGSAggregator.Application.Models.EpicGames
{
    public class CatalogItemDetailsModel
    {
        public string CatalogItemId { get; set; } = string.Empty;
        public string Namespace { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string? ImageUrl { get; set; }
        public string? ProductSlug { get; set; }
        public DateTime? AcquisitionDate { get; set; }
        public bool IsDlc { get; set; } = false;
        public List<CategoryModel> Categories { get; set; } = new();
    }
}
