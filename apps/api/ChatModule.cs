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
    public string Kind { get; set; } = "chat";
    public string Title { get; set; } = "New conversation";
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
    public Guid? ChatId { get; set; }
    public Guid? FactId { get; set; }
    public Fact? Fact { get; set; }
    public string Text { get; set; } = "";
}

internal static partial class ChatModule
{
    internal sealed record StartInput(string? Kind, Guid? RequestId, Guid? TargetId, Guid? BlockId);
    internal sealed record TurnInput(string? Text, Guid RequestId, int? Revision, string? Zone, string? Action);
    internal sealed record SearchInput(string? Query);
    internal sealed record VoteInput(string? Vote);
    private static bool Model => LocalCoach.Enabled;
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
        AgentMemory.Configure(m);
    }

    internal static ChatMessage Message(PracticeDb db, ChatSession s, int seq, string text, string mode = "studio", Guid? request = null)
    {
        var msg = new ChatMessage { ChatId = s.Id, WorkspaceId = s.WorkspaceId, Seq = seq, Text = text, Mode = mode,
            Speaker = request is null ? "assistant" : "user", RequestId = request };
        db.Add(msg);
        return msg;
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
        AgentMemory.Map(g);
    }

    private static async Task<IResult> Start(StartInput input, HttpContext c, PracticeDb db, DiscoveryScout scout, CancellationToken ct)
    {
        var owner = Owner(c);
        var kind = input.Kind is null or "builder" or "plan" or "scout" ? "chat" : input.Kind;
        if (kind is not ("chat" or "mock") || input.RequestId == Guid.Empty ||
            (input.TargetId.HasValue || input.BlockId.HasValue) && input.Kind != "mock")
            return Results.BadRequest("Start a conversation, or choose a mock interview for a saved target.");
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        if (input.RequestId is Guid key && await Owned(db, owner).SingleOrDefaultAsync(s => s.StartKey == key, ct) is { } prior)
            return (prior.Kind == kind || prior.Kind == input.Kind || prior.Kind == "builder" && kind == "chat") && (prior.Kind != "mock" || prior.TargetId == input.TargetId && prior.StartBlockId == input.BlockId)
                ? Results.Ok(new { prior.Id }) : Results.Conflict("Start key already used.");
        var s = new ChatSession { WorkspaceId = owner, Kind = kind, StartKey = input.RequestId, TargetId = input.TargetId, StartBlockId = input.BlockId };
        if (await Owned(db, owner).CountAsync(ct) >= 200 || s.Kind == "chat" &&
            !await AccountsModule.TryReserveBuilderAsync(db, owner, s.Id.ToString("N"))) return Full();
        var greeting = Greet(s, input.Kind, scout.SearchDisclosure);
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

    private static string Greet(ChatSession s, string? start = null, string disclosure = "")
    {
        var opening = start ?? s.Kind;
        s.Title = opening switch { "mock" => "Mock interview", "plan" => "Interview plan", "scout" => "Job search", _ => "New conversation" };
        if (opening == "scout") s.Stage = "search:role";
        return opening switch {
            "mock" => "What role are you interviewing for? Send the title or a short job description. Only your answers count toward the score. Work examples you share are also saved for review in Job experience and Agent memory, not approved for applications.",
            "scout" => SearchPrompt(disclosure),
            "plan" => ChatPlanning.Start(s),
            _ => "What's on your mind about your job search? We can work on your job history, practice a question, find roles, or plan for an interview."
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
        var general = s.Kind != "mock" && s.Stage != "document:review" && !planning && !finish;
        var remember = general && Is(text, @"^remember\s*:");
        var startMock = general && !remember && Is(text, @"\b(start|begin|do|practice|try|want|run)\b.{0,24}\bmock(?: interview)?\b|^mock interview[.!]?$");
        var practiceRequest = general && !remember && !startMock && Is(text, @"\b(practice|rehearse|try|example|sample|walk|go through|work through|ask me)\b.{0,65}\b(interview|behavioral|behavioural) questions?\b|\binterview question\b.{0,22}\btogether\b");
        var experienceRequest = general && !remember && Is(text, @"^(?:help me |let's |i want to )?(?:add|build|update|work on)\b.{0,45}\b(?:my (?:job|work) history|my experience)\b[.!]?$");
        var planRequest = general && !remember && !startMock && !practiceRequest && (Is(text, @"\b(plan|prepare|prep|upcoming|scheduled)\b.{0,48}\binterview\b|\bI (?:have|got) (?:an?|my next) (?:\w+ ){0,2}interview\b|\b(?:my )?interview (?:at|with|on|next|scheduled|is)\b") ||
            s.Stage == "offered-plan" && Is(text, @"^(yes|yeah|yep|sure)\b"));
        var search = general && !remember && !startMock && !practiceRequest && !experienceRequest && !planRequest ? SearchStep(s, text) : null;
        var reply = ""; var engine = "studio"; var shouldClose = finish; var recallable = !finish && !remember;
        BuilderReply? builder = null;
        MockReply? mock = null;
        Guid? digest = null;
        var materials = !finish && planning ? await ChatPlanning.Prepare(s, text, research, coach, ct) : null;
        if (s.PendingSearch is not null && s.PendingSearch != text) return Results.Conflict("A search is in progress. Resume it using the same message.");
        // Keep inference and public feed refreshes outside the SQLite writer.
        if (s.Kind == "mock") mock = await MockTurn(db, s, text, finish, coach, ct);
        else if (search?.Role is string searchRole)
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
            (digest, reply) = await scout.ChatReport(owner, searchRole, zone, ct);
            engine = "report";
        }
        else if (finish) reply = "Session closed. Your conversation is saved in history.";
        else if (general && !planRequest && !remember && !startMock && !practiceRequest && !experienceRequest && search is null)
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
            if (!mock.Start && !mock.Finish && ExperienceModule.IsWorkAnswer(text)) user.Recallable = false;
        }
        else if (search is not null)
        {
            if (s.PendingSearch is not null && s.PendingSearch != text) return Results.Conflict("A search is already in progress. Resume it using the same message.");
            reply = await ApplySearch(db, s, search, zone, digest, reply, scout.SearchDisclosure, ct);
        }
        else if (practiceRequest)
        {
            s.Stage = "practice:ownership"; s.ContextJson = "{}";
            reply = "Let's try one together, without a score. " + Practice.Probes[0].Question +
                " I'll use the work you describe to update your job history and agent memory.";
        }
        else if (experienceRequest)
        {
            s.Stage = "experience"; s.ContextJson = "{}";
            reply = "Tell me about a role or project you'd like in your job history. What was your own contribution?";
        }
        else if (startMock)
        {
            if (await Owned(db, owner).CountAsync(ct) >= 200) return Full();
            var next = new ChatSession { WorkspaceId = owner, Kind = "mock" };
            db.Add(next); Message(db, next, 0, Greet(next)); user.NextChatId = next.Id;
            reply = $"Opened a new {next.Title.ToLowerInvariant()} session. You can return to this conversation anytime.";
        }
        else if (!finish && planning) reply = await ChatPlanning.Reply(s, text, zone, db, research, coach, ct, materials);
        else if (!finish && planRequest) reply = ChatPlanning.Start(s);
        else if (!finish && remember)
        {
            var note = text[(text.IndexOf(':') + 1)..].Trim();
            if (note.Length is < 1 or > 300 || await db.Set<ChatNote>().CountAsync(n => n.WorkspaceId == owner && n.FactId == null, ct) >= 40)
                return Results.BadRequest("Use a short note (1–300 characters; up to 40 notes).");
            db.Add(new ChatNote { WorkspaceId = owner, ChatId = id, Text = note });
            reply = "Saved a private coaching note, not an experience claim. You can edit or delete it in Agent memory.";
        }
        else if (!finish && s.Stage == "document:review")
        {
            reply = await ExperienceModule.ResolveDocumentMatch(db, s, text, ct);
            engine = "history review";
        }
        else if (builder is not null)
        {
            (reply, engine) = await ApplyBuilder(db, s, user, builder, ct);
            s.Stage = s.Stage == "practice:ownership" && builder.Statement ? "practice:outcome" :
                s.Stage.StartsWith("practice:") || s.Stage == "experience" ? s.Stage :
                Is(builder.Text, @"\b(?:upcoming|scheduled|have an?)\b.{0,30}\binterview\b") ? "offered-plan" : "open";
            if (s.Stage == "open") s.ContextJson = "{}";
        }
        if (shouldClose) s.State = "closed";
        if (s.Revision == 0 && s.Title == "New conversation" && !finish && !remember && !startMock && search?.Role is null)
            s.Title = planRequest ? "Upcoming interview" : practiceRequest ? "Interview question practice" : experienceRequest ? "My job history" : ChatRecall.Clip(text, 60);
        Message(db, s, seq + 1, reply, engine).Recallable = practiceRequest || experienceRequest || s.Kind == "mock" || engine is "scorecard" or "report" ||
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
        if (s.Kind == "mock") await WorkspaceApi.ForgetMock(db, owner, id, ct);
        else if (s.SourceId is Guid source) await ExperienceModule.ForgetConversationSource(db, owner, source, ct);
        db.Remove(s); await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
        return Results.NoContent();
    }
}
