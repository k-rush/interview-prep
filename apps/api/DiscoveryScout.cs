using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal sealed record ScoutInventory(DiscoveryLocalJob[] Locals, DiscoveryBoard[] Boards,
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

internal sealed class DiscoveryScout(PracticeDb db, DiscoveryBoards feeds, DiscoveryBoardPolicy policy, TimeProvider clock)
{
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
    private async Task<ScoutInventory> Inventory(Guid owner, CancellationToken ct, bool withEvidence = true)
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
        return new(local, boards, jobs, DiscoveryFit.Index(facts), revisions, dismissed.ToHashSet());
    }

    private string[] Coverage(ScoutInventory inv)
    {
        var lines = new List<string> { $"{inv.Locals.Length} private pasted listing(s); not externally verified. Reconfirm after seven days." };
        foreach (var b in inv.Boards)
            lines.Add($"{DiscoveryBoardPolicy.Label(b.Key)}: {(policy.Permits(b.Key) ? b.Coverage : "access not permitted; excluded")}. " +
                $"Last nonempty check: {Stamp(b.LastSuccessUtc) ?? "never"}. " +
                (b.Key.StartsWith("replay:") ? "Recorded fixture, no network." : "Employer-scoped public metadata, not a global search."));
        return [.. lines];
    }

    internal async Task<IResult> Run(Guid owner, bool scheduled, CancellationToken ct)
    {
        var now = Now;
        var settings = await Settings(owner, ct);
        if (settings is null || settings.Role.Length == 0) return Results.BadRequest("Save a target role before scouting.");
        if (scheduled && (!settings.Enabled || settings.NextDueUtc is null || settings.NextDueUtc > now)) return Results.NoContent();
        if (!await Active(owner, now, ct)) return Results.Unauthorized();
        if (!await AccountsModule.AllowScoutAsync(db, owner))
        {
            if (scheduled) await db.Set<DiscoverySettings>().Where(s => s.WorkspaceId == owner && s.Revision == settings.Revision)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.Enabled, false).SetProperty(x => x.NextDueUtc, (DateTime?)null)
                    .SetProperty(x => x.Revision, x => x.Revision + 1), ct);
            return Results.Json("New scouting is unavailable on this plan. Existing digests remain readable.", statusCode: 403);
        }
        var localDay = scheduled ? DiscoveryCalendar.LatestDue(now, settings.LocalTime, settings.Zone) : DiscoveryCalendar.LocalDay(now, settings.Zone);
        var day = Day(localDay);
        var existing = await Digest(owner, day, ct);
        var next = DiscoveryCalendar.Next(now, settings.LocalTime, settings.Zone);
        if (existing is not null || (scheduled && DiscoveryCalendar.At(localDay, settings.LocalTime, settings.Zone) < now.AddHours(-24)))
        {
            if (scheduled) await db.Set<DiscoverySettings>().Where(s => s.WorkspaceId == owner && s.Enabled && s.Revision == settings.Revision)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.NextDueUtc, next), ct);
            return existing is null ? Results.NoContent() : Results.Ok(new { existing.Id, existing.LocalDate, replay = true });
        }
        var follows = await db.Set<DiscoveryFollow>().AsNoTracking().Where(f => f.WorkspaceId == owner)
            .OrderBy(f => f.BoardKey).Select(f => f.BoardKey).ToArrayAsync(ct);
        foreach (var key in follows)
        {
            if (!await db.Set<DiscoverySettings>().AnyAsync(s => s.WorkspaceId == owner && s.Revision == settings.Revision, ct))
                return Results.Conflict("Scout settings changed. No digest published.");
            await feeds.RefreshAsync(db, owner, key, ct);
        }

        // All private effects and the quota debit commit together. A crash before this point leaves the schedule due.
        // SQLite serializes these write transactions; the owner/date unique key also fences duplicate deliveries.
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var liveSettings = await db.Set<DiscoverySettings>().SingleOrDefaultAsync(s => s.WorkspaceId == owner, ct);
        if (liveSettings is null || liveSettings.Revision != settings.Revision || (scheduled && !liveSettings.Enabled) ||
            !await Active(owner, Now, ct)) return Results.Conflict("Scout inputs changed or were removed. No digest published.");
        if (!await AccountsModule.AllowScoutAsync(db, owner))
            return Results.Json("Scout permission changed. No digest or draft was published.", statusCode: 403);
        existing = await Digest(owner, day, ct);
        if (scheduled || (liveSettings.Enabled && liveSettings.NextDueUtc <= now)) liveSettings.NextDueUtc = next;
        if (existing is not null)
        {
            await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
            return Results.Ok(new { existing.Id, existing.LocalDate, replay = true });
        }
        var inv = await Inventory(owner, ct);
        var seenRows = await db.Set<DiscoveryMatch>().AsNoTracking().Where(m => m.WorkspaceId == owner)
            .Select(m => new { m.JobKey, m.JobHash }).ToArrayAsync(ct);
        var seen = seenRows.Select(x => (x.JobKey, x.JobHash)).ToHashSet();
        var top = inv.Jobs.Values.Where(j => !inv.Dismissed.Contains(j.Key) && !seen.Contains((j.Key, j.Version)) &&
                (!settings.RemoteOnly || j.Mode is not ("onsite" or "hybrid")) &&
                (!settings.RequireLocation || j.Location.Length > 0) && (!settings.RequirePay || j.Pay.Length > 0) &&
                DiscoveryFit.RoleOverlap(settings.Role, j.Title) > 0)
            .Select(j => (Job: j, Fit: DiscoveryFit.Assess(j, inv.Evidence, settings.Role)))
            .OrderByDescending(x => x.Fit.Possible == 0 ? 0 : x.Fit.Earned / x.Fit.Possible)
            .ThenByDescending(x => x.Job.CheckedUtc).ThenByDescending(x => DiscoveryFit.RoleOverlap(settings.Role, x.Job.Title))
            .ThenBy(x => x.Job.Key, StringComparer.Ordinal).Take(3).ToArray();
        var partial = inv.Boards.Any(b => !policy.Permits(b.Key) || b.Coverage != "checked");
        var coverage = Coverage(inv).ToList();
        if (scheduled && settings.NextDueUtc is DateTime due && DiscoveryCalendar.LocalDay(due, settings.Zone) < localDay)
            coverage.Add("Older missed days were skipped; only the latest due local day was processed.");
        var nextStep = top.Length > 0 ? "Review the listed gaps, verify that the job is open, and decide whether to prepare a pair." :
            inv.Locals.Length == 0 && inv.Boards.Length == 0 ? "No sources enabled. Add a private listing or follow a permitted board." :
            inv.Locals.Length == 0 && inv.Boards.All(b => !policy.Permits(b.Key) || !GoodBoard(b)) ?
                "No source could verify new openings. Check permissions or try a private listing; this does not mean there are no jobs." :
                "No new matching listings from the checked sources. Add a permitted listing or review your target.";
        var digest = new DiscoveryDigest { WorkspaceId = owner, LocalDate = day, Zone = settings.Zone, TargetRole = settings.Role,
            CreatedUtc = Now, Trigger = scheduled ? "scheduled" : "manual", Status = partial ? "partial" : "complete",
            CoverageJson = JsonSerializer.Serialize(coverage), NextStep = nextStep,
            DraftNote = !settings.AutoDraft || !settings.Enabled ? "Automatic drafting is off." :
                "No fresh match with directly mentioned, draft-permitted evidence; no pair generated." };
        db.Add(digest);
        var automaticAttempted = false;
        for (var i = 0; i < top.Length; i++)
        {
            var (job, fit) = top[i];
            var match = new DiscoveryMatch { WorkspaceId = owner, DigestId = digest.Id, JobKey = job.Key, JobHash = job.Version, Rank = i + 1 };
            db.Add(match);
            if (!automaticAttempted && settings.Enabled && settings.AutoDraft && job.Fresh && fit.DraftEvidence.Length > 0)
            {
                automaticAttempted = true;
                var packet = await Draft(owner, match, fit.DraftEvidence, inv, ct);
                digest.DraftNote = packet is null ? "Draft allowance unavailable; matches are still delivered." :
                    "One pair is ready for your review. Nothing was sent.";
            }
        }
        await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
        return Results.Ok(new { digest.Id, digest.LocalDate, replay = false });
    }

    private static string PinHash(Fact f, ScoutInventory inv) => DiscoveryFit.Hash(DiscoveryFit.FactHash(f),
        inv.FactRevisions.GetValueOrDefault(f.Id).ToString(CultureInfo.InvariantCulture));
    private async Task<DiscoveryPacket?> Draft(Guid owner, DiscoveryMatch match, Fact[] facts, ScoutInventory inv, CancellationToken ct)
    {
        var pins = facts.Select(f => new FactPin(f.Id, PinHash(f, inv))).ToArray();
        var json = JsonSerializer.Serialize(pins);
        var version = DiscoveryFit.Hash("verbatim-pair-v1", match.Id.ToString(), match.JobHash, json);
        var packet = await db.Set<DiscoveryPacket>().AsNoTracking().SingleOrDefaultAsync(p => p.WorkspaceId == owner && p.Version == version, ct);
        if (packet is not null) return packet;
        if (!await AccountsModule.TryReserveDraftAsync(db, owner, "scout-pair:" + version)) return null;
        packet = new() { WorkspaceId = owner, MatchId = match.Id, Version = version, FactPinsJson = json, CreatedUtc = Now };
        db.Add(packet);
        return packet;
    }

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
        var inv = await Inventory(owner, ct, withEvidence: false);
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

    internal async Task<IResult> State(Guid owner, CancellationToken ct)
    {
        // Read one consistent snapshot: do not combine an old fact with a newer approval or deletion.
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var s = await Settings(owner, ct) ?? new() { WorkspaceId = owner };
        var inv = await Inventory(owner, ct);
        var digests = await db.Set<DiscoveryDigest>().AsNoTracking().Where(x => x.WorkspaceId == owner)
            .OrderByDescending(x => x.CreatedUtc).Take(31).ToArrayAsync(ct);
        var ids = digests.Select(d => d.Id).ToArray();
        var matches = await db.Set<DiscoveryMatch>().AsNoTracking().Where(x => x.WorkspaceId == owner && ids.Contains(x.DigestId))
            .OrderBy(x => x.Rank).ToArrayAsync(ct);
        var mids = matches.Select(m => m.Id).ToArray();
        var packets = await db.Set<DiscoveryPacket>().AsNoTracking().Where(p => p.WorkspaceId == owner && mids.Contains(p.MatchId))
            .OrderByDescending(p => p.CreatedUtc).ToArrayAsync(ct);
        object MatchView(DiscoveryMatch m, string role)
        {
            var status = Condition(m, inv);
            var job = status is "current" or "dated listing; reconfirm before drafting" ? inv.Jobs[m.JobKey] : null;
            var fit = job is null ? null : DiscoveryFit.Assess(job, inv.Evidence, role);
            return new { m.Id, m.Rank, status, listing = job is null ? null : new { job.Title, job.Employer, job.Location,
                    job.Mode, job.Pay, job.Source, job.Url, checkedUtc = Stamp(job.CheckedUtc), job.Fresh },
                fit = fit is null ? null : new { fit.Earned, fit.Possible, fit.Lines, fit.Gaps, fit.Reason },
                canDraft = job?.Fresh == true && fit!.DraftEvidence.Length > 0,
                packets = packets.Where(p => p.MatchId == m.Id).Select(p => new { p.Id, current = status == "current" && Validate(p, inv) is not null,
                    approved = p.ApprovedUtc is not null, createdUtc = Stamp(p.CreatedUtc) }).ToArray() };
        }
        var output = new {
            scoutAllowed = await AccountsModule.AllowScoutAsync(db, owner),
            settings = new { s.Role, s.RemoteOnly, s.RequireLocation, s.RequirePay, s.Zone, s.LocalTime, s.Enabled,
                s.AutoDraft, nextDueUtc = Stamp(s.NextDueUtc) },
            roster = policy.Roster.Order(StringComparer.Ordinal).ToArray(), replay = policy.ReplayDirectory is not null,
            follows = inv.Boards.Select(b => new { key = DiscoveryBoardPolicy.Label(b.Key), b.Coverage, b.RightsBasis, b.Reuse,
                permitted = policy.Permits(b.Key), checkedUtc = Stamp(b.LastSuccessUtc),
                refreshAfterUtc = b.LastAttemptUtc.HasValue ? Stamp(b.RefreshAfterUtc) : null }).ToArray(),
            listings = inv.Locals.Select(j => new { j.Id, j.Employer, j.Title, j.Location, j.Mode, j.Pay,
                j.Excerpt, j.Must, j.Preferred, checkedUtc = Stamp(j.CheckedUtc) }).ToArray(),
            digests = digests.Select(d => new { d.Id, d.LocalDate, d.Zone, d.TargetRole, createdUtc = Stamp(d.CreatedUtc), d.Trigger,
                d.Status, coverage = JsonSerializer.Deserialize<string[]>(d.CoverageJson), d.NextStep, d.DraftNote,
                matches = matches.Where(m => m.DigestId == d.Id).Select(m => MatchView(m, d.TargetRole)).ToArray() }).ToArray()
        };
        await tx.CommitAsync(ct);
        return Results.Ok(output);
    }

    internal async Task<IResult> CreatePair(Guid owner, Guid matchId, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var m = await db.Set<DiscoveryMatch>().AsNoTracking().SingleOrDefaultAsync(x => x.WorkspaceId == owner && x.Id == matchId, ct);
        if (m is null) return Results.NotFound();
        var inv = await Inventory(owner, ct);
        if (Condition(m, inv) != "current") return Results.Conflict("This listing is stale, dismissed, changed or removed.");
        var facts = DiscoveryFit.Assess(inv.Jobs[m.JobKey], inv.Evidence, (await Settings(owner, ct))?.Role ?? "").DraftEvidence;
        if (facts.Length == 0) return Results.Conflict("No directly matching, confirmed facts permitted in drafts. Review evidence first.");
        var packet = await Draft(owner, m, facts, inv, ct);
        if (packet is null) return Results.Json("No draft allowance is available. Your matches are unchanged.", statusCode: 403);
        await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
        return Results.Ok(new { packet.Id });
    }

    internal async Task<IResult> Packet(Guid owner, Guid id, string action, string? version, string? format, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var p = await db.Set<DiscoveryPacket>().SingleOrDefaultAsync(x => x.Id == id && x.WorkspaceId == owner, ct);
        if (p is null) return Results.NotFound();
        var m = await db.Set<DiscoveryMatch>().AsNoTracking().SingleAsync(x => x.Id == p.MatchId && x.WorkspaceId == owner, ct);
        var inv = await Inventory(owner, ct);
        var facts = Validate(p, inv);
        if (facts is null || Condition(m, inv) != "current")
            return Results.Conflict("This pair is no longer current. Review the listing and confirmed fact permissions, then generate a new pair.");
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
                var owners = await db.Set<DiscoverySettings>().AsNoTracking().Where(x => x.Enabled && x.NextDueUtc <= now &&
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
