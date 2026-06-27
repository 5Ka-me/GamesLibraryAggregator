using Application.Services;

namespace SteamEGSAggregator.Middlewares;

/// <summary>
/// Allows access to /api/* only with a valid workspace token
/// (X-Workspace-Token header or Authorization: Bearer). Exception — workspace creation.
/// </summary>
public class WorkspaceMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext ctx, IWorkspaceService workspaces, IWorkspaceContext context)
    {
        var path = ctx.Request.Path;

        var isApi = path.StartsWithSegments("/api");
        var isCreate = path.Equals("/api/workspace") && HttpMethods.IsPost(ctx.Request.Method);

        if (!isApi || isCreate)
        {
            await next(ctx);
            return;
        }

        var token = ExtractToken(ctx.Request);
        var workspaceId = token is null ? null : await workspaces.ResolveAsync(token, ctx.RequestAborted);

        if (workspaceId is null)
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await ctx.Response.WriteAsJsonAsync(new { error = "Missing or invalid workspace token." });
            return;
        }

        context.Set(workspaceId.Value);
        await next(ctx);
    }

    private static string? ExtractToken(HttpRequest req)
    {
        if (req.Headers.TryGetValue("X-Workspace-Token", out var h) && !string.IsNullOrWhiteSpace(h))
            return h.ToString().Trim();

        var auth = req.Headers.Authorization.ToString();
        if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            return auth["Bearer ".Length..].Trim();

        return null;
    }
}
