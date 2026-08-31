using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Caching.Memory;
using SteamEGSAggregator.Services;

// Stateless web backend for the browser version of the library:
//   - "Sign in through Steam" (OpenID 2.0) → signed HTTP-only session cookie;
//   - Steam Web API proxy with ONE server-side key (users enter no secrets);
//   - in-memory response cache; NO database, NO stored user data.
// The desktop launcher does not use this — it is fully standalone; on the same
// machine the web app reads the launcher's data through its local bridge.

var builder = WebApplication.CreateBuilder(args);

var webOrigin = (builder.Configuration["Web:Origin"] ?? "http://localhost:3000").TrimEnd('/');
var publicUrl = (builder.Configuration["PublicUrl"] ?? "http://localhost:5080").TrimEnd('/');
// Plain HTTP is fine for localhost/self-hosted; a public deployment must be
// HTTPS so the session cookie can be Secure (and SameSite=None if the web app
// lives on another domain).
var requireSecureCookies = builder.Configuration.GetValue("Cookies:RequireHttps", !builder.Environment.IsDevelopment());
var crossSiteCookies = builder.Configuration.GetValue("Cookies:CrossSite", false);

if (!Uri.TryCreate(webOrigin, UriKind.Absolute, out _))
{
    throw new InvalidOperationException($"Web:Origin must be an absolute URL (got '{webOrigin}').");
}
if (!Uri.TryCreate(publicUrl, UriKind.Absolute, out _))
{
    throw new InvalidOperationException($"PublicUrl must be an absolute URL (got '{publicUrl}').");
}

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddMemoryCache();
builder.Services
    .AddHttpClient("steam", c => c.Timeout = TimeSpan.FromSeconds(15))
    // The Steam API key travels in the query string — the default HttpClient
    // loggers would print the full URI (key included) to the logs.
    .RemoveAllLoggers();
builder.Services.AddSingleton<SteamProxy>();
builder.Services.AddHealthChecks();

// Session cookies survive API restarts only when the keys are persisted
// (docker-compose mounts a volume here); without the setting they're ephemeral.
var dpKeys = builder.Configuration["DataProtection:KeysPath"];
if (!string.IsNullOrWhiteSpace(dpKeys))
{
    builder.Services.AddDataProtection().PersistKeysToFileSystem(new DirectoryInfo(dpKeys));
}

builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        o.Cookie.Name = "gl_session";
        o.Cookie.HttpOnly = true;
        // Lax keeps POST /auth/logout safe from cross-site invocation; None is
        // only for a cross-domain frontend and forces Secure.
        o.Cookie.SameSite = crossSiteCookies ? SameSiteMode.None : SameSiteMode.Lax;
        o.Cookie.SecurePolicy = requireSecureCookies || crossSiteCookies
            ? CookieSecurePolicy.Always
            : CookieSecurePolicy.SameAsRequest;
        // The cookie is the only auth factor and can't be revoked server-side
        // (no store), so it's deliberately short-lived and sliding.
        o.ExpireTimeSpan = TimeSpan.FromDays(7);
        o.SlidingExpiration = true;
        // An API must answer 401/403, not redirect to a login page.
        o.Events.OnRedirectToLogin = ctx =>
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
        o.Events.OnRedirectToAccessDenied = ctx =>
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        };
    });
builder.Services.AddAuthorization();

const string CorsPolicy = "frontend";
builder.Services.AddCors(o => o.AddPolicy(CorsPolicy, p => p
    .WithOrigins(webOrigin)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors(CorsPolicy);
app.UseAuthentication();
app.UseAuthorization();

app.MapHealthChecks("/health").AllowAnonymous();

// ---------- auth ----------

// Short-lived cookie binding the callback to the browser that started the flow
// (login CSRF / session-fixation protection).
const string StateCookie = "gl_login_state";

CookieOptions StateCookieOptions() => new()
{
    HttpOnly = true,
    SameSite = crossSiteCookies ? SameSiteMode.None : SameSiteMode.Lax,
    Secure = requireSecureCookies || crossSiteCookies,
    MaxAge = TimeSpan.FromMinutes(10),
    Path = "/auth/steam",
};

app.MapGet("/auth/steam/login", (HttpContext ctx) =>
{
    var state = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
    ctx.Response.Cookies.Append(StateCookie, state, StateCookieOptions());
    return Results.Redirect(SteamOpenId.LoginUrl(publicUrl, state));
});

app.MapGet("/auth/steam/callback", async (
    HttpContext ctx,
    IHttpClientFactory http,
    IMemoryCache cache,
    SteamProxy steam,
    CancellationToken ct) =>
{
    var expectedState = ctx.Request.Cookies[StateCookie];
    ctx.Response.Cookies.Delete(StateCookie, StateCookieOptions());

    var steamId = await SteamOpenId.VerifyAsync(
        ctx.Request.Query, publicUrl, expectedState, http.CreateClient("steam"), cache, ct);
    if (steamId is null) return Results.Redirect($"{webOrigin}/?login=failed");

    // The persona name is resolved per request in /api/me instead of being
    // baked into the cookie — it changes, and a failed lookup must not stick.
    var identity = new ClaimsIdentity(
        [new Claim(ClaimTypes.NameIdentifier, steamId)],
        CookieAuthenticationDefaults.AuthenticationScheme);
    await ctx.SignInAsync(new ClaimsPrincipal(identity));
    return Results.Redirect(webOrigin);
});

app.MapPost("/auth/logout", async (HttpContext ctx) =>
{
    await ctx.SignOutAsync();
    return Results.NoContent();
});

// ---------- data ----------

app.MapGet("/api/me", async (HttpContext ctx, ClaimsPrincipal user, SteamProxy steam, CancellationToken ct) =>
{
    NoStore(ctx);
    var steamId = user.FindFirstValue(ClaimTypes.NameIdentifier);
    if (steamId is null) return Results.Ok(new { authenticated = false, steamId = (string?)null, personaName = (string?)null });
    return Results.Ok(new
    {
        authenticated = true,
        steamId,
        personaName = await steam.GetPersonaAsync(steamId, ct),
    });
});

app.MapGet("/api/library", async (
    HttpContext ctx,
    ClaimsPrincipal user,
    SteamProxy steam,
    ILoggerFactory loggers,
    CancellationToken ct) =>
{
    NoStore(ctx);
    var steamId = user.FindFirstValue(ClaimTypes.NameIdentifier)!;
    try
    {
        return Results.Ok(await steam.GetLibraryAsync(steamId, ct));
    }
    catch (SteamProfilePrivateException)
    {
        // A precondition on the user's side, not an upstream failure.
        return Results.Problem(
            "Steam is not sharing this account's game details. Make them public in your Steam " +
            "privacy settings, or use the desktop launcher (it signs in as you and sees everything).",
            statusCode: StatusCodes.Status409Conflict);
    }
    catch (OperationCanceledException)
    {
        return Results.StatusCode(499); // client disconnected
    }
    catch (Exception e)
    {
        // Details go to the log, never to the client (they can carry
        // infrastructure hints such as a missing server-side key).
        loggers.CreateLogger("Library").LogError(e, "Steam library request failed");
        return Results.Problem("Could not load the library from Steam. Try again later.",
            statusCode: StatusCodes.Status502BadGateway);
    }
}).RequireAuthorization();

app.Run();

// Per-user responses must never sit in a shared cache.
static void NoStore(HttpContext ctx) => ctx.Response.Headers.CacheControl = "no-store";
