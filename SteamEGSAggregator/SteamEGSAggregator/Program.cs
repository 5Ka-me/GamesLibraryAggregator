using Application.DI;
using Microsoft.EntityFrameworkCore;
using SteamEGSAggregator.Application.Data;
using SteamEGSAggregator.Middlewares;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.AddApplication(builder.Configuration);

const string CorsPolicy = "frontend";
builder.Services.AddCors(o => o.AddPolicy(CorsPolicy, p => p
    .WithOrigins("http://localhost:3000")
    .AllowAnyHeader()
    .AllowAnyMethod()));

var app = builder.Build();

// Apply migrations on startup (creates the DB/tables if they don't exist yet).
// Retried: `depends_on` only orders `docker compose up` — after a host/daemon
// restart the API container can come up before Postgres (or before Docker's
// embedded DNS is ready), which used to crash-loop with a DNS error here.
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    const int maxAttempts = 12;
    for (var attempt = 1; ; attempt++)
    {
        try
        {
            db.Database.Migrate();
            break;
        }
        catch (Exception ex) when (attempt < maxAttempts)
        {
            app.Logger.LogWarning(
                "Database not reachable yet (attempt {Attempt}/{Max}): {Message} — retrying in 5s…",
                attempt, maxAttempts, ex.Message);
            Thread.Sleep(TimeSpan.FromSeconds(5));
        }
    }
}

app.UseMiddleware<ExceptionMiddleware>();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors(CorsPolicy);
app.UseMiddleware<WorkspaceMiddleware>();
app.MapControllers();

app.Run();
