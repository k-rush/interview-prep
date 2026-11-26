using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;

namespace InterviewPrep;

internal sealed class AccountsIdentity(IHttpClientFactory clients)
{
    internal sealed record Identity(string Subject, string Email, long Expires, long AuthTime);
    internal static string Issuer => $"https://securetoken.google.com/{AccountsModule.Project}";
    private const string Certificates = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
    private readonly SemaphoreSlim keyLock = new(1);
    private Dictionary<string, string> certs = [];
    private long refreshAt, fetchedAt;

    private async Task<string?> Certificate(string kid, CancellationToken ct)
    {
        await keyLock.WaitAsync(ct);
        try
        {
            var now = AccountsModule.Now;
            if (refreshAt > now && (certs.ContainsKey(kid) || now - fetchedAt < 60))
                return certs.GetValueOrDefault(kid);
            using var client = clients.CreateClient("accounts-firebase");
            using var result = await client.GetAsync(Certificates, ct);
            result.EnsureSuccessStatusCode();
            var keys = await result.Content.ReadFromJsonAsync<Dictionary<string, string>>(ct);
            if (keys is not { Count: > 0 and <= 32 }) return null;
            certs = keys;
            fetchedAt = now;
            refreshAt = now + Math.Clamp((long)(result.Headers.CacheControl?.MaxAge?.TotalSeconds ?? 300), 1, 21600);
            return certs.GetValueOrDefault(kid);
        }
        finally { keyLock.Release(); }
    }

    private static bool Object(JsonElement el) => el.ValueKind == JsonValueKind.Object &&
        el.EnumerateObject().Select(p => p.Name).Distinct(StringComparer.Ordinal).Count() == el.EnumerateObject().Count();
    private static string? Text(JsonElement obj, string key) => obj.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static long Number(JsonElement obj, string key) => obj.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;
    private static bool True(JsonElement obj, string key) => obj.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;

    internal async Task<Identity?> Verify(string? raw, CancellationToken ct)
    {
        if (raw is not { Length: >= 30 and <= 8192 }) return null;
        var pieces = raw.Split('.');
        if (pieces.Length != 3 || pieces.Any(p => p.Length == 0 || !p.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))) return null;
        try
        {
            using var head = JsonDocument.Parse(WebEncoders.Base64UrlDecode(pieces[0]));
            using var body = JsonDocument.Parse(WebEncoders.Base64UrlDecode(pieces[1]));
            var h = head.RootElement;
            var b = body.RootElement;
            if (!Object(h) || !Object(b) || Text(h, "alg") != "RS256" || Text(h, "kid") is not { Length: > 0 and <= 128 } kid ||
                Text(b, "iss") != Issuer || Text(b, "aud") != AccountsModule.Project || Text(b, "sub") is not { Length: > 0 and <= 128 } sub ||
                !True(b, "email_verified") || Text(b, "email") is not { Length: > 0 and <= 320 } email ||
                !b.TryGetProperty("firebase", out var firebase) || !Object(firebase) || firebase.TryGetProperty("tenant", out _) ||
                Text(firebase, "sign_in_provider") is null or "anonymous") return null;
            var now = AccountsModule.Now;
            var issued = Number(b, "iat"); var auth = Number(b, "auth_time"); var expires = Number(b, "exp");
            if (auth < now - 600 || auth > now + 30 || issued < auth - 30 || issued > now + 30 || expires <= now ||
                expires <= issued || expires > issued + 3660 || (b.TryGetProperty("nbf", out _) &&
                (Number(b, "nbf") <= 0 || Number(b, "nbf") > now + 30))) return null;
            if (await Certificate(kid, ct) is not { } pem) return null;
            using var cert = X509Certificate2.CreateFromPem(pem);
            using var rsa = cert.GetRSAPublicKey();
            if (rsa is null || rsa.KeySize < 2048 || cert.NotAfter.ToUniversalTime() <= DateTime.UtcNow ||
                cert.NotBefore.ToUniversalTime() > DateTime.UtcNow ||
                !rsa.VerifyData(Encoding.ASCII.GetBytes($"{pieces[0]}.{pieces[1]}"), WebEncoders.Base64UrlDecode(pieces[2]),
                    HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) return null;

            // Check current account state too: a previously issued token can outlive a disable/revocation.
            using var client = clients.CreateClient("accounts-firebase");
            using var response = await client.PostAsJsonAsync($"https://identitytoolkit.googleapis.com/v1/accounts:lookup?key={AccountsModule.LookupKey}",
                new { idToken = raw }, ct);
            if (response.StatusCode is System.Net.HttpStatusCode.BadRequest or System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden) return null;
            response.EnsureSuccessStatusCode();
            using var lookup = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(ct));
            if (!lookup.RootElement.TryGetProperty("users", out var users) || users.ValueKind != JsonValueKind.Array || users.GetArrayLength() != 1) return null;
            var user = users[0];
            if (!Object(user) || Text(user, "localId") != sub || True(user, "disabled") || !True(user, "emailVerified") ||
                Text(user, "email") != email || (user.TryGetProperty("validSince", out _) &&
                (!long.TryParse(Text(user, "validSince"), out var since) || since > auth))) return null;
            return new Identity(sub, email, expires, auth);
        }
        catch (Exception ex) when (ex is JsonException or FormatException or CryptographicException or InvalidOperationException or ArgumentException)
        { return null; }
    }
}
