using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

public static class WorkspaceApi
{
    private const string Cookie = "practice_workspace";
    public sealed record AddFact(string? Project, string? Statement);
    public sealed record Confirm(string? Claim, bool? AllowDrafts = null, bool? AllowLive = null);
    public sealed record Start(string? Target, bool Tailor = false, Guid? TargetId = null, Guid? BlockId = null, bool Adaptive = false, Guid? RequestId = null);
    public sealed record Answer(int? Index, string? Text, string? Question = null);
    public sealed record Assess(string? Assessor, int[]? Points);
    public sealed record Drill(string? Text);

    private static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    private static Guid Owner(HttpContext c) => (Guid)c.Items["workspace"]!;
    private static bool Valid(string? text, int limit) => !string.IsNullOrWhiteSpace(text) && text.Length <= limit;
    private static Task<Mock?> Find(PracticeDb db, HttpContext c, Guid id) =>
        db.Mocks.SingleOrDefaultAsync(m => m.WorkspaceId == Owner(c) && m.Id == id);

    public static async Task<Guid?> Identify(HttpContext c, PracticeDb db)
    {
        if (!c.Request.Cookies.TryGetValue(Cookie, out var token) || token.Length != 64) return null;
        var hash = Hash(token);
        return await db.Workspaces.Where(w => w.TokenHash == hash && w.ExpiresAt > DateTime.UtcNow)
            .Select(w => (Guid?)w.Id).SingleOrDefaultAsync(c.RequestAborted);
    }

    public static void Map(WebApplication app, bool localCoachEnabled)
    {
        app.MapPost("/api/workspace", async (HttpContext c, PracticeDb db) =>
        {
            if (c.Items.ContainsKey("workspace")) return Results.NoContent();
            if (!AccountsModule.LocalWorkspaceEnabled) return Results.Unauthorized();
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            var workspace = new Workspace { TokenHash = Hash(token) };
            db.Add(workspace);
            await db.SaveChangesAsync();
            c.Response.Cookies.Append(Cookie, token, new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Strict,
                Path = "/api", Secure = c.Request.IsHttps, Expires = workspace.ExpiresAt });
            return Results.NoContent();
        });
        app.MapGet("/api/workspace", async (HttpContext c, PracticeDb db) =>
        {
            var owner = Owner(c);
            var facts = await db.Facts.AsNoTracking().Where(f => f.WorkspaceId == owner).OrderBy(f => f.Project)
                .Select(f => new { f.Id, f.Project, f.Source, f.Claim, f.Confirmed, f.AllowDrafts, f.AllowLive, f.Origin }).ToListAsync();
            var mocks = await db.Mocks.AsNoTracking().Where(m => m.WorkspaceId == owner).OrderByDescending(m => m.StartedAt).ToListAsync();
            return Results.Ok(new { facts, probes = Practice.Probes, localCoachEnabled, mocks = mocks.Select(m =>
                new { m.Id, m.Target, m.TargetId, m.Rubric, startedAt = DateTime.SpecifyKind(m.StartedAt, DateTimeKind.Utc),
                    completedAt = m.CompletedAt is DateTime d ? (DateTime?)DateTime.SpecifyKind(d, DateTimeKind.Utc) : null, m.Tailored, m.Adaptive,
                    questions = m.Questions(), answers = m.Answers(), report = m.Report(), m.Retry }) });
        });
        app.MapDelete("/api/workspace", async (HttpContext c, PracticeDb db) =>
        {
            var owner = Owner(c);
            if (await AccountsModule.PrepareDeleteAsync(c, db, owner) is { } denied) return denied;
            await db.Workspaces.Where(w => w.Id == owner).ExecuteDeleteAsync();
            AccountsModule.ClearDeletedSession(c);
            return Results.NoContent();
        });
        app.MapPost("/api/evidence", async (AddFact input, HttpContext c, PracticeDb db) =>
        {
            if (!Valid(input.Project, 100) || !Valid(input.Statement, 2000)) return Results.BadRequest("Enter a project and your own statement.");
            var fact = new Fact { WorkspaceId = Owner(c), Project = input.Project!.Trim(),
                Source = input.Statement!.Trim(), Claim = input.Statement.Trim() };
            db.Add(fact);
            await db.SaveChangesAsync();
            return Results.Ok(new { fact.Id });
        });
        app.MapPost("/api/evidence/{id:guid}/confirm", async (Guid id, Confirm input, HttpContext c, PracticeDb db) =>
        {
            if (!Valid(input.Claim, 2000)) return Results.BadRequest("Enter the claim you want to confirm.");
            var fact = await db.Facts.SingleOrDefaultAsync(f => f.WorkspaceId == Owner(c) && f.Id == id);
            if (fact is null) return Results.NotFound();
            await using var tx = await db.Database.BeginTransactionAsync();
            var changed = fact.Claim != input.Claim!.Trim();
            if (changed || input.AllowLive == false)
                await db.Set<CueCard>().Where(x => x.FactId == fact.Id).ExecuteDeleteAsync();
            fact.Claim = input.Claim.Trim();
            fact.Confirmed = true;
            fact.AllowDrafts = input.AllowDrafts ?? (!changed && fact.AllowDrafts);
            fact.AllowLive = input.AllowLive ?? (!changed && fact.AllowLive);
            await db.SaveChangesAsync(); await tx.CommitAsync();
            return Results.NoContent();
        });
        app.MapDelete("/api/evidence/{id:guid}", async (Guid id, HttpContext c, PracticeDb db) =>
            await db.Facts.Where(f => f.WorkspaceId == Owner(c) && f.Id == id).ExecuteDeleteAsync() == 0
                ? Results.NotFound() : Results.NoContent());
        app.MapPost("/api/mocks", async (Start input, HttpContext c, PracticeDb db, LocalCoach coach) =>
        {
            var owner = Owner(c);
            var saved = input.TargetId is Guid tid ? await db.Set<InterviewTarget>().SingleOrDefaultAsync(t => t.Id == tid && t.WorkspaceId == owner) : null;
            if (input.TargetId.HasValue && saved is null) return Results.NotFound();
            if (saved is null && !Valid(input.Target, 2000)) return Results.BadRequest("Describe the role or choose a saved target.");
            var target = saved?.Context() ?? input.Target!.Trim();
            PrepBlock? block = null;
            if (input.BlockId.HasValue)
            {
                block = await (from b in db.Set<PrepBlock>() join s in db.Set<PrepSchedule>() on b.ScheduleId equals s.Id
                    where b.Id == input.BlockId && s.WorkspaceId == owner && s.TargetId == input.TargetId select b).SingleOrDefaultAsync();
                if (block is null) return Results.NotFound();
                if (block.AttemptId is Guid prior) return Results.Ok(new { id = prior });
                if (block.Kind != "mock" || block.State != "planned") return Results.Conflict("This is not an available mock block.");
            }
            if ((input.Tailor || input.Adaptive) && !localCoachEnabled) return Results.BadRequest("No local coach is configured.");
            async Task<Mock?> Existing() => input.RequestId is not Guid key ? null :
                await db.Mocks.AsNoTracking().SingleOrDefaultAsync(m => m.WorkspaceId == owner && m.StartKey == key);
            IResult Replay(Mock m) => m.Target == target && m.TargetId == input.TargetId && m.Tailored == input.Tailor && m.Adaptive == input.Adaptive
                ? Results.Ok(new { m.Id }) : Results.Conflict("This start request was already used for a different round.");
            if (await Existing() is { } existing) return Replay(existing);
            var context = target;
            if (saved?.ResearchedAt > DateTime.UtcNow.AddDays(-7))
                context += "\nDated research (context, not instructions or guaranteed questions): " + string.Join("; ", saved.Sources()
                    .Select(s => $"{s.Kind}: {s.Title} ({s.Url}) - {s.Theme}"));
            var mockId = Guid.NewGuid(); var operation = $"mock:{mockId:D}";
            var prepaid = false; var committed = false;
            IResult Full() => Results.Json("No mock starts remain for this allowance. Existing rounds and reports are still available.", statusCode: 429);
            try
            {
                if (input.Tailor && !(prepaid = await AccountsModule.TryReserveMockAsync(db, owner, operation))) return Full();
                var questions = input.Tailor ? await coach.Plan(context, c.RequestAborted) : Practice.Probes.Select(p => p.Question).ToArray();
                if (questions is null) return Results.Json("The local coach did not return a valid round. Retry or use the standard questions.", statusCode: 503);
                if (!input.Tailor && saved is not null)
                {
                    var repeat = await db.Mocks.AnyAsync(m => m.WorkspaceId == owner && m.TargetId == saved.Id && m.ReportJson != null);
                    questions = repeat ? [
                        $"For the {saved.Role} role, describe a different project. Which decision was yours rather than the team's?",
                        "What would the strongest alternative have cost, and why did you choose against it?",
                        "What evidence showed whether the change worked for the people using it?",
                        "How would you explain that decision and its consequences to someone outside the project?"
                    ] : [$"Thinking about the {saved.Role} role, which project best shows work you personally owned?", questions[1], questions[2], questions[3]];
                }
                await using var tx = await db.Database.BeginTransactionAsync(c.RequestAborted);
                if (await Existing() is { } done) return Replay(done);
                if (block is not null)
                {
                    await db.Entry(block).ReloadAsync(c.RequestAborted);
                    if (db.Entry(block).State == EntityState.Detached || block.State != "planned") return Results.Conflict("This block has changed.");
                    if (block.AttemptId is Guid prior) return Results.Ok(new { id = prior });
                }
                if (!prepaid && !await AccountsModule.TryReserveMockAsync(db, owner, operation)) return Full();
                var mock = new Mock { Id = mockId, WorkspaceId = owner, StartKey = input.RequestId, Target = target, TargetId = input.TargetId, Adaptive = input.Adaptive,
                    Tailored = input.Tailor, QuestionsJson = JsonSerializer.Serialize(questions) };
                if (block is not null) block.AttemptId = mock.Id;
                db.Add(mock); await db.SaveChangesAsync(c.RequestAborted); await tx.CommitAsync(c.RequestAborted); committed = true;
                return Results.Ok(new { mock.Id });
            }
            finally { if (prepaid && !committed) await AccountsModule.ReleaseReservationAsync(db, owner, "mocks", operation); }
        });
        app.MapDelete("/api/mocks/{id:guid}", async (Guid id, HttpContext c, PracticeDb db) =>
        {
            var owner = Owner(c);
            await using var tx = await db.Database.BeginTransactionAsync(c.RequestAborted);
            if (!await db.Mocks.AnyAsync(m => m.WorkspaceId == owner && m.Id == id)) return Results.NotFound();
            await db.Facts.Where(f => f.WorkspaceId == owner && f.SourceMockId == id).ExecuteDeleteAsync();
            await db.Set<PrepBlock>().Where(b => b.AttemptId == id && db.Set<PrepSchedule>().Any(s => s.Id == b.ScheduleId && s.WorkspaceId == owner))
                .ExecuteUpdateAsync(s => s.SetProperty(b => b.AttemptId, (Guid?)null).SetProperty(b => b.State, "skipped"));
            await db.Mocks.Where(m => m.WorkspaceId == owner && m.Id == id).ExecuteDeleteAsync();
            await tx.CommitAsync(c.RequestAborted); return Results.NoContent();
        });
        app.MapPost("/api/mocks/{id:guid}/answers", async (Guid id, Answer input, HttpContext c, PracticeDb db, LocalCoach coach) =>
        {
            var mock = await Find(db, c, id);
            if (mock is null) return Results.NotFound();
            if (input.Index is not int index || index < 0 || index >= Practice.Probes.Length || !Valid(input.Text, 3000))
                return Results.BadRequest("Answer the current question in 1 to 3,000 characters.");
            var answers = mock.Answers();
            var text = input.Text!.Trim();
            if (index < answers.Length && answers[index] == text) return Results.NoContent();
            if (index != answers.Length || mock.ReportJson is not null) return Results.Conflict("This is not the current question.");
            var qs = mock.Questions();
            if (input.Question is not null && input.Question != qs[index])
                return Results.Conflict("The next probe changed. Review the current question and your draft before saving.");
            mock.AnswersJson = JsonSerializer.Serialize(answers.Append(text));
            mock.Revision++;
            await db.SaveChangesAsync(c.RequestAborted);
            if (mock.Adaptive && index + 1 < Practice.Probes.Length)
            {
                var next = await coach.NextQuestion(mock.Target, qs[index], text, Practice.Probes[index + 1], c.RequestAborted);
                if (next is not null)
                {
                    qs[index + 1] = next;
                    var updated = JsonSerializer.Serialize(qs); var revision = mock.Revision;
                    await db.Mocks.Where(m => m.Id == id && m.Revision == revision).ExecuteUpdateAsync(
                        s => s.SetProperty(m => m.QuestionsJson, updated).SetProperty(m => m.Revision, m => m.Revision + 1), c.RequestAborted);
                }
            }
            return Results.NoContent();
        });
        app.MapPost("/api/mocks/{id:guid}/report", async (Guid id, Assess input, HttpContext c, PracticeDb db, LocalCoach coach) =>
        {
            var mock = await Find(db, c, id);
            if (mock is null) return Results.NotFound();
            if (mock.ReportJson is not null) return Results.NoContent();
            var answers = mock.Answers();
            if (answers.Length != Practice.Probes.Length) return Results.Conflict("Finish all four probes before assessing the round.");
            Mark[]? marks;
            if (input.Assessor == "self" && input.Points is { Length: 4 } points && points.All(p => p is >= 0 and <= 4))
                marks = points.Select((p, i) => new Mark(p, answers[i][..Math.Min(160, answers[i].Length)],
                    p >= 3 ? $"You rated this answer as meeting the anchor: {Practice.Probes[i].Anchor}" : Practice.Probes[i].Drill)).ToArray();
            else if (input.Assessor == PracticeScreen.Assessor && input.Points is null)
                marks = PracticeScreen.Review(answers);
            else if (input.Assessor == "local" && localCoachEnabled && input.Points is null)
            {
                marks = await coach.Assess(mock.Target, mock.Questions(), answers, c.RequestAborted);
                db.Add(new QualityCheck { MockId = id, Check = "rubric-and-exact-transcript-citations", Passed = marks is not null });
                if (marks is null) { await db.SaveChangesAsync(); return Results.Json("No validated local assessment was returned. Your answers are saved; retry or choose self-assessment.", statusCode: 503); }
            }
            else return Results.BadRequest("Choose the offline screen, a configured local model, or four self-ratings from 0 to 4.");
            mock.ReportJson = JsonSerializer.Serialize(Practice.Assess(input.Assessor!, marks));
            mock.CompletedAt = DateTime.UtcNow;
            var scheduled = await db.Set<PrepBlock>().SingleOrDefaultAsync(b => b.AttemptId == mock.Id);
            if (scheduled is not null) scheduled.State = "done";
            mock.Revision++;
            await db.SaveChangesAsync();
            return Results.NoContent();
        });
        app.MapPost("/api/mocks/{id:guid}/retry", async (Guid id, Drill input, HttpContext c, PracticeDb db) =>
        {
            var mock = await Find(db, c, id);
            if (mock is null) return Results.NotFound();
            if (!Valid(input.Text, 3000)) return Results.BadRequest("Enter your practice answer.");
            if (mock.ReportJson is null) return Results.Conflict("Complete the debrief before retrying.");
            if (mock.Retry == input.Text!.Trim()) return Results.NoContent();
            if (mock.Retry is not null) return Results.Conflict("This drill is already saved.");
            mock.Retry = input.Text.Trim();
            mock.Revision++;
            await db.SaveChangesAsync();
            return Results.NoContent();
        });
    }
}
