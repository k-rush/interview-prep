using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

public sealed class InterviewTarget
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid WorkspaceId { get; set; }
    public required string Role { get; set; }
    public string Company { get; set; } = "";
    public required string Level { get; set; }
    public required string Round { get; set; }
    public string Description { get; set; } = "";
    public string? JobUrl { get; set; }
    public string ResearchJson { get; set; } = "[]";
    public DateTime? ResearchedAt { get; set; }
    public DateTime? InterviewAt { get; set; }
    public string? InterviewZone { get; set; }
    public string ResearchStatus { get; set; } = "Not consulted";
    public ResearchSource[] Sources() => JsonSerializer.Deserialize<ResearchSource[]>(ResearchJson)!
        .Where(s => !s.ExpiresAt.HasValue || s.ExpiresAt > DateTimeOffset.UtcNow).ToArray();
    public string Context() => $"{Role} | {Level} | {Round}\n{Company}\n{Description}";
}

public sealed class PrepSchedule
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid WorkspaceId { get; set; }
    public Guid TargetId { get; set; }
    public DateTime InterviewAt { get; set; }
    public required string Zone { get; set; }
    public required string WindowsJson { get; set; }
    public List<PrepBlock> Blocks { get; set; } = [];
}

public sealed class PrepBlock
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ScheduleId { get; set; }
    public required string Kind { get; set; }
    public required string Label { get; set; }
    public DateTime StartsAt { get; set; }
    public int Minutes { get; set; }
    public string State { get; set; } = "planned";
    public Guid? AttemptId { get; set; }
}

public sealed class CoachFeedback
{
    public int Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid MockId { get; set; }
    public required string Item { get; set; }
    public required string Vote { get; set; }
    public string Reason { get; set; } = "";
}

public sealed class QualityCheck
{
    public int Id { get; set; }
    public Guid MockId { get; set; }
    public required string Check { get; set; }
    public bool Passed { get; set; }
    public DateTime At { get; set; } = DateTime.UtcNow;
}

public sealed class AssessmentChallenge
{
    public int Id { get; set; }
    public Guid MockId { get; set; }
    public int Turn { get; set; }
    public required string Excerpt { get; set; }
    public required string Note { get; set; }
    public string? SecondOpinion { get; set; }
}

public static class Preparation
{
    public sealed record TargetInput(string? Role, string? Company, string? Level, string? Round, string? Description, string? JobUrl);
    public sealed record Window(DateTimeOffset Start, DateTimeOffset End);
    public sealed record PlanInput(DateTimeOffset InterviewAt, string? Zone, Window[]? Windows);
    public sealed record BlockEdit(string? Action, DateTimeOffset? StartsAt);
    public sealed record VoteInput(string? Item, string? Vote, string? Reason);
    public sealed record ProposalInput(int? Index, string? Excerpt, string? Project);
    public sealed record ResearchInput(bool PublicCompanyLookup);
    public sealed record LookupInput(string? JobUrl);
    public sealed record ChallengeInput(int Turn, string? Excerpt, string? Note, bool AskLocalCoach);
    public static Guid Owner(HttpContext c) => (Guid)c.Items["workspace"]!;
    private static Task<InterviewTarget?> Target(PracticeDb db, HttpContext c, Guid id) =>
        db.Set<InterviewTarget>().SingleOrDefaultAsync(t => t.Id == id && t.WorkspaceId == Owner(c));
    static bool Text(string? s, int limit) => !string.IsNullOrWhiteSpace(s) && s.Length <= limit;
    static DateTime Utc(DateTime d) => DateTime.SpecifyKind(d, DateTimeKind.Utc);

    public static void Configure(ModelBuilder m)
    {
        m.Entity<InterviewTarget>().HasOne<Workspace>().WithMany().HasForeignKey(x => x.WorkspaceId);
        m.Entity<PrepSchedule>().HasOne<InterviewTarget>().WithOne().HasForeignKey<PrepSchedule>(x => x.TargetId);
        m.Entity<PrepSchedule>().HasMany(x => x.Blocks).WithOne().HasForeignKey(x => x.ScheduleId);
        m.Entity<PrepBlock>().Property(x => x.AttemptId).IsConcurrencyToken();
        m.Entity<CoachFeedback>().HasOne<Mock>().WithMany().HasForeignKey(x => x.MockId);
        m.Entity<CoachFeedback>().HasIndex(x => new { x.WorkspaceId, x.MockId, x.Item }).IsUnique();
        m.Entity<QualityCheck>().HasOne<Mock>().WithMany().HasForeignKey(x => x.MockId);
        m.Entity<AssessmentChallenge>().HasOne<Mock>().WithMany().HasForeignKey(x => x.MockId);
        m.Entity<AssessmentChallenge>().HasIndex(x => new { x.MockId, x.Turn }).IsUnique();
    }

    public static void Map(WebApplication app)
    {
        app.MapGet("/api/today", async (PracticeDb db, HttpContext c) =>
        {
            var owner = Owner(c); var now = DateTime.UtcNow;
            var next = await (from b in db.Set<PrepBlock>() join s in db.Set<PrepSchedule>() on b.ScheduleId equals s.Id
                join t in db.Set<InterviewTarget>() on s.TargetId equals t.Id
                where t.WorkspaceId == owner && s.InterviewAt > now && b.State == "planned"
                orderby b.StartsAt select new { t.Role, targetId = t.Id, b.Label, b.StartsAt, b.AttemptId }).FirstOrDefaultAsync();
            var digest = await db.Set<DiscoveryDigest>().AsNoTracking().Where(d => d.WorkspaceId == owner)
                .OrderByDescending(d => d.CreatedUtc).Select(d => new { d.LocalDate, d.Status, d.NextStep }).FirstOrDefaultAsync();
            return Results.Ok(new { next = next is null ? null : new { next.Role, next.targetId, next.Label,
                startsAt = Utc(next.StartsAt), next.AttemptId }, digest });
        });
        app.MapPost("/api/targets/lookup", async (LookupInput input, PracticeDb db, HttpContext c, DiscoveryBoardPolicy policy, DiscoveryBoards feeds) =>
        {
            if (!PublicResearch.IsHttpsLink(input.JobUrl)) return Results.BadRequest("Use a public HTTPS posting link.");
            var url = new Uri(input.JobUrl!); var path = url.AbsolutePath.Trim('/').Split('/');
            string provider, slug, id;
            if (url.IsDefaultPort && url.Host is ("job-boards.greenhouse.io" or "boards.greenhouse.io") &&
                path is [var board, "jobs", var number] && long.TryParse(number, out var n) && n > 0)
                (provider, slug, id) = ("greenhouse",board,n.ToString(System.Globalization.CultureInfo.InvariantCulture));
            else if (url.IsDefaultPort && url.Host == "jobs.lever.co" && path is [var org, var post] && Guid.TryParseExact(post,"D",out var guid))
                (provider, slug, id) = ("lever",org,guid.ToString("D"));
            else return Results.BadRequest("This link can be bookmarked. To prepare from its contents, paste or upload a permitted job description.");
            var key = policy.StoreKey($"{provider}:{slug}"); var owner = Owner(c);
            if (!DiscoveryBoardPolicy.Valid(provider,slug) || !policy.Permits(key) ||
                !await db.Set<DiscoveryFollow>().AnyAsync(f => f.BoardKey == key && f.WorkspaceId == owner))
                return Results.BadRequest("Follow this rights-cleared board in Job scout first, or paste the job description. No URL was fetched.");
            await feeds.RefreshAsync(db, owner, key, c.RequestAborted);
            var jobKey = $"{key}:{id}";
            var job = await db.Set<DiscoveryPublicJob>().AsNoTracking().SingleOrDefaultAsync(j => j.Key == jobKey && j.Open &&
                j.SeenUtc > DateTime.UtcNow.AddDays(-2) && db.Set<DiscoveryFollow>().Any(f => f.WorkspaceId == owner && f.BoardKey == j.BoardKey));
            return job is null ? Results.NotFound("No current listing in the permitted feed. Paste an authorized excerpt instead.") :
                Results.Ok(new { role = job.Title[..Math.Min(160,job.Title.Length)], company = slug,
                    description = $"{job.Title}\nBoard: {slug}. Location: {job.Location}. Mentioned skills (priority unknown): {job.Mentions}. Last seen {job.SeenUtc:yyyy-MM-dd}.",
                    source = policy.ReplayDirectory is null ? "Public listing metadata; verify the original posting." : "Offline fixture, not a live vacancy." });
        });
        app.MapGet("/api/targets", async (PracticeDb db, HttpContext c) =>
        {
            var targets = await db.Set<InterviewTarget>().AsNoTracking().Where(t => t.WorkspaceId == Owner(c)).ToArrayAsync();
            return Results.Ok(targets.Select(t => new { t.Id, t.Role, t.Company, t.Level, t.Round, t.Description, t.JobUrl,
                interviewAt = t.InterviewAt is { } at ? (DateTime?)Utc(at) : null, t.InterviewZone, t.ResearchStatus, t.ResearchedAt, sources = t.Sources() }));
        });
        app.MapPost("/api/targets", async (TargetInput input, PracticeDb db, HttpContext c) =>
        {
            if (!Text(input.Role, 160) || !Text(input.Level, 80) || !Text(input.Round, 80) ||
                (input.Description?.Length ?? 0) > 12000 || (input.Company?.Length ?? 0) > 100 ||
                (!string.IsNullOrWhiteSpace(input.JobUrl) && !PublicResearch.IsHttpsLink(input.JobUrl)))
                return Results.BadRequest("Provide a role, level and round; use an HTTPS bookmark and a description under 12,000 characters.");
            var target = new InterviewTarget { WorkspaceId = Owner(c), Role = input.Role!.Trim(), Company = input.Company?.Trim() ?? "",
                Level = input.Level!.Trim(), Round = input.Round!.Trim(), Description = input.Description?.Trim() ?? "",
                JobUrl = string.IsNullOrWhiteSpace(input.JobUrl) ? null : new Uri(input.JobUrl.Trim()).GetLeftPart(UriPartial.Path) };
            db.Add(target); await db.SaveChangesAsync();
            return Results.Ok(new { target.Id });
        });
        app.MapPost("/api/targets/{id:guid}/research", async (Guid id, ResearchInput input, PracticeDb db, HttpContext c, PublicResearch research) =>
        {
            var target = await Target(db, c, id); if (target is null) return Results.NotFound();
            if (!input.PublicCompanyLookup || !PublicResearch.IsCompany(target.Company))
                return Results.BadRequest("Explicitly approve looking up the public company name. Never enter private experience as a company.");
            if (target.ResearchedAt > DateTime.UtcNow.AddMinutes(-10)) return Results.NoContent();
            var result = await research.Find(target.Company, c.RequestAborted);
            target.ResearchJson = JsonSerializer.Serialize(result.Sources);
            target.ResearchedAt = DateTime.UtcNow; target.ResearchStatus = result.Status;
            await db.SaveChangesAsync(); return Results.NoContent();
        });
        app.MapPost("/api/targets/{id:guid}/schedule/{mode}", async (Guid id, string mode, PlanInput input, PracticeDb db, HttpContext c) =>
        {
            if (mode is not ("preview" or "confirm")) return Results.NotFound();
            if (await Target(db, c, id) is null) return Results.NotFound();
            var now = DateTimeOffset.UtcNow;
            if (input.InterviewAt <= now || input.InterviewAt > now.AddYears(2) || input.Windows is not { Length: > 0 and <= 40 } ||
                string.IsNullOrWhiteSpace(input.Zone) || !TimeZoneInfo.TryFindSystemTimeZoneById(input.Zone, out _))
                return Results.BadRequest("Choose a future interview, a valid timezone and one or more availability windows.");
            if (input.Windows.Any(w => w is null)) return Results.BadRequest("Each window needs a start and end.");
            var windows = input.Windows.OrderBy(w => w.Start).ToArray();
            if (windows.Any(w => w.Start <= now || w.End > input.InterviewAt || w.End <= w.Start || w.End - w.Start > TimeSpan.FromHours(16)) ||
                windows.Zip(windows.Skip(1)).Any(pair => pair.First.End > pair.Second.Start))
                return Results.BadRequest("Availability must be in the future, before the interview, and must not overlap.");
            var plan = await db.Set<PrepSchedule>().Include(x => x.Blocks).SingleOrDefaultAsync(x => x.TargetId == id && x.WorkspaceId == Owner(c));
            var preserved = plan?.Blocks.Where(b => b.State == "done" || b.AttemptId.HasValue).ToArray() ?? [];
            var free = windows.ToList();
            foreach (var b in preserved) free = Subtract(free, Utc(b.StartsAt), Utc(b.StartsAt).AddMinutes(b.Minutes));
            var proposed = Arrange(free, preserved, TimeZoneInfo.FindSystemTimeZoneById(input.Zone));
            if (mode == "preview") return Results.Ok(new { blocks = proposed.Select(BlockView), preserved = preserved.Length });
            if (proposed.Count == 0 && preserved.Length == 0) return Results.Conflict("No practice block fits; the existing plan has not changed.");
            if (plan is not null)
                foreach (var b in plan.Blocks.Except(preserved).ToArray()) db.Remove(b);
            StoreBlocks(db, Owner(c), id, plan, input with { Windows = windows }, proposed);
            await db.SaveChangesAsync(); return Results.NoContent();
        });
        app.MapGet("/api/targets/{id:guid}/progress", async (Guid id, PracticeDb db, HttpContext c) =>
        {
            if (await Target(db, c, id) is null) return Results.NotFound();
            var plan = await db.Set<PrepSchedule>().AsNoTracking().Include(x => x.Blocks).SingleOrDefaultAsync(x => x.TargetId == id && x.WorkspaceId == Owner(c));
            var attempts = await db.Mocks.AsNoTracking().Where(m => m.TargetId == id && m.WorkspaceId == Owner(c)).ToListAsync();
            var recent = attempts.Where(m => m.Rubric == Practice.Version && m.Report()?.Assessor is ("local" or PracticeScreen.Assessor) &&
                m.CompletedAt >= DateTime.UtcNow.AddDays(-30)).OrderByDescending(m => m.CompletedAt).ToArray();
            var assessor = recent.FirstOrDefault()?.Report()?.Assessor;
            var eligible = recent.Where(m => m.Report()!.Assessor == assessor).ToArray();
            var latest = eligible.FirstOrDefault()?.Report(); var before = eligible.Skip(1).FirstOrDefault()?.Report();
            string readiness = latest is null ? "Not assessed" : latest.Verdict != "Simulated hire" ? "Needs practice" :
                before?.Verdict == "Simulated hire" ? "Consistent in practice" : "On track: one passing mock";
            return Results.Ok(new { readiness, assessor, comparable = eligible.Length,
                delta = latest is not null && before is not null ? (decimal?)(latest.Score - before.Score) : null,
                competencies = latest?.Marks.Select((m, i) => new { name = Practice.Probes[i].Name, m.Points, delta = before is null ? (int?)null : m.Points - before.Marks[i].Points }),
                attempts = attempts.OrderByDescending(m => m.StartedAt).Select(m => new { m.Id, startedAt = Utc(m.StartedAt), completedAt = m.CompletedAt is DateTime d ? (DateTime?)Utc(d) : null, assessor = m.Report()?.Assessor, score = m.Report()?.Score }),
                plan = plan is null ? null : new { interviewAt = Utc(plan.InterviewAt), plan.Zone, blocks = plan.Blocks.OrderBy(b => b.StartsAt).Select(BlockView) } });
        });
        app.MapPost("/api/blocks/{id:guid}", async (Guid id, BlockEdit input, PracticeDb db, HttpContext c) =>
        {
            var plan = await db.Set<PrepSchedule>().Include(p => p.Blocks).SingleOrDefaultAsync(p => p.WorkspaceId == Owner(c) && p.Blocks.Any(b => b.Id == id));
            if (plan is null) return Results.NotFound();
            var b = plan.Blocks.Single(b => b.Id == id);
            if (b.State != "planned" || b.AttemptId.HasValue) return Results.Conflict("This block has already started or closed.");
            if (input.Action == "move" && input.StartsAt is { } start)
            {
                var end = start.AddMinutes(b.Minutes);
                if (start <= DateTimeOffset.UtcNow || end.UtcDateTime > plan.InterviewAt ||
                    !JsonSerializer.Deserialize<Window[]>(plan.WindowsJson)!.Any(w => start >= w.Start && end <= w.End) ||
                    plan.Blocks.Any(x => x.Id != b.Id && x.State != "skipped" && x.StartsAt < end.UtcDateTime && x.StartsAt.AddMinutes(x.Minutes) > start.UtcDateTime))
                    return Results.BadRequest("Move the block into an unused part of your availability before the interview.");
                b.StartsAt = start.UtcDateTime;
            }
            else if (input.Action == "skip") b.State = "skipped";
            else if (input.Action == "done" && b.Kind != "mock") b.State = "done";
            else return Results.BadRequest("A mock is completed only by finishing its practice round.");
            await db.SaveChangesAsync(); return Results.NoContent();
        });
        app.MapPost("/api/mocks/{id:guid}/proposals", async (Guid id, ProposalInput input, PracticeDb db, HttpContext c) =>
        {
            var mock = await db.Mocks.SingleOrDefaultAsync(m => m.Id == id && m.WorkspaceId == Owner(c)); if (mock is null) return Results.NotFound();
            if (mock.ReportJson is null || input.Index is not int index || index < 0 || index >= mock.Answers().Length ||
                !Text(input.Excerpt, 2000) || !Text(input.Project, 100) || !mock.Answers()[index].Contains(input.Excerpt!.Trim(), StringComparison.Ordinal))
                return Results.BadRequest("Select your own words from a completed answer and name the project.");
            if (!await db.Facts.AnyAsync(f => f.WorkspaceId == Owner(c) && f.SourceMockId == id && f.SourceTurn == index && f.Source == input.Excerpt.Trim()))
            {
                db.Add(new Fact { WorkspaceId = Owner(c), Project = input.Project!.Trim(), SourceMockId = id, SourceTurn = index,
                    Origin = $"mock answer {index + 1}", Source = input.Excerpt.Trim(), Claim = input.Excerpt.Trim() });
                await db.SaveChangesAsync();
            }
            return Results.NoContent();
        });
        app.MapPost("/api/mocks/{id:guid}/feedback", async (Guid id, VoteInput input, PracticeDb db, HttpContext c) =>
        {
            var m = await db.Mocks.SingleOrDefaultAsync(x => x.Id == id && x.WorkspaceId == Owner(c)); if (m is null) return Results.NotFound();
            if (input.Item is not ("report" or "Ownership" or "Impact" or "Judgment" or "Clarity") || input.Vote is not ("up" or "down") ||
                input.Reason is not (null or "" or "wrong fact" or "unfair grade" or "irrelevant" or "helpful" or "unsupported") || m.ReportJson is null)
                return Results.BadRequest("Choose a completed report item and a feedback reason.");
            var vote = await db.Set<CoachFeedback>().SingleOrDefaultAsync(x => x.MockId == id && x.WorkspaceId == Owner(c) && x.Item == input.Item);
            if (vote is null) { vote = new() { WorkspaceId = Owner(c), MockId = id, Item = input.Item, Vote = input.Vote }; db.Add(vote); }
            vote.Vote = input.Vote; vote.Reason = input.Reason ?? ""; await db.SaveChangesAsync();
            return Results.NoContent();
        });
        app.MapGet("/api/mocks/{id:guid}/review", async (Guid id, PracticeDb db, HttpContext c) =>
        {
            if (!await db.Mocks.AnyAsync(m => m.Id == id && m.WorkspaceId == Owner(c) && m.ReportJson != null)) return Results.NotFound();
            var votes = await db.Set<CoachFeedback>().Where(v => v.MockId == id).Select(v => new { v.Item, v.Vote, v.Reason }).ToListAsync();
            var challenges = await db.Set<AssessmentChallenge>().Where(x => x.MockId == id).OrderBy(x => x.Turn)
                .Select(x => new { x.Turn, x.Excerpt, x.Note, x.SecondOpinion }).ToListAsync();
            var checks = await db.Set<QualityCheck>().Where(x => x.MockId == id).OrderBy(x => x.Id).Select(x => new { x.Check, x.Passed }).ToListAsync();
            return Results.Ok(new { votes, challenges, checks });
        });
        app.MapPost("/api/mocks/{id:guid}/challenges", async (Guid id, ChallengeInput input, PracticeDb db, HttpContext c, LocalCoach coach) =>
        {
            var mock = await db.Mocks.SingleOrDefaultAsync(m => m.Id == id && m.WorkspaceId == Owner(c));
            if (mock is null) return Results.NotFound();
            var report = mock.Report();
            if (report is null || input.Turn < 0 || input.Turn >= report.Marks.Length || !Text(input.Note, 600) || !Text(input.Excerpt, 320) ||
                !mock.Answers()[input.Turn].Contains(input.Excerpt!.Trim(), StringComparison.Ordinal))
                return Results.BadRequest("Select a passage from the original answer and explain the disagreement.");
            if (input.AskLocalCoach && Environment.GetEnvironmentVariable("INTERVIEW_PREP_MODEL_PORT") is null)
                return Results.BadRequest("No local coach configured.");
            var challenge = await db.Set<AssessmentChallenge>().SingleOrDefaultAsync(x => x.MockId == id && x.Turn == input.Turn);
            if (challenge is not null && challenge.Excerpt == input.Excerpt.Trim() && challenge.Note == input.Note!.Trim() &&
                (!input.AskLocalCoach || challenge.SecondOpinion is not null)) return Results.NoContent();
            if (challenge is null) { challenge = new() { MockId = id, Turn = input.Turn, Note = "", Excerpt = "" }; db.Add(challenge); }
            challenge.Note = input.Note!.Trim(); challenge.Excerpt = input.Excerpt.Trim(); challenge.SecondOpinion = null;
            if (input.AskLocalCoach)
            {
                var marks = await coach.Assess(mock.Target, mock.Questions(), mock.Answers(), c.RequestAborted);
                if (marks is not null)
                {
                    var mark = marks[input.Turn];
                    challenge.SecondOpinion = $"{mark.Points}/4: \"{mark.Quote}\" - {mark.Feedback}";
                }
            }
            await db.SaveChangesAsync(); return Results.NoContent();
        });
    }

    static object BlockView(PrepBlock b) => new { b.Id, b.Kind, b.Label, startsAt = Utc(b.StartsAt), b.Minutes, b.State, b.AttemptId };
    static List<Window> Subtract(List<Window> slots, DateTimeOffset start, DateTimeOffset end) =>
        slots.SelectMany(w => w.End <= start || w.Start >= end ? [w] : new[] { new Window(w.Start, start), new Window(end, w.End) }
            .Where(x => x.Start < x.End)).ToList();

    internal static void StoreBlocks(PracticeDb db, Guid owner, Guid targetId, PrepSchedule? plan, PlanInput input, List<PrepBlock> proposed)
    {
        if (plan is null) { plan = new() { WorkspaceId = owner, TargetId = targetId, Zone = input.Zone!, WindowsJson = "" }; db.Add(plan); }
        plan.InterviewAt = input.InterviewAt.UtcDateTime; plan.Zone = input.Zone!; plan.WindowsJson = JsonSerializer.Serialize(input.Windows);
        foreach (var b in proposed) { b.ScheduleId = plan.Id; db.Add(b); }
    }

    internal const int MockMinutes = 25;
    internal static List<PrepBlock> Arrange(List<Window> free, PrepBlock[] kept, TimeZoneInfo zone, bool mocksOnly = false)
    {
        (string Kind, string Label, int Minutes)[] wanted = [("mock","Baseline mock",MockMinutes),("review","Review feedback",15),
            ("mock","Follow-up mock",MockMinutes),("drill","Final rehearsal",10)];
        var options = mocksOnly ? new[] { new[] { wanted[0], wanted[2] }, wanted[..1] } :
            new[] { wanted, wanted[..3], wanted[..2], wanted[..1], wanted[3..] };
        foreach (var candidate in options)
        foreach (var spaceDays in new[] { true, false })
        {
            var result = new List<PrepBlock>(); var deadline = DateTimeOffset.MaxValue; bool fits = true;
            foreach (var item in candidate.Reverse())
            {
                if (kept.FirstOrDefault(b => b.Label == item.Label) is { } existing)
                {
                    if (Utc(existing.StartsAt).AddMinutes(existing.Minutes) > deadline) { fits = false; break; }
                    deadline = Utc(existing.StartsAt); continue;
                }
                var ends = free.Select(w => (w.Start, End: w.End < deadline ? w.End : deadline))
                    .Where(w => w.End - w.Start >= TimeSpan.FromMinutes(item.Minutes)).Select(w => w.End).Reverse().ToList();
                if (ends.Count == 0) { fits = false; break; }
                var end = ends[0];
                if (spaceDays && deadline != DateTimeOffset.MaxValue)
                    end = ends.FirstOrDefault(e => TimeZoneInfo.ConvertTime(e.AddTicks(-1), zone).Date < TimeZoneInfo.ConvertTime(deadline, zone).Date, end);
                deadline = end.AddMinutes(-item.Minutes);
                result.Add(new() { Kind = item.Kind, Label = item.Label, StartsAt = deadline.UtcDateTime, Minutes = item.Minutes });
            }
            if (fits) { result.Reverse(); return result; }
        }
        return [];
    }
}
