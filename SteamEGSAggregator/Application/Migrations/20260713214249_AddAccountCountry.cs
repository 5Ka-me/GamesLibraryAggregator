using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SteamEGSAggregator.Application.Migrations
{
    /// <inheritdoc />
    public partial class AddAccountCountry : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Country",
                table: "SteamCredentials",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Country",
                table: "EpicSessions",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Country",
                table: "SteamCredentials");

            migrationBuilder.DropColumn(
                name: "Country",
                table: "EpicSessions");
        }
    }
}
