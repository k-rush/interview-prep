using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

public sealed class ChatSession
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid WorkspaceId { get; set; }
    public Guid? StartKey { get; set; }
    public Guid? StartBlockId { get; set; }
    public string Kind { get; set; } = "builder";
    public string Title { get; set; } = "Experience builder";
    public string State { get; set; } = "active";
    public string Stage { get; set; } = "open";
    public string ContextJson { get; set; } = "{}";
    public Guid? TargetId { get; set; }
    public Guid? DigestId { get; set; }
    public Guid? SourceId { get; set; }
    public Guid? NodeId { get; set; }
    public string? PendingSearch { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    [ConcurrencyCheck] public int Revision { get; set; }
}

internal sealed class ChatMessage
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ChatId { get; set; }
    public Guid WorkspaceId { get; set; }
    public ChatSession Session { get; set; } = null!;
    public int Seq { get; set; }
    public string Speaker { get; set; } = "assistant";
    public string Text { get; set; } = "";
    public string Mode { get; set; } = "studio";
    public Guid? RequestId { get; set; }
    public Guid? NextChatId { get; set; }
    public bool Recallable { get; set; }
    public string? Vote { get; set; }
}

internal sealed class ChatNote
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid WorkspaceId { get; set; }
    public Guid ChatId { get; set; }
    public string Text { get; set; } = "";
}

internal static partial class ChatModule
{
    internal sealed record StartInput(string? Kind, Guid? RequestId, Guid? TargetId, Guid? BlockId);
    internal sealed record TurnInput(string? Text, Guid RequestId, int? Revision, string? Zone, string? Action);
    internal sealed record SearchInput(string? Query);
    internal sealed record VoteInput(string? Vote);
    private static bool Model => Environment.GetEnvironmentVariable("INTERVIEW_PREP_MODEL_PORT") is not null;
    private static Guid Owner(HttpContext c) => (Guid)c.Items["workspace"]!;
    private static IQueryable<ChatSession> Owned(PracticeDb db, Guid owner) => db.Set<ChatSession>().Where(s => s.WorkspaceId == owner);
    private static DateTime Utc(DateTime d) => DateTime.SpecifyKind(d, DateTimeKind.Utc);
    private static bool Is(string text, string pattern) => Regex.IsMatch(text, pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static IResult Full() => Results.Json("This workspace has reached its allowance. Existing sessions are still available.", statusCode: 429);

    public static void Configure(ModelBuilder m)
    {
        var s = m.Entity<ChatSession>();
        s.HasOne<Workspace>().WithMany().HasForeignKey(c => c.WorkspaceId);
        s.HasIndex(c => new { c.WorkspaceId, c.StartKey }).IsUnique();
        s.HasIndex(c => new { c.WorkspaceId, c.UpdatedAt });
        var msg = m.Entity<ChatMessage>();
        msg.HasOne(c => c.Session).WithMany().HasForeignKey(c => new { c.WorkspaceId, c.ChatId })
            .HasPrincipalKey(c => new { c.WorkspaceId, c.Id });
        msg.HasIndex(c => new { c.ChatId, c.Seq }).IsUnique();
        msg.HasIndex(c => new { c.ChatId, c.RequestId }).IsUnique();
        m.Entity<ChatNote>().HasOne<ChatSession>().WithMany().HasForeignKey(n => new { n.WorkspaceId, n.ChatId })
            .HasPrincipalKey(c => new { c.WorkspaceId, c.Id });
    }

    internal static ChatMessage Message(PracticeDb db, ChatSession s, int seq, string text, string mode = "studio", Guid? request = null)
    {
        var msg = new ChatMessage { ChatId = s.Id, WorkspaceId = s.WorkspaceId, Seq = seq, Text = text, Mode = mode,
            Speaker = request is null ? "assistant" : "user", RequestId = request };
        db.Add(msg);
        return msg;
    }

    internal static void PublishDigest(PracticeDb db, DiscoveryDigest digest)
    {
        var s = new ChatSession { WorkspaceId = digest.WorkspaceId, Kind = "scout", Title = $"Job scout · {digest.TargetRole}",
            State = "closed", DigestId = digest.Id };
        db.Add(s); Message(db, s, 0, $"Job scout report · {digest.LocalDate}\n{digest.NextStep}", "report");
    }

    private static object Header(ChatSession s) => new { s.Id, s.Kind, s.Title, s.State, s.Stage, s.Revision, s.TargetId, s.DigestId, updatedAt = Utc(s.UpdatedAt) };
    public static void Map(WebApplication app)
    {
        var g = app.MapGroup("/api/chats");
        g.MapGet("", (HttpContext c, PracticeDb db, CancellationToken ct) =>
            Owned(db, Owner(c)).AsNoTracking().OrderByDescending(s => s.UpdatedAt).Take(200)
                .Select(s => new { s.Id, s.Kind, s.Title, s.State, s.Stage, s.Revision, s.TargetId, s.DigestId, updatedAt = Utc(s.UpdatedAt) }).ToArrayAsync(ct));
        g.MapGet("/{id:guid}", async (Guid id, HttpContext c, PracticeDb db, CancellationToken ct) =>
        {
            var owner = Owner(c);
            var s = await Owned(db, owner).AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, ct);
            if (s is null) return Results.NotFound();
            var messages = await db.Set<ChatMessage>().Where(m => m.WorkspaceId == owner && m.ChatId == id)
                .OrderBy(m => m.Seq).Select(m => new { m.Id, m.Speaker, m.Text, m.Mode, m.NextChatId, m.Vote }).ToArrayAsync(ct);
            return Results.Ok(new { session = Header(s), messages, s.PendingSearch });
        });
        g.MapPost("", Start);
        g.MapPost("/{id:guid}/import", ExperienceModule.RunDocument);
        g.MapPost("/{id:guid}/turns", Turn);
        g.MapDelete("/{id:guid}", Delete);
        g.MapGet("/archive", (HttpContext c, PracticeDb db, CancellationToken ct) => db.Set<ExperienceBuilder>()
            .Where(b => b.WorkspaceId == Owner(c)).OrderByDescending(b => b.UpdatedAt).Select(b => new { b.Id, b.Goal }).ToArrayAsync(ct));
        g.MapPut("/{id:guid}/feedback/{message:guid}", async (Guid id, Guid message, VoteInput input, HttpContext c, PracticeDb db, CancellationToken ct) =>
        {
            if (input.Vote is not ("up" or "down" or null)) return Results.BadRequest("Choose a helpful or unhelpful rating.");
            return await db.Set<ChatMessage>().Where(m => m.ChatId == id && m.WorkspaceId == Owner(c) && m.Id == message && m.Speaker == "assistant")
                .ExecuteUpdateAsync(x => x.SetProperty(m => m.Vote, input.Vote), ct) == 1 ? Results.NoContent() : Results.NotFound();
        });
        g.MapPost("/search", async (SearchInput input, HttpContext c, PracticeDb db, CancellationToken ct) =>
            input.Query?.Trim() is { Length: > 0 and <= 500 } q ? Results.Ok(await ChatRecall.Search(db, Owner(c), q, ct))
                : Results.BadRequest("Search with 1 to 500 characters."));
        g.MapGet("/memory", (HttpContext c, PracticeDb db, CancellationToken ct) => db.Set<ChatNote>().Where(n => n.WorkspaceId == Owner(c))
            .Select(n => new { n.Id, n.ChatId, n.Text }).ToArrayAsync(ct));
        g.MapDelete("/memory/{id:guid}", async (Guid id, HttpContext c, PracticeDb db, CancellationToken ct) =>
            await db.Set<ChatNote>().Where(n => n.WorkspaceId == Owner(c) && n.Id == id).ExecuteDeleteAsync(ct) == 1 ? Results.NoContent() : Results.NotFound());
    }

    private static async Task<IResult> Start(StartInput input, HttpContext c, PracticeDb db, CancellationToken ct)
    {
        var owner = Owner(c);
        if (input.Kind is not ("builder" or "plan" or "mock" or "scout") || input.RequestId == Guid.Empty ||
            (input.TargetId.HasValue || input.BlockId.HasValue) && input.Kind != "mock")
            return Results.BadRequest("Choose an experience, interview, planning or scout session.");
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        if (input.RequestId is Guid key && await Owned(db, owner).SingleOrDefaultAsync(s => s.StartKey == key, ct) is { } prior)
            return prior.Kind == input.Kind && (prior.Kind != "mock" || prior.TargetId == input.TargetId && prior.StartBlockId == input.BlockId)
                ? Results.Ok(new { prior.Id }) : Results.Conflict("Start key already used.");
        var s = new ChatSession { WorkspaceId = owner, Kind = input.Kind, StartKey = input.RequestId, TargetId = input.TargetId, StartBlockId = input.BlockId };
        if (await Owned(db, owner).CountAsync(ct) >= 200 || s.Kind is "builder" or "plan" &&
            !await AccountsModule.TryReserveBuilderAsync(db, owner, s.Id.ToString("N"))) return Full();
        var greeting = Greet(s);
        if (input.TargetId.HasValue || input.BlockId.HasValue)
        {
            var t = await db.Set<InterviewTarget>().SingleOrDefaultAsync(t => t.WorkspaceId == owner && t.Id == input.TargetId, ct);
            if (t is null) return Results.NotFound();
            PrepBlock? block = null;
            if (input.BlockId.HasValue)
            {
                block = await (from b in db.Set<PrepBlock>() join p in db.Set<PrepSchedule>() on b.ScheduleId equals p.Id
                    where p.WorkspaceId == owner && p.TargetId == t.Id && b.Id == input.BlockId select b).SingleOrDefaultAsync(ct);
                if (block is null) return Results.NotFound();
                if (block.AttemptId is Guid done) return Results.Ok(new { id = done });
                if (block.State != "planned" || block.Kind != "mock") return Results.Conflict("This mock block is no longer available.");
                block.AttemptId = s.Id;
            }
            if (!await AccountsModule.TryReserveMockAsync(db, owner, $"mock:{s.Id:D}")) return Full();
            greeting = BeginMock(db, s, t.Context(), t.Role);
        }
        db.Add(s); Message(db, s, 0, greeting);
        await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
        return Results.Ok(new { s.Id });
    }

    private static string Greet(ChatSession s)
    {
        s.Title = s.Kind switch { "mock" => "Mock interview", "plan" => "Interview plan", "scout" => "Job scout", _ => "Experience builder" };
        return s.Kind switch {
            "mock" => "What role are you interviewing for? Send the title or a short job description. This is a fresh four-question mock; only your answers count.",
            "scout" => "What role should I scout for? Send a job title for a report, or say “daily” to schedule a search. I’ll check your permitted sources and prepare a resume and letter for each eligible match, using available draft allowances. Nothing is submitted.",
            "plan" => ChatPlanning.Start(s),
            _ => "Tell me about a role, project or situation you’d like to use in an interview. Or tell me about an upcoming interview and we’ll plan for it."
        };
    }

    private static async Task<IResult> Turn(Guid id, TurnInput input, HttpContext c, PracticeDb db, LocalCoach coach, PublicResearch research,
        DiscoveryScout scout, CancellationToken ct)
    {
        var owner = Owner(c); var text = input.Text?.Trim() ?? "";
        var finish = input.Action == "finish" || Is(text, @"^(?:end|finish|stop) (?:this |my |the )?(?:mock interview|mock|interview|session|chat|job search)[.!]?$");
        var mode = finish ? "finish" : "say";
        if (finish) text = "Finish session";
        if (input.RequestId == Guid.Empty || input.Revision is null || input.Action is not (null or "say" or "finish") || text.Length is < 1 or > 8000)
            return Results.BadRequest("Send a message with a current revision and request ID.");
        var q = Owned(db, owner).Where(s => s.Id == id);
        var s = await q.SingleOrDefaultAsync(ct);
        if (s is null) return Results.NotFound();
        if (s.Kind == "import" && s.Stage == "document:pending") return Results.Conflict("Read the attachment before sending a follow-up.");
        var messages = db.Set<ChatMessage>().Where(m => m.WorkspaceId == owner && m.ChatId == id);
        async Task<IResult?> Check()
        {
            var prior = await messages.AsNoTracking().SingleOrDefaultAsync(m => m.RequestId == input.RequestId, ct);
            if (prior is not null) return prior.Text == text && prior.Mode == mode ? Results.Ok(new { id = prior.NextChatId ?? id }) : Results.Conflict("Turn key already used.");
            if (s.State != "active" || s.Revision != input.Revision) return Results.Conflict("This chat changed. Reload its latest turn.");
            if (s.Revision >= 150 && !finish) return Results.BadRequest("Finish this session and start a new chat.");
            return null;
        }
        if (await Check() is { } blocked) return blocked;
        var zone = input.Zone is { Length: > 0 and <= 80 } ? input.Zone : "UTC";
        var planning = s.Stage.StartsWith("plan:", StringComparison.Ordinal);
        var planRequest = s.Kind is "builder" or "plan" && !planning && (Is(text, @"\b(plan|prepare|prep|upcoming|scheduled|have|got|my)\b.{0,48}\binterview\b|\binterview (?:at|with|on|next|scheduled)\b") ||
            s.Stage == "offered-plan" && Is(text, @"^(yes|yeah|yep|sure)\b"));
        var remember = s.Kind == "builder" && !planning && Is(text, @"^remember\s*:");
        var fork = s.Kind == "builder" && !planning && !finish && !remember ? (
            Is(text, @"\b(start|begin|do|practice|try|want|run)\b.{0,24}\bmock(?: interview)?\b|^mock interview[.!]?$") ? "mock" :
            Is(text, @"\b(find|scout|search for|look for)\b.{0,24}\b(jobs|openings|positions)\b|^job scout[.!]?$") ? "scout" : null) : null;
        var reply = ""; var engine = "studio"; var shouldClose = finish; var recallable = !finish && !remember;
        BuilderReply? builder = null;
        MockReply? mock = null;
        Guid? digest = null;
        var daily = s.Kind == "scout" && !finish ? DailyStep(s, text, zone) : null;
        var materials = !finish && planning ? await ChatPlanning.Prepare(s, text, research, coach, ct) : null;
        var searchRole = daily?.Confirmed == true ? daily.Role : daily is null && !finish && s.Kind == "scout" && ValidRole(text) ? text : null;
        // Keep inference and public feed refreshes outside the SQLite writer.
        if (s.Kind == "mock") mock = await MockTurn(db, s, text, finish, coach, ct);
        else if (searchRole is not null)
        {
            await using (var claim = await db.Database.BeginTransactionAsync(ct))
            {
                await db.Entry(s).ReloadAsync(ct);
                if (db.Entry(s).State == EntityState.Detached) return Results.NotFound();
                if (await Check() is { } conflict) return conflict;
                if (s.PendingSearch is not null && s.PendingSearch != text) return Results.Conflict("A search is already in progress. Resume it using the same message.");
                s.PendingSearch = text;
                await db.SaveChangesAsync(ct); await claim.CommitAsync(ct);
            }
            (digest, reply) = await scout.ChatReport(owner, searchRole, daily?.Zone ?? zone, ct);
            shouldClose = true; engine = "report";
        }
        else if (s.Kind == "scout" && finish) { reply = "Job scout report · Not run. No search was completed, so there are no verified openings, pay or application materials. Start a new scout with a role title."; engine = "report"; }
        else if (s.Kind == "scout") reply = daily?.Reply ?? "Send a job title in 120 characters or fewer so I can run the search.";
        else if (finish) reply = "Session closed. Your conversation is saved in history.";
        else if (s.Stage != "document:review" && !planning && !planRequest && !remember && fork is null)
            builder = await BuilderTurn(db, s, text, coach, ct);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.Entry(s).ReloadAsync(ct);
        if (db.Entry(s).State == EntityState.Detached) return Results.NotFound();
        if (await Check() is { } changed) return changed;
        var seq = 2 * s.Revision + 1;
        var user = Message(db, s, seq, text, mode, input.RequestId);
        user.Recallable = recallable;
        if (mock is not null)
        {
            if (mock.Invalid is { } reason) return Results.BadRequest(reason);
            if (mock.Start && !await AccountsModule.TryReserveMockAsync(db, owner, $"mock:{id:D}")) return Full();
            (reply, engine, shouldClose) = await ApplyMock(db, s, text, mock, ct);
        }
        else if (s.Kind == "scout")
        {
            if (s.PendingSearch is not null && s.PendingSearch != text) return Results.Conflict("A search is already in progress. Resume it using the same message.");
            s.PendingSearch = null; s.DigestId = digest;
            if (daily is not null)
            {
                s.Stage = daily.Stage; s.ContextJson = shouldClose ? "{}" : JsonSerializer.Serialize(daily);
                if (daily.Confirmed && digest is not null && await AccountsModule.AllowScoutAsync(db, owner))
                    reply += "\n\n" + await EnableDaily(db, owner, daily, ct);
            }
            if (searchRole is not null) s.Title = "Job scout · " + ChatRecall.Clip(searchRole, 64);
        }
        else if (fork is not null)
        {
            if (await Owned(db, owner).CountAsync(ct) >= 200) return Full();
            var next = new ChatSession { WorkspaceId = owner, Kind = fork };
            db.Add(next); Message(db, next, 0, Greet(next)); user.NextChatId = next.Id;
            reply = $"Opened a new {next.Title.ToLowerInvariant()} session. You can return to this conversation anytime.";
        }
        else if (!finish && planning) reply = await ChatPlanning.Reply(s, text, zone, db, research, coach, ct, materials);
        else if (!finish && planRequest) reply = ChatPlanning.Start(s);
        else if (!finish && remember)
        {
            var note = text[(text.IndexOf(':') + 1)..].Trim();
            if (note.Length is < 1 or > 300 || await db.Set<ChatNote>().CountAsync(n => n.WorkspaceId == owner, ct) >= 40)
                return Results.BadRequest("Use a short note (1–300 characters; up to 40 notes).");
            db.Add(new ChatNote { WorkspaceId = owner, ChatId = id, Text = note });
            reply = "Saved a private chat note, not an experience claim. You can remove it in History → Chat memory.";
        }
        else if (!finish && s.Stage == "document:review")
        {
            reply = await ExperienceModule.ResolveDocumentMatch(db, s, text, ct);
            engine = "history review";
        }
        else if (builder is not null)
        {
            (reply, engine) = await ApplyBuilder(db, s, user, builder, ct);
            s.Stage = Is(builder.Text, @"\b(?:upcoming|scheduled|have an?)\b.{0,30}\binterview\b") ? "offered-plan" : "open";
        }
        if (shouldClose) s.State = "closed";
        if (s.Revision == 0 && s.Kind == "builder" && !finish && !remember && fork is null)
            s.Title = planRequest ? "Upcoming interview" : ChatRecall.Clip(text, 60);
        Message(db, s, seq + 1, reply, engine).Recallable = s.Kind == "mock" || engine is "scorecard" or "report" ||
            builder?.Recallable == true || planning && materials is null && !reply.Contains("Prep packet", StringComparison.Ordinal);
        s.Revision++; s.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
        return Results.Ok(new { id = user.NextChatId ?? id });
    }

    private static async Task<IResult> Delete(Guid id, HttpContext c, PracticeDb db, CancellationToken ct)
    {
        var owner = Owner(c);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var s = await Owned(db, owner).SingleOrDefaultAsync(x => x.Id == id, ct);
        if (s is null) return Results.NotFound();
        if (s.SourceId is Guid source)
        {
            await db.Facts.Where(f => f.WorkspaceId == owner && db.Set<ExperienceCitation>().Any(e => e.WorkspaceId == owner && e.SourceId == source && e.FactId == f.Id && !e.Corroborates)).ExecuteDeleteAsync(ct);
            await db.Set<ExperienceSource>().Where(x => x.WorkspaceId == owner && x.Id == source).ExecuteDeleteAsync(ct);
        }
        if (s.Kind == "mock") await WorkspaceApi.ForgetMock(db, owner, id, ct);
        db.Remove(s); await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
        return Results.NoContent();
    }
}
