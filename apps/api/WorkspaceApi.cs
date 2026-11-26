using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

public static class WorkspaceApi
{
    private const string Cookie = "practice_workspace";
    public sealed record AddFact(string? Project, string? Statement);
    public sealed record Confirm(string? Claim);
    public sealed record Start(string? Target, bool Tailor = false);
    public sealed record Answer(int? Index, string? Text);
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
                .Select(f => new { f.Id, f.Project, f.Source, f.Claim, f.Confirmed }).ToListAsync();
            var mocks = await db.Mocks.AsNoTracking().Where(m => m.WorkspaceId == owner).OrderByDescending(m => m.StartedAt).ToListAsync();
            return Results.Ok(new { facts, probes = Practice.Probes, localCoachEnabled, mocks = mocks.Select(m =>
                new { m.Id, m.Target, m.Rubric, m.StartedAt, m.Tailored, questions = m.Questions(), answers = m.Answers(), report = m.Report(), m.Retry }) });
        });
        app.MapDelete("/api/workspace", async (HttpContext c, PracticeDb db) =>
        {
            await db.Workspaces.Where(w => w.Id == Owner(c)).ExecuteDeleteAsync();
            c.Response.Cookies.Delete(Cookie, new CookieOptions { Path = "/api" });
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
            fact.Claim = input.Claim!.Trim();
            fact.Confirmed = true;
            await db.SaveChangesAsync();
            return Results.NoContent();
        });
        app.MapDelete("/api/evidence/{id:guid}", async (Guid id, HttpContext c, PracticeDb db) =>
            await db.Facts.Where(f => f.WorkspaceId == Owner(c) && f.Id == id).ExecuteDeleteAsync() == 0
                ? Results.NotFound() : Results.NoContent());
        app.MapPost("/api/mocks", async (Start input, HttpContext c, PracticeDb db, LocalCoach coach) =>
        {
            if (!Valid(input.Target, 2000)) return Results.BadRequest("Describe the role or paste a short job description.");
            var target = input.Target!.Trim();
            if (input.Tailor && !localCoachEnabled) return Results.BadRequest("No local coach is configured.");
            var questions = input.Tailor ? await coach.Plan(target, c.RequestAborted) : Practice.Probes.Select(p => p.Question).ToArray();
            if (questions is null) return Results.Json("The local coach did not return a valid round. Retry or use the standard questions.", statusCode: 503);
            var mock = new Mock { WorkspaceId = Owner(c), Target = target, Tailored = input.Tailor, QuestionsJson = JsonSerializer.Serialize(questions) };
            db.Add(mock);
            await db.SaveChangesAsync();
            return Results.Ok(new { mock.Id });
        });
        app.MapPost("/api/mocks/{id:guid}/answers", async (Guid id, Answer input, HttpContext c, PracticeDb db) =>
        {
            var mock = await Find(db, c, id);
            if (mock is null) return Results.NotFound();
            if (input.Index is not int index || index < 0 || index >= Practice.Probes.Length || !Valid(input.Text, 3000))
                return Results.BadRequest("Answer the current question in 1 to 3,000 characters.");
            var answers = mock.Answers();
            var text = input.Text!.Trim();
            if (index < answers.Length && answers[index] == text) return Results.NoContent();
            if (index != answers.Length || mock.ReportJson is not null) return Results.Conflict("This is not the current question.");
            mock.AnswersJson = JsonSerializer.Serialize(answers.Append(text));
            mock.Revision++;
            await db.SaveChangesAsync();
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
            else if (input.Assessor == "local" && localCoachEnabled && input.Points is null)
            {
                marks = await coach.Assess(mock.Target, mock.Questions(), answers, c.RequestAborted);
                if (marks is null) return Results.Json("No validated local assessment was returned. Your answers are saved; retry or choose self-assessment.", statusCode: 503);
            }
            else return Results.BadRequest("Choose an available assessor. Self-assessment needs four ratings from 0 to 4.");
            mock.ReportJson = JsonSerializer.Serialize(Practice.Assess(input.Assessor!, marks));
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
