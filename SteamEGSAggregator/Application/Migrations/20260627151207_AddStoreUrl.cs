using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SteamEGSAggregator.Application.Migrations
{
    /// <inheritdoc />
    public partial class AddStoreUrl : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "StoreUrl",
                table: "GameEntries",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "StoreUrl",
                table: "GameEntries");
        }
    }
}
