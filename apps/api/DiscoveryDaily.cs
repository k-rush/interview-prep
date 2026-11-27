using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal sealed record DailySearchState(bool Enabled, string Role);

internal static class DailySearch
{
    // Legacy rows always had a user-selected HH:mm. An empty LocalTime means the new
    // fixed schedule and an explicitly public role; never send an old board-search role.
    internal const string ManagedTime = "";
    internal const string DeliveryTime = "09:00";
    internal const string Denied = "Daily job search is unavailable on this plan.";
    internal const string NeedRole = "Enter a short public role title, not a message, URL or credential.";
    private static readonly Regex Title = new(@"\A[\p{L}\p{N}.][\p{L}\p{M}\p{N} .+#&/(),’'-]*\z", RegexOptions.CultureInvariant);
    private static readonly Regex Sensitive = new(@"\b(?:sk-|gh[pousr]_|github_pat_|AKIA[A-Z0-9]{12}|Bearer |www\.)|//|[\p{L}\p{N}]{45}|\b(?:my|our|we|please|remember|I (?:am|have|was|used|want))\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    internal static bool ValidRole(string? role) => role is { Length: > 0 and <= 120 } &&
        Title.IsMatch(role) && !Sensitive.IsMatch(role) && role.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length <= 12 &&
        DiscoveryFit.RoleWords(role).Any(w => w.Any(char.IsLetter)) &&
        !(Environment.GetEnvironmentVariable("INTERVIEW_PREP_OPENAI_SEARCH_KEY") is { Length: > 0 } key && role.Contains(key, StringComparison.Ordinal));
    internal static bool HasPublicRole(DiscoverySettings? s) => s?.LocalTime == ManagedTime && ValidRole(s.Role);
    private static DailySearchState View(DiscoverySettings? s) => HasPublicRole(s)
        ? new(s!.Enabled, s.Role) : new(false, "");

    internal static async Task<DailySearchState> Read(PracticeDb db, Guid owner, CancellationToken ct) =>
        View(await db.Set<DiscoverySettings>().AsNoTracking().SingleOrDefaultAsync(s => s.WorkspaceId == owner, ct));

    internal static async Task<bool> Enabled(PracticeDb db, Guid owner, CancellationToken ct) =>
        (await Read(db, owner, ct)).Enabled;

    // The caller owns the transaction and SaveChanges; changing settings performs no search.
    internal static async Task<string?> Set(PracticeDb db, Guid owner, bool enabled, string? role, string? zone, CancellationToken ct)
    {
        if (enabled && PrivateStaging.Enabled) return "Use an on-demand search in private staging; automatic searches are disabled.";
        if (enabled && !await AccountsModule.AllowScoutAsync(db, owner)) return Denied;
        if (zone is not null && !DiscoveryCalendar.Valid(zone, DeliveryTime)) return "Use a valid IANA time zone.";
        var s = await db.Set<DiscoverySettings>().SingleOrDefaultAsync(x => x.WorkspaceId == owner, ct);
        var previous = View(s);
        var target = role?.Trim() ?? previous.Role;
        if ((enabled || target.Length != 0) && !ValidRole(target)) return NeedRole;
        if (s is null && !enabled && target.Length == 0) return null;
        var timezone = zone ?? (HasPublicRole(s) ? s!.Zone : "UTC");
        if (HasPublicRole(s) && s!.Enabled == enabled && s.Role == target && s.Zone == timezone) return null;

        DateTime? due = null;
        if (enabled)
        {
            var now = DateTime.UtcNow;
            var day = DiscoveryCalendar.LocalDay(now, timezone);
            var localDate = DiscoveryScout.Day(day);
            var start = DiscoveryCalendar.At(day, "00:00", timezone);
            var end = DiscoveryCalendar.At(day.AddDays(1), "00:00", timezone);
            var alreadyReported = await db.Set<DiscoveryDigest>().AnyAsync(d => d.WorkspaceId == owner &&
                (d.LocalDate == localDate || (d.CreatedUtc >= start && d.CreatedUtc < end)), ct);
            due = DiscoveryCalendar.At(alreadyReported ? day.AddDays(1) : day, DeliveryTime, timezone);
        }
        s = Store(db, owner, s, target, timezone);
        s.Enabled = enabled;
        s.NextDueUtc = due;
        return null;
    }

    internal static DiscoverySettings Store(PracticeDb db, Guid owner, DiscoverySettings? s, string publicRole, string zone)
    {
        if (s is null) { s = new() { WorkspaceId = owner }; db.Add(s); }
        if (!HasPublicRole(s))
        {
            s.Enabled = false;
            s.NextDueUtc = null;
        }
        s.Role = publicRole;
        s.Zone = zone;
        s.LocalTime = ManagedTime;
        s.AutoDraft = s.RemoteOnly = s.RequireLocation = s.RequirePay = false;
        s.Revision++;
        return s;
    }
}
