using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal static partial class ChatModule
{
    private static string SearchPrompt(string disclosure) => $"What public job title should I search for? For example: Data analyst. {disclosure} Your chats, agent memory and job history stay here and help rank the returned links.";
    private sealed record SearchOffer(string Role, string Zone);
    private sealed record JobStep(string Action, string? Role = null);
    private static bool RequestsJobs(string text) => Is(text, @"\b(find|scout|search for|look for|show|match)\b.{0,70}\b(jobs?|roles?|openings|positions|vacancies|matches)\b|\b(start|run|initiate|do)\b.{0,24}\bjob search\b|^job (search|scout)[.!]?$");
    private static bool PublicRole(string text) => DailySearch.ValidRole(text) &&
        !Is(text, @"\b(I|instead|actually|thanks|yes|sure|never mind)\b");
    private static bool Accept(string text) => Is(text, @"^(yes|yep|yeah|sure|confirm|enable)(?:[, ]+(?:please|do that|run it|turn it on))?[.!]?$");
    private static bool Decline(string text) => Is(text, @"^(no|no[, ]+thanks|no thank you|not now|skip|cancel|stop|never mind)[.!]?$");

    private static JobStep? SearchStep(ChatSession s, string text)
    {
        if (RequestsJobs(text) || s.Stage.StartsWith("daily:", StringComparison.Ordinal)) return new("ask");
        if (s.Stage == "search:offer" && (Accept(text) || Decline(text))) return new(Accept(text) ? "enable" : "decline");
        if (s.Stage == "search:role" || s.Kind == "scout" && s.Stage == "open" && s.Revision == 0)
        {
            if (Accept(text)) return JsonSerializer.Deserialize<SearchOffer>(s.ContextJson)?.Role is { Length: > 0 } role && PublicRole(role) ? new("run", role) : new("ask");
            return Decline(text) ? new("cancel") : PublicRole(text) ? new("run", text) : new("ask");
        }
        return null;
    }

    private static async Task<string> ApplySearch(PracticeDb db, ChatSession s, JobStep step, string zone,
        Guid? digest, string report, string disclosure, CancellationToken ct)
    {
        var owner = s.WorkspaceId;
        if (step.Action == "ask")
        {
            var previous = await DailySearch.Read(db, owner, ct);
            var suggested = previous.Role.Length > 0 ? previous.Role :
                await db.Set<InterviewTarget>().Where(t => t.WorkspaceId == owner).OrderByDescending(t => t.InterviewAt)
                    .Select(t => t.Role).FirstOrDefaultAsync(ct) ??
                await db.Set<ExperienceNode>().Where(n => n.WorkspaceId == owner && n.Kind == "role").OrderBy(n => n.Id)
                    .Select(n => n.Label).FirstOrDefaultAsync(ct);
            s.Stage = "search:role"; s.ContextJson = "{}";
            if (suggested is null || !PublicRole(suggested)) return SearchPrompt(disclosure);
            s.ContextJson = JsonSerializer.Serialize(new SearchOffer(suggested, zone));
            return $"Search for “{suggested}”? Say yes to use this public job title, or type a different title. {disclosure} I'll compare results against your chats, memory and job history locally.";
        }
        var offer = step.Action == "enable" ? JsonSerializer.Deserialize<SearchOffer>(s.ContextJson) : null;
        s.Stage = "open"; s.ContextJson = "{}"; s.PendingSearch = null;
        if (offer is not null)
            return await DailySearch.Enabled(db, owner, ct) ? "Daily search is already on. Your account setting was not changed." :
                await DailySearch.Set(db, owner, true, offer.Role, offer.Zone, ct) ??
                $"Daily search is on for {offer.Role}. Results appear in chat history while the app runs. Turn it off anytime in Account.";
        if (step.Action == "decline") return "I left your daily search setting unchanged.";
        if (step.Role is null) return "No search was run. We can keep talking here.";
        if (s.Revision <= 1) s.Title = "Job search · " + ChatRecall.Clip(step.Role, 64);
        if (digest is not null)
        {
            s.DigestId = digest;
            if (!PrivateStaging.Enabled && !await DailySearch.Enabled(db, owner, ct) && await AccountsModule.AllowScoutAsync(db, owner))
            {
                s.Stage = "search:offer"; s.ContextJson = JsonSerializer.Serialize(new SearchOffer(step.Role, zone));
                report += $"\n\nWould you like me to search for {step.Role} daily while the app is running? Say yes or no. You can change this in Account.";
            }
        }
        return report;
    }
}
