using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal sealed record RankedScoutLink(int Rank, string Title, string Url, string Reason);
internal sealed record RankedScoutWeb(RankedScoutLink[] Links, string Status, bool Incomplete);

internal sealed class DiscoveryRanking
{
    private static readonly HashSet<string> Generic = new(StringComparer.Ordinal) {
        "a", "an", "and", "are", "at", "by", "career", "careers", "from", "hiring", "job", "jobs", "my",
        "opening", "openings", "our", "position", "positions", "posting", "search", "the", "this", "your"
    };
    private static HashSet<string> Words(IEnumerable<string> texts) => texts.SelectMany(DiscoveryFit.RoleWords)
        .Where(w => w.Length <= 45 && w.Any(char.IsLetter) && !Generic.Contains(w)).ToHashSet(StringComparer.Ordinal);
    private readonly List<(string Source, HashSet<string> Terms)> context = [];

    internal static async Task<DiscoveryRanking> For(PracticeDb db, Guid owner, CancellationToken ct)
    {
        var ranker = new DiscoveryRanking();
        var messages = await db.Set<ChatMessage>().AsNoTracking().Where(m => m.WorkspaceId == owner && m.Recallable && m.Speaker == "user")
            .OrderByDescending(m => m.Session.UpdatedAt).ThenByDescending(m => m.Seq).ThenBy(m => m.Id).Take(40)
            .Select(m => m.Text.Substring(0, 480)).ToArrayAsync(ct);
        var notes = await AgentMemory.Entries(db, owner).OrderBy(n => n.FactId != null).ThenBy(n => n.Id).Take(40)
            .Select(n => n.Text.Substring(0, 400)).ToArrayAsync(ct);
        var nodes = await db.Set<ExperienceNode>().AsNoTracking().Where(n => n.WorkspaceId == owner)
            .OrderBy(n => n.Id).Take(60).Select(n => (n.Label + " " + n.Employer).Substring(0, 320)).ToArrayAsync(ct);
        var claims = await db.Facts.AsNoTracking().Where(f => f.WorkspaceId == owner && f.Confirmed)
            .OrderBy(f => f.Id).Take(40).Select(f => f.Claim.Substring(0, 480)).ToArrayAsync(ct);
        ranker.context.Add(("your messages", Words(messages)));
        ranker.context.Add(("agent notes", Words(notes)));
        ranker.context.Add(("job history", Words(nodes.Concat(claims))));
        return ranker;
    }

    internal RankedScoutWeb Rank(ScoutWebResult search, string role)
    {
        var target = Words([role]);
        var links = search.Links.Select(link => {
            var title = Words([link.Title]);
            var roleCount = title.Count(target.Contains);
            // Do not count the user's search command again as a private-context match.
            title.ExceptWith(target);
            var sources = context.Where(c => c.Terms.Overlaps(title)).Select(c => c.Source).ToArray();
            var additional = title.Count(term => context.Any(c => c.Terms.Contains(term)));
            var reason = roleCount == 0 ? "No exact public role term in the citation title." :
                $"Citation title shares {roleCount} of {target.Count} public role {(target.Count == 1 ? "term" : "terms")}.";
            reason += sources.Length == 0 ? " No additional workspace wording matched the title." :
                $" Additional title wording overlaps with {string.Join(", ", sources)}.";
            return new { link, roleCount, additional, sourceCount = sources.Length, reason };
        }).OrderByDescending(x => x.roleCount).ThenByDescending(x => x.additional).ThenByDescending(x => x.sourceCount)
          .Select((x, i) => new RankedScoutLink(i + 1, x.link.Title, x.link.Url, x.reason)).ToArray();
        return new(links, search.Status, search.Incomplete);
    }
}
