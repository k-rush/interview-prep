using Azure.Core;
using Azure.Identity;
using System.Net.Http.Headers;
using System.Text.Json;

namespace InterviewPrep;

public sealed class StagingModel
{
    private readonly DateTimeOffset expires;
    private readonly string slots;
    private readonly Uri responses;
    private readonly TokenCredential credential;
    internal string Deployment { get; }
    internal StagingModel(DateTimeOffset expires, string share, string endpoint, string deployment, Guid clientId, TokenCredential? tokenCredential = null)
    {
        var uri = new Uri(endpoint, UriKind.Absolute);
        if (uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo != "" || uri.PathAndQuery != "/" || uri.Fragment != "" ||
            !uri.Host.EndsWith(".openai.azure.com", StringComparison.OrdinalIgnoreCase) || uri.Host.Split('.').Length != 4 ||
            deployment.Length is 0 or > 100 || deployment.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '.'))
            throw new InvalidOperationException("Invalid Azure OpenAI resource endpoint or deployment.");
        this.expires = expires; Deployment = deployment; responses = new Uri(uri, "openai/v1/responses");
        slots = Directory.CreateDirectory(Path.Combine(share, "model-budget")).FullName;
        credential = tokenCredential ?? new ManagedIdentityCredential(ManagedIdentityId.FromUserAssignedClientId(clientId.ToString()));
    }

    internal async Task<HttpResponseMessage> Send(HttpClient http, object body, bool search, CancellationToken ct)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(body);
        if (bytes.Length > 32768 || !Reserve(search)) throw new HttpRequestException("Private test model allowance unavailable.");
        var token = await credential.GetTokenAsync(new TokenRequestContext(["https://cognitiveservices.azure.com/.default"]), ct);
        if (DateTimeOffset.UtcNow >= expires) throw new HttpRequestException("Private test expired.");
        using var request = new HttpRequestMessage(HttpMethod.Post, responses) { Content = new ByteArrayContent(bytes) };
        request.Content.Headers.ContentType = new("application/json");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        return await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
    }

    internal bool Reserve(bool search)
    {
        if (DateTimeOffset.UtcNow >= expires) return false;
        // CreateNew is atomic on the share, even across a restart. Failures still consume the slot.
        var prefix = search ? "search" : "coach";
        for (var i = 0; i < (search ? 10 : 80); i++)
        {
            var path = Path.Combine(slots, $"{prefix}-{i}");
            try { using var marker = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None); return true; }
            catch (IOException) when (File.Exists(path)) { }
        }
        return false;
    }

    internal async Task<string?> Complete(HttpClient http, string instruction, object packet, int maxTokens, CancellationToken ct)
    {
        using var response = await Send(http, new {
            model = Deployment, store = false,
            input = new[] { new { role = "developer", content = instruction + "\nReturn valid JSON." },
                new { role = "user", content = JsonSerializer.Serialize(packet) } },
            text = new { format = new { type = "json_object" } },
            reasoning = new { effort = "low" }, max_output_tokens = Math.Clamp(maxTokens + 700, 800, 1800)
        }, false, ct);
        if (!response.IsSuccessStatusCode) return null;
        await response.Content.LoadIntoBufferAsync(131072, ct);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(ct));
        if (doc.RootElement.GetProperty("status").GetString() != "completed") return null;
        return doc.RootElement.GetProperty("output").EnumerateArray().Where(o => o.GetProperty("type").GetString() == "message" &&
            o.GetProperty("role").GetString() == "assistant").SelectMany(o => o.GetProperty("content").EnumerateArray())
            .Where(item => item.GetProperty("type").GetString() == "output_text").Select(item => item.GetProperty("text").GetString()).FirstOrDefault();
    }
}
