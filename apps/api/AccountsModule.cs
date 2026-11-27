using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal sealed class AccountProfile
{
    public Guid WorkspaceId { get; set; }
    public required string Issuer { get; set; }
    public required string Subject { get; set; }
    public required string Email { get; set; }
    public string? Customer { get; set; }
    public string? Subscription { get; set; }
    public string? Price { get; set; }
    public string BillingStatus { get; set; } = "none";
    public long PeriodStart { get; set; }
    public long PeriodEnd { get; set; }
    public long PaymentFailedAt { get; set; }
    public long LastChecked { get; set; }
    public long LastAttempt { get; set; }
    public long BillingRevision { get; set; }
    public string? CheckoutAttempt { get; set; }
    public long CheckoutExpires { get; set; }
    public string? Lease { get; set; }
    public long LeaseUntil { get; set; }
    public bool Deleting { get; set; }
}

internal sealed class AccountSession
{
    public required string Digest { get; set; }
    public Guid WorkspaceId { get; set; }
    public long AuthTime { get; set; }
    public long Expires { get; set; }
}

internal sealed class AccountUsage
{
    public Guid WorkspaceId { get; set; }
    public required string Meter { get; set; }
    public required string Scope { get; set; }
    public required string Operation { get; set; }
    public int Units { get; set; }
}

internal sealed class AccountStripeEvent
{
    public required string Id { get; set; }
    public string? Customer { get; set; }
    public string? Charge { get; set; }
    public long RetryAt { get; set; }
    public int Attempts { get; set; }
    public bool Processed { get; set; }
}

public static partial class AccountsModule
{
    private const string Cookie = "practice_account";
    private static readonly object SessionItem = new();
    internal static long Now => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    internal static string? Setting(string key) => Environment.GetEnvironmentVariable("INTERVIEW_PREP_" + key);
    internal static string? Project => Setting("FIREBASE_PROJECT");
    internal static string? WebKey => Setting("FIREBASE_WEB_API_KEY");
    internal static string? LookupKey => Setting("FIREBASE_SERVER_API_KEY") ?? WebKey;
    private static bool ValidKey(string? key) => key is { Length: >= 8 and <= 200 } && key.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');
    internal static bool FirebaseEnabled => ValidProject(Project) && ValidKey(WebKey) && ValidKey(LookupKey);
    private static bool ValidProject(string? s) => s is { Length: >= 6 and <= 30 } && char.IsAsciiLetter(s[0]) &&
        s.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-') && s[^1] != '-';
    public static bool LocalWorkspaceEnabled => Setting("PLANE") is (null or "" or "local") &&
        Setting("HOSTED") is (null or "" or "0" or "false") && Setting("PRIVATE_CONTAINER") != "1" &&
        string.IsNullOrEmpty(Environment.GetEnvironmentVariable("CONTAINER_APP_NAME"));
    internal static bool NamedId(string? s, string prefix) => s is { Length: <= 160 } && s.Length > prefix.Length &&
        s.StartsWith(prefix, StringComparison.Ordinal) && s.AsSpan(prefix.Length).IndexOfAnyExcept(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_".AsSpan()) < 0;
    internal static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    public static void Configure(ModelBuilder model)
    {
        var profile = model.Entity<AccountProfile>();
        profile.ToTable("AccountProfiles").HasKey(x => x.WorkspaceId);
        profile.HasOne<Workspace>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        profile.HasIndex(x => new { x.Issuer, x.Subject }).IsUnique();
        profile.HasIndex(x => x.Customer).IsUnique();
        var session = model.Entity<AccountSession>();
        session.ToTable("AccountSessions").HasKey(x => x.Digest);
        session.HasOne<AccountProfile>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        session.HasIndex(x => x.Expires);
        var usage = model.Entity<AccountUsage>();
        usage.ToTable("AccountUsage").HasKey(x => new { x.WorkspaceId, x.Meter, x.Operation });
        usage.HasOne<AccountProfile>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        usage.HasIndex(x => new { x.WorkspaceId, x.Meter, x.Scope });
        var inbox = model.Entity<AccountStripeEvent>();
        inbox.ToTable("AccountStripeInbox").HasKey(x => x.Id);
        inbox.HasIndex(x => new { x.Processed, x.RetryAt });
    }

    public static void Register(IServiceCollection services)
    {
        foreach (var name in new[] { "accounts-firebase", "accounts-stripe" })
        {
            services.AddHttpClient(name, c => { c.Timeout = TimeSpan.FromSeconds(10); c.MaxResponseContentBufferSize = 1024 * 1024; })
                .RemoveAllLoggers().ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
        }
        services.AddSingleton<AccountsIdentity>();
        services.AddSingleton<AccountsStripe>();
        services.AddHostedService<AccountsReconciler>();
    }

    public static bool IsWebhook(HttpRequest r) => HttpMethods.IsPost(r.Method) && r.Path == "/api/billing/webhook";
    public static bool IsPublic(HttpRequest r) => IsWebhook(r) || (HttpMethods.IsGet(r.Method) && r.Path == "/api/account/config") ||
        (HttpMethods.IsPost(r.Method) && r.Path == "/api/account/login");
    private static CookieOptions Options(HttpContext c) => new() { Path = "/api", HttpOnly = true, SameSite = SameSiteMode.Strict,
        Secure = !LocalWorkspaceEnabled || c.Request.IsHttps };
    internal static AccountSession? Session(HttpContext c) => c.Items.TryGetValue(SessionItem, out var s) ? s as AccountSession : null;
    internal static IResult? RequireRecent(HttpContext c, Guid owner) => Session(c) is { } s && s.WorkspaceId == owner && s.Expires > Now
        ? s.AuthTime >= Now - 600 ? null : Results.Json("Sign in again with a fresh email link for this change.", statusCode: 403)
        : Results.Unauthorized();

    public static async Task<Guid?> IdentifyAsync(HttpContext c, PracticeDb db)
    {
        if (!FirebaseEnabled || !c.Request.Cookies.TryGetValue(Cookie, out var token) || token.Length != 64) return null;
        var digest = Hash(token);
        var now = Now;
        var issuer = AccountsIdentity.Issuer;
        var session = await (from s in db.Set<AccountSession>().AsNoTracking()
            join a in db.Set<AccountProfile>() on s.WorkspaceId equals a.WorkspaceId
            where s.Digest == digest && s.Expires > now && a.Issuer == issuer
            select s).SingleOrDefaultAsync(c.RequestAborted);
        if (session is null) return null;
        c.Items[SessionItem] = session;
        return session.WorkspaceId;
    }

    public sealed record LoginRequest(string? IdToken);
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/account/config", () => Results.Ok(new { enabled = FirebaseEnabled,
            webApiKey = FirebaseEnabled ? WebKey : null, localWorkspace = LocalWorkspaceEnabled, privateTest = PrivateStaging.Enabled }));
        app.MapPost("/api/account/login", Login);
        app.MapPost("/api/account/logout", async (HttpContext c, PracticeDb db) =>
        {
            if (Session(c) is { } s) await db.Set<AccountSession>().Where(x => x.Digest == s.Digest).ExecuteDeleteAsync(c.RequestAborted);
            c.Response.Cookies.Delete(Cookie, Options(c));
            return Results.NoContent();
        });
        app.MapGet("/api/account", AccountView);
        app.MapPost("/api/billing/checkout", (HttpContext c, PracticeDb db, AccountsStripe stripe) => stripe.Start(c, db, false));
        app.MapPost("/api/billing/portal", (HttpContext c, PracticeDb db, AccountsStripe stripe) => stripe.Start(c, db, true));
        app.MapPost("/api/billing/webhook", AccountsStripe.Receive);
    }

    private static async Task<IResult> Login(LoginRequest input, HttpContext c, PracticeDb db, AccountsIdentity verifier)
    {
        if (!FirebaseEnabled) return Results.Json("Managed sign-in is not configured.", statusCode: 503);
        AccountsIdentity.Identity? identity;
        try { identity = await verifier.Verify(input.IdToken, c.RequestAborted); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !c.RequestAborted.IsCancellationRequested)
        { return Results.Json("The identity provider is unavailable. Try again later.", statusCode: 503); }
        if (identity is null) return Results.Json("A fresh, verified sign-in from this Firebase project is required.", statusCode: 401);

        var ct = c.RequestAborted;
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var issuer = AccountsIdentity.Issuer;
        var profile = await db.Set<AccountProfile>().SingleOrDefaultAsync(x => x.Issuer == issuer && x.Subject == identity.Subject, ct);
        if (profile is null)
        {
            // Never adopt a presented anonymous token or merge a different subject with the same email.
            var workspace = new Workspace { TokenHash = Hash(Convert.ToHexString(RandomNumberGenerator.GetBytes(32))), ExpiresAt = DateTime.MaxValue };
            db.Add(workspace);
            profile = new AccountProfile { WorkspaceId = workspace.Id, Issuer = issuer, Subject = identity.Subject, Email = identity.Email };
            db.Add(profile);
        }
        else profile.Email = identity.Email;
        if (Session(c) is { } previous)
            await db.Set<AccountSession>().Where(x => x.Digest == previous.Digest).ExecuteDeleteAsync(ct);
        var now = Now;
        await db.Set<AccountSession>().Where(x => x.Expires <= now).ExecuteDeleteAsync(ct);
        var oldest = await db.Set<AccountSession>().Where(x => x.WorkspaceId == profile.WorkspaceId)
            .OrderByDescending(x => x.Expires).ThenBy(x => x.Digest).Skip(7).Select(x => x.Digest).ToListAsync(ct);
        if (oldest.Count > 0) await db.Set<AccountSession>().Where(x => oldest.Contains(x.Digest)).ExecuteDeleteAsync(ct);
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var expiry = Math.Min(identity.Expires, now + 3600);
        db.Add(new AccountSession { Digest = Hash(token), WorkspaceId = profile.WorkspaceId, AuthTime = identity.AuthTime, Expires = expiry });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        var options = Options(c);
        options.Expires = DateTimeOffset.FromUnixTimeSeconds(expiry);
        c.Response.Cookies.Append(Cookie, token, options);
        return Results.NoContent();
    }

    private static readonly string[] Meters = ["mocks", "imports", "builds", "drafts", "voiceSeconds"];
    private static int Limit(string meter, bool prep) => meter switch {
        "mocks" => prep ? 8 : 1, "imports" => prep ? 40 : 2, "builds" => prep ? 100 : 20,
        "drafts" => prep ? 31 : 0, "voiceSeconds" => prep ? 120 * 60 : 0, _ => 0 };
    private static bool HasPrep(AccountProfile a) => !a.Deleting && AccountsStripe.Enabled && a.Issuer == AccountsIdentity.Issuer && a.Price == AccountsStripe.Price &&
        a.Subscription is not null && a.BillingStatus is ("active" or "canceling") && a.LastChecked > Now - 3600 &&
        a.PeriodStart <= Now && Now < a.PeriodEnd;
    private static string Grant(AccountProfile a, bool paid) => paid ? $"test:{a.Subscription}:{a.PeriodStart}" : "free:lifetime";
    private static bool Paused(AccountProfile a) => a.Deleting || (a.BillingStatus is ("active" or "canceling") &&
        a.PeriodStart <= Now && Now < a.PeriodEnd && !HasPrep(a)) ||
        (a.BillingStatus is ("past_due" or "unpaid") && Now < a.PaymentFailedAt + 72 * 3600);

    public static async Task<bool> AllowScoutAsync(PracticeDb db, Guid owner)
    {
        var a = await db.Set<AccountProfile>().AsNoTracking().SingleOrDefaultAsync(x => x.WorkspaceId == owner);
        return a is null ? await IsTestOrLocal(db, owner) : HasPrep(a);
    }
    private static Task<bool> IsTestOrLocal(PracticeDb db, Guid owner) =>
        db.Workspaces.AnyAsync(w => w.Id == owner && (LocalWorkspaceEnabled || PrivateStaging.Enabled && w.TokenHash == PrivateStaging.WorkspaceMarker));
    public static Task<bool> TryReserveDraftAsync(PracticeDb db, Guid owner, string operationKey) => Reserve(db, owner, "drafts", operationKey);
    public static Task<bool> TryReserveMockAsync(PracticeDb db, Guid owner, string operationKey) => Reserve(db, owner, "mocks", operationKey);
    public static Task<bool> TryReserveImportAsync(PracticeDb db, Guid owner, string operationKey) => Reserve(db, owner, "imports", operationKey);
    public static Task<bool> TryReserveBuilderAsync(PracticeDb db, Guid owner, string operationKey) => Reserve(db, owner, "builds", operationKey);
    public static Task<bool> TryReserveVoiceAsync(PracticeDb db, Guid owner, string operationKey, int seconds) =>
        Reserve(db, owner, "voiceSeconds", operationKey, seconds);
    public static Task<int> ReleaseReservationAsync(PracticeDb db, Guid owner, string meter, string key) =>
        db.Set<AccountUsage>().Where(x => x.WorkspaceId == owner && x.Meter == meter && x.Operation == key).ExecuteDeleteAsync();

    private static async Task<bool> Reserve(PracticeDb db, Guid owner, string meter, string operation, int units = 1)
    {
        if (string.IsNullOrWhiteSpace(operation) || operation.Length > 200 || units is < 1 or > 7200) return false;
        // The caller may include the durable effect in this same SQLite write transaction.
        await using var tx = db.Database.CurrentTransaction is null ? await db.Database.BeginTransactionAsync() : null;
        var a = await db.Set<AccountProfile>().AsNoTracking().SingleOrDefaultAsync(x => x.WorkspaceId == owner);
        if (a is null) return await IsTestOrLocal(db, owner);
        var paid = HasPrep(a);
        var scope = Grant(a, paid);
        var cap = Limit(meter, paid);
        if (!FirebaseEnabled || a.Issuer != AccountsIdentity.Issuer || Paused(a) || cap < units) return false;
        var inserted = await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO AccountUsage (WorkspaceId, Meter, Scope, Operation, Units)
            SELECT {owner}, {meter}, {scope}, {operation}, {units}
            WHERE (SELECT COALESCE(SUM(Units), 0) FROM AccountUsage WHERE WorkspaceId={owner} AND Meter={meter} AND Scope={scope}) <= {cap - units}
            ON CONFLICT (WorkspaceId, Meter, Operation) DO NOTHING
            """);
        var ok = inserted == 1 || await db.Set<AccountUsage>().AnyAsync(x =>
            x.WorkspaceId == owner && x.Meter == meter && x.Scope == scope && x.Operation == operation && x.Units == units);
        if (tx is not null) await tx.CommitAsync();
        return ok;
    }

    private static async Task<IResult> AccountView(HttpContext c, PracticeDb db)
    {
        if (c.Items["workspace"] is not Guid owner) return Results.Unauthorized();
        var a = await db.Set<AccountProfile>().AsNoTracking().SingleOrDefaultAsync(x => x.WorkspaceId == owner, c.RequestAborted);
        if (a is null)
            return Results.Ok(new { tier = PrivateStaging.Enabled ? "Private synthetic test" : LocalWorkspaceEnabled ? "Local sandbox" : "Unavailable", signedIn = false,
                checkoutEnabled = false, portalEnabled = false, usage = Array.Empty<object>() });
        if (Session(c)?.WorkspaceId != owner) return Results.Unauthorized();
        var paid = HasPrep(a);
        var scope = Grant(a, paid);
        var used = await db.Set<AccountUsage>().AsNoTracking().Where(x => x.WorkspaceId == owner && x.Scope == scope)
            .GroupBy(x => x.Meter).Select(g => new { meter = g.Key, used = g.Sum(x => x.Units) }).ToDictionaryAsync(x => x.meter, x => x.used, c.RequestAborted);
        return Results.Ok(new { tier = paid ? "Prep (Stripe test)" : "Free", signedIn = true, email = a.Email,
            billingStatus = a.BillingStatus, paused = Paused(a), periodStart = paid ? (long?)a.PeriodStart : null,
            periodEnd = paid ? (long?)a.PeriodEnd : null, checkoutEnabled = AccountsStripe.Enabled && !a.Deleting &&
                a.BillingStatus is ("none" or "inactive"), portalEnabled = AccountsStripe.Enabled && a.Customer is not null && !a.Deleting,
            usage = Meters.Select(m => new { meter = m, used = used.GetValueOrDefault(m), limit = Limit(m, paid) }) });
    }

    // Call before the host purges files and cascades the workspace. Failed remote cancellation must be retryable.
    public static async Task<IResult?> PrepareDeleteAsync(HttpContext c, PracticeDb db, Guid owner)
    {
        var account = await db.Set<AccountProfile>().AsNoTracking().SingleOrDefaultAsync(x => x.WorkspaceId == owner, c.RequestAborted);
        if (account is null) return null;
        if (RequireRecent(c, owner) is { } denied) return denied;
        return await c.RequestServices.GetRequiredService<AccountsStripe>().PrepareDelete(db, owner, c.RequestAborted);
    }

    public static void ClearDeletedSession(HttpContext c) =>
        c.Response.Cookies.Delete(Session(c) is null ? "practice_workspace" : Cookie, Options(c));
}
