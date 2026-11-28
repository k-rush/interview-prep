using System.Net;
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

    private static ResearchSource? Official(string company) => company.Trim().TrimEnd('.').ToLowerInvariant() switch
    {
        "amazon" or "aws" => new("Official reference", "Amazon Leadership Principles",
            "https://www.amazon.jobs/content/en/our-workplace/leadership-principles", "Practice explaining ownership, customer impact and a specific decision."),
        "microsoft" => new("Official reference", "Microsoft corporate values",
            "https://www.microsoft.com/en-us/about/corporate-values", "Prepare an example of accountability and collaboration."),
        "google" => new("Official reference", "Google company philosophy",
            "https://about.google/philosophy/", "Connect a technical choice to its effect on the user."),
        _ => null
    };

    public Task<ResearchResult> Find(string company, CancellationToken ct) => Find(company, false, ct);
    public Task<ResearchResult> FindForPlan(string company, CancellationToken ct) => Find(company, true, ct);
    public Task<PublicPageResult> ReadPage(string url, CancellationToken ct) => PublicPage.Read(http, url, ct);

    private async Task<ResearchResult> Find(string company, bool checkOfficial, CancellationToken ct)
    {
        var list = new List<ResearchSource>();
        var messages = new List<string>();
        var official = Official(company);
        if (checkOfficial)
        {
            if (official is null) messages.Add(Environment.GetEnvironmentVariable("INTERVIEW_PREP_BRAVE_SEARCH_KEY") is { Length: > 0 }
                ? "No curated official page for this employer" : "No supported official page for this employer; no live lookup was made");
            else
            {
                var theme = await CheckPage(official, ct);
                list.Add(theme is null ? official with { Kind = "Curated reference (unverified)" } :
                    official with { Kind = "Official page (checked)", Theme = theme });
                messages.Add(theme is null ? "Live principles unavailable; the curated reference may be stale" :
                    "Practice themes matched on the employer's official page; not reported interview questions");
            }
        }
        else if (official is not null) list.Add(official);
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
        else if (!checkOfficial) messages.Add("Live search not configured; any official references shown are curated, not a fresh search");
        var path = Environment.GetEnvironmentVariable("INTERVIEW_PREP_LICENSED_THEMES");
        bool licensed = false;
        if (!string.IsNullOrEmpty(path))
        {
            try
            {
                using var file = File.OpenRead(path);
                if (file.Length > 1024 * 1024) messages.Add("Licensed catalog unavailable: size limit exceeded");
                else
                {
                    var themes = await JsonSerializer.DeserializeAsync<LicensedTheme[]>(file, new JsonSerializerOptions(JsonSerializerDefaults.Web), ct);
                    var matches = (themes ?? []).Where(t => t?.Company?.Equals(company, StringComparison.OrdinalIgnoreCase) == true).ToArray();
                    var now = DateTimeOffset.UtcNow;
                    if (matches.Any(t => t.ExpiresAt <= now)) messages.Add("Expired licensed guidance was omitted");
                    foreach (var t in matches.Where(t => t.ExpiresAt > now && IsHttpsLink(t.Url) &&
                        t.Publisher is { Length: > 0 and <= 100 } && t.Theme is { Length: > 0 and <= 300 }).Take(3))
                    {
                        list.Add(new("Licensed candidate-reported theme", t.Publisher, t.Url, t.Theme, t.ExpiresAt)); licensed = true;
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { messages.Add("Licensed catalog unavailable"); }
        }
        messages.Add(licensed ? "Licensed themes found; not guaranteed questions" : "No licensed interview themes found. Glassdoor not consulted");
        return new(list.ToArray(), string.Join(". ", messages) + ".");
    }

    private async Task<string?> CheckPage(ResearchSource official, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(5));
        try
        {
            using var response = await ReadOfficial(new Uri(official.Url), deadline.Token);
            if (response is null || !response.IsSuccessStatusCode || response.Content.Headers.ContentType?.MediaType is not ("text/html" or "application/xhtml+xml"))
                return null;
            // Keep no page text. Match only known concepts in visible text; map them to original rehearsal prompts.
            using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(deadline.Token));
            var prefix = new char[256_000];
            var size = await reader.ReadBlockAsync(prefix.AsMemory(), deadline.Token);
            var text = Regex.Replace(new string(prefix, 0, size),
                @"<!--.*?(?:-->|\z)|<script\b[^>]*>.*?(?:</script\s*>|\z)|<style\b[^>]*>.*?(?:</style\s*>|\z)|<[^>]*>",
                " ", RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(250));
            text = Regex.Replace(WebUtility.HtmlDecode(text), @"\s+", " ");
            (string Term, string Prompt)[] concepts = new Uri(official.Url).Host switch
            {
                "www.amazon.jobs" => [("customer obsession", "Customer focus: how did you learn whether a change helped a customer?"),
                    ("ownership", "Ownership: which decision was yours, and where did others contribute?"),
                    ("earn trust", "Trust: what did you do when a teammate disagreed?")],
                "www.microsoft.com" => [("accountability", "Accountability: how did you follow up on a commitment?"),
                    ("integrity", "Integrity: how did you handle a difficult trade-off?"),
                    ("respect", "Respect: how did another perspective change your approach?")],
                _ => [("focus on the user", "User focus: which user need shaped your decision?"),
                    ("fast is better than slow", "Speed: how did you weigh responsiveness against another constraint?")]
            };
            var prompts = concepts.Where(c => text.Contains(c.Term, StringComparison.OrdinalIgnoreCase)).Take(2).Select(c => c.Prompt).ToArray();
            return prompts.Length == 0 ? null : string.Join(" ", prompts);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or RegexMatchTimeoutException ||
            ex is OperationCanceledException && !ct.IsCancellationRequested) { return null; }
    }

    private async Task<HttpResponseMessage?> ReadOfficial(Uri page, CancellationToken ct)
    {
        var uri = page;
        for (var redirects = 0; redirects <= 2; redirects++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.Accept.ParseAdd("text/html");
            var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if ((int)response.StatusCode is not (301 or 302 or 303 or 307 or 308)) return response;
            using (response)
            {
                if (response.Headers.Location is not { } location || !Uri.TryCreate(uri, location, out var next) ||
                    next.Scheme != "https" || next.UserInfo != "" || !next.IsDefaultPort || next.Query != "" ||
                    !(next.Host == page.Host || page.Host == "www.amazon.jobs" && next.Host == "amazon.jobs")) return null;
                uri = next;
            }
        }
        return null;
    }
}
