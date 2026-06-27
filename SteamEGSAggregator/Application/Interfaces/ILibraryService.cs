using SteamEGSAggregator.Application.Models;

namespace Application.Interfaces
{
    public interface ILibraryService : IGenericService
    {
        /// <summary>Combined library (Steam + EGS) from the DB.</summary>
        Task<List<GameDto>> GetCombinedLibraryAsync(CancellationToken ct);
    }
}
