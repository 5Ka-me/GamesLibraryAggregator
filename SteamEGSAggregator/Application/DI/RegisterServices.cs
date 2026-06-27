using Application.Interfaces;
using Application.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SteamEGSAggregator.Application.Configuration;
using SteamEGSAggregator.Application.Data;

namespace Application.DI;

public static class RegisterServices
{
    public static IServiceCollection AddApplication(this IServiceCollection services, IConfiguration config)
    {
        services
            .AddConfiguration(config)
            .AddPersistence(config)
            .AddHttpClients()
            .AddServices();

        return services;
    }

    public static IServiceCollection AddConfiguration(this IServiceCollection services, IConfiguration config)
    {
        // Services inject the concrete options types, so register already-bound instances.
        var epic = config.GetSection(EpicGamesOptions.SectionName).Get<EpicGamesOptions>() ?? new EpicGamesOptions();
        var security = config.GetSection(SecurityOptions.SectionName).Get<SecurityOptions>() ?? new SecurityOptions();

        services.AddSingleton(epic);
        services.AddSingleton(security);
        return services;
    }

    public static IServiceCollection AddPersistence(this IServiceCollection services, IConfiguration config)
    {
        var connectionString = config.GetConnectionString("Default")
            ?? "Host=localhost;Port=5432;Database=steamegs;Username=postgres;Password=postgres";

        services.AddDbContext<AppDbContext>(opt => opt.UseNpgsql(connectionString));
        return services;
    }

    public static IServiceCollection AddHttpClients(this IServiceCollection services)
    {
        // EGS strictly validates the User-Agent on the launcher endpoints.
        services.AddHttpClient("epic", c =>
        {
            c.DefaultRequestHeaders.UserAgent.ParseAdd(
                "UELauncher/14.0.8-22004686+++Portal+Release-Live Windows/10.0.19041.1.256.64bit");
        });
        services.AddHttpClient("steam");

        // Epic public Store GraphQL — requires browser-like Origin/Referer headers.
        services.AddHttpClient("epicstore", c =>
        {
            c.BaseAddress = new Uri("https://store.epicgames.com/");
            c.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
            c.DefaultRequestHeaders.TryAddWithoutValidation("Origin", "https://store.epicgames.com");
            c.DefaultRequestHeaders.TryAddWithoutValidation("Referer", "https://store.epicgames.com/");
            c.Timeout = TimeSpan.FromSeconds(15);
        });
        return services;
    }

    public static IServiceCollection AddServices(this IServiceCollection services)
    {
        services.AddSingleton<ICryptoService, CryptoService>();
        services.AddScoped<IWorkspaceContext, WorkspaceContext>();
        services.AddScoped<IWorkspaceService, WorkspaceService>();
        services.AddScoped<IGameWriter, GameWriter>();
        services.AddScoped<IEpicGamesService, EpicGamesService>();
        services.AddScoped<ISteamService, SteamService>();
        services.AddScoped<ILibraryService, LibraryService>();
        return services;
    }
}
