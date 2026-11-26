using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

public sealed class Workspace
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string TokenHash { get; set; }
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddDays(30);
}

public sealed class Fact
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid WorkspaceId { get; set; }
    public required string Project { get; set; }
    public required string Source { get; set; }
    public required string Claim { get; set; }
    public bool Confirmed { get; set; }
}

public sealed class Mock
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid WorkspaceId { get; set; }
    public required string Target { get; set; }
    public string Rubric { get; set; } = Practice.Version;
    public required string QuestionsJson { get; set; }
    public bool Tailored { get; set; }
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public string AnswersJson { get; set; } = "[]";
    public string? ReportJson { get; set; }
    public string? Retry { get; set; }
    [ConcurrencyCheck] public int Revision { get; set; }

    public string[] Answers() => JsonSerializer.Deserialize<string[]>(AnswersJson)!;
    public string[] Questions() => JsonSerializer.Deserialize<string[]>(QuestionsJson)!;
    public Report? Report() => ReportJson is null ? null : JsonSerializer.Deserialize<Report>(ReportJson);
}

public sealed class PracticeDb(DbContextOptions<PracticeDb> options) : DbContext(options)
{
    public DbSet<Workspace> Workspaces => Set<Workspace>();
    public DbSet<Fact> Facts => Set<Fact>();
    public DbSet<Mock> Mocks => Set<Mock>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<Workspace>().HasIndex(w => w.TokenHash).IsUnique();
        model.Entity<Fact>().HasOne<Workspace>().WithMany().HasForeignKey(f => f.WorkspaceId);
        model.Entity<Mock>().HasOne<Workspace>().WithMany().HasForeignKey(m => m.WorkspaceId);
    }
}
