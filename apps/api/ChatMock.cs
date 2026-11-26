using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal static partial class ChatModule
{
    private sealed record MockReply(bool Start = false, string? Invalid = null, string? Next = null, Mark[]? Marks = null, bool Finish = false);
    private static string BeginMock(PracticeDb db, ChatSession s, string target, string title)
    {
        var questions = Practice.Probes.Select(p => p.Question).ToArray();
        questions[0] = $"For {ChatRecall.Clip(title, 100)}, tell me about a relevant project. What part was yours?";
        db.Add(new Mock { Id = s.Id, WorkspaceId = s.WorkspaceId, TargetId = s.TargetId, Target = target, StartKey = s.Id,
            QuestionsJson = JsonSerializer.Serialize(questions), Adaptive = Model });
        s.Title = "Mock · " + ChatRecall.Clip(title, 60); s.Stage = "interview";
        return "Question 1 of 4 · Ownership\n" + questions[0];
    }

    private static async Task<MockReply> MockTurn(PracticeDb db, ChatSession s, string text, bool finish, LocalCoach coach, CancellationToken ct)
    {
        if (s.Stage == "open") return finish ? new(Finish: true) : text.Length <= 2000 ? new(Start: true) : new(Invalid: "Use at most 2,000 characters for the role.");
        var m = await db.Mocks.AsNoTracking().SingleOrDefaultAsync(m => m.WorkspaceId == s.WorkspaceId && m.Id == s.Id, ct);
        if (m is null || m.ReportJson is not null) return new(Invalid: "This round is no longer active.");
        if (finish) return new(Finish: true);
        if (text.Length > 3000) return new(Invalid: "Use at most 3,000 characters per interview answer.");
        var answers = m.Answers().Append(text).ToArray(); var i = answers.Length;
        if (i > 4) return new(Invalid: "This round already has four answers.");
        if (i == 4) return new(Marks: Model ? await coach.Assess(m.Target, m.Questions(), answers, ct) : null);
        return new(Next: Model ? await coach.NextQuestion(ChatRecall.Clip(m.Target, 1800), m.Questions()[i - 1], text, Practice.Probes[i], ct) : null);
    }

    private static async Task<(string Reply, string Mode, bool Closed)> ApplyMock(PracticeDb db, ChatSession s, string text, MockReply action, CancellationToken ct)
    {
        if (action.Start) return (BeginMock(db, s, text, text), "interviewer", false);
        var m = await db.Mocks.SingleOrDefaultAsync(m => m.WorkspaceId == s.WorkspaceId && m.Id == s.Id, ct);
        var answers = m?.Answers() ?? [];
        if (action.Finish)
        {
            var block = await db.Set<PrepBlock>().SingleOrDefaultAsync(b => b.AttemptId == s.Id && db.Set<PrepSchedule>().Any(p => p.WorkspaceId == s.WorkspaceId && p.Id == b.ScheduleId), ct);
            if (block is not null) block.State = "skipped";
            return ($"Practice scorecard · Incomplete\n{answers.Length}/4 questions answered. Grade and simulated hire/no-hire: insufficient evidence. " +
                $"Not counted in readiness trends.\nNext drill: {Practice.Probes[Math.Min(answers.Length, 3)].Drill}", "scorecard", true);
        }
        if (m is null) throw new DbUpdateConcurrencyException();
        answers = [.. answers, text]; m.AnswersJson = JsonSerializer.Serialize(answers); m.Revision++;
        if (answers.Length < 4)
        {
            var i = answers.Length; var qs = m.Questions();
            if (action.Next is not null) { qs[i] = action.Next; m.QuestionsJson = JsonSerializer.Serialize(qs); }
            return ($"Question {i + 1} of 4 · {Practice.Probes[i].Name}\n{qs[i]}", action.Next is not null ? "local model" : "standard probe", false);
        }
        if (Model) db.Add(new QualityCheck { MockId = m.Id, Check = "rubric-and-exact-transcript-citations", Passed = action.Marks is not null });
        var report = Practice.Assess(action.Marks is null ? PracticeScreen.Assessor : "local", action.Marks ?? PracticeScreen.Review(answers));
        m.ReportJson = JsonSerializer.Serialize(report); m.CompletedAt = DateTime.UtcNow;
        var scheduled = await db.Set<PrepBlock>().SingleOrDefaultAsync(b => b.AttemptId == m.Id && db.Set<PrepSchedule>().Any(p => p.WorkspaceId == s.WorkspaceId && p.Id == b.ScheduleId), ct);
        if (scheduled is not null) scheduled.State = "done";
        var source = action.Marks is not null ? "Local model · exact answer citations validated" :
            (Model ? "Model assessment unavailable or not supported by your transcript. " : "") + "Offline wording checklist, not an AI grade";
        return ($"Practice scorecard · {report.Score}/100 ({report.Grade}) · {report.Verdict}\n{source}. Practice only, not an employer prediction.\n\n" +
            string.Join("\n\n", report.Marks.Select((mark, i) => $"{Practice.Probes[i].Name} · {mark.Points}/4\n“{mark.Quote}”\n{mark.Feedback}")) +
            $"\n\nNext drill: {Practice.Probes[report.RetryIndex].Drill}", "scorecard", true);
    }
}
