using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;

[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("SchemaCheck")]

namespace InterviewPrep;

internal sealed class DiscoverySettings
{
    public Guid WorkspaceId { get; set; }
    public string Role { get; set; } = "";
    public bool RemoteOnly { get; set; }
    public bool RequireLocation { get; set; }
    public bool RequirePay { get; set; }
    public string Zone { get; set; } = "UTC";
    public string LocalTime { get; set; } = "09:00";
    public bool Enabled { get; set; }
    public bool AutoDraft { get; set; }
    public DateTime? NextDueUtc { get; set; }
    public int Revision { get; set; }
}

internal sealed class DiscoveryBoard
{
    public required string Key { get; set; }
    public required string RightsBasis { get; set; }
    public string Reuse { get; set; } = "Normalized public listing metadata only; no full posting text or employer outreach.";
    public DateTime? LastAttemptUtc { get; set; }
    public DateTime? LastSuccessUtc { get; set; }
    public DateTime RefreshAfterUtc { get; set; }
    public Guid? Lease { get; set; }
    public string Coverage { get; set; } = "not checked";
}

internal sealed class DiscoveryFollow
{
    public Guid WorkspaceId { get; set; }
    public required string BoardKey { get; set; }
    public Guid Grant { get; set; } = Guid.NewGuid();
    public DateTime ConsentedUtc { get; set; }
}

internal sealed class DiscoveryPublicJob
{
    public required string Key { get; set; }
    public required string BoardKey { get; set; }
    public required string Title { get; set; }
    public string Location { get; set; } = "";
    public string Mode { get; set; } = "unknown";
    public string Pay { get; set; } = "";
    public string Mentions { get; set; } = "";
    public string ContentHash { get; set; } = "";
    public Guid Version { get; set; } = Guid.NewGuid();
    public DateTime SeenUtc { get; set; }
    public bool Open { get; set; } = true;
}

internal sealed class DiscoveryLocalJob
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid WorkspaceId { get; set; }
    public string Title { get; set; } = "";
    public string Employer { get; set; } = "";
    public string Location { get; set; } = "";
    public string Mode { get; set; } = "unknown";
    public string Pay { get; set; } = "";
    public string Excerpt { get; set; } = "";
    public string Must { get; set; } = "";
    public string Preferred { get; set; } = "";
    public DateTime CheckedUtc { get; set; }
    public int Revision { get; set; }
}

internal sealed class DiscoveryDigest
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid WorkspaceId { get; set; }
    public required string LocalDate { get; set; }
    public required string Zone { get; set; }
    public required string TargetRole { get; set; }
    public DateTime CreatedUtc { get; set; }
    public required string Trigger { get; set; }
    public required string Status { get; set; }
    public string CoverageJson { get; set; } = "[]";
    public string WebSearchJson { get; set; } = "";
    public string NextStep { get; set; } = "";
    public string DraftNote { get; set; } = "";
}

internal sealed class DiscoveryMatch
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid WorkspaceId { get; set; }
    public Guid DigestId { get; set; }
    public required string JobKey { get; set; }
    public required string JobHash { get; set; }
    public int Rank { get; set; }
}

internal sealed class DiscoveryDismissal
{
    public Guid WorkspaceId { get; set; }
    public required string JobKey { get; set; }
    public required string Reason { get; set; }
}

internal sealed class DiscoveryPacket
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid WorkspaceId { get; set; }
    public Guid MatchId { get; set; }
    public required string Version { get; set; }
    public required string FactPinsJson { get; set; }
    public DateTime CreatedUtc { get; set; }
    public DateTime? ApprovedUtc { get; set; }
}

internal sealed class DiscoveryFactStamp
{
    public Guid FactId { get; set; }
    public Guid WorkspaceId { get; set; }
    public int Revision { get; set; }
}

public static partial class DiscoveryModule
{
    public static void Configure(ModelBuilder m)
    {
        var settings = m.Entity<DiscoverySettings>();
        settings.HasKey(x => x.WorkspaceId);
        settings.HasOne<Workspace>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        settings.HasIndex(x => new { x.Enabled, x.NextDueUtc });
        var board = m.Entity<DiscoveryBoard>();
        board.HasKey(x => x.Key);
        var job = m.Entity<DiscoveryPublicJob>();
        job.HasKey(x => x.Key);
        job.HasOne<DiscoveryBoard>().WithMany().HasForeignKey(x => x.BoardKey).OnDelete(DeleteBehavior.Cascade);
        var follow = m.Entity<DiscoveryFollow>();
        follow.HasKey(x => new { x.WorkspaceId, x.BoardKey });
        follow.HasOne<Workspace>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        follow.HasOne<DiscoveryBoard>().WithMany().HasForeignKey(x => x.BoardKey).OnDelete(DeleteBehavior.Cascade);
        var local = m.Entity<DiscoveryLocalJob>();
        local.HasOne<Workspace>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        var digest = m.Entity<DiscoveryDigest>();
        digest.HasOne<Workspace>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        digest.HasIndex(x => new { x.WorkspaceId, x.LocalDate }).IsUnique();
        var match = m.Entity<DiscoveryMatch>();
        match.HasOne<DiscoveryDigest>().WithMany().HasForeignKey(x => new { x.WorkspaceId, x.DigestId })
            .HasPrincipalKey(x => new { x.WorkspaceId, x.Id }).OnDelete(DeleteBehavior.Cascade);
        match.HasIndex(x => new { x.WorkspaceId, x.JobKey, x.JobHash }).IsUnique();
        var dismissal = m.Entity<DiscoveryDismissal>();
        dismissal.HasKey(x => new { x.WorkspaceId, x.JobKey });
        dismissal.HasOne<Workspace>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        var packet = m.Entity<DiscoveryPacket>();
        packet.HasOne<DiscoveryMatch>().WithMany().HasForeignKey(x => new { x.WorkspaceId, x.MatchId })
            .HasPrincipalKey(x => new { x.WorkspaceId, x.Id }).OnDelete(DeleteBehavior.Cascade);
        packet.HasIndex(x => new { x.WorkspaceId, x.Version }).IsUnique();
        var stamp = m.Entity<DiscoveryFactStamp>();
        stamp.HasKey(x => x.FactId);
        stamp.HasOne<Fact>().WithMany().HasForeignKey(x => x.FactId).OnDelete(DeleteBehavior.Cascade);
        stamp.HasOne<Workspace>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal static class DiscoveryCalendar
{
    public static bool Valid(string? zone, string? time) =>
        zone is { Length: > 0 and <= 80 } && Regex.IsMatch(zone, @"\A[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+-]+){0,2}\z") &&
        (zone == "UTC" || TimeZoneInfo.TryConvertIanaIdToWindowsId(zone, out _)) &&
        TimeZoneInfo.TryFindSystemTimeZoneById(zone, out _) &&
        TimeOnly.TryParseExact(time, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);

    public static DateOnly LocalDay(DateTime utc, string zone) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), TimeZoneInfo.FindSystemTimeZoneById(zone)));

    public static DateTime At(DateOnly day, string time, string zone)
    {
        var tz = TimeZoneInfo.FindSystemTimeZoneById(zone);
        var local = day.ToDateTime(TimeOnly.ParseExact(time, "HH:mm", CultureInfo.InvariantCulture), DateTimeKind.Unspecified);
        while (tz.IsInvalidTime(local)) local = local.AddMinutes(1);
        return tz.IsAmbiguousTime(local) ? new DateTimeOffset(local, tz.GetAmbiguousTimeOffsets(local).Max()).UtcDateTime :
            TimeZoneInfo.ConvertTimeToUtc(local, tz);
    }

    public static DateTime Next(DateTime now, string time, string zone)
    {
        var today = LocalDay(now, zone);
        var at = At(today, time, zone);
        return at > now ? at : At(today.AddDays(1), time, zone);
    }

    public static DateOnly LatestDue(DateTime now, string time, string zone)
    {
        var today = LocalDay(now, zone);
        return At(today, time, zone) <= now ? today : today.AddDays(-1);
    }
}

internal record ScoutJob(string Key, string Title, string Employer, string Location, string Mode, string Pay,
    string[] Must, string[] Preferred, string[] Mentions, DateTime CheckedUtc, string Source, string? Url,
    bool Fresh, string Version);
internal record FitLine(string Term, string Priority, string Support, double Points, int Weight);
internal record ScoutFit(double Earned, int Possible, FitLine[] Lines, string[] Gaps, string Reason, Fact[] DraftEvidence);
internal record FactPin(Guid Id, string Hash);
internal record ScoutEvidence(Fact Fact, string Text);

internal static class DiscoveryFit
{
    private static readonly string[] Vocabulary = ["Python", "SQL", "C#", ".NET", "Java", "JavaScript", "TypeScript",
        "Go", "Rust", "React", "AWS", "Azure", "Kubernetes", "Docker", "Terraform", "Linux", "PostgreSQL", "Excel",
        "Accessibility", "Data analysis", "Project management", "User research", "Product design", "Customer support",
        "Salesforce", "Accounting", "Budgeting", "Operations", "Forecasting", "Inventory", "Scheduling"];
    private static readonly HashSet<string> StopWords = new(StringComparer.OrdinalIgnoreCase)
        { "a", "an", "and", "or", "of", "in", "with", "the", "to", "for", "at", "on", "as", "is", "i", "work", "skills", "experience", "using", "role" };
    public static string Hash(params string[] values) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(values))));
    public static string FactHash(Fact f) => Hash(f.Id.ToString(), f.Project, f.Claim, f.Source, f.Origin,
        f.SourceMockId?.ToString() ?? "", f.SourceTurn?.ToString(CultureInfo.InvariantCulture) ?? "");
    public static string[] Terms(string text) => text.Split([',', ';', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    private static string[] Words(string text) => Regex.Matches(text, @"[\p{L}\p{Nd}+#]+(?:\.[\p{L}\p{Nd}]+)*|\.[\p{L}]+")
        .Select(m => m.Value == "Go" ? "golang" : m.Value.ToLowerInvariant()).ToArray();
    private static bool Contains(string normalized, string term) =>
        term.Length > 0 && normalized.Contains(" " + term + " ", StringComparison.Ordinal);
    private static string Normalized(string text) => " " + string.Join(' ', Words(text)) + " ";
    public static string[] Mentions(string text)
    {
        var normalized = Normalized(text);
        return Vocabulary.Where(t => Contains(normalized, string.Join(' ', Words(t)))).ToArray();
    }
    public static int RoleOverlap(string role, string title) =>
        Words(role).Where(w => !StopWords.Contains(w)).Distinct().Intersect(Words(title)).Count();
    public static string[] RoleWords(string role) => Words(role).Where(w => !StopWords.Contains(w)).ToArray();

    public static ScoutEvidence[] Index(Fact[] facts) => facts.Where(f => f.Confirmed && f.AllowDrafts)
        .Select(f => new ScoutEvidence(f, Normalized(f.Claim))).ToArray();
    private static bool Supports(string normalized, string phrase) => Contains(normalized, phrase) &&
        !Regex.IsMatch(normalized, @"\b(?:no|not|never|without|haven t|didn t|don t)(?: [\p{L}\p{Nd}.+#]+){0,4} " + Regex.Escape(phrase) + " ");
    public static ScoutFit Assess(ScoutJob job, IReadOnlyList<ScoutEvidence> candidates, string role)
    {
        var requirements = job.Must.Select(t => (t, priority: "required", weight: 2))
            .Concat(job.Preferred.Select(t => (t, "preferred", 1))).Concat(job.Mentions.Select(t => (t, "posting mentions", 1)))
            .DistinctBy(x => x.Item1, StringComparer.OrdinalIgnoreCase).ToArray();
        var lines = new List<FitLine>();
        var directScores = new Dictionary<Guid, int>();
        foreach (var (term, priority, weight) in requirements)
        {
            var words = Words(term);
            var phrase = string.Join(' ', words);
            var direct = candidates.Where(c => Supports(c.Text, phrase)).ToArray();
            foreach (var c in direct) directScores[c.Fact.Id] = directScores.GetValueOrDefault(c.Fact.Id) + weight;
            var partial = words.Length > 1 && words.Any(w => !StopWords.Contains(w) && candidates.Any(c => Supports(c.Text, w)));
            var support = direct.Length > 0 ? "term present" : partial ? "partial term only" : "not documented";
            lines.Add(new(term, priority, support, direct.Length > 0 ? weight : partial ? weight * 0.5 : 0, weight));
        }
        var gaps = lines.Where(l => l.Points < l.Weight).Select(l => $"{l.Term}: {l.Support}").ToList();
        if (requirements.Length == 0) gaps.Add("Requirements were not supplied; evidence coverage is unknown.");
        if (job.Mode == "unknown") gaps.Add("Work arrangement not stated.");
        if (job.Location.Length == 0) gaps.Add("Location not stated.");
        if (job.Pay.Length == 0) gaps.Add("Pay not stated.");
        if (!job.Fresh) gaps.Add("Not freshly verified; confirm the listing before drafting.");
        var selected = candidates.Where(c => directScores.ContainsKey(c.Fact.Id))
            .OrderByDescending(c => directScores[c.Fact.Id]).ThenBy(c => c.Fact.Id).Take(4).Select(c => c.Fact).ToArray();
        return new(lines.Sum(l => l.Points), lines.Sum(l => l.Weight), [.. lines], [.. gaps],
            $"The title shares {RoleOverlap(role, job.Title)} search term(s) with your target. " +
            "Coverage counts wording in your confirmed, draft-permitted statements, not proof of qualification or an offer prediction.", selected);
    }
}
