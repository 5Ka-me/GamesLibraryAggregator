using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;

namespace SteamEGSAggregator.Services;

/// <summary>
/// Minimal Steam "Sign in through Steam" (OpenID 2.0, stateless mode).
/// Steam is the only provider we ever talk to, so no generic OpenID library —
/// just the two steps the spec needs: the checkid_setup redirect and the
/// check_authentication verification round-trip.
/// </summary>
public static partial class SteamOpenId
{
    public const string Endpoint = "https://steamcommunity.com/openid/login";
    private const string Ns = "http://specs.openid.net/auth/2.0";
    private const string IdentifierSelect = "http://specs.openid.net/auth/2.0/identifier_select";

    /// <summary>How long a signed assertion stays acceptable (replay window).</summary>
    private static readonly TimeSpan NonceMaxAge = TimeSpan.FromMinutes(5);

    // `\z` (not `$`): `$` in .NET also matches before a trailing newline.
    [GeneratedRegex(@"^https://steamcommunity\.com/openid/id/(7656\d{13})\z",
        RegexOptions.CultureInvariant)]
    private static partial Regex ClaimedIdRegex();

    public static string CallbackUrl(string publicUrl) => $"{publicUrl}/auth/steam/callback";

    /// <summary>
    /// The URL to send the browser to. <paramref name="state"/> is echoed back
    /// through <c>return_to</c> (and therefore covered by Steam's signature),
    /// binding the callback to the browser that started the flow.
    /// </summary>
    public static string LoginUrl(string publicUrl, string state)
    {
        var returnTo = $"{CallbackUrl(publicUrl)}?state={Uri.EscapeDataString(state)}";
        var query = new Dictionary<string, string>
        {
            ["openid.ns"] = Ns,
            ["openid.mode"] = "checkid_setup",
            ["openid.return_to"] = returnTo,
            ["openid.realm"] = publicUrl,
            ["openid.identity"] = IdentifierSelect,
            ["openid.claimed_id"] = IdentifierSelect,
        };
        return Endpoint + "?" + string.Join("&",
            query.Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}"));
    }

    /// <summary>
    /// Verifies a callback and returns the SteamID64, or null when the
    /// assertion is invalid, stale, replayed, or addressed elsewhere.
    /// <paramref name="expectedState"/> is the value stored in the browser's
    /// login cookie; it must match the one Steam signed.
    /// </summary>
    public static async Task<string?> VerifyAsync(
        IQueryCollection query,
        string publicUrl,
        string? expectedState,
        HttpClient http,
        IMemoryCache cache,
        CancellationToken ct = default)
    {
        if (query["openid.mode"] != "id_res") return null;
        if (string.IsNullOrEmpty(expectedState)) return null;

        // The assertion must be addressed to this exact endpoint, and carry the
        // state we handed out (both are covered by Steam's signature).
        if (!ReturnsToUs(query["openid.return_to"].ToString(), publicUrl, expectedState)) return null;

        // Steam must be the issuing endpoint.
        var opEndpoint = query["openid.op_endpoint"].ToString();
        if (!string.IsNullOrEmpty(opEndpoint) && opEndpoint != Endpoint) return null;

        var match = ClaimedIdRegex().Match(query["openid.claimed_id"].ToString());
        if (!match.Success) return null;

        // Steam's check_authentication does NOT track nonces, so freshness and
        // single-use are enforced here: reject old assertions and remember the
        // ones already spent (a captured callback URL must not be reusable).
        var nonce = query["openid.response_nonce"].ToString();
        if (!IsFreshNonce(nonce)) return null;

        // Direct verification: echo every openid.* field back with
        // mode=check_authentication; Steam answers "is_valid:true" only for a
        // signature it really produced.
        var fields = query
            .Where(kv => kv.Key.StartsWith("openid.", StringComparison.Ordinal))
            .ToDictionary(kv => kv.Key, kv => kv.Value.ToString());
        fields["openid.mode"] = "check_authentication";

        using var res = await http.PostAsync(Endpoint, new FormUrlEncodedContent(fields), ct);
        if (!res.IsSuccessStatusCode) return null;
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!body.Contains("is_valid:true", StringComparison.Ordinal)) return null;

        // Burn the nonce only once the signature is confirmed valid, so a bogus
        // request can't lock out a legitimate one.
        var nonceKey = $"openid-nonce:{nonce}";
        if (!cache.TryGetValue(nonceKey, out _))
        {
            cache.Set(nonceKey, true, NonceMaxAge);
            return match.Groups[1].Value;
        }
        return null; // replay
    }

    private static bool ReturnsToUs(string returnTo, string publicUrl, string expectedState)
    {
        if (!Uri.TryCreate(returnTo, UriKind.Absolute, out var actual)) return false;
        if (!Uri.TryCreate(CallbackUrl(publicUrl), UriKind.Absolute, out var expected)) return false;
        if (actual.Scheme != expected.Scheme ||
            !string.Equals(actual.Host, expected.Host, StringComparison.OrdinalIgnoreCase) ||
            actual.Port != expected.Port ||
            actual.AbsolutePath != expected.AbsolutePath)
        {
            return false;
        }
        var state = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(actual.Query)["state"]
            .ToString();
        // Fixed-length random tokens; ordinal comparison is enough.
        return state == expectedState;
    }

    /// <summary>response_nonce starts with an ISO-8601 UTC timestamp.</summary>
    private static bool IsFreshNonce(string nonce)
    {
        if (nonce.Length < 20) return false;
        var stamp = nonce[..20];
        if (!DateTimeOffset.TryParse(stamp, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var issued))
        {
            return false;
        }
        var age = DateTimeOffset.UtcNow - issued;
        // A little slack for clock skew in both directions.
        return age < NonceMaxAge && age > -TimeSpan.FromMinutes(1);
    }
}
