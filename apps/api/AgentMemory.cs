using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal static class AgentMemory
{
    internal sealed record Edit(string? Text);
    internal sealed class Entry
    {
        public Guid Id { get; init; }
        public Guid? ChatId { get; init; }
        public Guid? FactId { get; init; }
        public string Text { get; init; } = "";
    }

    internal static void Configure(ModelBuilder m)
    {
        var note = m.Entity<ChatNote>();
        note.HasOne<ChatSession>().WithMany().HasForeignKey(n => new { n.WorkspaceId, n.ChatId })
            .HasPrincipalKey(c => new { c.WorkspaceId, c.Id }).OnDelete(DeleteBehavior.Cascade);
        note.HasOne(n => n.Fact).WithMany().HasForeignKey(n => new { n.WorkspaceId, n.FactId })
            .HasPrincipalKey(f => new { f.WorkspaceId, f.Id }).OnDelete(DeleteBehavior.Cascade);
        note.HasIndex(n => new { n.WorkspaceId, n.FactId }).IsUnique().HasFilter("FactId IS NOT NULL AND Text = ''");
        note.ToTable(t => t.HasCheckConstraint("CK_ChatNote_source", "ChatId IS NOT NULL OR FactId IS NOT NULL"));
    }

    // Linked memories follow corrections instead of keeping a second, stale copy of an answer.
    internal static IQueryable<Entry> Entries(PracticeDb db, Guid owner) => db.Set<ChatNote>().AsNoTracking()
        .Where(n => n.WorkspaceId == owner).Select(n => new Entry {
            Id = n.Id, ChatId = n.ChatId, FactId = n.FactId,
            Text = n.Text == "" && n.FactId != null ? n.Fact!.Claim : n.Text
        });

    private static Guid Owner(HttpContext c) => (Guid)c.Items["workspace"]!;

    internal static void Map(RouteGroupBuilder g)
    {
        g.MapGet("/memory", (HttpContext c, PracticeDb db, CancellationToken ct) =>
            Entries(db, Owner(c)).OrderBy(n => n.Id).ToArrayAsync(ct));
        g.MapPut("/memory/{id:guid}", async (Guid id, Edit input, HttpContext c, PracticeDb db, CancellationToken ct) =>
        {
            if (input.Text?.Trim() is not { Length: > 0 and <= 2000 } text) return Results.BadRequest("Use 1 to 2,000 characters for a memory.");
            return await db.Set<ChatNote>().Where(n => n.WorkspaceId == Owner(c) && n.Id == id)
                .ExecuteUpdateAsync(x => x.SetProperty(n => n.Text, text), ct) == 1 ? Results.NoContent() : Results.NotFound();
        });
        g.MapDelete("/memory/{id:guid}", async (Guid id, HttpContext c, PracticeDb db, CancellationToken ct) =>
            await db.Set<ChatNote>().Where(n => n.WorkspaceId == Owner(c) && n.Id == id)
                .ExecuteDeleteAsync(ct) == 1 ? Results.NoContent() : Results.NotFound());
    }
}
