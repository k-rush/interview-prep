using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal sealed class DiscoveryBoardPolicy(IConfiguration config)
{
    public string? ReplayDirectory { get; } = string.IsNullOrWhiteSpace(config["INTERVIEW_PREP_SCOUT_REPLAY_DIR"])
        ? null : Path.GetFullPath(config["INTERVIEW_PREP_SCOUT_REPLAY_DIR"]!);
    public HashSet<string> Roster { get; } = (config["INTERVIEW_PREP_SCOUT_BOARDS"] ?? "")
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Where(k => k.Split(':') is [var provider, var slug] && Valid(provider, slug)).ToHashSet(StringComparer.Ordinal);
    public static bool Valid(string? provider, string? slug) =>
        provider is "greenhouse" or "lever" && slug is { Length: > 0 and <= 64 } &&
        Regex.IsMatch(slug, @"\A[a-z0-9]+(?:[-_][a-z0-9]+)*\z", RegexOptions.CultureInvariant);
    public string StoreKey(string key) => (ReplayDirectory is null ? "public:" : "replay:") + key;
    public bool Permits(string key) => Roster.Any(k => StoreKey(k) == key);
    public static string Label(string key) => key[(key.IndexOf(':') + 1)..];
}

internal sealed class DiscoveryBoards(HttpClient http, DiscoveryBoardPolicy policy, TimeProvider clock)
{
    private const int MaxJobs = 60, MaxBytes = 2 * 1024 * 1024;
    private sealed class Backoff(DateTime until) : Exception { public DateTime Until { get; } = until; }
    internal static SocketsHttpHandler Transport() => new() {
        AllowAutoRedirect = false, UseProxy = false, UseCookies = false, Credentials = null,
        ActivityHeadersPropagator = null, AutomaticDecompression = DecompressionMethods.None,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5), ConnectTimeout = TimeSpan.FromSeconds(4),
        ConnectCallback = async (context, token) =>
        {
            var endpoint = context.DnsEndPoint;
            if (endpoint.Port != 443 || endpoint.Host is not ("boards-api.greenhouse.io" or "api.lever.co"))
                throw new HttpRequestException("Not a permitted board host.");
            var addresses = await Dns.GetHostAddressesAsync(endpoint.Host, token);
            // Pin the connection to the checked address; TLS still verifies the fixed provider hostname.
            foreach (var address in addresses.Where(PublicAddress))
            {
                var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
                try { await socket.ConnectAsync(new IPEndPoint(address, 443), token); return new NetworkStream(socket, ownsSocket: true); }
                catch (SocketException) { socket.Dispose(); }
                catch { socket.Dispose(); throw; }
            }
            throw new HttpRequestException("No reachable public board endpoint.");
        }
    };

    private static bool PublicAddress(IPAddress address)
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
    private static string Clean(string? s, int limit)
    {
        s = (s ?? "").Trim();
        return s.Length > limit ? s[..limit] : s;
    }
    private static string Field(JsonElement e, string key, int limit = 180) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? Clean(v.GetString(), limit) : "";
    private static string Field(JsonElement e, string p, string k, int n) =>
        e.TryGetProperty(p, out var v) ? Field(v, k, n) : "";
    private static string Mode(string location, string explicitMode)
    {
        var s = explicitMode.Length > 0 ? explicitMode : location;
        if (Regex.IsMatch(s, @"\bhybrid\b", RegexOptions.IgnoreCase)) return "hybrid";
        if (Regex.IsMatch(s, @"\bon[ -]?site\b", RegexOptions.IgnoreCase)) return "onsite";
        return Regex.IsMatch(s, @"\bremote\b", RegexOptions.IgnoreCase) ? "remote" : "unknown";
    }
    private static Uri Endpoint(string provider, string slug) => provider == "greenhouse"
        ? new($"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true")
        : new($"https://api.lever.co/v0/postings/{slug}?mode=json&limit={MaxJobs + 1}");
    public static string? PublicLink(string key)
    {
        if (key.Split(':') is not ["public", var provider, var slug, var id] || !DiscoveryBoardPolicy.Valid(provider, slug)) return null;
        return provider switch
        {
            "greenhouse" when long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out _) =>
                $"https://job-boards.greenhouse.io/{slug}/jobs/{id}",
            "lever" when Guid.TryParseExact(id, "D", out _) => $"https://jobs.lever.co/{slug}/{id}",
            _ => null
        };
    }

    private async Task<JsonDocument> ReadAsync(string provider, string slug, CancellationToken token)
    {
        if (policy.ReplayDirectory is not null)
        {
            // Replay is server-selected, uses the same parser and never falls back to the network.
            await using var file = File.OpenRead(Path.Combine(policy.ReplayDirectory, $"{provider}.{slug}.json"));
            if (file.Length > MaxBytes) throw new InvalidDataException();
            return await JsonDocument.ParseAsync(file, cancellationToken: token);
        }
        using var response = await http.GetAsync(Endpoint(provider, slug), HttpCompletionOption.ResponseHeadersRead, token);
        if (response.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.ServiceUnavailable &&
            response.Headers.RetryAfter is { } retry)
        {
            var earliest = clock.GetUtcNow().UtcDateTime;
            var until = retry.Date?.UtcDateTime ?? (retry.Delta is { } delay && delay < DateTime.MaxValue - earliest ? earliest + delay : DateTime.MaxValue);
            throw new Backoff(until);
        }
        if (response.StatusCode != HttpStatusCode.OK ||
            !string.Equals(response.Content.Headers.ContentType?.MediaType, "application/json", StringComparison.OrdinalIgnoreCase) ||
            response.Content.Headers.ContentLength > MaxBytes) throw new InvalidDataException();
        await response.Content.LoadIntoBufferAsync(MaxBytes, token);
        return JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(token));
    }

    private sealed record Batch(List<DiscoveryPublicJob> Jobs, string Status, bool Complete);
    private static Batch Parse(JsonDocument doc, string boardKey, string provider, DateTime now)
    {
        var root = doc.RootElement;
        if (provider == "greenhouse")
        {
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("jobs", out var arr)) throw new InvalidDataException();
            root = arr;
        }
        if (root.ValueKind != JsonValueKind.Array) throw new InvalidDataException();
        var rows = new Dictionary<string, DiscoveryPublicJob>();
        var discarded = false;
        foreach (var el in root.EnumerateArray().Take(MaxJobs))
        {
            if (el.ValueKind != JsonValueKind.Object) { discarded = true; continue; }
            var title = Field(el, provider == "lever" ? "text" : "title", 180);
            if (title.Length == 0 || !el.TryGetProperty("id", out var id)) { discarded = true; continue; }
            string external;
            if (provider == "lever" && id.ValueKind == JsonValueKind.String && Guid.TryParseExact(id.GetString(), "D", out var guid))
                external = guid.ToString("D");
            else if (provider == "greenhouse" && id.ValueKind == JsonValueKind.Number && id.TryGetInt64(out var number) && number > 0)
                external = number.ToString(CultureInfo.InvariantCulture);
            else { discarded = true; continue; }
            var location = provider == "lever" ? Field(el, "categories", "location", 150) : Field(el, "location", "name", 150);
            var description = provider == "lever" ? Field(el, "descriptionPlain", 20000) : Field(el, "content", 20000);
            if (provider == "lever" && el.TryGetProperty("lists", out var lists) && lists.ValueKind == JsonValueKind.Array)
                description += " " + string.Join(' ', lists.EnumerateArray().Take(8).Select(l => Field(l, "content", 2500)));
            description = Regex.Replace(WebUtility.HtmlDecode(description), "<[^>]{0,512}>", " ");
            var pay = "";
            if (provider == "lever" && el.TryGetProperty("salaryRange", out var salary) && salary.ValueKind == JsonValueKind.Object &&
                salary.TryGetProperty("min", out var min) && min.ValueKind == JsonValueKind.Number && min.TryGetDecimal(out var low) &&
                salary.TryGetProperty("max", out var max) && max.ValueKind == JsonValueKind.Number && max.TryGetDecimal(out var high) &&
                low >= 0 && high >= low && Field(salary, "currency", 10) is { Length: > 0 } currency)
                pay = FormattableString.Invariant($"{low}–{high} {currency} {Field(salary, "interval", 30)}").TrimEnd();
            var key = $"{boardKey}:{external}";
            rows[key] = new() { Key = key, BoardKey = boardKey, Title = title, Location = location, Pay = pay,
                Mode = Mode(location, Field(el, "workplaceType")), SeenUtc = now,
                ContentHash = DiscoveryFit.Hash(el.GetRawText()),
                Mentions = string.Join(", ", DiscoveryFit.Mentions($"{title} {description}")) };
        }
        var complete = !discarded && root.GetArrayLength() <= MaxJobs && rows.Count > 0;
        var status = root.GetArrayLength() == 0 ? "empty feed; previous entries not presumed closed" :
            rows.Count == 0 ? "unreadable entries; previous entries not presumed closed" :
            complete ? "checked" : "partial: bounded or unrecognized entries";
        return new([.. rows.Values], status, complete);
    }

    public async Task RefreshAsync(PracticeDb db, Guid owner, string key, CancellationToken ct)
    {
        if (!policy.Permits(key) || key.Split(':') is not [_, var provider, var slug] || !DiscoveryBoardPolicy.Valid(provider, slug)) return;
        var now = clock.GetUtcNow().UtcDateTime;
        var lease = Guid.NewGuid();
        // A durable cooldown doubles as a short crash-recoverable refresh lease across workspaces/processes.
        var claimed = await db.Set<DiscoveryBoard>().Where(b => b.Key == key && b.RefreshAfterUtc <= now &&
                db.Set<DiscoveryFollow>().Any(f => f.BoardKey == b.Key && f.WorkspaceId == owner) &&
                db.Workspaces.Any(w => w.Id == owner && w.ExpiresAt > now))
            .ExecuteUpdateAsync(b => b.SetProperty(x => x.Lease, lease).SetProperty(x => x.LastAttemptUtc, now)
                .SetProperty(x => x.RefreshAfterUtc, now.AddMinutes(2)).SetProperty(x => x.Coverage, "refresh in progress"), ct);
        if (claimed == 0)
        {
            // On a simultaneous cold fetch, give the winning worker a bounded chance to publish the shared result.
            for (var i = 0; i < 9 && await db.Set<DiscoveryBoard>().AnyAsync(b => b.Key == key && b.Lease != null, ct); i++)
                await Task.Delay(TimeSpan.FromSeconds(1), ct);
            return;
        }
        Batch? batch = null;
        DateTime? backoff = null;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            using var document = await ReadAsync(provider, slug, timeout.Token);
            batch = Parse(document, key, provider, now);
        }
        catch (Backoff e) { backoff = e.Until; }
        catch (Exception ex) when (!ct.IsCancellationRequested && ex is HttpRequestException or IOException or JsonException
            or OperationCanceledException or UnauthorizedAccessException or InvalidDataException or InvalidOperationException or ArgumentException)
        { /* Keep the dated cache, never presume closure. */ }

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var board = await db.Set<DiscoveryBoard>().SingleOrDefaultAsync(b => b.Key == key && b.Lease == lease, ct);
        if (board is null) return;
        board.Lease = null;
        board.RefreshAfterUtc = now.AddHours(batch is { Jobs.Count: > 0 } ? 24 : 1);
        if (backoff > board.RefreshAfterUtc) board.RefreshAfterUtc = backoff.Value;
        board.Coverage = batch?.Status ?? (backoff.HasValue ? "unavailable: provider requested backoff" : "unavailable: permission, timeout or unreadable feed");
        if (batch is { Jobs.Count: > 0 })
        {
            board.LastSuccessUtc = now;
            var previous = await db.Set<DiscoveryPublicJob>().Where(j => j.BoardKey == key).ToDictionaryAsync(j => j.Key, ct);
            foreach (var row in batch.Jobs)
            {
                if (previous.Remove(row.Key, out var existing))
                {
                    if (existing.Open && existing.ContentHash == row.ContentHash) row.Version = existing.Version;
                    db.Entry(existing).CurrentValues.SetValues(row);
                }
                else db.Add(row);
            }
            if (batch.Complete)
                foreach (var existing in previous.Values) existing.Open = false;
        }
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        db.ChangeTracker.Clear();
    }
}
