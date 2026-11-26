using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal sealed class RecallHit
{
    public string Kind { get; init; } = "";
    public Guid Id { get; init; }
    public Guid? SessionId { get; init; }
    public string Label { get; init; } = "";
    public string Text { get; set; } = "";
}

internal static class ChatRecall
{
    private static readonly HashSet<string> Stop = new("what which when where how have with from that this about would could please tell recall remember search find previous earlier session chat did does mine your some show mentioned said before".Split(' '));
    internal static string Clip(string value, int length) => value.Length <= length ? value : value[..length];

    // One allowlisted read tool. No model-provided identifiers, URLs, SQL, or workspace selectors.
    internal static async Task<RecallHit[]> Search(PracticeDb db, Guid owner, string query, CancellationToken ct, bool historyOnly = false)
    {
        var terms = Regex.Matches(query.ToLowerInvariant(), @"[\p{L}\p{N}][\p{L}\p{N}.+#-]*")
            .Select(m => m.Value).Where(t => t.Length > 1 && t.Length <= 50 && !Stop.Contains(t) &&
                (!historyOnly || t is not ("the" or "and" or "for" or "my" or "we" or "was" or "as" or "an" or "of" or "at" or "in" or "to")))
            .Distinct().Take(historyOnly ? 32 : 8).ToArray();
        var hits = new List<RecallHit>();
        async Task Find(IQueryable<RecallHit> source)
        {
            if (terms.Length == 0) return;
            // Keep filters in SQLite, so an old matching turn isn't lost behind a global recent-history cap.
            var candidates = source.Where(h => terms.Any(term => (h.Label + " " + h.Text).ToLower().Contains(term)));
            hits.AddRange(await candidates.OrderByDescending(h => terms.Count(term => (h.Label + " " + h.Text).ToLower().Contains(term)))
                .ThenBy(h => h.Id).Take(6).ToListAsync(ct));
        }
        await Find(db.Facts.AsNoTracking().Where(f => f.WorkspaceId == owner)
            .Select(f => new RecallHit { Id = f.Id, Kind = f.Confirmed ? "confirmed fact" : "unreviewed statement", Label = f.Project + " · " + f.Origin, Text = f.Claim }));
        await Find(db.Set<ExperienceNode>().AsNoTracking().Where(n => n.WorkspaceId == owner)
            .Select(n => new RecallHit { Id = n.Id, Kind = n.Kind, Label = n.Label, Text = n.Employer + " " + n.Dates }));
        if (historyOnly) return Ranked();
        await Find(db.Set<ChatMessage>().AsNoTracking().Where(m => m.WorkspaceId == owner && m.Recallable)
            .Select(m => new RecallHit { Id = m.Id, SessionId = m.ChatId, Kind = "past conversation", Label = m.Session.Kind + " · " + m.Speaker, Text = m.Text }));
        await Find(db.Set<InterviewTarget>().AsNoTracking().Where(t => t.WorkspaceId == owner)
            .Select(t => new RecallHit { Id = t.Id, Kind = "interview target", Label = t.Role + " · " + t.Company, Text = t.Description }));
        await Find(db.Set<ChatNote>().AsNoTracking().Where(n => n.WorkspaceId == owner)
            .Select(n => new RecallHit { Id = n.Id, SessionId = n.ChatId, Kind = "private chat note", Label = "Conversation preference", Text = n.Text }));
        await Find(db.Set<ExperienceTurn>().AsNoTracking().Where(t => t.WorkspaceId == owner && t.Speaker == "candidate" && t.Mode == "answer")
            .Select(t => new RecallHit { Id = t.Id, SessionId = t.BuilderId, Kind = "earlier builder", Label = t.Stage, Text = t.Text }));
        var legacy = db.Mocks.AsNoTracking().Where(m => m.WorkspaceId == owner && m.AnswersJson != "[]" &&
            !db.Set<ChatSession>().Any(s => s.WorkspaceId == owner && s.Id == m.Id));
        await Find(legacy.Select(m => new RecallHit { Id = m.Id, SessionId = m.Id, Kind = "earlier mock", Label = m.Target, Text = m.AnswersJson }));
        return Ranked();
        RecallHit[] Ranked()
        {
            var result = hits.OrderByDescending(h => terms.Count(t => (h.Label + " " + h.Text).Contains(t, StringComparison.OrdinalIgnoreCase)))
                .ThenByDescending(h => h.Kind == "confirmed fact").ThenBy(h => h.Id).Take(8).ToArray();
            foreach (var h in result) h.Text = Clip(h.Text, historyOnly ? 180 : 480);
            return result;
        }
    }
}
