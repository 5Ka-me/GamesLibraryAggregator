using SteamEGSAggregator.Application.Models;

namespace Application.Interfaces
{
    public interface ISteamService : IGenericService
    {
        /// <summary>Load the Steam library and store it in the DB. Returns the number of games.</summary>
        Task<int> SyncLibraryAsync(CancellationToken ct);

        /// <summary>Current Steam account (whether the key is configured, persona name).</summary>
        Task<SteamAccountDto> GetAccountAsync(CancellationToken ct);

        /// <summary>Save the key/SteamId, validate them and fetch the persona name.</summary>
        Task<SteamAccountDto> SaveCredentialsAsync(SteamCredentialsRequest request, CancellationToken ct);
    }
}
