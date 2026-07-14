using Application.Interfaces;
using Microsoft.AspNetCore.Mvc;
using SteamEGSAggregator.Application.Models;

namespace SteamEGSAggregator.Controllers;

[ApiController]
[Route("api/steam")]
public class SteamController(ISteamService steam) : ControllerBase
{
    /// <summary>Current Steam account (whether the key is configured, persona name).</summary>
    [HttpGet("account")]
    public async Task<ActionResult<SteamAccountDto>> Account(CancellationToken ct)
        => Ok(await steam.GetAccountAsync(ct));

    /// <summary>Save the Steam API key and SteamId (with validation).</summary>
    [HttpPost("credentials")]
    public async Task<ActionResult<SteamAccountDto>> SaveCredentials(
        [FromBody] SteamCredentialsRequest request, CancellationToken ct)
        => Ok(await steam.SaveCredentialsAsync(request, ct));

    /// <summary>Load the Steam library into the DB. Returns the number of games.</summary>
    [HttpPost("sync")]
    public async Task<ActionResult<object>> Sync(CancellationToken ct)
        => Ok(new { count = await steam.SyncLibraryAsync(ct) });

    /// <summary>Override the store region (ISO alpha-2) used for prices.</summary>
    [HttpPost("region")]
    public async Task<ActionResult<SteamAccountDto>> SetRegion(
        [FromBody] RegionRequest request, CancellationToken ct)
        => Ok(await steam.SetRegionAsync(request.Country, ct));

    /// <summary>Games played in the last 2 weeks.</summary>
    [HttpGet("recent")]
    public async Task<ActionResult<List<SteamRecentGameDto>>> Recent(CancellationToken ct)
        => Ok(await steam.GetRecentGamesAsync(ct));

    /// <summary>Player achievements for a game (+ global unlock rates).</summary>
    [HttpGet("achievements/{appId:int}")]
    public async Task<ActionResult<SteamGameAchievementsDto>> Achievements(
        int appId, [FromQuery] string? lang, CancellationToken ct)
        => Ok(await steam.GetAchievementsAsync(appId, lang, ct));
}
