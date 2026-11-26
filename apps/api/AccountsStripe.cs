using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal sealed partial class AccountsStripe(IHttpClientFactory clients)
{
    internal static string? Price => AccountsModule.Setting("STRIPE_TEST_PRICE_ID");
    private static string? Secret => AccountsModule.Setting("STRIPE_TEST_SECRET_KEY");
    private static string? SigningSecret => AccountsModule.Setting("STRIPE_TEST_WEBHOOK_SECRET");
    private static string? Origin
    {
        get
        {
            if (!Uri.TryCreate(AccountsModule.Setting("PUBLIC_ORIGIN"), UriKind.Absolute, out var uri) ||
                uri.UserInfo != "" || uri.Query != "" || uri.Fragment != "" || uri.AbsolutePath != "/" ||
                !(uri.Scheme == "https" || (uri.Scheme == "http" && uri.IsLoopback && AccountsModule.LocalWorkspaceEnabled))) return null;
            return uri.GetLeftPart(UriPartial.Authority);
        }
    }
    // There is deliberately no live branch, live key, or client-selected Price.
    internal static bool Enabled => AccountsModule.Setting("STRIPE_MODE") == "test" &&
        (AccountsModule.LocalWorkspaceEnabled || AccountsModule.Setting("PLANE") is "staging" or "test") &&
        AccountsModule.FirebaseEnabled && Origin is not null && AccountsModule.NamedId(Price, "price_") &&
        (AccountsModule.NamedId(Secret, "sk_test_") || AccountsModule.NamedId(Secret, "rk_test_")) &&
        AccountsModule.NamedId(SigningSecret, "whsec_");
    private static long Now => AccountsModule.Now;
    private static string? Str(JsonElement e, string key) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
    private static long Num(JsonElement e, string key) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetInt64(out var n) ? n : -1;
    private static JsonElement Field(JsonElement e, string key) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var p) ? p : default;
    private static bool Flag(JsonElement e, string key, bool value) => Field(e, key).ValueKind == (value ? JsonValueKind.True : JsonValueKind.False);
    private static IResult Unavailable() => Results.Json("Stripe test billing is unavailable. No entitlement was granted.", statusCode: 503);
    private static IResult Disabled() => Results.Json("Live billing is closed: the Prep price is not set. Stripe test billing is not configured here.", statusCode: 503);
    private static IResult Busy() => Results.Conflict("Another billing change is in progress. Try again shortly.");

    private async Task<JsonElement> Send(HttpMethod method, string route, CancellationToken ct, Dictionary<string, string>? fields = null,
        string? idempotency = null, bool allowMissing = false)
    {
        using var http = clients.CreateClient("accounts-stripe");
        using var request = new HttpRequestMessage(method, $"https://api.stripe.com/v1/{route}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.ASCII.GetBytes($"{Secret}:")));
        request.Headers.Add("Stripe-Version", "2024-06-20");
        if (idempotency is not null) request.Headers.Add("Idempotency-Key", idempotency);
        if (fields is not null) request.Content = new FormUrlEncodedContent(fields);
        using var response = await http.SendAsync(request, ct);
        if (allowMissing && response.StatusCode == HttpStatusCode.NotFound) return default;
        response.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(ct));
        return doc.RootElement.Clone();
    }

    private static IQueryable<AccountProfile> Rows(PracticeDb db, Guid owner) => db.Set<AccountProfile>().Where(a => a.WorkspaceId == owner);
    private static IQueryable<AccountProfile> Held(PracticeDb db, Guid owner, string lease) =>
        Rows(db, owner).Where(a => a.Lease == lease);
    private static async Task<string?> Lease(PracticeDb db, Guid owner, CancellationToken ct)
    {
        var id = Guid.NewGuid().ToString("N");
        var now = Now;
        var updated = await Rows(db, owner).Where(a => a.LeaseUntil <= now).ExecuteUpdateAsync(u =>
            u.SetProperty(a => a.Lease, id).SetProperty(a => a.LeaseUntil, now + 120).SetProperty(a => a.LastAttempt, now), ct);
        return updated == 1 ? id : null;
    }
    private static Task<int> Release(PracticeDb db, Guid owner, string lease) => Held(db, owner, lease).ExecuteUpdateAsync(u =>
        u.SetProperty(a => a.Lease, (string?)null).SetProperty(a => a.LeaseUntil, 0L));

    private sealed record Snapshot(string Status, string? Sub = null, string? Price = null, long Start = 0, long End = 0);
    private static bool Monthly(JsonElement p) => Str(p, "id") == Price && Flag(p, "livemode", false) &&
        Str(p, "type") == "recurring" && Str(Field(p, "recurring"), "interval") == "month" &&
        Num(Field(p, "recurring"), "interval_count") == 1 && Str(Field(p, "recurring"), "usage_type") == "licensed";

    private static Snapshot Evaluate(JsonElement list, string customer)
    {
        var all = Field(list, "data");
        if (Str(list, "object") != "list" || all.ValueKind != JsonValueKind.Array) throw new InvalidDataException();
        if (!Flag(list, "has_more", false)) return new("review");
        var current = all.EnumerateArray().Where(s => Str(s, "status") is not ("incomplete_expired" or "canceled")).ToArray();
        if (current.Length == 0) return new("inactive");
        if (current.Length != 1) return new("review");
        var sub = current[0];
        var id = Str(sub, "id");
        var items = Field(Field(sub, "items"), "data");
        if (!AccountsModule.NamedId(id, "sub_") || !Flag(sub, "livemode", false) || Str(sub, "customer") != customer ||
            items.ValueKind != JsonValueKind.Array || !Flag(Field(sub, "items"), "has_more", false) || items.GetArrayLength() != 1 ||
            !Monthly(Field(items[0], "price")) || Num(items[0], "quantity") != 1) return new("review");
        var start = Num(sub, "current_period_start"); var end = Num(sub, "current_period_end");
        if (start <= 0 || end <= start || end - start > 32L * 86400) return new("review");
        var status = Str(sub, "status");
        if (status != "active") return new(status is "past_due" or "unpaid" or "paused" or "incomplete" ? status : "review", id, Price, start, end);
        var invoice = Field(sub, "latest_invoice"); var lines = Field(Field(invoice, "lines"), "data");
        if (!AccountsModule.NamedId(Str(invoice, "id"), "in_") || !Flag(invoice, "livemode", false) || !Flag(invoice, "paid", true) ||
            Str(invoice, "status") != "paid" || Str(invoice, "customer") != customer || Str(invoice, "subscription") != id ||
            lines.ValueKind != JsonValueKind.Array || !lines.EnumerateArray().Any(l => Str(l, "type") == "subscription" &&
                Str(Field(l, "price"), "id") == Price && Num(Field(l, "period"), "start") == start && Num(Field(l, "period"), "end") == end))
            return new("awaiting_payment", id, Price, start, end);
        var charge = Field(invoice, "charge");
        if (Num(invoice, "amount_paid") < 0 || (Num(invoice, "amount_paid") > 0 &&
            (!AccountsModule.NamedId(Str(charge, "id"), "ch_") || !Flag(charge, "livemode", false) || Str(charge, "customer") != customer ||
             !Flag(charge, "paid", true) || !Flag(charge, "refunded", false) || !Flag(charge, "disputed", false) || Num(charge, "amount_refunded") != 0)))
            return new("review", id, Price, start, end);
        var cancel = Num(sub, "cancel_at");
        var canceling = Flag(sub, "cancel_at_period_end", true) || cancel > 0;
        return new(canceling ? "canceling" : "active", id, Price, start, cancel > 0 ? Math.Min(cancel, end) : end);
    }

    private async Task<Snapshot?> Refresh(PracticeDb db, AccountProfile account, string lease, CancellationToken ct)
    {
        if (account.Customer is null) return new("none");
        var list = await Send(HttpMethod.Get,
            $"subscriptions?customer={account.Customer}&status=all&limit=100&expand%5B%5D=data.latest_invoice.charge", ct);
        var snapshot = Evaluate(list, account.Customer);
        var now = Now;
        var failedAt = snapshot.Status is "past_due" or "unpaid"
            ? account.PaymentFailedAt > 0 ? account.PaymentFailedAt : now : 0;
        var updated = await Held(db, account.WorkspaceId, lease).Where(a => a.BillingRevision == account.BillingRevision && !a.Deleting)
            .ExecuteUpdateAsync(u => u.SetProperty(a => a.Subscription, snapshot.Sub)
                .SetProperty(a => a.Price, snapshot.Price).SetProperty(a => a.BillingStatus, snapshot.Status)
                .SetProperty(a => a.PeriodStart, snapshot.Start).SetProperty(a => a.PeriodEnd, snapshot.End)
                .SetProperty(a => a.PaymentFailedAt, failedAt)
                .SetProperty(a => a.LastChecked, now), ct);
        return updated == 1 ? snapshot : null;
    }

    internal async Task<IResult> Start(HttpContext c, PracticeDb db, bool portal)
    {
        if (c.Items["workspace"] is not Guid owner) return Results.Unauthorized();
        if (AccountsModule.RequireRecent(c, owner) is { } denied) return denied;
        if (!Enabled) return Disabled();
        if (c.Request.ContentLength is > 0 || c.Request.Headers.ContainsKey("Transfer-Encoding"))
            return Results.BadRequest("Billing requests have no client-selectable price, customer, or return URL.");
        var ct = c.RequestAborted;
        if (await Lease(db, owner, ct) is not { } lease) return Busy();
        try
        {
            var a = await Rows(db, owner).AsNoTracking().SingleAsync(ct);
            if (a.Deleting) return Results.Conflict("Account deletion is in progress.");
            if (portal)
            {
                if (a.Customer is null) return Results.Conflict("There is no Stripe test customer yet.");
                var session = await Send(HttpMethod.Post, "billing_portal/sessions", ct,
                    new() { ["customer"] = a.Customer, ["return_url"] = Origin + "/#workspace" });
                return RedirectResult(session, "billing.stripe.com");
            }
            var price = await Send(HttpMethod.Get, $"prices/{Price}", ct);
            if (!Flag(price, "active", true) || !Monthly(price) || Str(price, "billing_scheme") != "per_unit" ||
                Num(price, "unit_amount") <= 0) return Unavailable();
            if (a.Customer is null)
            {
                var customer = await Send(HttpMethod.Post, "customers", ct, new() { ["metadata[workspace]"] = owner.ToString("N") }, $"customer-{owner:N}");
                var id = Str(customer, "id");
                if (!AccountsModule.NamedId(id, "cus_") || !Flag(customer, "livemode", false)) return Unavailable();
                if (await Held(db, owner, lease).ExecuteUpdateAsync(u => u.SetProperty(p => p.Customer, id), ct) != 1) return Busy();
                a.Customer = id;
            }
            var state = await Refresh(db, a, lease, ct);
            if (state is null) return Busy();
            if (state.Status is not ("none" or "inactive")) return Results.Conflict("A subscription already exists or needs review. Use the test billing portal.");
            if (a.CheckoutAttempt is null || a.CheckoutExpires <= Now)
            {
                a.CheckoutAttempt = Guid.NewGuid().ToString("N");
                a.CheckoutExpires = Now + 3600;
                if (await Held(db, owner, lease).ExecuteUpdateAsync(u => u.SetProperty(p => p.CheckoutAttempt, a.CheckoutAttempt)
                    .SetProperty(p => p.CheckoutExpires, a.CheckoutExpires), ct) != 1) return Busy();
            }
            var checkout = await Send(HttpMethod.Post, "checkout/sessions", ct, new() {
                ["customer"] = a.Customer!, ["mode"] = "subscription", ["line_items[0][price]"] = Price!,
                ["line_items[0][quantity]"] = "1", ["expires_at"] = a.CheckoutExpires.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["success_url"] = Origin + "/#workspace", ["cancel_url"] = Origin + "/#workspace"
            }, $"checkout-{owner:N}-{a.CheckoutAttempt}");
            if (!Flag(checkout, "livemode", false) || Str(checkout, "customer") != a.Customer) return Unavailable();
            return RedirectResult(checkout, "checkout.stripe.com");
        }
        catch (Exception ex) when (ProviderFailure(ex) && !ct.IsCancellationRequested) { return Unavailable(); }
        finally { await Release(db, owner, lease); }
    }
    private static bool ProviderFailure(Exception ex) => ex is HttpRequestException or OperationCanceledException or JsonException or InvalidDataException;
    private static IResult RedirectResult(JsonElement obj, string host) =>
        Uri.TryCreate(Str(obj, "url"), UriKind.Absolute, out var u) && u.Scheme == "https" && u.Host == host &&
        u.IsDefaultPort && u.UserInfo == "" ? Results.Ok(new { url = u.AbsoluteUri }) : Unavailable();

    internal async Task<IResult?> PrepareDelete(PracticeDb db, Guid owner, CancellationToken ct)
    {
        if (await Lease(db, owner, ct) is not { } lease) return Busy();
        try
        {
            var a = await Rows(db, owner).AsNoTracking().SingleAsync(ct);
            // Persist the tombstone before the external call. A cleanup retry cannot race new checkout or paid work.
            await Held(db, owner, lease).ExecuteUpdateAsync(u => u.SetProperty(p => p.Deleting, true), ct);
            if (a.Customer is { } id)
            {
                if (!Enabled) return Results.Json("Test billing must reconnect before the customer and its renewals can be removed.", statusCode: 503);
                var deleted = await Send(HttpMethod.Delete, $"customers/{id}", ct, allowMissing: true);
                // A different Stripe account/key also returns 404. Confirm the deleted customer, not just absence.
                if (deleted.ValueKind == JsonValueKind.Undefined) deleted = await Send(HttpMethod.Get, $"customers/{id}", ct);
                if (Str(deleted, "id") != id || !Flag(deleted, "deleted", true)) return Unavailable();
                await Held(db, owner, lease).ExecuteUpdateAsync(u => u.SetProperty(p => p.Customer, (string?)null), ct);
            }
            return null;
        }
        catch (Exception ex) when (ProviderFailure(ex) && !ct.IsCancellationRequested) { return Unavailable(); }
        finally { await Release(db, owner, lease); }
    }
}
