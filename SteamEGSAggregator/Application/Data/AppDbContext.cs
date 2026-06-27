using Microsoft.EntityFrameworkCore;
using SteamEGSAggregator.Application.Models.Entities;

namespace SteamEGSAggregator.Application.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Workspace> Workspaces => Set<Workspace>();
    public DbSet<Game> Games => Set<Game>();
    public DbSet<GameEntry> GameEntries => Set<GameEntry>();
    public DbSet<EpicSession> EpicSessions => Set<EpicSession>();
    public DbSet<SteamCredentials> SteamCredentials => Set<SteamCredentials>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Workspace>(e =>
        {
            e.HasKey(w => w.Id);
            e.HasIndex(w => w.TokenHash).IsUnique();
            e.Property(w => w.TokenHash).IsRequired();
        });

        modelBuilder.Entity<Game>(e =>
        {
            e.HasKey(g => g.Id);
            e.HasIndex(g => new { g.WorkspaceId, g.NormalizedTitle }).IsUnique();
            e.Property(g => g.Title).IsRequired();
            e.Property(g => g.NormalizedTitle).IsRequired();
            e.HasMany(g => g.Entries)
                .WithOne(en => en.Game)
                .HasForeignKey(en => en.GameId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<GameEntry>(e =>
        {
            e.HasKey(en => en.Id);
            // One entry per (game, source, external id). A game may have two entries of the same
            // source if different appids produce the same normalized title.
            e.HasIndex(en => new { en.GameId, en.Source, en.ExternalId }).IsUnique();
            e.Property(en => en.ExternalId).IsRequired();
            e.Property(en => en.Source).HasConversion<string>();
        });

        modelBuilder.Entity<EpicSession>(e =>
        {
            e.HasKey(s => s.Id);
            e.HasIndex(s => s.WorkspaceId).IsUnique();
        });

        modelBuilder.Entity<SteamCredentials>(e =>
        {
            e.HasKey(s => s.Id);
            e.HasIndex(s => s.WorkspaceId).IsUnique();
        });
    }
}
