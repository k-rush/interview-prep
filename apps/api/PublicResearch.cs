using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace InterviewPrep;

public sealed record ResearchSource(string Kind, string Title, string Url, string Theme, DateTimeOffset? ExpiresAt = null);
public sealed record ResearchResult(ResearchSource[] Sources, string Status);
public sealed class PublicResearch(HttpClient http)
{
    private sealed record LicensedTheme(string Company, string Publisher, string Url, string Theme, DateTimeOffset ExpiresAt);
    public static bool IsCompany(string name) => Regex.IsMatch(name, @"^[\p{L}\p{N}][\p{L}\p{N} .&'-]{0,99}$");
    public static bool IsHttpsLink(string? text) => text is { Length: <= 1500 } && Uri.TryCreate(text, UriKind.Absolute, out var url) &&
        url.Scheme == "https" && url.UserInfo == "" && !url.IsLoopback && url.HostNameType == UriHostNameType.Dns;

    public async Task<ResearchResult> Find(string company, CancellationToken ct)
    {
        var list = new List<ResearchSource>();
        var official = company.ToLowerInvariant() switch
        {
            "amazon" or "aws" => new ResearchSource("Official reference", "Amazon Leadership Principles",
                "https://www.amazon.jobs/content/en/our-workplace/leadership-principles", "Practice explaining ownership, customer impact and a specific decision."),
            "microsoft" => new("Official reference", "Microsoft corporate values",
                "https://www.microsoft.com/en-us/about/corporate-values", "Prepare an example of accountability and collaboration."),
            "google" => new("Official reference", "Google company philosophy",
                "https://about.google/philosophy/", "Connect a technical choice to its effect on the user."),
            _ => null
        };
        if (official is not null) list.Add(official);
        var messages = new List<string>();
        if (Environment.GetEnvironmentVariable("INTERVIEW_PREP_BRAVE_SEARCH_KEY") is { Length: > 0 } key)
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get,
                    "https://api.search.brave.com/res/v1/web/search?count=5&q=" + Uri.EscapeDataString($"{company} official careers values interview process"));
                req.Headers.Add("X-Subscription-Token", key);
                using var res = await http.SendAsync(req, ct);
                res.EnsureSuccessStatusCode();
                using var body = await res.Content.ReadFromJsonAsync<JsonDocument>(ct);
                if (body?.RootElement.TryGetProperty("web", out var web) == true && web.TryGetProperty("results", out var results))
                    foreach (var hit in results.EnumerateArray().Take(5))
                    {
                        var url = hit.GetProperty("url").GetString(); var title = hit.GetProperty("title").GetString();
                        if (title is { Length: > 0 and <= 300 } && IsHttpsLink(url) && !new Uri(url!).Host.Contains("glassdoor.", StringComparison.OrdinalIgnoreCase))
                            list.Add(new("Public search result (verify publisher)", title, url!, "Discovery link only; no verified interview question."));
                    }
                messages.Add("Public web search consulted");
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException or InvalidOperationException or KeyNotFoundException ||
                (ex is OperationCanceledException && !ct.IsCancellationRequested)) { messages.Add("Public search unavailable"); }
        }
        else messages.Add("Live search not configured; any official references shown are curated, not a fresh search");
        var path = Environment.GetEnvironmentVariable("INTERVIEW_PREP_LICENSED_THEMES");
        bool licensed = false;
        if (!string.IsNullOrEmpty(path) && File.Exists(path) && new FileInfo(path).Length <= 1024 * 1024)
        {
            try
            {
                using var file = File.OpenRead(path);
                var themes = await JsonSerializer.DeserializeAsync<LicensedTheme[]>(file, new JsonSerializerOptions(JsonSerializerDefaults.Web), ct);
                foreach (var t in (themes ?? []).Where(t => t?.Company?.Equals(company, StringComparison.OrdinalIgnoreCase) == true &&
                    t.ExpiresAt > DateTimeOffset.UtcNow && IsHttpsLink(t.Url) && t.Publisher is { Length: > 0 and <= 100 } && t.Theme is { Length: > 0 and <= 300 }).Take(3))
                {
                    list.Add(new("Licensed candidate-reported theme", t.Publisher, t.Url, t.Theme, t.ExpiresAt)); licensed = true;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { messages.Add("Licensed catalog unavailable"); }
        }
        messages.Add(licensed ? "Licensed themes found; not guaranteed questions" : "No licensed interview themes found. Glassdoor not consulted");
        return new(list.ToArray(), string.Join(". ", messages) + ".");
    }
}
