using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal static partial class ChatModule
{
    private const int PostingLineLimit = 6;
    private const string PostingNoun = @"(?:\b(?:posting|job (?:description|listing|ad))\b|\b(?:this|that|pasted|advertised) (?:role|position|job)\b|\b(?:this|that|the|those|these|job|role|listed|following|first|second|third|fourth|fifth|sixth|last) requirements?\b|\brequirement\s*#?\s*\d+\b)";
    private const string PostingHeader = @"^(?:(?:here['’]s|here is|this is)\s+)?(?:(?:the|a|this|that)\s+)?(?:(?:job\s+)?posting(?: requirements?)?|job (?:description|listing|ad)|(?:role )?requirements?)\s*(?:[:\r\n—–]|\b(?:requires?|calls for|asks for|needs|says)\b)";
    private const string PostingRequest = @"^(?:(?:please|help me|can you|could you|would you)\s+)*(?:match|compare|map|align|relate|check|recheck|revisit|connect|contrast|weigh|assess)\b";
    private static bool IsPostingMatch(string text)
    {
        var lead = ChatRecall.Clip(text.Trim(), 420);
        if (Is(lead, PostingHeader)) return true;
        // Inspect the request, not the instructions/actions that may appear inside a pasted listing.
        lead = lead.Split([':', '\n', '\r', '?', '!', '.'], 2)[0];
        if (!Is(lead, PostingNoun)) return false;
        if (Is(lead, @"^(?:(?:please|help me|(?:can|could|would) (?:you|I|we)|I (?:want|need) to|let['’]s)\s+)*(?:(?:start|begin|run|do|try|book|schedule)\b.{0,30}\b(?:mock|interview|practice session)|(?:plan|prep|prepare|practice|rehearse)\b.{0,60}\b(?:interview|mock|question))\b|^(?:which|what) (?:other |similar )?(?:jobs|job postings|roles|openings|vacancies)\b")) return false;
        var lookup = Regex.Match(lead, @"^(?:(?:please|help me|can you|could you|would you|I want to)\s+)*(?:find|scout|search for|look for|look up|send me|show(?: me)?|match me (?:with|to))\s+(?<object>.{0,110}?)\b(?:jobs?|roles?|postings?|vacanc(?:y|ies)|openings?|positions?)\b", RegexOptions.IgnoreCase);
        if (lookup.Success && !Is(lookup.Groups["object"].Value, @"\b(?:experiences?|background|examples?|projects?|evidence|stories|skills|memory|notes|history|how|whether)\b")) return false;
        if (Is(lead, @"^(?:what about|and) (?:the (?:first|second|third|fourth|fifth|sixth|last) requirement|requirement\s*#?\s*\d+|that posting)$")) return true;
        if (Is(lead, PostingRequest)) return true;
        return Is(lead, @"^(?:(?:please|can you|could you)\s+)*(?:which|what|how|where|does|do I|can I|is there|for (?:this|that|the)|show|find|use|choose|pick|review|suggest)\b") &&
            Is(lead, @"\b(?:my (?:experience|background|work|skills|history|examples?|projects?|memory|notes)|experiences|examples?|evidence|stories|fits?|matches|gaps?|support(?:s|ed)?|qualify|I (?:should|could) (?:bring up|mention|highlight))\b");
    }

    private sealed record PostingLine(int Number, string Text, string[] Terms);
    private sealed record PostingPick(int? Requirement, int? Evidence);
    private static readonly HashSet<string> PostingStop = new(("the this that those these a an and or by in into on of at to from for as with without using use be is are will must should " +
        "able ability can you your we our my me i it its have has had who across least years year required requires requirement requirements preferred including " +
        "demonstrated proven knowledge understanding familiarity experience experienced background expertise skills skill work working worked team teams " +
        "project projects role responsibilities responsible position candidate candidates strong excellent successful related").Split(' '));
    private static readonly HashSet<string> PostingWeak = PostingTerms("build built develop design deliver lead led manage own support help maintain review plan create drive " +
        "implement improve process system product company business technical production data service tool report quality train customer staff engineer engineering").ToHashSet();

    private static string[] PostingTerms(string text) => Regex.Matches(text.ToLowerInvariant(), @"[\p{L}][\p{L}\d+#]*(?:-[\p{L}\d][\p{L}\d+#]*)*")
        .Select(m => m.Value).Where(t => t.Length is > 1 and <= 50 && !PostingStop.Contains(t)).Select(t =>
            t.Length > 5 && t.EndsWith("ies") ? t[..^3] + "y" : t.Length > 6 && t.EndsWith("ing") ? t[..^3] :
            t.Length > 5 && t.EndsWith("ed") ? t[..^2] :
            t.Length > 4 && t.EndsWith('s') && !t.EndsWith("ss") && !t.EndsWith("is") && !t.EndsWith("us") ? t[..^1] : t)
        .Select(t => t.Length > 4 && t.EndsWith('e') ? t[..^1] : t)
        .Where(t => !PostingStop.Contains(t)).Distinct().ToArray();

    private static string PostingBody(string posting)
    {
        var prose = Regex.Match(posting, @"^[^:?.!\r\n]{0,250}?\b(?:posting|description|role|job|requirement)\s+(?:requires?|calls for|asks for|needs|says|is to)\s+", RegexOptions.IgnoreCase);
        var split = posting.IndexOfAny([':', '\n', '\r', '?', '.', '!', '—', '–']);
        return prose.Success ? posting[prose.Length..] : split >= 0 ? posting[(split + 1)..] : "";
    }

    private static PostingLine[] PostingLines(string body)
    {
        var lines = new List<PostingLine>();
        foreach (var part in Regex.Split(body, @"[\r\n;•]+|(?<=[.!?])\s+"))
        {
            var line = Regex.Replace(part.Trim(), @"^(?:[-*]\s*|\d+[.)]\s*|(?:requirements?|responsibilities|required(?: skills)?|preferred(?: skills)?|must[- ]haves?)\s*:\s*)+", "", RegexOptions.IgnoreCase).Trim();
            if (line.Length is < 2 or > 500 || line.EndsWith(':') || line.EndsWith('?') ||
                Is(line, @"^(?:about us|apply now|how to apply|compensation|benefits|job title|company|salary|location)\b") ||
                Is(line, @"\b(?:ignore (?:all |any |the |previous |prior |your )*(?:instructions?|rules?|prompts?)|system prompt|other workspaces?|another workspace|tell (?:the candidate|the user)|pretend (?:that|to)|output (?:only|json)|return json|say (?:that )?(?:I|you|the candidate) (?:am|are|is|have)|(?:start|book|run) (?:a |an? |the )?(?:mock|job search))\b"))
                continue;
            var terms = PostingTerms(line);
            if (terms.Length == 0 || lines.Any(r => r.Text.Equals(line, StringComparison.OrdinalIgnoreCase))) continue;
            lines.Add(new(lines.Count + 1, line, terms));
            if (lines.Count == PostingLineLimit) break;
        }
        return lines.ToArray();
    }

    private static int? PostingFocus(string message, int count)
    {
        var number = Regex.Match(message, @"\brequirement\s*#?\s*(\d{1,2})\b", RegexOptions.IgnoreCase);
        if (number.Success) return int.Parse(number.Groups[1].Value);
        var ordinal = Regex.Match(message.ToLowerInvariant(), @"\b(first|second|third|fourth|fifth|sixth|last) requirement\b");
        return ordinal.Groups[1].Value switch { "first" => 1, "second" => 2, "third" => 3, "fourth" => 4, "fifth" => 5, "sixth" => 6, "last" => count, _ => null };
    }

    private static int PostingPriority(RecallHit h) => h.Kind switch { "confirmed fact" => 0, "unreviewed statement" => 1, "past conversation" => 2, _ => 3 };
    private static int PostingOverlap(PostingLine line, RecallHit hit)
    {
        // A project label, substring (SQL in NoSQL), or lone generic verb is not support.
        var clauses = Regex.Split(hit.Text, @"[.!?;\r\n]+|,\s*(?=(?:but|not|never|without)\b)|\bbut\b", RegexOptions.IgnoreCase);
        var work = hit.Kind == "agent memory" ? hit.Text : string.Join(' ', clauses.Where(c =>
            !Is(c, @"\b(?:never|no experience|without (?:approval|authority|experience)|not (?:my|our) (?:work|responsibility)|(?:did|have|had|was|were|am|is|are|do|does|could)(?: not|n['’]t)|(?:I|we) (?:prefer|hope to|want to learn|plan to)|only (?:watched|observed))\b")));
        var shared = line.Terms.Intersect(PostingTerms(work)).ToArray();
        return shared.Length >= 2 || shared.Any(t => !PostingWeak.Contains(t)) ? shared.Length : 0;
    }
    private static string PostingDisplay(string text) => Regex.Replace(text, @"[\p{Cc}\p{Zl}\p{Zp}]+", " ");

    private static async Task<List<RecallHit>> PostingSources(PracticeDb db, Guid owner, PostingLine[] lines, CancellationToken ct)
    {
        var found = new List<RecallHit>();
        foreach (var line in lines)
        {
            var query = string.Join(' ', line.Terms.OrderBy(t => PostingWeak.Contains(t)).Take(8).Select(t => t.Length > 3 && t.EndsWith('y') ? t[..^1] : t));
            var hits = await ChatRecall.Search(db, owner, query, ct);
            found.AddRange(hits);
            // A crowded chat/target history must not push all current library statements out of recall.
            if (hits.Length == 8 && !hits.Any(h => h.Kind is "confirmed fact" or "unreviewed statement"))
                found.AddRange(await ChatRecall.Search(db, owner, query, ct, historyOnly: true));
        }
        var factIds = found.Where(h => h.Kind is "confirmed fact" or "unreviewed statement").Select(h => h.Id).ToHashSet();
        var memoryIds = found.Where(h => h.Kind == "agent memory").Select(h => h.Id).Distinct().ToArray();
        var memories = memoryIds.Length == 0 ? [] : await AgentMemory.Entries(db, owner).Where(n => memoryIds.Contains(n.Id)).ToListAsync(ct);
        factIds.UnionWith(memories.Where(n => n.FactId.HasValue).Select(n => n.FactId!.Value));
        // Recall returns clipped snippets. Use the complete current wording, not a stale transcript or a
        // leading clause that drops a qualification. Bare job-history labels and target descriptions aren't examples.
        var records = await db.Facts.AsNoTracking().Where(f => f.WorkspaceId == owner && factIds.Contains(f.Id))
            .Select(f => new { f.Id, f.Project, f.Origin, f.Confirmed, f.Claim, f.Source }).ToListAsync(ct);
        var facts = records.Select(f => new RecallHit { Id = f.Id, Kind = f.Confirmed ? "confirmed fact" : "unreviewed statement",
            Label = f.Project + " · " + f.Origin, Text = f.Claim }).ToList();
        bool Superseded(string text) => records.Any(f => f.Claim != text &&
            (f.Source == text || f.Source.EndsWith("\n" + text, StringComparison.Ordinal)));
        var sources = new List<RecallHit>(facts);
        foreach (var n in memories.Where(n => !facts.Any(f => f.Text == n.Text) && !Superseded(n.Text)))
            sources.Add(new() { Id = n.Id, Kind = "agent memory", Label = n.FactId.HasValue ? "Edited experience note" : "Coaching note", Text = n.Text });
        var chatIds = found.Where(h => h.Kind == "past conversation").Select(h => h.Id).Distinct().ToArray();
        if (chatIds.Length > 0)
        {
            var chats = await (from u in db.Set<ChatMessage>().AsNoTracking()
                join a in db.Set<ChatMessage>() on new { u.WorkspaceId, u.ChatId, Seq = u.Seq + 1 } equals new { a.WorkspaceId, a.ChatId, a.Seq }
                where u.WorkspaceId == owner && u.Speaker == "user" && u.Recallable && u.Session.Kind == "chat" && chatIds.Contains(u.Id) &&
                    a.Speaker == "assistant" && (a.Mode == "local model" || a.Mode == "Azure OpenAI" || a.Mode == "offline guide" || a.Mode == "model unavailable · guided reply")
                select new { u.Id, u.Text, u.Seq }).ToListAsync(ct);
            foreach (var u in chats.Where(u => !IsPostingMatch(u.Text) && !u.Text.Contains('?') && Is(u.Text, @"\b(I|my|we|our|mine)\b") && !facts.Any(f => f.Text == u.Text) && !Superseded(u.Text)))
                sources.Add(new() { Id = u.Id, Kind = "past conversation", Label = $"Candidate's chat turn {(u.Seq + 1) / 2}", Text = u.Text });
        }
        return sources.Where(h => h.Text.Length is > 0 and <= 2000 && !IsPostingMatch(h.Text)).ToList();
    }

    private static async Task<BuilderReply> MatchPosting(PracticeDb db, ChatSession s, string text, LocalCoach coach, CancellationToken ct)
    {
        const string guide = "posting evidence guide";
        BuilderReply Answer(string reply, string engine = guide) => new(reply, engine, null, null, false, [], false);
        var posting = text;
        var body = PostingBody(posting);
        var lines = PostingLines(body);
        if (string.IsNullOrWhiteSpace(body) && !Is(text, @"\b(?:new|another|different) (?:job |role )?(?:posting|description|requirement)\b"))
        {
            var prior = await db.Set<ChatMessage>().AsNoTracking().Where(m => m.WorkspaceId == s.WorkspaceId && m.ChatId == s.Id && m.Speaker == "user")
                .OrderByDescending(m => m.Seq).Take(5).Select(m => m.Text).ToListAsync(ct);
            foreach (var previous in prior.Where(IsPostingMatch))
            {
                var previousLines = PostingLines(PostingBody(previous));
                if (previousLines.Length == 0) continue;
                posting = previous; lines = previousLines; break;
            }
            if (PostingFocus(text, lines.Length) is int focus) lines = lines.Where(r => r.Number == focus).ToArray();
        }
        if (lines.Length == 0) return Answer("Paste the redacted posting or a specific requirement after “Posting:”. I can compare it privately to examples you’ve actually recorded.");

        var sources = await PostingSources(db, s.WorkspaceId, lines, ct);
        var ranked = lines.ToDictionary(r => r.Number, r => sources.Select(h => (hit: h, score: PostingOverlap(r, h))).Where(p => p.score > 0)
            .OrderByDescending(p => p.score).ThenBy(p => PostingPriority(p.hit)).ThenBy(p => p.hit.Id).Take(4).Select(p => p.hit).ToArray());
        var pool = ranked.Values.SelectMany(hits => hits.Select((hit, rank) => (hit, rank))).OrderBy(p => p.rank)
            .Select(p => p.hit).DistinctBy(h => h.Id).Take(10).ToArray();
        var requirements = lines.Select(r => new { number = r.Number, text = r.Text, options = ranked[r.Number]
            .Select(h => Array.IndexOf(pool, h) + 1).Where(n => n > 0).ToArray() }).ToArray();
        var selections = requirements.ToDictionary(r => r.number, _ => 0);
        var engine = guide;
        if (pool.Length > 0 && Model)
        {
            var picks = await coach.Call<PostingPick?[]>(coach.Prompt("posting.match"),
                new { posting, message = posting == text ? null : text, requirements, evidence = pool.Select((h, i) => new { number = i + 1, kind = h.Kind, label = h.Label, text = h.Text }) },
                "matches", ct, 320);
            if (picks != null && picks.Length == lines.Length && requirements.All(r =>
                picks.Count(p => p?.Requirement == r.number && p.Evidence is int e && (e == 0 || r.options.Contains(e))) == 1))
            {
                foreach (var p in picks) selections[p!.Requirement!.Value] = p.Evidence!.Value;
                engine = LocalCoach.Label;
            }
            else engine = "model unavailable · posting review";
        }
        else if (!Model)
        {
            // Offline, show only an unambiguous lead; keyword order doesn't break a tie between examples.
            foreach (var r in requirements)
                if (r.options.Length == 1) selections[r.number] = r.options[0];
        }

        var parts = new List<string> { engine == "model unavailable · posting review" ? "I couldn’t validate a comparison. No source was selected." :
            "Private posting comparison. The citations below are leads, not a qualification or hiring verdict." };
        foreach (var r in lines)
        {
            var selection = selections[r.Number];
            var heading = $"Requirement {r.Number}: {r.Text}\n";
            if (selection == 0)
                parts.Add(heading + "Evidence gap: no supporting example selected. What did you personally do, if anything, that addresses this requirement?");
            else
            {
                var h = pool[selection - 1];
                var context = h.Kind switch {
                    "agent memory" => "Evidence gap: a memory is context, not proof of doing the work. Is there a project behind this note?",
                    "past conversation" => "A recollection, not a confirmed fact. Which part could you verify?",
                    "unreviewed statement" => "This wording is unreviewed. Check the attribution and your own contribution before using it.",
                    _ => "Only the quoted wording is confirmed."
                };
                var duration = Regex.Match(r.Text, @"\b(?:\d+\+?|one|two|three|four|five|six|seven|eight|nine|ten)[ -]+(?:years?|months?)\b", RegexOptions.IgnoreCase);
                if (duration.Success && !h.Text.Contains(duration.Value, StringComparison.OrdinalIgnoreCase))
                    context += $" Evidence gap: this citation doesn’t establish the stated duration ({duration.Value}).";
                else if (h.Kind != "agent memory" && PostingOverlap(r, h) < r.Terms.Length)
                    context += " Partial overlap: the rest of the requirement is not established by this citation.";
                parts.Add(heading + $"[{selection}] {h.Kind} · {PostingDisplay(h.Label)}: “{PostingDisplay(h.Text)}”\n" + context);
            }
        }
        if (lines.Length == PostingLineLimit) parts.Add("I compared up to six requirements. Paste any remaining priorities separately.");
        return Answer(string.Join("\n\n", parts), engine);
    }
}
