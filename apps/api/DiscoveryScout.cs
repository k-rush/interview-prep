using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal sealed record ScoutInventory(DiscoveryLocalJob[] Locals,
    Dictionary<string, ScoutJob> Jobs, ScoutEvidence[] Evidence, Dictionary<Guid, int> FactRevisions, HashSet<string> Dismissed);

internal sealed class DiscoveryEvidenceObserver(IServiceScopeFactory scopes) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PracticeDb>();
        // Version only material edits. A revoke/regrant or edit/revert must not resurrect an approved export,
        // including when a different module updates the fact and nobody opens Discovery in between.
        await db.Database.ExecuteSqlRawAsync("""
            CREATE TRIGGER IF NOT EXISTS DiscoveryFactVersion
            AFTER UPDATE OF Project, Source, Claim, Confirmed, AllowDrafts, Origin, SourceMockId, SourceTurn ON Facts
            WHEN OLD.Project <> NEW.Project OR OLD.Source <> NEW.Source OR OLD.Claim <> NEW.Claim
                 OR OLD.Confirmed <> NEW.Confirmed OR OLD.AllowDrafts <> NEW.AllowDrafts OR OLD.Origin <> NEW.Origin
                 OR OLD.SourceMockId IS NOT NEW.SourceMockId OR OLD.SourceTurn IS NOT NEW.SourceTurn
            BEGIN
                INSERT INTO DiscoveryFactStamp (FactId, WorkspaceId, Revision) VALUES (NEW.Id, NEW.WorkspaceId, 1)
                ON CONFLICT(FactId) DO UPDATE SET Revision = Revision + 1;
            END;
            """, ct);
    }
    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}

internal sealed class DiscoveryScout(PracticeDb db, DiscoveryBoardPolicy policy, TimeProvider clock, ScoutWebSearch webSearch)
{
    internal string SearchDisclosure => webSearch.Disclosure;
    private static readonly SemaphoreSlim[] Runs = Enumerable.Range(0, 64).Select(_ => new SemaphoreSlim(1, 1)).ToArray();
    private DateTime Now => clock.GetUtcNow().UtcDateTime;
    internal static string? Stamp(DateTime? utc) => utc is null ? null :
        DateTime.SpecifyKind(utc.Value, DateTimeKind.Utc).ToString("O", CultureInfo.InvariantCulture);
    internal static string Day(DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    private Task<DiscoverySettings?> Settings(Guid owner, CancellationToken ct) =>
        db.Set<DiscoverySettings>().AsNoTracking().SingleOrDefaultAsync(x => x.WorkspaceId == owner, ct);
    private Task<bool> Active(Guid owner, DateTime now, CancellationToken ct) =>
        db.Workspaces.AnyAsync(x => x.Id == owner && x.ExpiresAt > now, ct);
    private Task<DiscoveryDigest?> Digest(Guid owner, string day, CancellationToken ct) =>
        db.Set<DiscoveryDigest>().AsNoTracking().SingleOrDefaultAsync(d => d.WorkspaceId == owner && d.LocalDate == day, ct);
    private static bool GoodBoard(DiscoveryBoard b) => b.Coverage == "checked" || b.Coverage.StartsWith("partial:", StringComparison.Ordinal);
    private async Task<ScoutInventory> HistoricalInventory(Guid owner, CancellationToken ct, bool withEvidence = true)
    {
        var now = Now;
        var local = await db.Set<DiscoveryLocalJob>().AsNoTracking().Where(x => x.WorkspaceId == owner)
            .OrderByDescending(x => x.CheckedUtc).ThenBy(x => x.Id).ToArrayAsync(ct);
        var boards = await db.Set<DiscoveryBoard>().AsNoTracking().Where(b => db.Set<DiscoveryFollow>()
            .Any(f => f.WorkspaceId == owner && f.BoardKey == b.Key)).OrderBy(b => b.Key).ToArrayAsync(ct);
        var grants = await db.Set<DiscoveryFollow>().AsNoTracking().Where(f => f.WorkspaceId == owner)
            .ToDictionaryAsync(f => f.BoardKey, f => f.Grant, ct);
        var permitted = boards.Where(b => policy.Permits(b.Key)).ToDictionary(b => b.Key);
        var keys = permitted.Keys.ToArray();
        var publicJobs = await db.Set<DiscoveryPublicJob>().AsNoTracking().Where(j => keys.Contains(j.BoardKey) &&
            j.Open && j.SeenUtc >= now.AddDays(-3)).OrderByDescending(j => j.SeenUtc).ThenBy(j => j.Key).Take(720).ToArrayAsync(ct);
        var jobs = new Dictionary<string, ScoutJob>();
        foreach (var j in local)
        {
            var key = $"local:{j.Id:D}";
            jobs[key] = new(key, j.Title, j.Employer, j.Location, j.Mode, j.Pay,
                DiscoveryFit.Terms(j.Must), DiscoveryFit.Terms(j.Preferred), DiscoveryFit.Mentions(j.Excerpt),
                j.CheckedUtc, "Private paste · candidate-permitted excerpt; verify with the employer", null,
                j.CheckedUtc >= now.AddDays(-7), DiscoveryFit.Hash(j.Revision.ToString(CultureInfo.InvariantCulture), j.Title, j.Employer,
                    j.Mode, j.Location, j.Pay, j.Must, j.Preferred, j.Excerpt));
        }
        foreach (var j in publicJobs)
        {
            var b = permitted[j.BoardKey];
            var key = j.Key;
            jobs[key] = new(key, j.Title, j.BoardKey.Split(':')[2], j.Location, j.Mode, j.Pay, [], [],
                DiscoveryFit.Terms(j.Mentions), j.SeenUtc, policy.ReplayDirectory is null ?
                    $"{DiscoveryBoardPolicy.Label(j.BoardKey)} · permitted public metadata only" :
                    $"{DiscoveryBoardPolicy.Label(j.BoardKey)} · recorded fixture, not a live vacancy",
                DiscoveryBoards.PublicLink(key), GoodBoard(b) && b.LastSuccessUtc == j.SeenUtc && j.SeenUtc >= now.AddHours(-24),
                DiscoveryFit.Hash(key, j.Version.ToString(), grants[j.BoardKey].ToString(), j.ContentHash));
        }
        var facts = withEvidence ? await db.Facts.AsNoTracking().Where(f => f.WorkspaceId == owner && f.Confirmed && f.AllowDrafts)
            .OrderBy(f => f.Id).ToArrayAsync(ct) : [];
        var dismissed = await db.Set<DiscoveryDismissal>().AsNoTracking().Where(x => x.WorkspaceId == owner)
            .Select(x => x.JobKey).ToArrayAsync(ct);
        var revisions = withEvidence ? await db.Set<DiscoveryFactStamp>().AsNoTracking().Where(x => x.WorkspaceId == owner)
            .ToDictionaryAsync(x => x.FactId, x => x.Revision, ct) : [];
        return new(local, jobs, DiscoveryFit.Index(facts), revisions, dismissed.ToHashSet());
    }

    private sealed record Delivery(DiscoveryDigest? Digest = null, bool Replay = false, int StatusCode = 200, string? Error = null);

    internal async Task<IResult> Run(Guid owner, bool scheduled, CancellationToken ct, string? role = null, string? zone = null)
    {
        var result = await Deliver(owner, scheduled, false, role, zone, ct);
        if (result.Error is not null) return Results.Json(result.Error, statusCode: result.StatusCode);
        return result.Digest is { } d ? Results.Ok(new { d.Id, d.LocalDate, d.TargetRole, result.Replay }) : Results.NoContent();
    }

    private async Task<Delivery> Deliver(Guid owner, bool scheduled, bool inChat, string? role, string? zone, CancellationToken ct)
    {
        // Fence same-host deliveries before a paid lookup; the owner/date key also fences publication.
        var gate = Runs[(uint)owner.GetHashCode() % (uint)Runs.Length];
        await gate.WaitAsync(ct);
        try { return await RunCore(owner, scheduled, inChat, role?.Trim(), zone, ct); }
        finally { gate.Release(); }
    }

    private async Task<Delivery> RunCore(Guid owner, bool scheduled, bool inChat, string? suppliedRole, string? zone, CancellationToken ct)
    {
        var now = Now;
        var settings = await Settings(owner, ct);
        var hasRole = DailySearch.HasPublicRole(settings);
        if (scheduled && (!hasRole || !settings!.Enabled || settings.NextDueUtc is null || settings.NextDueUtc > now)) return new();
        if (!await Active(owner, now, ct)) return new(StatusCode: 401, Error: "Workspace unavailable.");
        if (!await AccountsModule.AllowScoutAsync(db, owner))
        {
            if (scheduled) await db.Set<DiscoverySettings>().Where(s => s.WorkspaceId == owner && s.Revision == settings!.Revision)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.Enabled, false).SetProperty(x => x.NextDueUtc, (DateTime?)null)
                    .SetProperty(x => x.Revision, x => x.Revision + 1), ct);
            return new(StatusCode: 403, Error: "New public job searches are unavailable on this plan. Existing reports remain readable.");
        }
        var role = suppliedRole ?? (hasRole ? settings!.Role : "");
        if (!webSearch.AcceptsRole(role)) return new(StatusCode: 400, Error: DailySearch.NeedRole);
        zone ??= hasRole ? settings!.Zone : "UTC";
        const string time = DailySearch.DeliveryTime;
        if (!DiscoveryCalendar.Valid(zone, time)) return new(StatusCode: 400, Error: "Use a valid IANA time zone.");
        var localDay = scheduled ? DiscoveryCalendar.LatestDue(now, time, zone) : DiscoveryCalendar.LocalDay(now, zone);
        var day = Day(localDay);
        var existing = await Digest(owner, day, ct);
        var search = existing is null ? await webSearch.Find(role, ct) : null;

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var live = await db.Set<DiscoverySettings>().SingleOrDefaultAsync(s => s.WorkspaceId == owner, ct);
        if (live?.Revision != settings?.Revision || (scheduled && live?.Enabled != true) || !await Active(owner, Now, ct))
            return new(StatusCode: 409, Error: "Job search settings changed. No new report was published.");
        if (!await AccountsModule.AllowScoutAsync(db, owner))
            return new(StatusCode: 403, Error: "Job search permission changed. No new report was published.");
        existing = await Digest(owner, day, ct);
        // Reports produced before the public-only flow either lack search citations or
        // carry the old packet-generation note. Keep them readable, not new search results.
        var archived = existing is not null && (existing.WebSearchJson.Length == 0 || existing.DraftNote.Length != 0);
        if (!scheduled && suppliedRole is not null && (!hasRole || !live!.Enabled) &&
            (existing is null || !archived && existing.TargetRole.Equals(role, StringComparison.OrdinalIgnoreCase)) &&
            (!hasRole || live!.Role != role || live.Zone != zone))
            live = DailySearch.Store(db, owner, live, role, zone);
        if (scheduled) live!.NextDueUtc = DiscoveryCalendar.Next(now, time, zone);
        if (existing is not null)
        {
            await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
            if (archived) return new(StatusCode: 409, Error: "This local day already has a historical report. It remains in history; no new public lookup was made.");
            return new(existing, true);
        }
        if (search is null) return new(StatusCode: 409, Error: "The earlier report was removed. Try again.");
        var coverage = new List<string> { search.Status };
        if (scheduled && settings!.NextDueUtc is DateTime due && DiscoveryCalendar.LocalDay(due, zone) < localDay)
            coverage.Add("Older missed days were skipped; only the latest due local day was processed.");
        var nextStep = search.Links.Length > 0
            ? "Compare the cited descriptions. Check responsibilities, availability, location and pay with the employer; title overlap is not a hiring assessment."
            : search.Incomplete ? "No public results are available for this report. Check employer careers pages directly; this does not mean there are no jobs."
            : "No usable cited links were returned. Check employer careers pages directly; this does not mean there are no jobs.";
        var digest = new DiscoveryDigest { WorkspaceId = owner, LocalDate = day, Zone = zone, TargetRole = role,
            CreatedUtc = Now, Trigger = scheduled ? "scheduled" : "manual", Status = search.Incomplete ? "partial" : "complete",
            CoverageJson = JsonSerializer.Serialize(coverage), WebSearchJson = JsonSerializer.Serialize(search), NextStep = nextStep };
        db.Add(digest);
        if (!inChat)
        {
            var session = new ChatSession { WorkspaceId = owner, Title = $"{(scheduled ? "Daily job search" : "Job search")} · {role}",
                DigestId = digest.Id };
            db.Add(session);
            ChatModule.Message(db, session, 0, await ReportText(owner, digest, ct), "report");
        }
        await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
        return new(digest);
    }

    internal async Task<(Guid? Id, string Text)> ChatReport(Guid owner, string role, string zone, CancellationToken ct)
    {
        var delivery = await Deliver(owner, false, true, role, zone, ct);
        if (delivery.Digest is not { } digest) return (null, delivery.Error ?? "No public report was published.");
        if (!digest.TargetRole.Equals(role.Trim(), StringComparison.OrdinalIgnoreCase))
            return (null, "This local day already has a report for a different role. You can open it in history. No additional search or schedule change was made.");
        return (digest.Id, await ReportText(owner, digest, ct));
    }

    private async Task<string> ReportText(Guid owner, DiscoveryDigest digest, CancellationToken ct)
    {
        var search = SearchResult(digest);
        var ranker = search.Links.Length == 0 ? new DiscoveryRanking() : await DiscoveryRanking.For(db, owner, ct);
        return ReportText(digest, ranker.Rank(search, digest.TargetRole));
    }

    internal static string ReportText(DiscoveryDigest digest, RankedScoutWeb? ranked = null)
    {
        ranked ??= new DiscoveryRanking().Rank(SearchResult(digest), digest.TargetRole);
        var lines = new List<string> { $"Job search report · {digest.TargetRole} · {digest.LocalDate}", ranked.Status };
        if (ranked.Links.Length > 0)
        {
            lines.Add(ranked.Links.Length == 1 ? "One unverified public citation:" : $"{ranked.Links.Length} unverified public citations, ordered locally by title wording:");
            lines.AddRange(ranked.Links.Select(l => $"{l.Rank}. {l.Title} — {l.Reason}"));
        }
        lines.Add(digest.WebSearchJson.Length == 0 ? "This historical report predates public web search." : digest.NextStep);
        return string.Join("\n", lines);
    }

    private static string PinHash(Fact f, ScoutInventory inv) => DiscoveryFit.Hash(DiscoveryFit.FactHash(f),
        inv.FactRevisions.GetValueOrDefault(f.Id).ToString(CultureInfo.InvariantCulture));

    private static string Condition(DiscoveryMatch m, ScoutInventory inv)
    {
        if (inv.Dismissed.Contains(m.JobKey)) return "dismissed";
        if (!inv.Jobs.TryGetValue(m.JobKey, out var j)) return "removed, closed, expired or source permission withdrawn";
        if (j.Version != m.JobHash) return "listing changed; a new match is needed";
        return j.Fresh ? "current" : "dated listing; reconfirm before drafting";
    }
    private static Fact[]? Validate(DiscoveryPacket packet, ScoutInventory inv)
    {
        var pins = JsonSerializer.Deserialize<FactPin[]>(packet.FactPinsJson) ?? [];
        var facts = pins.Select(p => inv.Evidence.FirstOrDefault(c => c.Fact.Id == p.Id && PinHash(c.Fact, inv) == p.Hash)?.Fact).ToArray();
        return facts.Length == 0 || facts.Any(f => f is null) ? null : facts.Cast<Fact>().ToArray();
    }

    internal async Task<IResult> PrepInput(Guid owner, Guid matchId, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var m = await db.Set<DiscoveryMatch>().AsNoTracking().SingleOrDefaultAsync(x => x.WorkspaceId == owner && x.Id == matchId, ct);
        if (m is null) return Results.NotFound();
        var inv = await HistoricalInventory(owner, ct, withEvidence: false);
        if (Condition(m, inv) != "current") return Results.Conflict("Reconfirm this listing before using it as an interview target.");
        var j = inv.Jobs[m.JobKey];
        var lines = new List<string> { $"Posting: {j.Title} — {j.Employer}", $"Source: {j.Source}. Checked {Stamp(j.CheckedUtc)}." };
        if (j.Location.Length > 0) lines.Add("Location: " + j.Location);
        if (j.Mode != "unknown") lines.Add("Work arrangement: " + j.Mode);
        if (j.Pay.Length > 0) lines.Add("Posted pay: " + j.Pay);
        if (j.Must.Length > 0) lines.Add("Required: " + string.Join(", ", j.Must));
        if (j.Preferred.Length > 0) lines.Add("Preferred: " + string.Join(", ", j.Preferred));
        if (j.Mentions.Length > 0) lines.Add("Mentioned in the posting (priority not specified): " + string.Join(", ", j.Mentions));
        if (inv.Locals.FirstOrDefault(l => $"local:{l.Id:D}" == j.Key)?.Excerpt is { Length: > 0 } excerpt)
            lines.Add("Candidate-permitted posting excerpt:\n" + excerpt);
        return Results.Ok(new Preparation.TargetInput(j.Title[..Math.Min(j.Title.Length, 160)], j.Employer[..Math.Min(j.Employer.Length, 100)],
            "Not specified", "Not scheduled", string.Join("\n", lines), j.Url));
    }

    internal async Task<IResult> State(Guid owner, CancellationToken ct, Guid? digestId = null)
    {
        // Read one consistent snapshot: do not combine an old fact with a newer approval or deletion.
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var digests = await db.Set<DiscoveryDigest>().AsNoTracking().Where(x => x.WorkspaceId == owner && (digestId == null || x.Id == digestId))
            .OrderByDescending(x => x.CreatedUtc).Take(31).ToArrayAsync(ct);
        var searches = digests.ToDictionary(d => d.Id, SearchResult);
        var ranker = searches.Values.Any(s => s.Links.Length > 0) ? await DiscoveryRanking.For(db, owner, ct) : new DiscoveryRanking();
        var ids = digests.Select(d => d.Id).ToArray();
        var matches = await db.Set<DiscoveryMatch>().AsNoTracking().Where(x => x.WorkspaceId == owner && ids.Contains(x.DigestId))
            .OrderBy(x => x.Rank).ToArrayAsync(ct);
        var mids = matches.Select(m => m.Id).ToArray();
        var packets = await db.Set<DiscoveryPacket>().AsNoTracking().Where(p => p.WorkspaceId == owner && mids.Contains(p.MatchId))
            .OrderByDescending(p => p.CreatedUtc).ToArrayAsync(ct);
        var archive = matches.Length > 0 ? await HistoricalInventory(owner, ct) : null;
        object MatchView(DiscoveryMatch m, string role, ScoutInventory inv)
        {
            var status = Condition(m, inv);
            var job = status is "current" or "dated listing; reconfirm before drafting" ? inv.Jobs[m.JobKey] : null;
            var fit = job is null ? null : DiscoveryFit.Assess(job, inv.Evidence, role);
            return new { m.Id, m.Rank, status, listing = job is null ? null : new { job.Title, job.Employer, job.Location,
                    job.Mode, job.Pay, job.Source, job.Url, checkedUtc = Stamp(job.CheckedUtc), job.Fresh },
                fit = fit is null ? null : new { fit.Earned, fit.Possible, fit.Lines, fit.Gaps, fit.Reason },
                packets = packets.Where(p => p.MatchId == m.Id).Select(p => new { p.Id, current = status == "current" && Validate(p, inv) is not null,
                    approved = p.ApprovedUtc is not null, createdUtc = Stamp(p.CreatedUtc) }).ToArray() };
        }
        var output = new {
            scoutAllowed = await AccountsModule.AllowScoutAsync(db, owner),
            webSearchConfigured = webSearch.Configured,
            digests = digests.Select(d => new { d.Id, d.LocalDate, d.Zone, d.TargetRole, createdUtc = Stamp(d.CreatedUtc), d.Trigger,
                d.Status, coverage = JsonSerializer.Deserialize<string[]>(d.CoverageJson), webSearch = ranker.Rank(searches[d.Id], d.TargetRole), d.NextStep,
                matches = matches.Where(m => m.DigestId == d.Id).Select(m => MatchView(m, d.TargetRole, archive!)).ToArray() }).ToArray()
        };
        await tx.CommitAsync(ct);
        return Results.Ok(output);
    }

    private static ScoutWebResult SearchResult(DiscoveryDigest digest) => digest.WebSearchJson.Length == 0
        ? new([], "Public web search was not consulted for this historical digest.", true)
        : JsonSerializer.Deserialize<ScoutWebResult>(digest.WebSearchJson)!;

    internal async Task<IResult> Packet(Guid owner, Guid id, string action, string? version, string? format, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var p = await db.Set<DiscoveryPacket>().SingleOrDefaultAsync(x => x.Id == id && x.WorkspaceId == owner, ct);
        if (p is null) return Results.NotFound();
        var m = await db.Set<DiscoveryMatch>().AsNoTracking().SingleAsync(x => x.Id == p.MatchId && x.WorkspaceId == owner, ct);
        var inv = await HistoricalInventory(owner, ct);
        var facts = Validate(p, inv);
        if (facts is null || Condition(m, inv) != "current")
            return Results.Conflict("This historical pair is no longer current. Its listing or the supporting fact permissions changed.");
        var job = inv.Jobs[m.JobKey];
        if (action == "approve")
        {
            if (p.Version != version) return Results.Conflict("Open the current pair and review both documents before approving.");
            p.ApprovedUtc ??= Now;
            await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
            return Results.NoContent();
        }
        var resume = $"Target role: {job.Title} — {job.Employer}\n\nSelected experience\n" + string.Join("\n\n", facts.Select(f => f.Claim));
        var letter = $"Dear hiring team,\n\nI am writing about the {job.Title} role at {job.Employer}.\n\n" +
            string.Join("\n\n", facts.Select(f => f.Claim)) + "\n\nThank you for your consideration.";
        if (action == "export")
        {
            if (p.ApprovedUtc is null) return Results.Conflict("Review and approve both documents before exporting.");
            return DiscoveryExport.Download(resume, letter, format);
        }
        return Results.Ok(new { p.Id, p.Version, approved = p.ApprovedUtc is not null, resume, letter,
            evidence = facts.Select((f, i) => new { f.Id, f.Project, f.Claim, resumeClaim = i + 1, letterClaim = i + 1 }).ToArray() });
    }
}

internal sealed class DiscoveryTimer(IServiceScopeFactory scopes, DiscoveryBoardPolicy policy, TimeProvider clock, ILogger<DiscoveryTimer> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(45), clock);
        do
        {
            try
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<PracticeDb>();
                var now = clock.GetUtcNow().UtcDateTime;
                var owners = await db.Set<DiscoverySettings>().AsNoTracking().Where(x => x.LocalTime == DailySearch.ManagedTime && x.Enabled && x.NextDueUtc <= now &&
                        db.Workspaces.Any(w => w.Id == x.WorkspaceId && w.ExpiresAt > now))
                    .OrderBy(x => x.NextDueUtc).Take(25).Select(x => x.WorkspaceId).ToArrayAsync(stoppingToken);
                foreach (var owner in owners)
                {
                    using var work = scopes.CreateScope();
                    try { await work.ServiceProvider.GetRequiredService<DiscoveryScout>().Run(owner, true, stoppingToken); }
                    catch (Exception) when (!stoppingToken.IsCancellationRequested) { log.LogWarning("A scout schedule remains due; retrying on the next tick."); }
                }
                var permitted = policy.Roster.Select(policy.StoreKey).ToArray();
                await db.Set<DiscoveryPublicJob>().Where(x => x.SeenUtc < now.AddDays(-3) || !permitted.Contains(x.BoardKey)).ExecuteDeleteAsync(stoppingToken);
                await db.Set<DiscoveryBoard>().Where(b => !db.Set<DiscoveryFollow>().Any(f => f.BoardKey == b.Key)).ExecuteDeleteAsync(stoppingToken);
            }
            catch (Exception) when (!stoppingToken.IsCancellationRequested) { log.LogWarning("Scout timer could not finish its tick."); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
