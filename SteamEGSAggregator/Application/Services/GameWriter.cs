using System.Text;
using Microsoft.EntityFrameworkCore;
using SteamEGSAggregator.Application.Data;
using SteamEGSAggregator.Application.Models.Entities;

namespace Application.Services;

public interface IGameWriter
{
    Task UpsertAsync(
        GameSource source, string externalId, string title,
        string? iconUrl, string? storeUrl, int? playtimeMinutes, string? ns, DateTime? acquisitionDate,
        CancellationToken ct);
}

/// <summary>
/// Merges entries from different stores into single games, matching by normalized title.
/// One instance per request (scoped) — uses the shared AppDbContext; SaveChanges is called by the syncing service.
/// </summary>
public class GameWriter(AppDbContext db, IWorkspaceContext workspace) : IGameWriter
{
    public async Task UpsertAsync(
        GameSource source, string externalId, string title,
        string? iconUrl, string? storeUrl, int? playtimeMinutes, string? ns, DateTime? acquisitionDate,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(externalId) || string.IsNullOrWhiteSpace(title))
            return;

        var ws = workspace.WorkspaceId;
        var now = DateTime.UtcNow;
        var norm = Normalize(title);

        // Look up the game within the workspace: first in the change tracker, then in the DB (with entries).
        var game = db.Games.Local.FirstOrDefault(g => g.WorkspaceId == ws && g.NormalizedTitle == norm)
                   ?? await db.Games
                       .Include(g => g.Entries)
                       .FirstOrDefaultAsync(g => g.WorkspaceId == ws && g.NormalizedTitle == norm, ct);

        if (game is null)
        {
            game = new Game { WorkspaceId = ws, Title = title, NormalizedTitle = norm, CreatedAt = now, UpdatedAt = now };
            db.Games.Add(game);
        }
        else
        {
            game.UpdatedAt = now;
        }

        var entry = game.Entries.FirstOrDefault(e => e.Source == source && e.ExternalId == externalId);
        if (entry is null)
        {
            entry = new GameEntry { Source = source, ExternalId = externalId };
            game.Entries.Add(entry);
        }

        entry.IconUrl = iconUrl;
        entry.StoreUrl = storeUrl;
        entry.PlaytimeMinutes = playtimeMinutes;
        entry.Namespace = ns;
        entry.AcquisitionDate = acquisitionDate;
        entry.UpdatedAt = now;
    }

    /// <summary>Matching key: lowercase, letters and digits only (strips ™, spaces, punctuation, case).</summary>
    public static string Normalize(string title)
    {
        var sb = new StringBuilder(title.Length);
        foreach (var ch in title)
            if (char.IsLetterOrDigit(ch))
                sb.Append(char.ToLowerInvariant(ch));
        return sb.ToString();
    }
}
