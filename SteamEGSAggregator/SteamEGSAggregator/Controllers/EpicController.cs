using Application.Interfaces;
using Microsoft.AspNetCore.Mvc;
using SteamEGSAggregator.Application.Models;
using SteamEGSAggregator.Application.Models.EpicGames;

namespace SteamEGSAggregator.Controllers;

[ApiController]
[Route("api/epic")]
public class EpicController(IEpicGamesService egs) : ControllerBase
{
    public record AuthCodeRequest(string AuthorizationCode);

    /// <summary>Login link: open it in a browser and copy the authorizationCode from the JSON.</summary>
    [HttpGet("login-url")]
    public IActionResult GetLoginUrl() => Ok(new { loginUrl = egs.GetLoginUrl() });

    /// <summary>Current EGS account.</summary>
    [HttpGet("account")]
    public async Task<ActionResult<EpicAccountDto>> Account(CancellationToken ct)
        => Ok(await egs.GetAccountAsync(ct));

    /// <summary>Flow A: exchange the pasted code for tokens + sync the library.</summary>
    [HttpPost("auth")]
    public async Task<ActionResult<EpicAuthResultModel>> Auth(
        [FromBody] AuthCodeRequest body, CancellationToken ct)
        => Ok(await egs.AuthenticateWithCodeAsync(body.AuthorizationCode, ct));

    /// <summary>Flow B: import the login from the installed Epic Games Launcher.</summary>
    [HttpPost("import-launcher")]
    public async Task<ActionResult<EpicAuthResultModel>> ImportLauncher(CancellationToken ct)
        => Ok(await egs.ImportFromLauncherAsync(ct));

    /// <summary>Sync the library using the saved session.</summary>
    [HttpPost("sync")]
    public async Task<ActionResult<EpicAuthResultModel>> Sync(CancellationToken ct)
        => Ok(await egs.SyncLibraryAsync(ct));

    /// <summary>Exact link to the game's EGS store page (resolved on click, cached).</summary>
    [HttpGet("store-url")]
    public async Task<IActionResult> StoreUrl([FromQuery] string ns, [FromQuery] string title, CancellationToken ct)
        => Ok(new { url = await egs.GetStoreUrlAsync(ns, title, ct) });
}
