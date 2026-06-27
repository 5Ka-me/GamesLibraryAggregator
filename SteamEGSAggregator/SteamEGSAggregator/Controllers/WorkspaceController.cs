using Application.Services;
using Microsoft.AspNetCore.Mvc;

namespace SteamEGSAggregator.Controllers;

[ApiController]
[Route("api/workspace")]
public class WorkspaceController(IWorkspaceService workspaces, IWorkspaceContext context) : ControllerBase
{
    /// <summary>Create a new workspace. Returns the secret token (shown only once).</summary>
    [HttpPost]
    public async Task<IActionResult> Create(CancellationToken ct)
    {
        var token = await workspaces.CreateAsync(ct);
        return Ok(new { token });
    }

    /// <summary>Validates the current token (the middleware has already let it through).</summary>
    [HttpGet("me")]
    public IActionResult Me() => Ok(new { workspaceId = context.WorkspaceId });
}
