using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace InterviewPrep;

public sealed record PublicPageResult(string Url, string? Text, string Status);

internal static class PublicPage
{
    private const int MaxBytes = 512_000;
    private const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant;
    private static string Replace(string text, string pattern, string replacement) =>
        Regex.Replace(text, pattern, replacement, Options, TimeSpan.FromMilliseconds(250));
    private static Match Match(string text, string pattern) =>
        Regex.Match(text, pattern, Options, TimeSpan.FromMilliseconds(250));

    internal static bool Permitted(string? text, out Uri uri)
    {
        uri = null!;
        return text is { Length: > 0 and <= 1500 } && !text.Any(char.IsControl) &&
            Uri.TryCreate(text, UriKind.Absolute, out uri!) && uri.Scheme == "https" &&
            uri.UserInfo == "" && uri.IsDefaultPort && !uri.IsLoopback &&
            uri.HostNameType == UriHostNameType.Dns && uri.Host.Contains('.') &&
            !uri.Host.TrimEnd('.').EndsWith(".local", StringComparison.OrdinalIgnoreCase) &&
            !uri.Host.TrimEnd('.').EndsWith(".localhost", StringComparison.OrdinalIgnoreCase) &&
            !uri.Host.Contains("glassdoor.", StringComparison.OrdinalIgnoreCase);
    }

    internal static SocketsHttpHandler Transport() => new()
    {
        AllowAutoRedirect = false,
        UseProxy = false,
        UseCookies = false,
        Credentials = null,
        ActivityHeadersPropagator = null,
        AutomaticDecompression = DecompressionMethods.None,
        ConnectTimeout = TimeSpan.FromSeconds(4),
        PooledConnectionLifetime = TimeSpan.FromMinutes(2),
        ConnectCallback = async (context, ct) =>
        {
            var endpoint = context.DnsEndPoint;
            if (!Permitted($"https://{endpoint.Host}:{endpoint.Port}/", out _))
                throw new HttpRequestException("Not a public HTTPS destination.");
            var addresses = await Dns.GetHostAddressesAsync(endpoint.Host, ct);
            if (addresses.Length == 0 || addresses.Any(a => !PublicAddress(a)))
                throw new HttpRequestException("Not a public network destination.");
            // Pin the socket to a checked address; TLS still verifies the original hostname.
            foreach (var address in addresses)
            {
                var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
                try { await socket.ConnectAsync(new IPEndPoint(address, endpoint.Port), ct); return new NetworkStream(socket, ownsSocket: true); }
                catch (SocketException) { socket.Dispose(); }
                catch { socket.Dispose(); throw; }
            }
            throw new HttpRequestException("Public page unavailable.");
        }
    };

    internal static bool PublicAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        var b = address.GetAddressBytes();
        if (b.Length == 16) return (b[0] & 0xe0) == 0x20 && !(b[0] == 0x20 && b[1] == 0x01 &&
            (b[2] < 2 || (b[2] == 0x0d && b[3] == 0xb8))) && !(b[0] == 0x20 && b[1] == 0x02);
        return b[0] is not (0 or 10 or 127) && b[0] < 224 && !(b[0] == 100 && b[1] is >= 64 and <= 127) &&
            !(b[0] == 169 && b[1] == 254) && !(b[0] == 172 && b[1] is >= 16 and <= 31) &&
            !(b[0] == 192 && (b[1] is 0 or 168 || (b[1] == 88 && b[2] == 99))) &&
            !(b[0] == 198 && (b[1] is 18 or 19 || (b[1] == 51 && b[2] == 100))) &&
            !(b[0] == 203 && b[1] == 0 && b[2] == 113);
    }

    internal static async Task<PublicPageResult> Read(HttpClient http, string url, CancellationToken ct)
    {
        const string unavailable = "I couldn’t read that public page. It may require sign-in, block automated access, or need JavaScript. Paste a permitted job description or summary, try another public HTTPS link, or say 'skip'.";
        if (!Permitted(url, out var uri))
            return new(url, null, "Use a public HTTPS link without credentials or a custom port, paste a permitted description, or say 'skip'.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            for (int redirects = 0; redirects <= 3; redirects++)
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, uri);
                request.Headers.Accept.ParseAdd("text/html, application/xhtml+xml, text/plain");
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
                if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308)
                {
                    if (response.Headers.Location is not { } location || !Uri.TryCreate(uri, location, out var next) ||
                        !Permitted(next.AbsoluteUri, out uri)) return new(url, null, unavailable);
                    continue;
                }
                if (!response.IsSuccessStatusCode ||
                    response.Content.Headers.ContentType?.MediaType is not ("text/html" or "application/xhtml+xml" or "text/plain") ||
                    response.Content.Headers.ContentLength > MaxBytes ||
                    response.Content.Headers.ContentEncoding.Count > 0) return new(url, null, unavailable);
                await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
                using var buffer = new MemoryStream();
                var chunk = new byte[8192];
                int count;
                while ((count = await stream.ReadAsync(chunk, deadline.Token)) > 0)
                {
                    if (buffer.Length + count > MaxBytes) return new(url, null, unavailable);
                    buffer.Write(chunk, 0, count);
                }
                buffer.Position = 0;
                using var reader = new StreamReader(buffer);
                var body = await reader.ReadToEndAsync(deadline.Token);
                var text = response.Content.Headers.ContentType.MediaType == "text/plain" ? body.Trim() : Extract(body, uri);
                if (text.Length < 80) return new(url, null, unavailable);
                return new(uri.GetLeftPart(UriPartial.Query), ChatRecall.Clip(text, 12000),
                    "Read the public page; its text is source material, not verified employer guidance.");
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or JsonException or InvalidOperationException or RegexMatchTimeoutException ||
            ex is OperationCanceledException && !ct.IsCancellationRequested)
        { }
        return new(url, null, unavailable);
    }

    private static string Visible(string html) =>
        Replace(WebUtility.HtmlDecode(Replace(html,
            @"<!--.*?(?:-->|\z)|<(script|style|noscript|nav|footer)\b[^>]*>.*?(?:</\1\s*>|\z)|<[^>]*>", " ")), @"\s+", " ").Trim();

    private static string Field(JsonElement value, string key) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var field) && field.ValueKind == JsonValueKind.String
            ? field.GetString() ?? "" : "";

    private static string? JobPosting(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Array)
            return value.EnumerateArray().Select(JobPosting).FirstOrDefault(t => !string.IsNullOrWhiteSpace(t));
        if (value.ValueKind != JsonValueKind.Object) return null;
        if (Field(value, "@type") == "JobPosting" && Field(value, "description") is { Length: > 0 } description)
            return Visible(Field(value, "title") + "\n" + description);
        return value.TryGetProperty("@graph", out var graph) ? JobPosting(graph) : null;
    }

    private static string Extract(string html, Uri uri)
    {
        // Apple's server-rendered routing data contains the posting even when the body is a JS shell.
        if (uri.Host == "jobs.apple.com")
        {
            var hydration = Match(html, @"window\.__staticRouterHydrationData\s*=\s*JSON\.parse\((?<json>""(?:\\.|[^""\\])*"")\)");
            if (hydration.Success)
            {
                using var data = JsonDocument.Parse(JsonSerializer.Deserialize<string>(hydration.Groups["json"].Value)!);
                if (data.RootElement.ValueKind == JsonValueKind.Object && data.RootElement.TryGetProperty("loaderData", out var loaders) &&
                    loaders.ValueKind == JsonValueKind.Object && loaders.TryGetProperty("jobDetails", out var details) &&
                    details.ValueKind == JsonValueKind.Object && details.TryGetProperty("jobsData", out var job))
                {
                    var text = string.Join("\n", new[] { "postingTitle", "jobSummary", "description", "responsibilities",
                        "minimumQualifications", "preferredQualifications" }.Select(key => Field(job, key)));
                    if (text.Trim().Length > 80) return Visible(text);
                }
            }
        }
        foreach (Match script in Regex.Matches(html, @"<script\b[^>]*type\s*=\s*[""']application/ld\+json[""'][^>]*>(?<json>.*?)</script\s*>",
            Options, TimeSpan.FromMilliseconds(250)))
        {
            try
            {
                using var data = JsonDocument.Parse(script.Groups["json"].Value);
                if (JobPosting(data.RootElement) is { Length: > 80 } job) return job;
            }
            catch (JsonException) { }
        }
        var main = Match(html, @"<(main|article)\b[^>]*>(?<body>.*?)</\1\s*>");
        return Visible(main.Success ? main.Groups["body"].Value : html);
    }
}
