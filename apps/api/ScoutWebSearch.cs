using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace InterviewPrep;

public sealed record ScoutWebLink(string Title, string Url);
public sealed record ScoutWebResult(ScoutWebLink[] Links, string Status, bool Incomplete = false);

public sealed class ScoutWebSearch(HttpClient http, IConfiguration config, StagingModel? staging = null, PromptPack? prompts = null)
{
    private const int MaxBytes = 1024 * 1024;
    private string? Key => config["INTERVIEW_PREP_OPENAI_SEARCH_KEY"];
    private string? ReplayFile => config["INTERVIEW_PREP_SCOUT_SEARCH_REPLAY_FILE"];
    private bool PublicIndex => staging is null && config["INTERVIEW_PREP_HN_JOB_SEARCH"] == "1" && string.IsNullOrWhiteSpace(Key) && string.IsNullOrWhiteSpace(ReplayFile);
    public bool Configured => staging != null || PublicIndex || !string.IsNullOrWhiteSpace(Key) || !string.IsNullOrWhiteSpace(ReplayFile);
    internal string Disclosure => !string.IsNullOrWhiteSpace(ReplayFile) ? "This installation uses recorded search results; it makes no live lookup." :
        PublicIndex ? "This installation sends only that title to the Hacker News jobs index (Algolia), which mostly covers startup and technology roles." :
        Configured ? "This installation sends only that title to OpenAI public web search." : NotConsulted.Status;
    public static ScoutWebResult NotConsulted => new([], "Public web search not configured; no lookup was made.", true);
    private ScoutWebResult Unavailable => new([], $"{(PublicIndex ? "Hacker News job search" : "OpenAI public web search")} unavailable; no opening was inferred.", true);

    public Task<ScoutWebResult> Find(string publicRole, CancellationToken ct) =>
        Find(publicRole, !string.IsNullOrWhiteSpace(config["INTERVIEW_PREP_SCOUT_REPLAY_DIR"]), ct);

    internal bool AcceptsRole(string role) => DailySearch.ValidRole(role) &&
        !(Key is { Length: > 0 } key && role.Contains(key, StringComparison.Ordinal));

    public async Task<ScoutWebResult> Find(string role, bool replayOnly, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!AcceptsRole(role)) return new([], "No lookup made: supply only a short public role title.", true);
        if (!Configured) return NotConsulted;
        if (replayOnly && string.IsNullOrWhiteSpace(ReplayFile))
            return new([], "Public web search not consulted in offline fixture mode.", true);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(45));
        try
        {
            if (!string.IsNullOrWhiteSpace(ReplayFile))
            {
                await using var file = File.OpenRead(Path.GetFullPath(ReplayFile));
                if (file.Length > MaxBytes) return Unavailable;
                using var recorded = await JsonDocument.ParseAsync(file, cancellationToken: deadline.Token);
                return Parse(recorded, true);
            }
            if (PublicIndex) return await FindPublicJobs(role, deadline.Token);
            using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.openai.com/v1/responses");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Key);
            var payload = new {
                model = staging?.Deployment ?? config["INTERVIEW_PREP_OPENAI_SEARCH_MODEL"] ?? "gpt-6.2-astra",
                store = false,
                instructions = (prompts ?? PromptPack.Bundled)["scout.search"],
                input = JsonSerializer.Serialize(new { targetRole = role }),
                tools = new[] { new { type = "web_search", search_context_size = "low" } },
                tool_choice = new { type = "web_search" },
                max_tool_calls = staging is null ? 2 : 1,
                max_output_tokens = 1800,
                reasoning = new { effort = "low" }
            };
            request.Content = JsonContent.Create(payload);
            using var response = staging != null ? await staging.Send(http, payload, true, deadline.Token) :
                await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > MaxBytes ||
                response.Content.Headers.ContentType?.MediaType != "application/json") return Unavailable;
            await response.Content.LoadIntoBufferAsync(MaxBytes, deadline.Token);
            using var document = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(deadline.Token));
            return Parse(document, false);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or UnauthorizedAccessException or JsonException
            or InvalidOperationException or ArgumentException or Azure.Identity.AuthenticationFailedException || ex is OperationCanceledException && !ct.IsCancellationRequested)
        { return Unavailable; }
    }

    private async Task<ScoutWebResult> FindPublicJobs(string role, CancellationToken ct)
    {
        var since = DateTimeOffset.UtcNow.AddDays(-90).ToUnixTimeSeconds();
        var uri = $"https://hn.algolia.com/api/v1/search_by_date?tags=job&numericFilters=created_at_i%3E{since}&hitsPerPage=5&attributesToRetrieve=objectID%2Ctitle&query={Uri.EscapeDataString(role)}";
        using var response = await http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > MaxBytes ||
            response.Content.Headers.ContentType?.MediaType != "application/json") return Unavailable;
        await response.Content.LoadIntoBufferAsync(MaxBytes, ct);
        using var body = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(ct));
        if (body.RootElement.ValueKind != JsonValueKind.Object || !body.RootElement.TryGetProperty("hits", out var hits) ||
            hits.ValueKind != JsonValueKind.Array) return Unavailable;
        var links = new Dictionary<long, ScoutWebLink>();
        foreach (var hit in hits.EnumerateArray())
        {
            var title = Field(hit, "title").Trim();
            if (title.Length is > 0 and <= 300 && !title.Any(char.IsControl) &&
                long.TryParse(Field(hit, "objectID"), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var id) && id > 0)
                links.TryAdd(id, new(title, $"https://news.ycombinator.com/item?id={id}"));
            if (links.Count == 5) break;
        }
        return new(links.Values.ToArray(), "Source: Hacker News jobs via Algolia. Recent startup and technology postings only; verify openings with the employer.");
    }

    private static string Field(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String
            ? field.GetString() ?? "" : "";
    private static IEnumerable<JsonElement> Array(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.Array
            ? field.EnumerateArray() : [];

    private ScoutWebResult Parse(JsonDocument document, bool recorded)
    {
        var root = document.RootElement;
        var output = Array(root, "output").ToArray();
        if (Field(root, "status") != "completed" ||
            !output.Any(item => Field(item, "type") == "web_search_call" && Field(item, "status") == "completed"))
            return Unavailable;
        var links = new Dictionary<string, ScoutWebLink>(StringComparer.Ordinal);
        var citations = output.Where(item => Field(item, "type") == "message" && Field(item, "role") == "assistant")
            .SelectMany(item => Array(item, "content")).Where(text => Field(text, "type") == "output_text")
            .SelectMany(text => Array(text, "annotations")).Where(c => Field(c, "type") == "url_citation");
        foreach (var citation in citations)
        {
            var title = Field(citation, "title").Trim();
            var url = Field(citation, "url");
            if (title.Length is 0 or > 300 || title.Any(char.IsControl) || url.Any(c => char.IsControl(c) || char.IsWhiteSpace(c) || c == '\\') ||
                !PublicResearch.IsHttpsLink(url)) continue;
            var uri = new Uri(url);
            var host = uri.IdnHost.TrimEnd('.');
            if (!uri.IsDefaultPort || !host.Contains('.') || host.EndsWith(".local", StringComparison.OrdinalIgnoreCase) ||
                host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase) || host.EndsWith(".internal", StringComparison.OrdinalIgnoreCase)) continue;
            links.TryAdd(url, new(title, url));
            if (links.Count == 5) break;
        }
        return new(links.Values.ToArray(), recorded
            ? "Recorded OpenAI search fixture, not a live lookup or verified vacancy."
            : "OpenAI public web search consulted using only the target role. Cited links are unverified; check the employer before applying.");
    }

    internal static SocketsHttpHandler Transport() => new() {
        AllowAutoRedirect = false, UseProxy = false, UseCookies = false, Credentials = null,
        ActivityHeadersPropagator = null, AutomaticDecompression = DecompressionMethods.None,
        ConnectTimeout = TimeSpan.FromSeconds(5), PooledConnectionLifetime = TimeSpan.FromMinutes(5)
    };
}
