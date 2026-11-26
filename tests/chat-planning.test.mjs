import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Exercise the transaction boundary with SQLite and injected HTTP responses, not a running studio.
const runner = String.raw`
using System.Net;
using System.Text;
using System.Text.Json;
using InterviewPrep;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

var scenario = args.Single();
using var cx = new SqliteConnection("Data Source=:memory:;Foreign Keys=true");
await cx.OpenAsync();
await using var db = new PracticeDb(new DbContextOptionsBuilder<PracticeDb>().UseSqlite(cx).Options);
await db.Database.EnsureCreatedAsync();
var owner = new Workspace { TokenHash = "alice" }; var other = new Workspace { TokenHash = "bob" };
var chat = new ChatSession { WorkspaceId = owner.Id, Kind = "builder", ContextJson = """{"builder":42}""" };
Check(ChatPlanning.Start(chat).Contains("company"), "missing initial question");
db.AddRange(owner, other, chat); await db.SaveChangesAsync(); db.ChangeTracker.Clear();
var http = new FixtureHttp();
using var client = new HttpClient(http);
var research = new PublicResearch(client); var coach = new LocalCoach(client);
const string zone = "America/Chicago";
var fall = Sunday(11, 1); var spring = Sunday(3, 2);
var interview = fall.AddDays(2);

static void Check(bool ok, string why) { if (!ok) throw new Exception(why); }
static DateOnly Sunday(int month, int nth)
{
    var today = DateOnly.FromDateTime(DateTime.UtcNow);
    for (int year = today.Year; ; year++)
    {
        var first = new DateOnly(year, month, 1);
        var date = first.AddDays((7 - (int)first.DayOfWeek) % 7 + (nth - 1) * 7);
        if (date > today.AddDays(10)) return date;
    }
}
Task<ChatSession> State() => db.Set<ChatSession>().AsNoTracking().SingleAsync();
async Task<string> Turn(string text, string currentZone = zone, bool rollback = false)
{
    await using var tx = await db.Database.BeginTransactionAsync();
    var session = await db.Set<ChatSession>().SingleAsync();
    var reply = await ChatPlanning.Reply(session, text, currentZone, db, research, coach, default);
    session.Revision++; await db.SaveChangesAsync();
    if (rollback) await tx.RollbackAsync(); else await tx.CommitAsync();
    db.ChangeTracker.Clear(); return reply;
}
async Task Details()
{
    await Turn("Amazon"); await Turn("Platform engineer");
    await Turn("Release reliability and a redacted private priority.");
    Check((await State()).Stage == "plan:date", "missing date step");
}
Fact Fact(Guid workspace, string label, bool confirmed, bool drafts) => new() { WorkspaceId = workspace, Project = label,
    Confirmed = confirmed, AllowDrafts = drafts, Source = "restricted source passage", Claim = "restricted release evidence text" };
DateTime Utc(DateOnly date, int hour) => date.ToDateTime(new TimeOnly(hour, 0), DateTimeKind.Utc);

if (scenario == "grounded booking")
{
    db.AddRange(Fact(owner.Id, "Release pilot", true, true), Fact(owner.Id, "No draft reuse", true, false),
        Fact(owner.Id, "Unconfirmed label", false, true), Fact(other.Id, "Other workspace", true, true));
    await db.SaveChangesAsync(); await Details();
    await Turn($"{interview:yyyy-MM-dd}"); Check((await State()).Stage == "plan:date", "a date alone guessed the time");
    Check((await Turn("10:00")).Contains("UTC-06:00"), "incorrect interview offset");
    await Turn("maybe yes, but don't yet");
    Check(http.Urls.Count == 0 && !await db.Set<InterviewTarget>().AnyAsync(), "lookup/save before explicit choice");
    var packet = await Turn("yes");
    Check(http.Urls.SequenceEqual([FixtureHttp.Official]), "outbound input was not a fixed public page");
    foreach (var expected in new[] { "Prep packet", "Reliable delivery", "Release pilot", "Customer focus", FixtureHttp.Official, "nothing booked" })
        Check(packet.Contains(expected), "missing packet element: " + expected);
    foreach (var hidden in new[] { "restricted", "No draft reuse", "Unconfirmed label", "Other workspace", "redacted private", "secret script" })
        Check(!packet.Contains(hidden), "private or unverified material copied: " + hidden);
    var target = await db.Set<InterviewTarget>().AsNoTracking().SingleAsync();
    Check(target.Id == (await State()).TargetId && target.WorkspaceId == owner.Id && target.Sources().Single().Kind.Contains("checked"), "target or citation not persisted");
    Check(!await db.Set<PrepSchedule>().AnyAsync(), "preview booked a schedule");
    await Turn("change"); var preview = await Turn($"{fall.AddDays(-1):yyyy-MM-dd} 18:00; {fall.AddDays(1):yyyy-MM-dd} 18:00");
    Check(preview.Contains("18:00 (UTC-05:00)") && preview.Contains("18:00 (UTC-06:00)"), "preview failed to cross DST at the same local hour");
    await Turn("confirm", "UTC", rollback: true);
    Check(!await db.Set<PrepBlock>().AnyAsync() && (await State()).Stage == "plan:confirm", "effects escaped caller rollback");
    await Turn("confirm", "UTC"); await Turn("confirm");
    var saved = await db.Set<PrepSchedule>().AsNoTracking().Include(p => p.Blocks).SingleAsync();
    var blocks = saved.Blocks.OrderBy(b => b.StartsAt).ToArray();
    Check(saved.TargetId == target.Id && saved.WorkspaceId == owner.Id && saved.Zone == zone && saved.InterviewAt == Utc(interview, 16), "wrong Schedule target/deadline");
    Check(blocks.Select(b => b.StartsAt).SequenceEqual([Utc(fall.AddDays(-1), 23), Utc(fall.AddDays(2), 0)])
        && blocks.All(b => b.Kind == "mock" && b.State == "planned" && b.Minutes == 25), "saved blocks differed from the approved preview");
    var windows = JsonSerializer.Deserialize<Preparation.Window[]>(saved.WindowsJson)!;
    Check(windows.Select(w => w.Start.UtcDateTime).SequenceEqual(blocks.Select(b => b.StartsAt)), "Schedule windows do not describe the approved blocks");
    Check((await State()).Stage == "open" && (await State()).ContextJson == """{"builder":42}""", "planner corrupted the builder state");
}
else if (scenario == "decline and ambiguous dates")
{
    await Details();
    await Turn("03/04"); await Turn("9999-12-31 23:59");
    Check((await State()).Stage == "plan:date", "accepted an ambiguous or unreasonable date");
    Check((await Turn($"{spring:yyyy-MM-dd} 02:30")).Contains("does not exist"), "accepted a nonexistent local time");
    Check((await Turn($"{fall:yyyy-MM-dd} 01:30")).Contains("occurs twice"), "guessed at a repeated local time");
    Check((await Turn("01:30 -05:00")).Contains("01:30 (UTC-05:00)"), "lost the corrected date or ignored its explicit fold offset");
    var packet = await Turn("no");
    Check(packet.Contains("Evidence gap") && packet.Contains("Research declined") && http.Urls.Count == 0, "declined lookup or missing evidence mishandled");
    await Turn("no");
    Check((await State()).Stage == "open" && !await db.Set<PrepSchedule>().AnyAsync() && await db.Set<InterviewTarget>().CountAsync() == 1, "decline booked blocks or lost the saved target");
    var restarted = await db.Set<ChatSession>().SingleAsync(); ChatPlanning.Start(restarted); await db.SaveChangesAsync();
    await Turn("skip"); await Turn("Analyst"); await Turn("skip"); await Turn("zone Pacific/Auckland");
    var shortly = DateTime.UtcNow.AddMinutes(10).ToString("yyyy-MM-ddTHH:mm:ss'Z'");
    Check((await Turn(shortly)).Contains("Pacific/Auckland") && (await Turn("yes")).Contains("isn’t time for a full mock"), "infeasible booking or wrong chosen timezone");
    Check((await State()).Stage == "open" && !await db.Set<PrepSchedule>().AnyAsync() && http.Urls.Count == 0, "booked or fetched for a private imminent interview");
}
else if (scenario == "schedule conflict")
{
    await Details(); await Turn($"{interview:yyyy-MM-dd} 10:00"); await Turn("no");
    await Turn("change"); await Turn($"{fall.AddDays(-1):yyyy-MM-dd} 18:00");
    var target = new InterviewTarget { WorkspaceId = owner.Id, Role = "Different target", Level = "Mid", Round = "Panel" };
    var busy = new PrepSchedule { WorkspaceId = owner.Id, TargetId = target.Id, Zone = zone, WindowsJson = "[]", InterviewAt = Utc(interview, 18) };
    busy.Blocks.Add(new() { Kind = "mock", Label = "Already scheduled", StartsAt = Utc(fall.AddDays(-1), 23).AddMinutes(5), Minutes = 25 });
    db.AddRange(target, busy); await db.SaveChangesAsync(); db.ChangeTracker.Clear();
    Check((await Turn("confirm")).Contains("no longer free") && await db.Set<PrepBlock>().CountAsync() == 1, "silently double-booked a newly occupied slot");
    await Turn($"{fall.AddDays(-1):yyyy-MM-dd} 15:00");
    await Turn("cancel");
    Check((await State()).Stage == "open" && await db.Set<PrepSchedule>().CountAsync() == 1, "cancel overwrote a schedule");
}
else if (scenario == "unavailable and licensed research")
{
    http.Redirect = true;
    var result = await research.FindForPlan("Amazon", default);
    Check(http.Urls.SequenceEqual([FixtureHttp.Official]) && result.Status.Contains("unavailable") && result.Status.Contains("stale")
        && result.Sources.Single().Kind.Contains("unverified"), "followed an off-site redirect or claimed fresh principles");
    result = await research.FindForPlan("Catalog Fixture", default);
    Check(http.Urls.Count == 1 && result.Status.Contains("no live lookup") && result.Status.Contains("Expired") && result.Sources.Single().Title == "Active fixture",
        "unsupported employer triggered search, lost attribution, or included an expired theme");
}
else throw new ArgumentException("Unknown fixture scenario");

sealed class FixtureHttp : HttpMessageHandler
{
    public const string Official = "https://www.amazon.jobs/content/en/our-workplace/leadership-principles";
    public List<string> Urls { get; } = [];
    public bool Redirect { get; set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Urls.Add(request.RequestUri!.AbsoluteUri);
        if (request.RequestUri.AbsoluteUri != Official || request.Method != HttpMethod.Get || request.Content != null || request.Headers.Contains("X-Subscription-Token"))
            throw new Exception("Unexpected outbound request");
        var response = new HttpResponseMessage(Redirect ? HttpStatusCode.MovedPermanently : HttpStatusCode.OK);
        if (Redirect) response.Headers.Location = new Uri("https://elsewhere.invalid/redirect");
        else response.Content = new StringContent("<body><script>secret script</script><h2>Customer Obsession</h2><h2>Ownership</h2></body>", Encoding.UTF8, "text/html");
        return Task.FromResult(response);
    }
}
`;

test('chat planner (isolated SQLite, no app server or network)', async t => {
  const tests = dirname(fileURLToPath(import.meta.url)), fixture = join(tests, 'obj', `planning-${randomUUID()}`);
  await mkdir(fixture, { recursive: true });
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const api = join(tests, '..', 'apps', 'api'), src = relative(fixture, api);
  const project = (await readFile(join(api, 'InterviewPrep.Api.csproj'), 'utf8')).replace('</Project>', `
    <PropertyGroup><RestoreSources>$(MSBuildProjectDirectory)</RestoreSources><NuGetAudit>false</NuGetAudit></PropertyGroup>
    <ItemGroup><Compile Include="${join(src, '*.cs')}" Exclude="${join(src, 'Program.cs')}" /></ItemGroup>
  </Project>`);
  const catalog = join(fixture, 'catalog.json');
  const theme = { company: 'Catalog Fixture', url: 'https://fixture.invalid/theme', theme: 'Synthetic guidance.' };
  await Promise.all([writeFile(join(fixture, 'Fixture.csproj'), project), writeFile(join(fixture, 'Runner.cs'), runner),
    writeFile(catalog, JSON.stringify([{ ...theme, publisher: 'Expired fixture', expiresAt: '2001-01-01T00:00:00Z' },
      { ...theme, publisher: 'Active fixture', expiresAt: new Date(Date.now() + 86400000) }]))]);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('INTERVIEW_PREP_'))),
    INTERVIEW_PREP_LICENSED_THEMES: catalog, DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
  const run = async args => {
    try { await promisify(execFile)('dotnet', args, { cwd: fixture, env, timeout: 120000 }); }
    catch (e) { throw new Error([e.message, e.stdout, e.stderr].join('\n')); }
  };
  await run(['build', 'Fixture.csproj', '--nologo', '--verbosity', 'quiet']);
  for (const scenario of ['grounded booking', 'decline and ambiguous dates', 'schedule conflict', 'unavailable and licensed research'])
    await t.test(scenario, () => run([join('bin', 'Debug', 'net10.0', 'Fixture.dll'), scenario]));
});
