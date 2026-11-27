using System.Net;
using System.Text;
using System.Text.Json;
using InterviewPrep;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

internal static class ScoutWebSearchChecks
{
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => send(request, ct);
    }
    private static HttpResponseMessage Response(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
    private static IConfiguration Config(bool enabled = true) => new ConfigurationBuilder().AddInMemoryCollection(
        enabled ? new Dictionary<string, string?> {
            ["INTERVIEW_PREP_OPENAI_SEARCH_KEY"] = "synthetic-test-key",
            ["INTERVIEW_PREP_OPENAI_SEARCH_MODEL"] = "configured-search-model"
        } : []).Build();

    internal static async Task Run()
    {
        var annotations = new[] {
            new { type = "url_citation", title = "Employer posting", url = "https://careers.example.com/jobs/1" },
            new { type = "url_citation", title = "Duplicate", url = "https://careers.example.com/jobs/1" },
            new { type = "url_citation", title = "Unsafe", url = "javascript:alert(1)" },
            new { type = "url_citation", title = "Credentials", url = "https://user:pass@example.com/job" },
            new { type = "url_citation", title = "Local", url = "https://127.0.0.1/job" },
            new { type = "url_citation", title = "Local DNS", url = "https://jobs.local/job" },
            new { type = "url_citation", title = "Local DNS with a trailing dot", url = "https://jobs.local./job" },
            new { type = "url_citation", title = "Wrong port", url = "https://example.com:8443/job" },
            new { type = "url_citation", title = "", url = "https://example.com/empty-title" }
        }.Concat(Enumerable.Range(2, 7).Select(i => new { type = "url_citation", title = $"Posting {i}", url = $"https://careers.example.com/jobs/{i}" })).ToArray();
        var body = JsonSerializer.Serialize(new { status = "completed", output = new object[] {
            new { type = "web_search_call", status = "completed" },
            new { type = "message", role = "assistant", content = new[] { new { type = "output_text", text = "Never store model narrative", annotations } } }
        } });
        var calls = 0;
        using var http = new HttpClient(new Handler(async (request, ct) => {
            calls++;
            Check(request.Method == HttpMethod.Post && request.RequestUri?.AbsoluteUri == "https://api.openai.com/v1/responses",
                "Search used an unexpected endpoint.");
            Check(request.Headers.Authorization?.Scheme == "Bearer" && request.Headers.Authorization.Parameter == "synthetic-test-key",
                "Search did not authenticate.");
            using var packet = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            var root = packet.RootElement;
            Check(root.GetProperty("model").GetString() == "configured-search-model" && !root.GetProperty("store").GetBoolean(),
                "Search model or storage configuration changed.");
            using var input = JsonDocument.Parse(root.GetProperty("input").GetString()!);
            Check(input.RootElement.EnumerateObject().Count() == 1 && input.RootElement.GetProperty("targetRole").GetString() == "Data analyst",
                "Search received more than the target role.");
            Check(root.GetProperty("tools")[0].GetProperty("type").GetString() == "web_search" &&
                root.GetProperty("tool_choice").GetProperty("type").GetString() == "web_search" &&
                root.GetProperty("max_tool_calls").GetInt32() == 2, "Search was not forced or bounded.");
            return Response(body);
        }));
        var search = new ScoutWebSearch(http, Config());
        var result = await search.Find("Data analyst", false, default);
        Check(!result.Incomplete && result.Links.Length == 5 && result.Links[0].Title == "Employer posting" &&
            result.Links.All(l => l.Url.StartsWith("https://careers.example.com/jobs/")), "Citation validation or limit failed.");
        Check(!JsonSerializer.Serialize(result).Contains("Never store"), "Model narrative escaped into the report.");
        Check((await search.Find("Data analyst", true, default)).Links.Length == 0 && calls == 1, "Offline mode made a network call.");
        Check((await new ScoutWebSearch(http, Config(false)).Find("Data analyst", false, default)).Incomplete && calls == 1,
            "Unconfigured search made a network call.");
        foreach (var privateInput in new[] { "reader@example.com", "https://example.com/my-resume", "Engineer synthetic-test-key" })
            Check((await search.Find(privateInput, default)).Incomplete && calls == 1, "Non-role data left the workspace.");

        foreach (var invalid in new[] { "{", "[]", "{\"status\":\"completed\",\"output\":[]}",
            body.Replace("\"status\":\"completed\"", "\"status\":\"incomplete\""), "{\"status\":\"completed\",\"output\":{}}" })
        {
            using var badHttp = new HttpClient(new Handler((_, _) => Task.FromResult(Response(invalid))));
            var bad = await new ScoutWebSearch(badHttp, Config()).Find("Data analyst", false, default);
            Check(bad.Incomplete && bad.Links.Length == 0, "Invalid or incomplete provider output published links.");
        }
        using var deniedHttp = new HttpClient(new Handler((_, _) => Task.FromResult(Response(body, HttpStatusCode.TooManyRequests))));
        Check((await new ScoutWebSearch(deniedHttp, Config()).Find("Data analyst", false, default)).Incomplete, "Rate limiting was hidden.");
        using var largeHttp = new HttpClient(new Handler((_, _) => Task.FromResult(Response(new string('x', 1024 * 1024 + 1)))));
        Check((await new ScoutWebSearch(largeHttp, Config()).Find("Data analyst", false, default)).Incomplete, "Response size was not bounded.");
        using var timeoutHttp = new HttpClient(new Handler((_, _) => throw new TaskCanceledException()));
        Check((await new ScoutWebSearch(timeoutHttp, Config()).Find("Data analyst", false, default)).Incomplete, "Timeout was not handled.");
        using var canceled = new CancellationTokenSource();
        canceled.Cancel();
        try
        {
            await new ScoutWebSearch(timeoutHttp, Config()).Find("Data analyst", false, canceled.Token);
            throw new Exception("Caller cancellation was swallowed.");
        }
        catch (OperationCanceledException) { }
        await CheckArchiveAndConsent(search);
        Check(calls == 2, "Scheduled setup, replay, or an old source caused another public lookup.");
        var indexCalls = 0;
        using var publicHttp = new HttpClient(new Handler((r, _) => {
            indexCalls++;
            Check(r.Method == HttpMethod.Get && r.RequestUri is { Host: "hn.algolia.com", AbsolutePath: "/api/v1/search_by_date" } &&
                r.RequestUri.Query.Contains("tags=job") && r.RequestUri.Query.Contains("query=C%23%20engineer") &&
                !r.RequestUri.Query.Contains("workspace") && r.Headers.Authorization is null && r.Content is null, "Unexpected public-index request.");
            return Task.FromResult(Response("""{"hits":[{"objectID":"12","title":"C# engineer","url":"https://untrusted.example"},{"objectID":"12","title":"Duplicate"},{"objectID":"not-an-id","title":"Ignore"}]}"""));
        }));
        var publicIndex = new ScoutWebSearch(publicHttp,new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string,string?> { ["INTERVIEW_PREP_HN_JOB_SEARCH"] = "1" }).Build());
        var jobs = await publicIndex.Find("C# engineer", default);
        Check(!jobs.Incomplete && jobs.Links is [{ Title: "C# engineer", Url: "https://news.ycombinator.com/item?id=12" }] &&
            jobs.Status.Contains("Hacker News"), "Public search did not return attributed job links.");
        await publicIndex.Find("C# engineer", true, default);
        await publicIndex.Find("private@example.com", default);
        Check(indexCalls == 1, "Private input or offline replay contacted the public index.");
    }

    private static async Task CheckArchiveAndConsent(ScoutWebSearch search)
    {
        using var cx = new SqliteConnection("Data Source=:memory:;Foreign Keys=true");
        await cx.OpenAsync();
        using var services = new ServiceCollection().AddDbContext<PracticeDb>(o => o.UseSqlite(cx)).BuildServiceProvider();
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PracticeDb>();
        await db.Database.EnsureCreatedAsync();
        await new DiscoveryEvidenceObserver(services.GetRequiredService<IServiceScopeFactory>()).StartAsync(default);
        var owner = new Workspace { TokenHash = "fixture-owner" };
        var other = new Workspace { TokenHash = "fixture-other" };
        var fact = new Fact { WorkspaceId = owner.Id, Project = "Archive", Source = "Fixture", Claim = "I used SQL.", Confirmed = true, AllowDrafts = true };
        var local = new DiscoveryLocalJob { WorkspaceId = owner.Id, Title = "Data analyst", Employer = "Private archive", Must = "SQL", CheckedUtc = DateTime.UtcNow };
        var past = new DiscoveryDigest { WorkspaceId = owner.Id, LocalDate = "2000-01-01", TargetRole = local.Title, Zone = "UTC",
            Trigger = "manual", Status = "complete", CreatedUtc = new DateTime(2000, 1, 1) };
        var match = new DiscoveryMatch { WorkspaceId = owner.Id, DigestId = past.Id, Rank = 1, JobKey = $"local:{local.Id:D}",
            JobHash = DiscoveryFit.Hash("0", local.Title, local.Employer, local.Mode, local.Location, local.Pay, local.Must, local.Preferred, local.Excerpt) };
        var pins = new[] { new FactPin(fact.Id, DiscoveryFit.Hash(DiscoveryFit.FactHash(fact), "0")) };
        var pair = new DiscoveryPacket { WorkspaceId = owner.Id, MatchId = match.Id, Version = "previously-reviewed", FactPinsJson = JsonSerializer.Serialize(pins) };
        var board = new DiscoveryBoard { Key = "replay:greenhouse:fixture", RightsBasis = "Fixture" };
        db.AddRange(owner, other, fact, local, board, past, match, pair,
            new DiscoveryFollow { WorkspaceId = owner.Id, BoardKey = board.Key },
            new DiscoverySettings { WorkspaceId = owner.Id, Role = "Old private target", LocalTime = "09:00", AutoDraft = true,
                Enabled = true, RequirePay = true, RemoteOnly = true, NextDueUtc = DateTime.UtcNow.AddDays(-1) });
        await db.SaveChangesAsync(); db.ChangeTracker.Clear();
        var policy = new DiscoveryBoardPolicy(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
            ["INTERVIEW_PREP_SCOUT_REPLAY_DIR"] = ".", ["INTERVIEW_PREP_SCOUT_BOARDS"] = "greenhouse:fixture"
        }).Build());
        var scout = new DiscoveryScout(db, policy, TimeProvider.System, search);
        static int? Status(IResult r) => ((IStatusCodeHttpResult)r).StatusCode;
        Check(!await DailySearch.Enabled(db, owner.Id, default) && (await DailySearch.Read(db, owner.Id, default)).Role == "",
            "A retired setting exposed its target as a public role.");
        Check(Status(await scout.Run(owner.Id, true, default)) == 204 &&
            Status(await scout.Run(owner.Id, false, default)) == 400, "An old enabled schedule looked up a private target.");
        Check(await DailySearch.Set(db, owner.Id, true, null, null, default) is not null, "Enabling reused a board-only role.");
        Check(Status(await scout.Run(owner.Id, false, default, "Data analyst", "UTC")) == 200, "Public report was not published.");
        var fresh = await db.Set<DiscoveryDigest>().SingleAsync(d => d.Id != past.Id);
        Check(!fresh.WebSearchJson.Contains("Private archive") && !fresh.WebSearchJson.Contains("SQL") && !fresh.WebSearchJson.Contains("Reason") &&
            await db.Set<DiscoveryPacket>().CountAsync() == 1 && await db.Set<DiscoveryMatch>().CountAsync() == 1 &&
            (await db.Set<DiscoveryBoard>().SingleAsync()).LastAttemptUtc is null, "Private/ranked data persisted or a retired source was used.");
        Check(!await DailySearch.Enabled(db, owner.Id, default), "A one-time search opted in.");
        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            Check(await DailySearch.Set(db, owner.Id, true, null, null, default) is null, "Previously public role could not be enabled.");
            await db.SaveChangesAsync();
            Check((await db.Set<DiscoverySettings>().AsNoTracking().SingleAsync()).NextDueUtc > DateTime.UtcNow, "Enabling would rerun today's report.");
            await tx.RollbackAsync();
        }
        db.ChangeTracker.Clear();
        Check(!await DailySearch.Enabled(db, owner.Id, default), "Chat rollback did not roll back its toggle.");
        Check(Status(await scout.Run(owner.Id, false, default)) == 200, "Replay lost the saved public report.");
        Check(Status(await scout.Packet(other.Id, pair.Id, "preview", null, null, default)) == 404 &&
            Status(await scout.Packet(owner.Id, pair.Id, "preview", null, null, default)) == 200, "Archive read ownership was lost.");
        Check(Status(await scout.Packet(owner.Id, pair.Id, "export", null, null, default)) == 409 &&
            Status(await scout.Packet(owner.Id, pair.Id, "approve", pair.Version, null, default)) == 204, "Archive review gate was lost.");
        Check(await scout.Packet(owner.Id, pair.Id, "export", null, "txt", default) is IContentTypeHttpResult { ContentType: "text/plain; charset=utf-8" },
            "An approved, current historical pair can no longer be exported.");
        await db.Facts.Where(f => f.Id == fact.Id).ExecuteUpdateAsync(q => q.SetProperty(f => f.AllowDrafts, false));
        await db.Facts.Where(f => f.Id == fact.Id).ExecuteUpdateAsync(q => q.SetProperty(f => f.AllowDrafts, true));
        Check(Status(await scout.Packet(owner.Id, pair.Id, "preview", null, null, default)) == 409 &&
            Status(await scout.Packet(owner.Id, pair.Id, "export", null, null, default)) == 409, "Revoked historical material was exposed.");
        db.Add(new AccountProfile { WorkspaceId = other.Id, Issuer = "fixture", Subject = "free", Email = "free@example.invalid" });
        await db.SaveChangesAsync();
        Check(await DailySearch.Set(db, other.Id, true, "Data analyst", null, default) == DailySearch.Denied &&
            Status(await scout.Run(other.Id, false, default, "Data analyst")) == 403 &&
            await DailySearch.Set(db, other.Id, false, null, null, default) is null, "Daily search ignored entitlements.");
    }
}
