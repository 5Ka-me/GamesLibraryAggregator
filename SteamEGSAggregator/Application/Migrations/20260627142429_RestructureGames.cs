using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace SteamEGSAggregator.Application.Migrations
{
    /// <inheritdoc />
    public partial class RestructureGames : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // The old Games rows are incompatible with the new schema (one row per source) and
            // are easily restored by re-syncing. EpicSessions/SteamCredentials are left untouched.
            migrationBuilder.Sql("DELETE FROM \"Games\";");

            migrationBuilder.DropIndex(
                name: "IX_Games_Source_ExternalId",
                table: "Games");

            migrationBuilder.DropColumn(
                name: "AcquisitionDate",
                table: "Games");

            migrationBuilder.DropColumn(
                name: "ExternalId",
                table: "Games");

            migrationBuilder.DropColumn(
                name: "IconUrl",
                table: "Games");

            migrationBuilder.DropColumn(
                name: "Namespace",
                table: "Games");

            migrationBuilder.DropColumn(
                name: "PlaytimeMinutes",
                table: "Games");

            migrationBuilder.RenameColumn(
                name: "Source",
                table: "Games",
                newName: "NormalizedTitle");

            migrationBuilder.CreateTable(
                name: "GameEntries",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    GameId = table.Column<int>(type: "integer", nullable: false),
                    Source = table.Column<string>(type: "text", nullable: false),
                    ExternalId = table.Column<string>(type: "text", nullable: false),
                    IconUrl = table.Column<string>(type: "text", nullable: true),
                    PlaytimeMinutes = table.Column<int>(type: "integer", nullable: true),
                    Namespace = table.Column<string>(type: "text", nullable: true),
                    AcquisitionDate = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GameEntries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GameEntries_Games_GameId",
                        column: x => x.GameId,
                        principalTable: "Games",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "SteamCredentials",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ApiKey = table.Column<string>(type: "text", nullable: false),
                    SteamId = table.Column<string>(type: "text", nullable: false),
                    PersonaName = table.Column<string>(type: "text", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SteamCredentials", x => x.Id);
                });

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

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "GameEntries");

            migrationBuilder.DropTable(
                name: "SteamCredentials");

            migrationBuilder.DropIndex(
                name: "IX_Games_NormalizedTitle",
                table: "Games");

            migrationBuilder.RenameColumn(
                name: "NormalizedTitle",
                table: "Games",
                newName: "Source");

            migrationBuilder.AddColumn<DateTime>(
                name: "AcquisitionDate",
                table: "Games",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ExternalId",
                table: "Games",
                type: "text",
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "IconUrl",
                table: "Games",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Namespace",
                table: "Games",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "PlaytimeMinutes",
                table: "Games",
                type: "integer",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Games_Source_ExternalId",
                table: "Games",
                columns: new[] { "Source", "ExternalId" },
                unique: true);
        }
    }
}
