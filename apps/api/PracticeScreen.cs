using System.Text.RegularExpressions;

namespace InterviewPrep;

// A transparent offline screen, not a substitute for a failed model assessment.
public static class PracticeScreen
{
    public const string Assessor = "wording-v1";
    private sealed record Signal(string Name, string Pattern);
    private static readonly Signal Personal = new("a specific first-person action", @"\bI (?:personally )?(?:wrote|built|led|owned|designed|chose|tested|created|changed|reviewed|ran|implemented|proposed|coordinated|decided|introduced|measured)\b");
    private static readonly Signal Outcome = new("an observed change", @"\b(reduced|fell|decreased|increased|rose|improved|stopped|dropped|recovered|completed|eliminated|grew|no longer|fewer|faster)\b");
    private static readonly Signal[][] Signals =
    [
        [Personal, new("the team's contribution", @"\b(my team|our team|my colleague|my partner|my teammate|another engineer|the team)\b"),
            new("the scope of the work", @"\b(rollout|pilot|migration|workflow|design|service|project|release|process|prototype|customer|incident)\b")],
        [new("a decision", @"\b(I chose|we chose|I decided|we decided|selected|preferred|we opted|I opted)\b"),
            new("an alternative", @"\b(instead of|rather than|alternative|versus|compared|whereas|over a|over the)\b"),
            new("a reason or constraint", @"\b(because|due to|constraint|risk|cost|deadline|limited|trade-?off|to avoid)\b")],
        [Outcome, new("how the outcome was checked", @"\b(measured|compared|observed|monitored|tracked|checked|surveyed|reported|reviewed|dashboard|feedback|logs|tickets|survey)\b"),
            new("a comparison or time frame", @"\b(before|after|compared with|compared to|from .{1,45} to|per week|during|within|over the)\b")],
        [new("the situation", @"\b(when|during|originally|initially|faced|needed|before|the problem|the goal|the challenge)\b"), Personal, Outcome]
    ];
    private static readonly Regex Uncertain = new(@"\b(don't know|do not know|couldn't measure|didn't measure|not sure|no evidence|unknown|did not (?:improve|change)|didn't (?:improve|change))\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static Mark[] Review(string[] answers) => answers.Select((answer, i) =>
    {
        var hits = Signals[i].Select(s => Regex.Match(answer, s.Pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)).ToArray();
        var found = hits.Count(h => h.Success);
        // Reserve 4 ("unusually strong evidence") for a human or a semantic assessor.
        var points = i == 2 && Uncertain.IsMatch(answer) ? Math.Min(2, found) : found;
        var hit = hits.FirstOrDefault(h => h.Success);
        var start = Math.Min(Math.Max(0, (hit?.Index ?? 0) - 45), Math.Max(0, answer.Length - 150));
        var quote = answer.Substring(start, Math.Min(150, answer.Length - start));
        var missing = Signals[i].Where((_, j) => !hits[j].Success).Select(s => s.Name).ToArray();
        var feedback = missing.Length == 0 ? "The wording screen found all three markers. Verify that the details actually support the claim." :
            "The wording screen did not recognize " + string.Join(" or ", missing) + ". " + Practice.Probes[i].Drill;
        if (points < found) feedback = "The answer expresses uncertainty about the result. State what you could observe without claiming an unmeasured change.";
        return new Mark(points, quote, feedback);
    }).ToArray();
}
