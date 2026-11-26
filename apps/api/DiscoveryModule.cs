using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace InterviewPrep;

public static partial class DiscoveryModule
{
    internal sealed record Preferences(string? Role, string? Zone, string? LocalTime, bool Enabled, bool AutoDraft,
        bool RemoteOnly, bool RequireLocation, bool RequirePay);
    internal sealed record FollowBoard(string? Provider, string? Slug, bool PermitPublicLookup);
    internal sealed record PastedListing(string? Title, string? Employer, string? Location, string? Mode, string? Pay,
        string? Excerpt, string? Must, string? Preferred, bool PermitPrivateUse);
    internal sealed record Dismiss(string? Reason);
    internal sealed record Approval(string? Version);
    private static Guid Owner(HttpContext c) => (Guid)c.Items["workspace"]!;
    private static bool Single(string? text, int max, bool required = false) =>
        (text?.Length ?? 0) <= max && (!required || !string.IsNullOrWhiteSpace(text)) &&
        (text is null || !text.Any(char.IsControl));
    private static bool Lines(string? text, int max) => (text?.Length ?? 0) <= max &&
        (text is null || !text.Any(c => char.IsControl(c) && c is not ('\r' or '\n' or '\t')));
    private static bool ListOfTerms(string? text) => Lines(text, 650) && DiscoveryFit.Terms(text ?? "") is { Length: <= 8 } terms &&
        terms.All(t => t.Length <= 80 && t.Any(char.IsLetterOrDigit));
    private static Task<int> InputsChanged(PracticeDb db, Guid owner, CancellationToken ct) =>
        db.Set<DiscoverySettings>().Where(s => s.WorkspaceId == owner).ExecuteUpdateAsync(s => s.SetProperty(x => x.Revision, x => x.Revision + 1), ct);

    public static void Register(IServiceCollection services)
    {
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<DiscoveryBoardPolicy>();
        services.AddHttpClient<DiscoveryBoards>(c =>
        {
            c.Timeout = TimeSpan.FromSeconds(8);
            c.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        }).RemoveAllLoggers().ConfigurePrimaryHttpMessageHandler(DiscoveryBoards.Transport);
        services.AddScoped<DiscoveryScout>();
        services.AddHostedService<DiscoveryEvidenceObserver>();
        services.AddHostedService<DiscoveryTimer>();
    }

    public static void Map(WebApplication app)
    {
        var g = app.MapGroup("/api/discovery");
        g.MapGet("", (Guid? digestId, DiscoveryScout scout, HttpContext c) => scout.State(Owner(c), c.RequestAborted, digestId));
        g.MapPost("/run", (DiscoveryScout scout, HttpContext c) => scout.Run(Owner(c), false, c.RequestAborted));
        g.MapPut("/settings", async (Preferences input, HttpContext c, PracticeDb db, TimeProvider clock) =>
        {
            if (!Single(input.Role, 120, true) || DiscoveryFit.RoleWords(input.Role!).Length == 0 ||
                !DiscoveryCalendar.Valid(input.Zone, input.LocalTime) || (input.AutoDraft && !input.Enabled))
                return Results.BadRequest("Enter a target role, an IANA timezone and a 24-hour HH:mm time. Automatic pairs require the daily scout.");
            var owner = Owner(c); var ct = c.RequestAborted;
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            if (input.Enabled && !await AccountsModule.AllowScoutAsync(db, owner))
                return Results.Json("Daily scouting is unavailable on this plan.", statusCode: 403);
            var s = await db.Set<DiscoverySettings>().SingleOrDefaultAsync(s => s.WorkspaceId == owner, ct);
            if (s is null) { s = new() { WorkspaceId = owner }; db.Add(s); }
            if (!input.Enabled) s.NextDueUtc = null;
            else if (s.NextDueUtc is null || !s.Enabled || s.Zone != input.Zone || s.LocalTime != input.LocalTime)
            {
                var now = clock.GetUtcNow().UtcDateTime;
                var day = DiscoveryCalendar.LocalDay(now, input.Zone!);
                var done = await db.Set<DiscoveryDigest>().AnyAsync(d => d.WorkspaceId == owner && d.LocalDate == DiscoveryScout.Day(day), ct);
                s.NextDueUtc = DiscoveryCalendar.At(done ? day.AddDays(1) : day, input.LocalTime!, input.Zone!);
            }
            s.Role = input.Role!.Trim(); s.Zone = input.Zone!; s.LocalTime = input.LocalTime!; s.Enabled = input.Enabled;
            s.AutoDraft = input.AutoDraft; s.RemoteOnly = input.RemoteOnly; s.RequireLocation = input.RequireLocation;
            s.RequirePay = input.RequirePay; s.Revision++;
            await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
            return Results.NoContent();
        });
        g.MapPost("/pause", async (PracticeDb db, HttpContext c) =>
        {
            await db.Set<DiscoverySettings>().Where(s => s.WorkspaceId == Owner(c)).ExecuteUpdateAsync(q =>
                q.SetProperty(s => s.Enabled, false).SetProperty(s => s.AutoDraft, false).SetProperty(s => s.NextDueUtc, (DateTime?)null)
                    .SetProperty(s => s.Revision, s => s.Revision + 1), c.RequestAborted);
            return Results.NoContent();
        });
        g.MapGet("/schedule-preview", (string zone, string localTime, string date) =>
        {
            if (!DiscoveryCalendar.Valid(zone, localTime) ||
                !DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) || day.Year is < 2000 or > 2099)
                return Results.BadRequest("Use an IANA zone, HH:mm and an ISO calendar date from 2000–2099.");
            return Results.Ok(new { date, zone, localTime, dueUtc = DiscoveryScout.Stamp(DiscoveryCalendar.At(day, localTime, zone)) });
        });
        g.MapPost("/boards", async (FollowBoard input, HttpContext c, PracticeDb db, DiscoveryBoardPolicy policy, TimeProvider clock) =>
        {
            if (!input.PermitPublicLookup || !DiscoveryBoardPolicy.Valid(input.Provider, input.Slug))
                return Results.BadRequest("Opt in to a permitted board using its public lowercase token, not a URL.");
            var label = $"{input.Provider}:{input.Slug}";
            if (!policy.Roster.Contains(label)) return Results.BadRequest("That board has no operator-approved public metadata reuse permission.");
            var owner = Owner(c); var ct = c.RequestAborted;
            var key = policy.StoreKey(label);
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            if (!await db.Set<DiscoveryFollow>().AnyAsync(f => f.WorkspaceId == owner && f.BoardKey == key, ct))
            {
                if (await db.Set<DiscoveryFollow>().CountAsync(f => f.WorkspaceId == owner, ct) >= 4) return Results.BadRequest("Follow at most four boards.");
                if (!await db.Set<DiscoveryBoard>().AnyAsync(b => b.Key == key, ct)) db.Add(new DiscoveryBoard { Key = key,
                    RightsBasis = policy.ReplayDirectory is null ? "Operator-cleared employer board; published jobs API." : "Operator-supplied offline fixture, not a live vacancy." });
                db.Add(new DiscoveryFollow { WorkspaceId = owner, BoardKey = key, ConsentedUtc = clock.GetUtcNow().UtcDateTime });
                await InputsChanged(db, owner, ct);
                await db.SaveChangesAsync(ct);
            }
            await tx.CommitAsync(ct);
            return Results.NoContent();
        });
        g.MapDelete("/boards/{provider}/{slug}", async (string provider, string slug, HttpContext c, PracticeDb db) =>
        {
            if (!DiscoveryBoardPolicy.Valid(provider, slug)) return Results.NotFound();
            var owner = Owner(c); var ct = c.RequestAborted;
            string[] keys = [$"public:{provider}:{slug}", $"replay:{provider}:{slug}"];
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            if (await db.Set<DiscoveryFollow>().Where(f => f.WorkspaceId == owner && keys.Contains(f.BoardKey)).ExecuteDeleteAsync(ct) == 0)
                return Results.NotFound();
            await db.Set<DiscoveryBoard>().Where(b => keys.Contains(b.Key) && !db.Set<DiscoveryFollow>().Any(f => f.BoardKey == b.Key)).ExecuteDeleteAsync(ct);
            await InputsChanged(db, owner, ct); await tx.CommitAsync(ct);
            return Results.NoContent();
        });
        g.MapPost("/listings", (PastedListing input, HttpContext c, PracticeDb db, TimeProvider clock) => SaveListing(null, input, c, db, clock));
        g.MapPut("/listings/{id:guid}", (Guid id, PastedListing input, HttpContext c, PracticeDb db, TimeProvider clock) => SaveListing(id, input, c, db, clock));
        g.MapDelete("/listings/{id:guid}", async (Guid id, HttpContext c, PracticeDb db) =>
        {
            var owner = Owner(c); var ct = c.RequestAborted;
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            if (await db.Set<DiscoveryLocalJob>().Where(j => j.WorkspaceId == owner && j.Id == id).ExecuteDeleteAsync(ct) == 0) return Results.NotFound();
            await InputsChanged(db, owner, ct); await tx.CommitAsync(ct);
            return Results.NoContent();
        });
        g.MapPost("/matches/{id:guid}/dismiss", async (Guid id, Dismiss input, HttpContext c, PracticeDb db) =>
        {
            if (input.Reason is not ("not relevant" or "stale listing")) return Results.BadRequest("Choose a dismissal reason.");
            var owner = Owner(c); var ct = c.RequestAborted;
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var key = await db.Set<DiscoveryMatch>().Where(m => m.WorkspaceId == owner && m.Id == id).Select(m => m.JobKey).SingleOrDefaultAsync(ct);
            if (key is null) return Results.NotFound();
            if (!await db.Set<DiscoveryDismissal>().AnyAsync(d => d.WorkspaceId == owner && d.JobKey == key, ct))
                db.Add(new DiscoveryDismissal { WorkspaceId = owner, JobKey = key, Reason = input.Reason });
            await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
            return Results.NoContent();
        });
        g.MapPost("/matches/{id:guid}/draft", (Guid id, DiscoveryScout scout, HttpContext c) => scout.CreatePair(Owner(c), id, c.RequestAborted));
        g.MapGet("/matches/{id:guid}/prep", (Guid id, DiscoveryScout scout, HttpContext c) => scout.PrepInput(Owner(c), id, c.RequestAborted));
        g.MapGet("/drafts/{id:guid}", (Guid id, DiscoveryScout scout, HttpContext c) => scout.Packet(Owner(c), id, "preview", null, null, c.RequestAborted));
        g.MapPost("/drafts/{id:guid}/approve", (Guid id, Approval input, DiscoveryScout scout, HttpContext c) =>
            scout.Packet(Owner(c), id, "approve", input.Version, null, c.RequestAborted));
        g.MapGet("/drafts/{id:guid}/export", (Guid id, string? format, DiscoveryScout scout, HttpContext c) =>
            scout.Packet(Owner(c), id, "export", null, format, c.RequestAborted));
    }

    private static async Task<IResult> SaveListing(Guid? id, PastedListing input, HttpContext c, PracticeDb db, TimeProvider clock)
    {
        if (!input.PermitPrivateUse || !Single(input.Title, 180, true) || !Single(input.Employer, 120, true) ||
            !Single(input.Location, 150) || !Single(input.Pay, 120) || !Lines(input.Excerpt, 4000) ||
            !ListOfTerms(input.Must) || !ListOfTerms(input.Preferred) || input.Mode is not (null or "unknown" or "remote" or "hybrid" or "onsite"))
            return Results.BadRequest("Confirm permission, enter employer and title, and use at most eight short phrases per requirement field.");
        var owner = Owner(c); var ct = c.RequestAborted;
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        DiscoveryLocalJob? j;
        if (id.HasValue)
        {
            j = await db.Set<DiscoveryLocalJob>().SingleOrDefaultAsync(x => x.WorkspaceId == owner && x.Id == id, ct);
            if (j is null) return Results.NotFound();
        }
        else
        {
            if (await db.Set<DiscoveryLocalJob>().CountAsync(x => x.WorkspaceId == owner, ct) >= 50)
                return Results.BadRequest("Remove an older private listing before adding another (limit 50).");
            j = new() { WorkspaceId = owner }; db.Add(j);
        }
        j.Title = input.Title!.Trim(); j.Employer = input.Employer!.Trim(); j.Location = input.Location?.Trim() ?? "";
        j.Pay = input.Pay?.Trim() ?? ""; j.Mode = input.Mode ?? "unknown"; j.Excerpt = input.Excerpt?.Trim() ?? "";
        j.Must = string.Join(", ", DiscoveryFit.Terms(input.Must ?? "")); j.Preferred = string.Join(", ", DiscoveryFit.Terms(input.Preferred ?? ""));
        if (id.HasValue && db.ChangeTracker.HasChanges()) j.Revision++;
        j.CheckedUtc = clock.GetUtcNow().UtcDateTime;
        await InputsChanged(db, owner, ct); await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
        return Results.Ok(new { j.Id });
    }
}
