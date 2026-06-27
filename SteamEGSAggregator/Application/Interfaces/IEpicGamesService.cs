using SteamEGSAggregator.Application.Models;
using SteamEGSAggregator.Application.Models.EpicGames;

namespace Application.Interfaces
{
    public interface IEpicGamesService : IGenericService
    {
        /// <summary>Link used to obtain the authorizationCode (flow A).</summary>
        string GetLoginUrl();

        /// <summary>Flow A: exchange the authorizationCode for tokens + sync the library.</summary>
        Task<EpicAuthResultModel> AuthenticateWithCodeAsync(string authorizationCode, CancellationToken ct);

        /// <summary>Flow B: import the login from the installed Epic Games Launcher (Windows/DPAPI).</summary>
        Task<EpicAuthResultModel> ImportFromLauncherAsync(CancellationToken ct);

        /// <summary>Sync the library using the saved session (with auto-refresh).</summary>
        Task<EpicAuthResultModel> SyncLibraryAsync(CancellationToken ct);

        /// <summary>Current EGS account (whether connected, display name).</summary>
        Task<EpicAccountDto> GetAccountAsync(CancellationToken ct);

        /// <summary>Lazily resolves the exact EGS store page link by namespace (on click), cached in the DB.</summary>
        Task<string> GetStoreUrlAsync(string ns, string title, CancellationToken ct);
    }
}
