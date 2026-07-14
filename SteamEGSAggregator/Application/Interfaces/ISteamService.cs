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

        /// <summary>Override the store region (ISO alpha-2) used for prices.</summary>
        Task<SteamAccountDto> SetRegionAsync(string country, CancellationToken ct);

        /// <summary>Games played in the last 2 weeks.</summary>
        Task<List<SteamRecentGameDto>> GetRecentGamesAsync(CancellationToken ct);

        /// <summary>Player achievements for a game, merged with the schema and global unlock rates.</summary>
        Task<SteamGameAchievementsDto> GetAchievementsAsync(int appId, string? lang, CancellationToken ct);
    }
}
