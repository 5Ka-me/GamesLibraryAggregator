using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using SteamEGSAggregator.Application.Data;
using SteamEGSAggregator.Application.Models.Entities;

namespace Application.Services;

public interface IWorkspaceService
{
    /// <summary>Creates a new workspace and returns the raw token (shown to the client only once).</summary>
    Task<string> CreateAsync(CancellationToken ct);

    /// <summary>Finds a workspace by token and updates LastSeenAt. null — if the token is not found.</summary>
    Task<Guid?> ResolveAsync(string token, CancellationToken ct);

    static string HashToken(string token) =>
        Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
}

public class WorkspaceService(AppDbContext db) : IWorkspaceService
{
    public async Task<string> CreateAsync(CancellationToken ct)
    {
        var token = Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var now = DateTime.UtcNow;

        db.Workspaces.Add(new Workspace
        {
            Id = Guid.NewGuid(),
            TokenHash = IWorkspaceService.HashToken(token),
            CreatedAt = now,
            LastSeenAt = now
        });
        await db.SaveChangesAsync(ct);
        return token;
    }

    public async Task<Guid?> ResolveAsync(string token, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        var hash = IWorkspaceService.HashToken(token);

        var ws = await db.Workspaces.FirstOrDefaultAsync(w => w.TokenHash == hash, ct);
        if (ws is null) return null;

        ws.LastSeenAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return ws.Id;
    }

    private static string Base64UrlEncode(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
