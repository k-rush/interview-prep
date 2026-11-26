namespace InterviewPrep;

public sealed record Probe(string Name, string Question, string Anchor, string Drill);
public sealed record Mark(int Points, string Quote, string Feedback);
public sealed record Report(string Assessor, Mark[] Marks, decimal Score, string Grade, string Verdict, int RetryIndex);

public static class Practice
{
    public const string Version = "behavioral-v1";
    public static readonly Probe[] Probes =
    [
        new("Ownership", "Tell me about a project relevant to this role. What part was yours?",
            "Distinguishes an individual action from the team's work.", "Name one decision that was yours and who owned the rest."),
        new("Judgment", "Which alternatives did you consider, and why did you choose that approach?",
            "Connects a real alternative and trade-off to a constraint.", "Contrast your choice with one credible alternative."),
        new("Impact", "What changed as a result, and how do you know?",
            "Describes an observed outcome and how it was observed; a number is not required.", "Name an outcome and the observation that supports it. If unknown, say so."),
        new("Clarity", "How would you explain the situation, your action and the result to a new teammate?",
            "Gives a concise, coherent account that someone outside the project can follow.", "Retell the situation, your action and the result in that order.")
    ];

    public static Report Assess(string assessor, Mark[] marks)
    {
        var score = marks.Sum(m => m.Points) * 6.25m;
        var grade = score switch { >= 90 => "A", >= 80 => "B", >= 70 => "C", >= 60 => "D", _ => "F" };
        var hire = score >= 75 && marks[2].Points >= 3;
        var retry = marks[2].Points < 3 ? 2 : Array.FindIndex(marks, m => m.Points == marks.Min(other => other.Points));
        return new(assessor, marks, score, grade, hire ? "Simulated hire" : "Simulated no-hire", retry);
    }
}
