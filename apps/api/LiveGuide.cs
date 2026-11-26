using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

public sealed class CueCard
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TargetId { get; set; }
    public Guid? FactId { get; set; }
    public string? FactHash { get; set; }
    public required string Line { get; set; }
    public required string Topic { get; set; }
    public int Position { get; set; }
}

public static class LiveGuide
{
    public sealed record Selection(string? Topic, Guid? FactId, string? Label);
    public sealed record Approval(bool Approved, Selection[]? Cards);
    static readonly Dictionary<string, string> Generic = new()
    {
        ["Impact"] = "What changed as a result?", ["Ownership"] = "Separate your contribution from the team's.",
        ["Judgment"] = "Name the trade-off you considered.", ["Clarity"] = "Start with the situation."
    };
    static string Hash(Fact f) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{f.Project}\n{f.Claim}")));
    public static void Configure(ModelBuilder m)
    {
        m.Entity<CueCard>().HasOne<InterviewTarget>().WithMany().HasForeignKey(c => c.TargetId);
        m.Entity<CueCard>().HasOne<Fact>().WithMany().HasForeignKey(c => c.FactId).OnDelete(DeleteBehavior.Cascade);
    }
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/targets/{id:guid}/deck", async (Guid id, PracticeDb db, HttpContext c) =>
        {
            var owner = Preparation.Owner(c);
            if (!await db.Set<InterviewTarget>().AnyAsync(t => t.Id == id && t.WorkspaceId == owner)) return Results.NotFound();
            var cards = await db.Set<CueCard>().AsNoTracking().Where(x => x.TargetId == id).OrderBy(x => x.Position).ToListAsync();
            var ids = cards.Where(x => x.FactId.HasValue).Select(x => x.FactId!.Value).ToArray();
            var facts = await db.Facts.AsNoTracking().Where(f => ids.Contains(f.Id) && f.WorkspaceId == owner && f.Confirmed && f.AllowLive).ToDictionaryAsync(f => f.Id);
            return Results.Ok(cards.Where(x => !x.FactId.HasValue || facts.TryGetValue(x.FactId.Value, out var f) && Hash(f) == x.FactHash)
                .Select(x => new { x.Id, x.Topic, x.Line }));
        });
        app.MapPost("/api/targets/{id:guid}/deck", async (Guid id, Approval input, PracticeDb db, HttpContext c) =>
        {
            var owner = Preparation.Owner(c);
            if (!await db.Set<InterviewTarget>().AnyAsync(t => t.Id == id && t.WorkspaceId == owner)) return Results.NotFound();
            if (!input.Approved || input.Cards is not { Length: <= 5 }) return Results.BadRequest("Preview and approve up to five cards.");
            var cards = new List<CueCard>();
            foreach (var choice in input.Cards)
            {
                if (choice is null || !Generic.TryGetValue(choice.Topic ?? "", out var line)) return Results.BadRequest("Unknown cue topic.");
                string? hash = null;
                if (choice.FactId is Guid fid)
                {
                    var fact = await db.Facts.SingleOrDefaultAsync(f => f.Id == fid && f.WorkspaceId == owner && f.Confirmed && f.AllowLive);
                    if (fact is null) return Results.BadRequest("Select a confirmed example that permits live reminders.");
                    if (choice.Label is not { Length: > 0 and <= 65 } label ||
                        !Regex.IsMatch(label, @"^[\p{L}\p{N}][\p{L}\p{N}'-]*( [\p{L}\p{N}][\p{L}\p{N}'-]*){0,5}$"))
                        return Results.BadRequest("Use a short, non-confidential project label (one to six words).");
                    line = $"Mention {label}."; hash = Hash(fact);
                }
                cards.Add(new() { TargetId = id, Topic = choice.Topic!, Line = line, FactId = choice.FactId, FactHash = hash, Position = cards.Count });
            }
            await using var tx = await db.Database.BeginTransactionAsync();
            await db.Set<CueCard>().Where(x => x.TargetId == id).ExecuteDeleteAsync();
            db.AddRange(cards); await db.SaveChangesAsync(); await tx.CommitAsync();
            return Results.NoContent();
        });
    }
}
