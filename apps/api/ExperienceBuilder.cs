using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

public static partial class ExperienceModule
{
    public sealed record BuilderInput(string? Goal, int? Minutes, bool UseModel);
    public sealed record TurnInput(int? Revision, Guid ClientTurnId, string? Mode, string? Text, Guid? NodeId);
    public sealed record StateInput(int? Revision, string? State);
    private sealed record Suggestion(int? Question);
    // Older "question" turns have no recorded selector; don't attribute those retroactively.
    private const string ModelQuestion = "model-question";
    private const string GuideQuestion = "guide-question";

    private static readonly Dictionary<string, string[]> Probes = new()
    {
        ["role"] = ["Which role title would you like to start with?"],
        ["employer"] = ["Which employer or organization was that role with?"],
        ["dates"] = ["When did you hold that role (approximate dates are fine)?"],
        ["project"] = ["What short label would you give one project or example to explore?"],
        ["scope"] = ["What was the project meant to change?", "What problem was the team trying to solve?"],
        ["action"] = ["What did you personally do on this project?", "Which part was yours, distinct from the team's work?",
            "Which decision about the rollout was yours?"],
        ["tradeoff"] = ["What alternative did you consider before choosing that approach?", "What risk shaped your choice?"],
        ["outcome"] = ["What changed afterward, if anything you actually observed?", "What result could you verify without estimating a number?"],
        ["evidence"] = ["How do you know that result occurred?", "What observation or feedback supports that outcome?"]
    };

    private static void MapBuilders(RouteGroupBuilder group)
    {
        group.MapPost("/builders", async (BuilderInput input, HttpContext c, PracticeDb db, CancellationToken ct) =>
        {
            if (!Valid(input.Goal, 240) || input.Minutes is < 1 or > 120 || (input.UseModel && !ModelEnabled))
                return Results.BadRequest("Enter a target role and optionally 1–120 minutes. The model must be configured before opting in.");
            var owner = Owner(c);
            var builder = new ExperienceBuilder { WorkspaceId = owner, Goal = input.Goal!.Trim(), Minutes = input.Minutes, UseModel = input.UseModel };
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            if (await db.Set<ExperienceBuilder>().CountAsync(b => b.WorkspaceId == owner, ct) >= 60 ||
                !await AccountsModule.TryReserveBuilderAsync(db, owner, builder.Id.ToString("N"))) return Full();
            db.Add(builder);
            AddTurn(db, builder, 1, "coach", GuideQuestion, Probes["role"][0]);
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            return Results.Ok(new { builder.Id });
        });
        group.MapGet("/builders/{id:guid}", async (Guid id, HttpContext c, PracticeDb db, CancellationToken ct) =>
        {
            var owner = Owner(c);
            var session = await db.Set<ExperienceBuilder>().Where(b => b.WorkspaceId == owner && b.Id == id)
                .Select(b => new { b.Id, b.Goal, b.Minutes, b.Stage, b.State, b.Revision, b.UseModel, b.RoleId, b.ProjectId }).SingleOrDefaultAsync(ct);
            if (session is null) return Results.NotFound();
            var turns = await db.Set<ExperienceTurn>().Where(t => t.WorkspaceId == owner && t.BuilderId == id).OrderBy(t => t.Seq)
                .Select(t => new { t.Id, t.Seq, t.Stage, t.Speaker, mode = t.Mode == ModelQuestion || t.Mode == GuideQuestion ? "question" : t.Mode, t.Text,
                    selectedBy = t.Mode == ModelQuestion ? "model" : t.Mode == GuideQuestion ? "guide" : null }).ToListAsync(ct);
            return Results.Ok(new { session, turns });
        });
        group.MapPost("/builders/{id:guid}/turns", AnswerBuilder);
        group.MapPost("/builders/{id:guid}/state", async (Guid id, StateInput input, HttpContext c, PracticeDb db, CancellationToken ct) =>
        {
            var owner = Owner(c);
            if (input.State is not ("active" or "paused" or "closed")) return Results.BadRequest("Choose pause, resume, or finish.");
            var b = await db.Set<ExperienceBuilder>().SingleOrDefaultAsync(b => b.WorkspaceId == owner && b.Id == id, ct);
            if (b == null) return Results.NotFound();
            if (b.State == input.State) return Results.NoContent();
            if (b.Revision != input.Revision || b.State == "closed") return Results.Conflict("The conversation changed. Refresh the transcript.");
            b.State = input.State;
            b.Revision++;
            b.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
        group.MapDelete("/builders/{id:guid}", async (Guid id, HttpContext c, PracticeDb db, CancellationToken ct) =>
        {
            var owner = Owner(c);
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var session = db.Set<ExperienceBuilder>().Where(b => b.WorkspaceId == owner && b.Id == id);
            if (!await session.AnyAsync(ct)) return Results.NotFound();
            var turns = db.Set<ExperienceTurn>().Where(t => t.WorkspaceId == owner && t.BuilderId == id);
            await ForgetFacts(db, owner, db.Set<ExperienceCitation>().Where(e => turns.Any(t => t.Id == e.TurnId)), ct);
            await session.ExecuteDeleteAsync(ct);
            await tx.CommitAsync(ct);
            return Results.NoContent();
        });
    }

    private static ExperienceTurn AddTurn(PracticeDb db, ExperienceBuilder b, int seq, string speaker, string mode, string text, Guid? op = null)
    {
        var turn = new ExperienceTurn { WorkspaceId = b.WorkspaceId, BuilderId = b.Id, Seq = seq, Speaker = speaker,
            Mode = mode, Text = text, Stage = b.Stage, ClientTurnId = op };
        db.Add(turn);
        return turn;
    }

    private static IResult? CheckTurn(ExperienceBuilder? b, ExperienceTurn? previous, TurnInput input, string text)
    {
        if (b == null) return Results.NotFound();
        if (previous != null) return previous.Mode == input.Mode && previous.Text == text ? Results.NoContent() : Results.Conflict("This turn was already used.");
        if (b.Revision != input.Revision || b.State != "active") return Results.Conflict("Refresh the transcript and answer the current question.");
        if (input.NodeId.HasValue && (input.Mode != "answer" || b.Stage is not ("role" or "project")))
            return Results.BadRequest("Choose a saved label only for a role or project question.");
        return null;
    }

    private static async Task<IResult> AnswerBuilder(Guid id, TurnInput input, HttpContext c, PracticeDb db, LocalCoach coach, CancellationToken ct)
    {
        var owner = Owner(c);
        if (input.ClientTurnId == Guid.Empty || input.Revision is null || input.Mode is not ("answer" or "skip" or "unknown") ||
            (input.Mode == "answer" ? !Valid(input.Text, 1500) : !string.IsNullOrWhiteSpace(input.Text)))
            return Results.BadRequest("Answer in up to 1,500 characters, skip, or record an unknown.");
        var answered = input.Mode == "answer";
        var text = answered ? input.Text!.Trim() : input.Mode == "skip" ? "Skipped." : "Unknown.";
        var owned = db.Set<ExperienceBuilder>().Where(b => b.WorkspaceId == owner && b.Id == id);
        var history = db.Set<ExperienceTurn>().Where(t => t.WorkspaceId == owner && t.BuilderId == id);
        var before = await owned.AsNoTracking().SingleOrDefaultAsync(ct);
        var existing = await history.AsNoTracking().SingleOrDefaultAsync(t => t.ClientTurnId == input.ClientTurnId, ct);
        if (CheckTurn(before, existing, input, text) is { } blocked) return blocked;
        var stage = before!.Stage;
        var limit = stage switch { "role" or "project" or "dates" => 100, "employer" => 120, _ => 1500 };
        if (answered && text.Length > limit) return Results.BadRequest($"Use a short answer for this field (up to {limit} characters).");
        var brief = before.Minutes is <= 5;
        var next = stage switch
        {
            "role" => !answered || brief || input.NodeId.HasValue ? "project" : "employer",
            "employer" => "dates", "dates" => "project", "project" => "scope", "scope" => "action",
            "action" => brief ? "outcome" : "tradeoff", "tradeoff" => "outcome",
            "outcome" => answered ? "evidence" : "done", _ => "done"
        };
        var options = Probes.GetValueOrDefault(next) ?? [];
        var question = next switch
        {
            "action" when text.Contains("team", StringComparison.OrdinalIgnoreCase) || text.Split(' ').Contains("we", StringComparer.OrdinalIgnoreCase) => 1,
            "action" when text.Contains("rollout", StringComparison.OrdinalIgnoreCase) => 2,
            "tradeoff" when text.Contains("risk", StringComparison.OrdinalIgnoreCase) => 1,
            "outcome" when input.Mode == "unknown" => 1,
            _ => 0
        };
        var questionMode = GuideQuestion;
        if (answered && before.UseModel && ModelEnabled && options.Length > 1 && stage is "scope" or "action" or "tradeoff" or "outcome")
        {
            var model = await BoundedCall<Suggestion>(coach, coach.Prompt("experience.probe"),
                new { before.Goal, stage, answer = text, options }, "suggestion", ct);
            if (model?.Question is int q && q >= 0 && q < options.Length)
            {
                question = q;
                questionMode = ModelQuestion;
            }
        }
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var b = await owned.SingleOrDefaultAsync(ct);
        existing = await history.AsNoTracking().SingleOrDefaultAsync(t => t.ClientTurnId == input.ClientTurnId, ct);
        if (CheckTurn(b, existing, input, text) is { } changed) return changed;
        var nodes = db.Set<ExperienceNode>().Where(n => n.WorkspaceId == owner);
        var seq = await history.MaxAsync(t => t.Seq, ct) + 1;
        var turn = AddTurn(db, b!, seq, "candidate", input.Mode!, text, input.ClientTurnId);
        if (answered && stage is "role" or "project")
        {
            ExperienceNode? node;
            if (input.NodeId is Guid picked)
            {
                node = await nodes.SingleOrDefaultAsync(n => n.Id == picked && n.Kind == stage, ct);
                if (node == null) return Results.NotFound();
                if (node.Label != text || stage == "project" && b!.RoleId != null && node.ParentRoleId != b.RoleId)
                    return Results.BadRequest("Use the chosen role or project's current label and matching role.");
            }
            else
            {
                if (await nodes.CountAsync(ct) >= 200) return Full();
                node = new ExperienceNode { WorkspaceId = owner, Kind = stage, Label = text, ParentRoleId = stage == "project" ? b!.RoleId : null };
                db.Add(node);
            }
            if (stage == "role") b!.RoleId = node.Id; else b!.ProjectId = node.Id;
        }
        else if (answered)
        {
            var target = stage is "employer" or "dates" ? b!.RoleId : b!.ProjectId ?? b.RoleId;
            var node = target == null ? null : await nodes.SingleOrDefaultAsync(n => n.Id == target, ct);
            if (stage == "employer" && node != null) { node.Employer = text; node.Revision++; }
            if (stage == "dates" && node != null) { node.Dates = text; node.Revision++; }
            var location = $"Builder turn {seq} · {stage}";
            Propose(db, owner, node?.Id, node?.Label ?? "Unfiled experience", text, $"{location} · candidate statement\n{text}",
                "builder · candidate statement", location, null, turn.Id);
        }
        b!.Stage = next;
        b.Revision++;
        b.UpdatedAt = DateTime.UtcNow;
        if (options.Length > 0) AddTurn(db, b, seq + 1, "coach", questionMode, options[question]);
        else
        {
            b.State = "closed";
            AddTurn(db, b, seq + 1, "coach", "recap", "Your conversation is saved. Review the proposed statements; skipped or unknown details are not facts.");
        }
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return Results.NoContent();
    }
}
