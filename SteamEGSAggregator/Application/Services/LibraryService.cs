using Application.Interfaces;
using Microsoft.EntityFrameworkCore;
using SteamEGSAggregator.Application.Data;
using SteamEGSAggregator.Application.Models;

namespace Application.Services;

public class LibraryService(AppDbContext db, IWorkspaceContext workspace) : ILibraryService
{
    public async Task<List<GameDto>> GetCombinedLibraryAsync(CancellationToken ct)
    {
        var ws = workspace.WorkspaceId;
        var games = await db.Games
            .AsNoTracking()
            .Include(g => g.Entries)
            .Where(g => g.WorkspaceId == ws)
            .OrderBy(g => g.Title)
            .ToListAsync(ct);
        return games.Select(GameDto.FromEntity).ToList();
    }
}
