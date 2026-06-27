using Application.Interfaces;
using Microsoft.AspNetCore.Mvc;
using SteamEGSAggregator.Application.Models;

namespace SteamEGSAggregator.Controllers;

[ApiController]
[Route("api/library")]
public class LibraryController(
    ILibraryService library,
    ISteamService steam,
    IEpicGamesService egs,
    ILogger<LibraryController> logger) : ControllerBase
{
    /// <summary>Combined library (Steam + EGS) from the DB.</summary>
    [HttpGet]
    public async Task<ActionResult<List<GameDto>>> Get(CancellationToken ct)
        => Ok(await library.GetCombinedLibraryAsync(ct));

    /// <summary>Sync both sources (a failure in one doesn't block the other) and return the library.</summary>
    [HttpPost("sync")]
    public async Task<ActionResult<List<GameDto>>> Sync(CancellationToken ct)
    {
        try { await steam.SyncLibraryAsync(ct); }
        catch (Exception ex) { logger.LogWarning(ex, "Steam sync skipped"); }

        try { await egs.SyncLibraryAsync(ct); }
        catch (Exception ex) { logger.LogWarning(ex, "EGS sync skipped"); }

        return Ok(await library.GetCombinedLibraryAsync(ct));
    }
}
