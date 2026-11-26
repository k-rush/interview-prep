using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal sealed partial class AccountsStripe
{
    private static bool Signed(string header, byte[] bytes)
    {
        if (header.Length is 0 or > 2048) return false;
        var entries = header.Split(',', StringSplitOptions.TrimEntries);
        var stamps = entries.Where(x => x.StartsWith("t=", StringComparison.Ordinal)).ToArray();
        if (stamps.Length != 1 || !long.TryParse(stamps[0].AsSpan(2), NumberStyles.None, CultureInfo.InvariantCulture, out var stamp) ||
            stamp < Now - 300 || stamp > Now + 300) return false;
        using var hmac = IncrementalHash.CreateHMAC(HashAlgorithmName.SHA256, Encoding.UTF8.GetBytes(SigningSecret!));
        hmac.AppendData(Encoding.ASCII.GetBytes(stamps[0][2..] + "."));
        hmac.AppendData(bytes);
        var expected = hmac.GetHashAndReset();
        Span<byte> value = stackalloc byte[32];
        foreach (var entry in entries.Where(x => x.StartsWith("v1=", StringComparison.Ordinal) && x.Length == 67))
            if (Convert.FromHexString(entry.AsSpan(3), value, out _, out _) == System.Buffers.OperationStatus.Done &&
                CryptographicOperations.FixedTimeEquals(value, expected)) return true;
        return false;
    }

    internal static async Task<IResult> Receive(HttpContext c, PracticeDb db, AccountsStripe stripe)
    {
        if (!Enabled) return Disabled();
        const int max = 256 * 1024;
        var limit = c.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (limit is { IsReadOnly: false }) limit.MaxRequestBodySize = max;
        if (c.Request.ContentLength > max) return Results.StatusCode(413);
        var ct = c.RequestAborted;
        using var body = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var n = await c.Request.Body.ReadAsync(buffer, ct);
            if (n == 0) break;
            if (body.Length + n > max) return Results.StatusCode(413);
            body.Write(buffer, 0, n);
        }
        var bytes = body.ToArray();
        if (!Signed(c.Request.Headers["Stripe-Signature"].ToString(), bytes)) return Results.BadRequest("Invalid webhook signature.");
        string? id, customer, charge;
        try
        {
            using var doc = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 48 });
            var evt = doc.RootElement;
            id = Str(evt, "id");
            if (!AccountsModule.NamedId(id, "evt_") || Str(evt, "object") != "event" || !Flag(evt, "livemode", false))
                return Results.BadRequest("Expected a Stripe test-mode event.");
            var kind = Str(evt, "type") ?? "";
            if (!(kind.StartsWith("customer.subscription.", StringComparison.Ordinal) || kind.StartsWith("invoice.", StringComparison.Ordinal) ||
                kind.StartsWith("charge.dispute.", StringComparison.Ordinal) || kind.StartsWith("refund.", StringComparison.Ordinal) ||
                kind is "checkout.session.completed" or "checkout.session.async_payment_succeeded" or "charge.refunded" or "customer.deleted"))
                return Results.Ok();
            var obj = Field(Field(evt, "data"), "object");
            customer = kind == "customer.deleted" ? Str(obj, "id") : Str(obj, "customer");
            charge = Str(obj, "charge");
            if (!AccountsModule.NamedId(customer, "cus_")) customer = null;
            if (!AccountsModule.NamedId(charge, "ch_")) charge = null;
            if (customer is null && charge is null) return Results.Ok();
        }
        catch (JsonException) { return Results.BadRequest("Invalid Stripe event."); }

        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            var inserted = await db.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO AccountStripeInbox (Id, Customer, Charge, RetryAt, Attempts, Processed)
                VALUES ({id}, {customer}, {charge}, 0, 0, 0) ON CONFLICT (Id) DO NOTHING
                """, ct);
            if (inserted == 1 && customer is not null)
                await db.Set<AccountProfile>().Where(p => p.Customer == customer).ExecuteUpdateAsync(u =>
                    u.SetProperty(p => p.BillingRevision, p => p.BillingRevision + 1).SetProperty(p => p.LastChecked, 0L), ct);
            await tx.CommitAsync(ct);
        }
        // The minimal inbox survives a restart; acknowledgment never depends on trusting an event's desired tier.
        await stripe.Process(db, id!, ct);
        return Results.Ok();
    }

    private async Task<bool> Sync(PracticeDb db, Guid owner, CancellationToken ct)
    {
        if (await Lease(db, owner, ct) is not { } lease) return false;
        try
        {
            var a = await Rows(db, owner).AsNoTracking().SingleAsync(ct);
            return a.Deleting || a.Customer is null || await Refresh(db, a, lease, ct) is not null;
        }
        finally { await Release(db, owner, lease); }
    }
    private async Task Process(PracticeDb db, string id, CancellationToken ct)
    {
        var events = db.Set<AccountStripeEvent>().Where(e => e.Id == id && !e.Processed);
        var evt = await events.AsNoTracking().SingleOrDefaultAsync(ct);
        if (evt is null || evt.RetryAt > Now) return;
        var ok = false;
        try
        {
            var customer = evt.Customer;
            if (customer is null && evt.Charge is not null)
            {
                var charge = await Send(HttpMethod.Get, $"charges/{evt.Charge}", ct);
                if (!Flag(charge, "livemode", false) || Str(charge, "id") != evt.Charge ||
                    !AccountsModule.NamedId(Str(charge, "customer"), "cus_")) throw new InvalidDataException();
                customer = Str(charge, "customer");
            }
            var owner = await db.Set<AccountProfile>().Where(p => p.Customer == customer).Select(p => (Guid?)p.WorkspaceId).SingleOrDefaultAsync(ct);
            ok = owner is null || await Sync(db, owner.Value, ct);
        }
        catch (Exception ex) when (ProviderFailure(ex) && !ct.IsCancellationRequested) { }
        var retry = Now + Math.Min(1800, 5L << Math.Min(evt.Attempts, 8));
        if (ok) await events.ExecuteUpdateAsync(u => u.SetProperty(e => e.Processed, true)
            .SetProperty(e => e.Customer, (string?)null).SetProperty(e => e.Charge, (string?)null).SetProperty(e => e.RetryAt, Now), ct);
        else await events.ExecuteUpdateAsync(u => u.SetProperty(e => e.Attempts, e => e.Attempts + 1).SetProperty(e => e.RetryAt, retry), ct);
    }

    internal async Task Sweep(PracticeDb db, CancellationToken ct)
    {
        if (!Enabled) return;
        var now = Now;
        var cutoff = now - 90 * 86400;
        await db.Set<AccountStripeEvent>().Where(e => e.Processed && e.RetryAt < cutoff).ExecuteDeleteAsync(ct);
        var events = await db.Set<AccountStripeEvent>().Where(x => !x.Processed && x.RetryAt <= now)
            .OrderBy(x => x.RetryAt).Select(x => x.Id).Take(32).ToListAsync(ct);
        foreach (var id in events) await Process(db, id, ct);
        var stale = now - 900;
        var owners = await db.Set<AccountProfile>().Where(x => !x.Deleting && x.Customer != null && x.LastChecked < stale && x.LeaseUntil <= now)
            .OrderBy(x => x.LastAttempt).ThenBy(x => x.WorkspaceId).Select(x => x.WorkspaceId).Take(16).ToListAsync(ct);
        foreach (var owner in owners)
        {
            try { await Sync(db, owner, ct); }
            catch (Exception ex) when (ProviderFailure(ex) && !ct.IsCancellationRequested) { }
        }
    }
}

internal sealed class AccountsReconciler(IServiceScopeFactory scopes, AccountsStripe stripe, ILogger<AccountsReconciler> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!AccountsStripe.Enabled) return;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        do
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                await stripe.Sweep(scope.ServiceProvider.GetRequiredService<PracticeDb>(), stoppingToken);
            }
            catch (Exception) when (!stoppingToken.IsCancellationRequested)
            { logger.LogWarning("Stripe test reconciliation is delayed; the durable inbox will retry."); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
