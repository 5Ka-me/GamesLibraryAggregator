using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SteamEGSAggregator.Application.Migrations
{
    /// <inheritdoc />
    public partial class Workspaces : Migration
    {
        // Default workspace that pre-existing rows are attached to during this one-time migration.
        // The token hash below is a placeholder (no usable token maps to it) — on a fresh database
        // this just yields an empty, unclaimable workspace; real workspaces are created at runtime.
        private static readonly Guid DefaultWorkspaceId = new("9e1fefd7-9db4-4fcd-9e45-06965656e445");
        private const string DefaultWorkspaceTokenHash = "0000000000000000000000000000000000000000000=";

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Games_NormalizedTitle",
                table: "Games");

            migrationBuilder.DropIndex(
                name: "IX_GameEntries_GameId",
                table: "GameEntries");

            migrationBuilder.DropIndex(
                name: "IX_GameEntries_Source_ExternalId",
                table: "GameEntries");

            // 1. Workspaces table + a default workspace for the already-existing data.
            migrationBuilder.CreateTable(
                name: "Workspaces",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TokenHash = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastSeenAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Workspaces", x => x.Id);
                });

            var seedTime = new DateTime(2026, 6, 27, 0, 0, 0, DateTimeKind.Utc);
            migrationBuilder.InsertData(
                table: "Workspaces",
                columns: new[] { "Id", "TokenHash", "CreatedAt", "LastSeenAt" },
                values: new object[] { DefaultWorkspaceId, DefaultWorkspaceTokenHash, seedTime, seedTime });

            // 2. WorkspaceId with default = the default workspace — existing rows are attached to it.
            migrationBuilder.AddColumn<Guid>(
                name: "WorkspaceId",
                table: "SteamCredentials",
                type: "uuid",
                nullable: false,
                defaultValue: DefaultWorkspaceId);

            migrationBuilder.AddColumn<Guid>(
                name: "WorkspaceId",
                table: "Games",
                type: "uuid",
                nullable: false,
                defaultValue: DefaultWorkspaceId);

            migrationBuilder.AddColumn<Guid>(
                name: "WorkspaceId",
                table: "EpicSessions",
                type: "uuid",
                nullable: false,
                defaultValue: DefaultWorkspaceId);

            migrationBuilder.CreateIndex(
                name: "IX_SteamCredentials_WorkspaceId",
                table: "SteamCredentials",
                column: "WorkspaceId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Games_WorkspaceId_NormalizedTitle",
                table: "Games",
                columns: new[] { "WorkspaceId", "NormalizedTitle" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_GameEntries_GameId_Source_ExternalId",
                table: "GameEntries",
                columns: new[] { "GameId", "Source", "ExternalId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_EpicSessions_WorkspaceId",
                table: "EpicSessions",
                column: "WorkspaceId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Workspaces_TokenHash",
                table: "Workspaces",
                column: "TokenHash",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "Workspaces");

            migrationBuilder.DropIndex(
                name: "IX_SteamCredentials_WorkspaceId",
                table: "SteamCredentials");

            migrationBuilder.DropIndex(
                name: "IX_Games_WorkspaceId_NormalizedTitle",
                table: "Games");

            migrationBuilder.DropIndex(
                name: "IX_GameEntries_GameId_Source_ExternalId",
                table: "GameEntries");

            migrationBuilder.DropIndex(
                name: "IX_EpicSessions_WorkspaceId",
                table: "EpicSessions");

            migrationBuilder.DropColumn(
                name: "WorkspaceId",
                table: "SteamCredentials");

            migrationBuilder.DropColumn(
                name: "WorkspaceId",
                table: "Games");

            migrationBuilder.DropColumn(
                name: "WorkspaceId",
                table: "EpicSessions");

            migrationBuilder.CreateIndex(
                name: "IX_Games_NormalizedTitle",
                table: "Games",
                column: "NormalizedTitle",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_GameEntries_GameId",
                table: "GameEntries",
                column: "GameId");

            migrationBuilder.CreateIndex(
                name: "IX_GameEntries_Source_ExternalId",
                table: "GameEntries",
                columns: new[] { "Source", "ExternalId" },
                unique: true);
        }
    }
}
