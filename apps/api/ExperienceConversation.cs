using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

public static partial class ExperienceModule
{
    internal static bool IsWorkAnswer(string text, bool inExample = true)
    {
        const RegexOptions flags = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
        if (Regex.IsMatch(text, @"^(?:what|why|how|could (?:you|I)|can (?:you|I)|please|for example|hypothetically|I (?:would|might|could|don't know|do not know))\b", flags)) return false;
        return Regex.IsMatch(text, @"\b(?:(?:I|we|my team|our team) (?:personally |also |had |have )?(?:\w+ed|work|own|wrote|ran|built|led|chose|made|took|cut|saw|set|drove|taught|grew|won|sold|oversaw)|(?:my|our) (?:role|contribution|responsibility|job|project) (?:is|was|involved)|(?:I was|we were) responsible for|I (?:am|was) (?:an? |the )[\w-]+)\b", flags) ||
            inExample && Regex.IsMatch(text, @"\b(?:fell|grew|dropped|decreased|increased|improved|reduced|built|designed|implemented|launched|migrated|shipped|delivered|went (?:from|down|up))\b", flags);
    }

    internal static async Task<string?> CaptureAnswer(PracticeDb db, Guid owner, string text, ChatSession? chat,
        Guid? mockId, string location, string? kind, string? label, CancellationToken ct)
    {
        var excerpt = text.Trim();
        if (excerpt.Length > 2000)
        {
            var cut = excerpt[..2000].LastIndexOfAny(['.', '!', '?', '\n']);
            if (cut < 1) return "Your answer stays in the transcript. Share a complete work example under 2,000 characters to file it in your history and memory.";
            excerpt = excerpt[..(cut + 1)].Trim();
        }
        if (excerpt.Length == 0) return null;
        var filing = FilingFor(excerpt, new Filing(kind, label));
        var nodes = await db.Set<ExperienceNode>().Where(n => n.WorkspaceId == owner).ToListAsync(ct);
        var sourceId = chat?.SourceId ?? mockId ?? Guid.NewGuid();
        var cites = db.Set<ExperienceCitation>().Where(c => c.WorkspaceId == owner);
        var previousId = chat?.NodeId ?? (mockId.HasValue ? await cites.Where(c => c.SourceId == sourceId && c.NodeId != null)
            .OrderByDescending(c => c.Location).Select(c => c.NodeId).FirstOrDefaultAsync(ct) : null);
        var previous = nodes.Find(n => n.Id == previousId);
        ExperienceNode? node = null;
        if (filing is not null)
        {
            var matches = nodes.Where(n => n.Kind == filing.Kind && Key(n.Label) == Key(filing.Label!)).ToArray();
            if (matches.Length == 1) node = matches[0];
            else if (matches.Length == 0 && nodes.Count < 200)
            {
                node = new ExperienceNode { WorkspaceId = owner, Kind = filing.Kind!, Label = filing.Label!,
                    ParentRoleId = filing.Kind != "role" && previous?.Kind == "role" ? previous.Id : null };
                db.Add(node);
            }
        }
        else
        {
            var mentioned = nodes.Where(n => n.Label.Length >= 3 && Regex.IsMatch(excerpt,
                @"(?<!\w)" + Regex.Escape(n.Label) + @"(?!\w)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)).Take(2).ToArray();
            node = mentioned.Length == 1 ? mentioned[0] : mentioned.Length == 0 ? previous : null;
        }
        if (chat is not null) chat.NodeId = node?.Id;
        var key = Key(excerpt);
        var facts = await db.Facts.AsNoTracking().Where(f => f.WorkspaceId == owner)
            .Select(f => new { f.Id, f.Claim, f.Project, f.Source }).ToListAsync(ct);
        var attached = node is null ? [] : (await cites.Where(c => c.NodeId == node.Id).Select(c => c.FactId).Distinct().ToListAsync(ct)).ToHashSet();
        bool Compatible(Guid id, string project) => node is null || attached.Contains(id) || Key(project) == Key(node.Label) || project == "Unfiled experience";
        var same = facts.Where(f => Key(f.Claim) == key && Compatible(f.Id, f.Project)).Take(2).ToArray();
        if (same.Length == 0 && facts.Any(f => Compatible(f.Id, f.Project) && (Key(f.Source) == key ||
            f.Source.Split('\n', 2) is [_, var quote] && Key(quote) == key)))
            return "That wording was already reviewed. I kept your current job history unchanged.";
        var origin = mockId.HasValue ? "mock interview answer" : "candidate chat statement";
        var attributed = $"{origin} · {location}\n{excerpt}";
        if (!await db.Set<ExperienceSource>().AnyAsync(x => x.WorkspaceId == owner && x.Id == sourceId, ct))
            db.Add(new ExperienceSource { Id = sourceId, WorkspaceId = owner, Category = "chat",
                Title = (mockId.HasValue ? "Mock interview" : "Conversation") + " · " + ChatRecall.Clip(excerpt, 60) });
        if (chat is not null) chat.SourceId = sourceId;
        var existing = same.Length == 1;
        Guid factId;
        if (existing)
        {
            factId = same[0].Id;
            if (await cites.AnyAsync(c => c.SourceId == sourceId && c.FactId == factId && c.Location == location, ct)) return null;
            db.Add(new ExperienceCitation { WorkspaceId = owner, SourceId = sourceId, FactId = factId,
                NodeId = node?.Id, Location = location, AttributedExcerpt = attributed, Corroborates = true });
        }
        else factId = Propose(db, owner, node?.Id, node?.Label ?? "Unfiled experience",
            excerpt, attributed, origin, location, sourceId, null).Id;
        if (!await db.Set<ChatNote>().AnyAsync(n => n.WorkspaceId == owner && n.FactId == factId, ct))
            db.Add(new ChatNote { WorkspaceId = owner, FactId = factId });
        return existing ? "Linked this answer to your existing statement without changing its wording or permissions. You can review its agent memory."
            : "Added your wording to Job experience for review and to Agent memory. It isn't approved for applications.";
    }

    internal static async Task ForgetConversationSource(PracticeDb db, Guid owner, Guid source, CancellationToken ct)
    {
        await PreserveIndependentSupport(db, owner, source, ct);
        await ForgetFacts(db, owner, db.Set<ExperienceCitation>().Where(c => c.SourceId == source), ct);
        await db.Set<ExperienceSource>().Where(x => x.Id == source && x.WorkspaceId == owner).ExecuteDeleteAsync(ct);
    }
}
