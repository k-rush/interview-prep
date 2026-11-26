using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

public static partial class ExperienceModule
{
    private sealed record Option(Guid Id, int Revision, string Display);
    private sealed record Review(Guid FactId, string Claim, string Kind, string Label, Option[] Options);
    private sealed record KnownFact(Guid Id, string Claim, string Project);
    private static string Key(string text) => Regex.Replace(text.Trim(), @"\s+", " ").ToUpperInvariant();
    private static HashSet<string> Words(string text) => Regex.Matches(Key(text), @"[\p{L}\p{N}+#]+").Select(m => m.Value)
        .Where(t => t.Length > 1 && t is not ("PROJECT" or "THE" or "ROLE" or "JOB" or "OF" or "AT")).ToHashSet();
    private static Option AsOption(ExperienceNode n, List<ExperienceNode> nodes) => new(n.Id, n.Revision,
        string.Join(" · ", new[] { n.Label, n.Employer, n.Dates, nodes.Find(p => p.Id == n.ParentRoleId)?.Label }.Where(x => !string.IsNullOrWhiteSpace(x))));
    private static string Ask(Review r) => r.Kind == "statement" ?
        $"This passage may overlap with an existing statement:\nNew: “{r.Claim}”\nExisting: “{r.Options[0].Display}”\n" +
        "Reply “use 1” only if the new passage supports that same wording, or “keep separate” to retain both versions. Neither will overwrite the other." :
        $"Does “{r.Label}” in the document refer to an existing {r.Kind}?\n" +
        string.Join("\n", r.Options.Select((o, i) => $"{i + 1}. {o.Display}")) +
        "\nReply with a number, “keep separate” for a new record, or “skip” to leave the statement unfiled.";

    private static async Task PreserveIndependentSupport(PracticeDb db, Guid owner, Guid removed, CancellationToken ct)
    {
        var cites = db.Set<ExperienceCitation>().Where(c => c.WorkspaceId == owner);
        var pairs = await (from primary in cites.Where(c => c.SourceId == removed && !c.Corroborates)
            join support in cites.Where(c => c.SourceId != removed && c.Corroborates) on primary.FactId equals support.FactId
            join fact in db.Facts.Where(f => f.WorkspaceId == owner) on primary.FactId equals fact.Id
            select new { primary, support, fact }).ToListAsync(ct);
        foreach (var group in pairs.GroupBy(p => p.fact.Id))
        {
            // Only a separately cited verbatim claim can stand alone after the original source is forgotten.
            var keep = group.FirstOrDefault(p => p.support.AttributedExcerpt.Split('\n', 2) is [_, var quote] && Key(quote) == Key(p.fact.Claim));
            if (keep is null) continue;
            foreach (var p in group) p.primary.Corroborates = true;
            keep.support.Corroborates = false;
            keep.fact.Source = keep.support.AttributedExcerpt; keep.fact.Origin = "Document excerpt";
            keep.fact.Confirmed = keep.fact.AllowDrafts = keep.fact.AllowLive = false;
            await db.Set<CueCard>().Where(c => c.FactId == keep.fact.Id).ExecuteDeleteAsync(ct);
        }
        if (pairs.Count != 0) await db.SaveChangesAsync(ct);
    }

    private static async Task<bool> ReconcileHistory(PracticeDb db, ChatSession session, ExperienceSource source, List<EvidenceLine> evidence, CancellationToken ct)
    {
        var owner = session.WorkspaceId;
        var nodes = await db.Set<ExperienceNode>().Where(n => n.WorkspaceId == owner).ToListAsync(ct);
        var history = await db.Facts.AsNoTracking().Where(f => f.WorkspaceId == owner)
            .Select(f => new KnownFact(f.Id, f.Claim, f.Project)).ToListAsync(ct);
        var facts = history.ToLookup(f => Key(f.Claim));
        var added = new List<KnownFact>(); var reviews = new List<Review>();
        var names = new HashSet<string>(); var linked = 0;
        foreach (var (line, filing, suggested) in evidence.Distinct())
        {
            var identical = facts[Key(line.Text)].Concat(added.Where(f => Key(f.Claim) == Key(line.Text))).ToArray();
            ExperienceNode? node = null;
            Option[] choices = [];
            if (filing is { Kind: { } kind, Label: { } label })
            {
                var sameKind = nodes.Where(n => n.Kind == kind).ToArray();
                var exact = sameKind.Where(n => Key(n.Label) == Key(label)).ToArray();
                var qualified = exact.Where(n => n.Employer.Length > 0 && line.Text.Contains(n.Employer, StringComparison.OrdinalIgnoreCase) &&
                    (n.Dates.Length == 0 || line.Text.Contains(n.Dates, StringComparison.OrdinalIgnoreCase))).ToArray();
                if (qualified.Length == 1) node = qualified[0];
                else if (exact.Length == 1 && (kind != "role" && exact[0].ParentRoleId is null ||
                    identical.Any(f => Key(f.Project) == Key(exact[0].Label)))) node = exact[0];
                if (node is null)
                {
                    var terms = Words(label);
                    choices = sameKind.Select(n => new { Node = n, Score = (Key(n.Label) == Key(label) ? 100 : 0) +
                        (suggested == n.Id ? 10 : 0) + Words(n.Label).Count(terms.Contains) })
                        .Where(x => x.Score > 0).OrderByDescending(x => x.Score).ThenBy(x => x.Node.Id)
                        .Take(4).Select(x => AsOption(x.Node, nodes)).ToArray();
                    if (choices.Length == 0 && (node = FileUnder(db, owner, nodes, filing)) is null) return false;
                }
                if (node is not null) names.Add(node.Label);
            }
            var matches = identical.Where(f => node is null || Key(f.Project) == Key(node.Label)).ToArray();
            var excerpt = $"Document excerpt · {source.Title} · {line.Location}\n{line.Text}";
            if (choices.Length == 0 && matches.Length == 1)
            {
                db.Add(new ExperienceCitation { WorkspaceId = owner, FactId = matches[0].Id, NodeId = node?.Id,
                    SourceId = source.Id, Location = line.Location, AttributedExcerpt = excerpt, Corroborates = true });
                linked++; continue;
            }
            var fact = Propose(db, owner, node?.Id, node?.Label ?? "Unfiled experience", line.Text, excerpt, "Document excerpt", line.Location, source.Id, null);
            added.Add(new(fact.Id, fact.Claim, fact.Project));
            if (choices.Length != 0) reviews.Add(new(fact.Id, fact.Claim, filing!.Kind!, filing.Label!, choices));
            else if (filing is null && history.Find(f => f.Id == suggested) is { } similar)
                reviews.Add(new(fact.Id, fact.Claim, "statement", "", [new(similar.Id, 0, similar.Claim)]));
        }
        session.ContextJson = reviews.Count == 0 ? "{}" : JsonSerializer.Serialize(reviews);
        session.Stage = reviews.Count == 0 ? "document:done" : "document:review";
        session.Revision++; session.UpdatedAt = DateTime.UtcNow;
        var result = $"{source.Description}\n\nI searched your job history. New statements: {added.Count}. Existing statements supported by this source: {linked}.";
        if (names.Count > 0) result += "\nFiled under: " + string.Join(", ", names.Take(8)) + (names.Count > 8 ? ", …" : "") + ".";
        result += "\nExisting wording and permissions were kept. New statements need your review.";
        if (reviews.Count > 0) result += $"\n\nPossible matches to check: {reviews.Count}.\n{Ask(reviews[0])}";
        ChatModule.Message(db, session, 1, result, "document review");
        return true;
    }

    internal static async Task<string> ResolveDocumentMatch(PracticeDb db, ChatSession s, string text, CancellationToken ct)
    {
        var pending = JsonSerializer.Deserialize<List<Review>>(s.ContextJson)!;
        var r = pending[0]; var input = text.Trim().TrimEnd('.', '!').ToLowerInvariant();
        var match = Regex.Match(input, @"^(?:use\s+)?([1-4])$");
        if (input is not ("keep separate" or "skip") && (!match.Success || int.Parse(match.Groups[1].Value) > r.Options.Length)) return Ask(r);
        var fact = await db.Facts.SingleOrDefaultAsync(f => f.WorkspaceId == s.WorkspaceId && f.Id == r.FactId, ct);
        var cite = await db.Set<ExperienceCitation>().FirstOrDefaultAsync(c => c.WorkspaceId == s.WorkspaceId && c.SourceId == s.Id && c.FactId == r.FactId && !c.Corroborates, ct);
        var reply = "Left this statement unfiled.";
        if (cite is null || fact is null || fact.Confirmed || fact.Claim != r.Claim || cite.NodeId.HasValue)
            reply = "That statement changed or was removed. I left the current history untouched.";
        else if (r.Kind == "statement")
        {
            reply = "Kept the document passage as a separate statement for review.";
            if (match.Success)
            {
                var option = r.Options[0];
                var original = await db.Facts.SingleOrDefaultAsync(f => f.WorkspaceId == s.WorkspaceId && f.Id == option.Id, ct);
                if (original is null || original.Claim != option.Display ||
                    await db.Set<ExperienceCitation>().AnyAsync(c => c.WorkspaceId == s.WorkspaceId && c.FactId == fact.Id && c.SourceId != s.Id, ct))
                    reply = "The earlier statement or its supporting evidence changed. I kept both records untouched.";
                else
                {
                    var citations = await db.Set<ExperienceCitation>().Where(c => c.WorkspaceId == s.WorkspaceId && c.FactId == fact.Id).ToListAsync(ct);
                    foreach (var citation in citations) { citation.FactId = original.Id; citation.Corroborates = true; }
                    await db.SaveChangesAsync(ct);
                    db.Remove(fact);
                    reply = "Attached the new passage to the existing statement. Its wording and permissions are unchanged.";
                }
            }
        }
        else if (input != "skip")
        {
            var nodes = await db.Set<ExperienceNode>().Where(n => n.WorkspaceId == s.WorkspaceId).ToListAsync(ct);
            ExperienceNode node;
            if (input == "keep separate")
            {
                if (nodes.Count >= 200) return "Your library is full. Reply “skip” to keep the source statement without creating a record.";
                node = new ExperienceNode { WorkspaceId = s.WorkspaceId, Kind = r.Kind, Label = r.Label };
                db.Add(node);
            }
            else
            {
                var option = r.Options[int.Parse(match.Groups[1].Value) - 1];
                var current = nodes.Find(n => n.Id == option.Id && n.Kind == r.Kind);
                if (current is null || AsOption(current, nodes) != option)
                {
                    pending[0] = r with { Options = nodes.Where(n => n.Kind == r.Kind && r.Options.Any(o => o.Id == n.Id)).Select(n => AsOption(n, nodes)).ToArray() };
                    s.ContextJson = JsonSerializer.Serialize(pending);
                    return "The saved record changed. No link was made.\n" + Ask(pending[0]);
                }
                node = current;
            }
            cite.NodeId = node.Id; fact.Project = node.Label;
            reply = $"Filed the document statement under {node.Label}. Existing statements were not changed.";
        }
        pending.RemoveAt(0);
        s.ContextJson = pending.Count == 0 ? "{}" : JsonSerializer.Serialize(pending);
        if (pending.Count == 0) { s.Stage = "document:done"; return reply + "\nAll possible matches have been reviewed."; }
        return reply + "\n\n" + Ask(pending[0]);
    }
}
