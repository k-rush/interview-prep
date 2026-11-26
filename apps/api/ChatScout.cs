using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal static partial class ChatModule
{
    private sealed record Daily(string Stage, string Reply, string Role = "", string Zone = "UTC", string Time = "", bool Confirmed = false);
    private static bool ValidRole(string text) => text.Length is > 0 and <= 120 && !text.Any(char.IsControl) && DiscoveryFit.RoleWords(text).Length != 0;

    private static Daily? DailyStep(ChatSession s, string text, string zone)
    {
        if (!DiscoveryCalendar.Valid(zone, "09:00")) zone = "UTC";
        if (s.Stage == "open") return Is(text, @"^(?:set up (?:a )?|schedule (?:a )?)?daily(?: job (?:search|scout)(?:es)?)?[.!]?$")
            ? new("daily:role", "What role should I look for each day?") : null;
        var d = JsonSerializer.Deserialize<Daily>(s.ContextJson)!;
        if (Is(text, @"^(?:no|cancel|stop|not now)[.!]?$"))
            return new("open", "Daily search settings were not changed. Send a role for a one-time report, or finish the session.");
        if (s.Stage == "daily:role") return ValidRole(text)
            ? new("daily:time", $"At what local time should I check for {text}? Use HH:mm in {zone}.", text, zone)
            : d with { Reply = "Please use a short role title (up to 120 characters)." };
        if (s.Stage == "daily:time") return DiscoveryCalendar.Valid(d.Zone, text)
            ? d with { Stage = "daily:confirm", Time = text, Reply = $"Run a search for {d.Role} every day at {text} ({d.Zone}) while the studio is running? " +
                "This replaces your scout role and time, keeps your source filters, and permits one eligible draft pair per daily run. Say ‘confirm’ to enable it and get today's report, or ‘no’." }
            : d with { Reply = $"Use a 24-hour time like 09:00 in {d.Zone}. No search has been scheduled." };
        return Is(text, @"^(?:yes|confirm|enable)[.!]?$") ? d with { Stage = "open", Confirmed = true } : d with { Reply = "Say ‘confirm’ to enable the daily search, or ‘no’ to leave your schedule unchanged." };
    }

    private static async Task<string> EnableDaily(PracticeDb db, Guid owner, Daily d, CancellationToken ct)
    {
        var s = await db.Set<DiscoverySettings>().SingleAsync(s => s.WorkspaceId == owner, ct);
        s.Role = d.Role; s.Zone = d.Zone; s.LocalTime = d.Time; s.Enabled = true; s.AutoDraft = true;
        s.NextDueUtc = DiscoveryCalendar.Next(DateTime.UtcNow, d.Time, d.Zone); s.Revision++;
        return $"Daily search enabled for {d.Time} ({d.Zone}). New reports appear in Chat history; pause or change it in Schedule → Daily job search.";
    }
}
