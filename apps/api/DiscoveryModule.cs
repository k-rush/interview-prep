using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace InterviewPrep;

public static partial class DiscoveryModule
{
    internal sealed record PublicSearch(string? Role, string? Zone);
    internal sealed record DailyChange(bool? Enabled, string? Role, string? Zone);
    internal sealed record Dismiss(string? Reason);
    internal sealed record Approval(string? Version);
    private static Guid Owner(HttpContext c) => (Guid)c.Items["workspace"]!;

    public static void Register(IServiceCollection services)
    {
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<DiscoveryBoardPolicy>();
        services.AddHttpClient<DiscoveryBoards>(c =>
        {
            c.Timeout = TimeSpan.FromSeconds(8);
            c.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        }).RemoveAllLoggers().ConfigurePrimaryHttpMessageHandler(DiscoveryBoards.Transport);
        services.AddHttpClient<ScoutWebSearch>(c => c.Timeout = TimeSpan.FromSeconds(45))
            .RemoveAllLoggers().ConfigurePrimaryHttpMessageHandler(ScoutWebSearch.Transport);
        services.AddScoped<DiscoveryScout>();
        services.AddHostedService<DiscoveryEvidenceObserver>();
        if (!PrivateStaging.Enabled) services.AddHostedService<DiscoveryTimer>();
    }

    public static void Map(WebApplication app)
    {
        var g = app.MapGroup("/api/discovery");
        g.MapGet("", (Guid? digestId, DiscoveryScout scout, HttpContext c) => scout.State(Owner(c), c.RequestAborted, digestId));
        g.MapPost("/run", (PublicSearch? input, DiscoveryScout scout, HttpContext c) =>
            scout.Run(Owner(c), false, c.RequestAborted, input?.Role, input?.Zone));
        app.MapGet("/api/account/daily-search", (HttpContext c, PracticeDb db) => DailySearch.Read(db, Owner(c), c.RequestAborted));
        app.MapPut("/api/account/daily-search", async (DailyChange input, HttpContext c, PracticeDb db) =>
        {
            if (input.Enabled is not bool enabled) return Results.BadRequest("Choose whether to enable daily search.");
            var owner = Owner(c); var ct = c.RequestAborted;
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var error = await DailySearch.Set(db, owner, enabled, input.Role, input.Zone, ct);
            if (error is not null) return Results.Json(error, statusCode: error == DailySearch.Denied ? 403 : 400);
            await db.SaveChangesAsync(ct);
            var state = await DailySearch.Read(db, owner, ct);
            await tx.CommitAsync(ct);
            return Results.Ok(state);
        });

        // Keep revocation and review of earlier artifacts available to their owner.
        g.MapDelete("/boards/{provider}/{slug}", async (string provider, string slug, HttpContext c, PracticeDb db) =>
        {
            if (!DiscoveryBoardPolicy.Valid(provider, slug)) return Results.NotFound();
            var owner = Owner(c); var ct = c.RequestAborted;
            string[] keys = [$"public:{provider}:{slug}", $"replay:{provider}:{slug}"];
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            if (await db.Set<DiscoveryFollow>().Where(f => f.WorkspaceId == owner && keys.Contains(f.BoardKey)).ExecuteDeleteAsync(ct) == 0)
                return Results.NotFound();
            await db.Set<DiscoveryBoard>().Where(b => keys.Contains(b.Key) && !db.Set<DiscoveryFollow>().Any(f => f.BoardKey == b.Key)).ExecuteDeleteAsync(ct);
            await tx.CommitAsync(ct);
            return Results.NoContent();
        });
        g.MapDelete("/listings/{id:guid}", async (Guid id, HttpContext c, PracticeDb db) =>
        {
            var owner = Owner(c); var ct = c.RequestAborted;
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            if (await db.Set<DiscoveryLocalJob>().Where(j => j.WorkspaceId == owner && j.Id == id).ExecuteDeleteAsync(ct) == 0) return Results.NotFound();
            await tx.CommitAsync(ct);
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
        g.MapGet("/matches/{id:guid}/prep", (Guid id, DiscoveryScout scout, HttpContext c) => scout.PrepInput(Owner(c), id, c.RequestAborted));
        g.MapGet("/drafts/{id:guid}", (Guid id, DiscoveryScout scout, HttpContext c) => scout.Packet(Owner(c), id, "preview", null, null, c.RequestAborted));
        g.MapPost("/drafts/{id:guid}/approve", (Guid id, Approval input, DiscoveryScout scout, HttpContext c) =>
            scout.Packet(Owner(c), id, "approve", input.Version, null, c.RequestAborted));
        g.MapGet("/drafts/{id:guid}/export", (Guid id, string? format, DiscoveryScout scout, HttpContext c) =>
            scout.Packet(Owner(c), id, "export", null, format, c.RequestAborted));
    }

}
