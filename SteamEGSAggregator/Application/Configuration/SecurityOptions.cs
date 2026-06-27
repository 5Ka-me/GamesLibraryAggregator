namespace SteamEGSAggregator.Application.Configuration;

public class SecurityOptions
{
    public static string SectionName = "Security";

    /// <summary>Base64 of a 32-byte AES key used to encrypt secrets in the DB. In prod set via env Security__EncryptionKey.</summary>
    public string EncryptionKey { get; set; } = string.Empty;
}
