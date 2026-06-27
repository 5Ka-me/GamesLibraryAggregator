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
}
