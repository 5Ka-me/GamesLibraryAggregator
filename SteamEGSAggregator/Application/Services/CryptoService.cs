using System.Security.Cryptography;
using System.Text;
using SteamEGSAggregator.Application.Configuration;

namespace Application.Services;

public interface ICryptoService
{
    string Encrypt(string plaintext);
    string Decrypt(string stored);
}

/// <summary>
/// Encrypts secrets (Steam API key, EGS tokens) for storage in the DB — AES-256-GCM.
/// Format: "enc::base64(nonce|tag|ciphertext)". Values without the prefix are treated as legacy plaintext
/// (returned as-is and re-encrypted on the next write).
/// </summary>
public class CryptoService : ICryptoService
{
    private const string Prefix = "enc::";
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private readonly byte[] _key;

    public CryptoService(SecurityOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.EncryptionKey))
            throw new InvalidOperationException(
                "Security:EncryptionKey is not set (base64, 32 bytes). Provide it via env Security__EncryptionKey.");

        _key = Convert.FromBase64String(options.EncryptionKey);
        if (_key.Length != 32)
            throw new InvalidOperationException("Security:EncryptionKey must be 32 bytes (base64).");
    }

    public string Encrypt(string plaintext)
    {
        if (string.IsNullOrEmpty(plaintext)) return plaintext;

        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var plain = Encoding.UTF8.GetBytes(plaintext);
        var cipher = new byte[plain.Length];
        var tag = new byte[TagSize];

        using var aes = new AesGcm(_key, TagSize);
        aes.Encrypt(nonce, plain, cipher, tag);

        var blob = new byte[NonceSize + TagSize + cipher.Length];
        Buffer.BlockCopy(nonce, 0, blob, 0, NonceSize);
        Buffer.BlockCopy(tag, 0, blob, NonceSize, TagSize);
        Buffer.BlockCopy(cipher, 0, blob, NonceSize + TagSize, cipher.Length);

        return Prefix + Convert.ToBase64String(blob);
    }

    public string Decrypt(string stored)
    {
        if (string.IsNullOrEmpty(stored)) return stored;
        if (!stored.StartsWith(Prefix, StringComparison.Ordinal))
            return stored; // legacy plaintext

        var blob = Convert.FromBase64String(stored[Prefix.Length..]);
        var nonce = blob.AsSpan(0, NonceSize);
        var tag = blob.AsSpan(NonceSize, TagSize);
        var cipher = blob.AsSpan(NonceSize + TagSize);
        var plain = new byte[cipher.Length];

        using var aes = new AesGcm(_key, TagSize);
        aes.Decrypt(nonce, cipher, tag, plain);
        return Encoding.UTF8.GetString(plain);
    }
}
