using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal static partial class ChatModule
{
    private sealed record ToolRequest(string? Name, string? Query);
    private sealed record CoachTurn(string? Reply, string? Kind, string? Label);
    private sealed record BuilderReply(string Text, string Engine, string? Kind, string? Label, bool Statement, RecallHit[] Hits, bool Recallable,
        bool WordingRequest = false);
    private static readonly object TurnSchema = new { type = "object", properties = new { turn = new {
        type = "object", properties = new { reply = new { type = "string" }, kind = new { type = "string", @enum = new[] { "role", "project", "situation", "none" } },
            label = new { type = "string" } }, required = new[] { "reply", "kind", "label" }, additionalProperties = false
    } }, required = new[] { "turn" }, additionalProperties = false };
    private const int RehearsalLimit = 600;
    private static readonly object RehearsalSchema = new { type = "object", properties = new { reply = new { type = "string", maxLength = RehearsalLimit } },
        required = new[] { "reply" }, additionalProperties = false };

    private const string WriteVerb = @"\b(?:I|we)(?:['’](?:ve|ll)| (?:have|will|can))?(?: (?:already|just|now))? (?:sav(?:e|ed)|approv(?:e|ed)|confirm(?:ed)?|book(?:ed)?|fil(?:e|ed)|add(?:ed)?|updat(?:e|ed))\b";
    private const string Receipt = @"\b(?:your|this|that) (?:story|claim|draft|session|application) (?:is|was|has been)(?: (?:now|already))? (?:saved|confirmed|approved|booked|filed)\b";
    private static bool ClaimsWorkspaceWrite(string reply) => Is(reply, Receipt + "|" + WriteVerb +
        @"\s+(?:(?:this|that|your) (?:story|claim|draft|session|application)\b|(?:this|that|it) (?:in|into|to|for|as) (?:(?:your|the) )?(?:history|job history|agent memory|resume|applications?|confirmed|approved)\b|your (?:job history|agent memory|resume)\b)");

    // Hold possible filing receipts back from partial previews. Only the app can report actual writes.
    private static ModelReplyStream? NarrativeStream(Func<string, Task>? preview, int limit, string? parent = null) =>
        ModelReplyStream.For(preview is null ? null : text => Is(text, WriteVerb + "|" + Receipt) ? Task.CompletedTask : preview(text), "reply", limit, parent);

    private static bool SearchWordsFrom(string query, string message)
    {
        var words = query.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        return words.Length is >= 1 and <= 5 && words.All(word =>
            Is(word, @"\A[\p{L}\p{N}][\p{L}\p{N}.+#-]{0,49}\z") &&
            Is(message, @"(?<![\p{L}\p{N}])" + Regex.Escape(word) + @"(?![\p{L}\p{N}])"));
    }

    private static async Task<BuilderReply> BuilderTurn(PracticeDb db, ChatSession s, string text, LocalCoach coach, Func<string, Task>? preview, CancellationToken ct)
    {
        if (IsPostingMatch(text)) return await MatchPosting(db, s, text, coach, ct);
        var wording = Is(text, @"^(?:(?:please|(?:can|could|would) you)\s+)*(?:(?:retell|rephrase|rewrite|summari[sz]e|condense)\b|(?:turn|shape|put|make|tell|give|say|open|describe)\b.{0,100}\b(?:story|spoken|sentence|answer|version|line|stakes|learned|wording)\b|(?:how (?:would|can|should) I|what (?:should|could) I) (?:say|tell|phrase|answer)\b)");
        var recall = !wording && Is(text, @"^(?:(?:can|could|would) you |please )?(?:recall|remember|search|show (?:me )?my|remind me|look up)\b|^(?:what|which|when|where|do you|have I|did I)\b.*\b(?:my|I|recall|remember|history|previous|earlier|last time|mention|mentioned|say|said)\b");
        var practice = !recall && s.Stage.StartsWith("practice:", StringComparison.Ordinal);
        var query = text;
        if (recall && Model)
        {
            var message = ChatRecall.Clip(text, 500);
            var tool = await coach.Call<ToolRequest>(coach.Prompt("chat.search"), new { message }, "tool", ct, 80);
            if (tool is { Name: "search_workspace", Query.Length: > 0 and <= 150 } && SearchWordsFrom(tool.Query, message))
                query = tool.Query + " " + text;
        }
        var hits = recall || Model && !practice ? await ChatRecall.Search(db, s.WorkspaceId, query, ct) : [];
        if (recall && hits.Length == 0)
            return new("I couldn’t find a saved source for that. What project, role or phrase should I look for?", "workspace search", null, null, false, [], false);
        var fullContext = Model && !practice;
        var messages = db.Set<ChatMessage>().AsNoTracking().Where(m => m.ChatId == s.Id && m.WorkspaceId == s.WorkspaceId);
        var recent = fullContext ? await messages.Where(m => m.Recallable && m.Mode != "report")
            .OrderByDescending(m => m.Seq).Take(6).Select(m => new { m.Speaker, m.Text }).ToArrayAsync(ct) : [];
        var cited = s.SourceId is Guid source && Model && (!practice || s.Stage == "practice:outcome") ? await (from cite in db.Set<ExperienceCitation>()
            join fact in db.Facts on cite.FactId equals fact.Id
            where cite.WorkspaceId == s.WorkspaceId && cite.SourceId == source && fact.WorkspaceId == s.WorkspaceId
            orderby cite.Location.Length descending, cite.Location descending
            select new { cite.Location, fact.Confirmed, fact.Project, claim = fact.Claim.Substring(0, 600), partial = fact.Claim.Length > 600 })
            .Take(3).ToArrayAsync(ct) : [];
        // Only use current claims (never old transcripts) from after the start of this rehearsal.
        var startTurn = practice && cited.Length > 0 ? await messages.Where(m => m.Speaker == "assistant" && m.Mode == "studio" && m.Recallable)
            .MaxAsync(m => (int?)m.Seq, ct) / 2 : null;
        var examples = cited.Where(e => !practice || startTurn.HasValue && e.Location.StartsWith("Chat turn ", StringComparison.Ordinal) &&
                int.TryParse(e.Location.AsSpan("Chat turn ".Length), out var turn) && turn > startTurn.Value)
            .Reverse().Select(e => new { confirmed = e.Confirmed, project = e.Project, e.claim, e.partial }).ToArray();
        var notes = fullContext ? await AgentMemory.Entries(db, s.WorkspaceId).OrderBy(n => n.FactId != null).ThenByDescending(n => n.Id)
            .Take(4).Select(n => n.Text.Substring(0, 300)).ToArrayAsync(ct) : [];
        CoachTurn? result = null;
        if (Model && practice)
        {
            var previous = await messages.Where(m => m.Speaker == "assistant").OrderByDescending(m => m.Seq)
                .Select(m => m.Text.Substring(0, 400)).FirstOrDefaultAsync(ct);
            var answer = await coach.Call<string>(coach.Prompt("chat.rehearse"), new { example = ChatRecall.Clip(text, 1000),
                previousQuestion = previous?.Split("\n\n", 2)[0], examples, next = s.Stage == "practice:ownership" ? "observed result" : "decision or trade-off" },
                "reply", ct, 180, RehearsalSchema, NarrativeStream(preview, RehearsalLimit));
            if (answer?.Trim() is { Length: > 0 and <= RehearsalLimit } a) result = new(a, null, null);
        }
        else if (Model) result = await coach.Call<CoachTurn>(coach.Prompt("chat.coach"), new { task = recall ? "recall" : wording ? "wording" : "develop",
                conversation = recent.Reverse().Select(m => new { speaker = m.Speaker, text = ChatRecall.Clip(m.Text, 400) }), examples, notes,
                search_workspace = hits.Take(5).Select(h => new { kind = h.Kind, label = h.Label, text = h.Text }), message = ChatRecall.Clip(text, 2000) },
                "turn", ct, 240, TurnSchema, NarrativeStream(preview, 1600, "turn"));
        var usable = result is { Reply.Length: > 0 and <= 1600 } && result.Reply.Any(char.IsLetter) && !ClaimsWorkspaceWrite(result.Reply);
        if (!usable) result = null;
        var match = Regex.Match(text, @"^(?:my\s+)?(?<kind>role|job|project|situation)\s*(?::|(?:is|was)\s+)\s*(?<label>[^.!?\r\n]{1,100})(?:[.!?\r\n]|$)", RegexOptions.IgnoreCase);
        var kind = match.Success ? match.Groups["kind"].Value.ToLowerInvariant() : result?.Kind;
        if (kind == "job") kind = "role";
        var label = match.Success ? match.Groups["label"].Value.Trim() : result?.Label?.Trim();
        if (kind is not ("role" or "project" or "situation") || label is not { Length: > 0 and <= 100 } ||
            !text.Contains(label, StringComparison.Ordinal) || label.Any(char.IsControl)) { kind = null; label = null; }
        var statement = !recall && !wording && !text.TrimEnd().EndsWith('?') &&
            (match.Success || ExperienceModule.IsWorkAnswer(text, practice || s.Stage == "experience" || s.SourceId.HasValue));
        string reply = usable ? result!.Reply!.Trim() : recall ? hits.Length > 0 ? "Here is what I found in your workspace." : "I don’t have a matching source for that yet." :
            wording ? "I can’t draft that retelling right now. Start with the problem, name just your part, and end with what you observed. If the result is unknown, leave it open." :
            practice && statement ? s.Stage == "practice:ownership" ? "That's the start of a concrete example. What changed, and how did you check the result?" :
                "Try putting your own action and the outcome in two sentences. Keep the result in your own words." :
            statement ? "Which part was your decision, and how did you know whether it worked?" :
            s.Revision % 2 == 0 ? "Tell me about one project from that role. What were you trying to change?" : "What did you personally do, and what changed afterward?";
        return new(reply, usable ? LocalCoach.Label : Model ? "model unavailable · guided reply" : "offline guide", kind, label, statement,
            recall ? hits : [], !statement && !wording && examples.Length == 0 && hits.Length == 0 && notes.Length == 0, wording);
    }

    private static async Task<(string, string)> ApplyBuilder(PracticeDb db, ChatSession s, ChatMessage user, BuilderReply result, CancellationToken ct)
    {
        var reply = result.Text;
        if (result.WordingRequest || IsPostingMatch(user.Text)) user.Recallable = false;
        if (result.Hits.Length > 0)
            reply += "\n\nWorkspace sources:\n" + string.Join("\n", result.Hits.Take(3).Select(h => $"• {h.Kind} · {h.Label}: {ChatRecall.Clip(h.Text, 180)}"));
        if (result.Statement)
        {
            var learned = await ExperienceModule.CaptureAnswer(db, s.WorkspaceId, user.Text, s, null, $"Chat turn {s.Revision + 1}", result.Kind, result.Label, ct);
            if (learned is not null) reply += "\n\n" + learned;
            user.Recallable = false; // Retrieve the current library record, not a stale copy of a corrected claim.
        }
        return (reply, result.Engine);
    }
}
