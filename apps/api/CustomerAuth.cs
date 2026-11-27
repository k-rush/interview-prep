using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

namespace InterviewPrep;

internal sealed class CustomerLogin
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid WorkspaceId { get; set; }
    public required string Issuer { get; set; }
    public required string Subject { get; set; }
    public required string Label { get; set; }
}

internal sealed class CustomerAuth(Guid tenant, Guid client, Uri origin, string? loginHost)
{
    private const string Scheme = "customer-oidc", MigrationCookie = "__Host-interview-migration";
    internal static bool Enabled => AccountsModule.Setting("PLANE") == "customer";
    internal static bool Migration => Enabled && AccountsModule.Setting("CUSTOMER_MIGRATE_FIREBASE") == "1" && AccountsModule.FirebaseEnabled;
    internal static string Realm => $"customer:{Guid.Parse(AccountsModule.Setting("CUSTOMER_TENANT_ID")!):D}:{Guid.Parse(AccountsModule.Setting("CUSTOMER_CLIENT_ID")!):D}";
    internal string Issuer => $"https://{tenant:D}.ciamlogin.com/{tenant:D}/v2.0";
    private string Authority => loginHost == null ? Issuer : $"https://{loginHost}/{tenant:D}/v2.0";
    private static readonly CookieOptions MigrationOptions = new() { Path = "/", HttpOnly = true, Secure = true, SameSite = SameSiteMode.Lax, MaxAge = TimeSpan.FromMinutes(5) };

    internal static CustomerAuth Configure(WebApplicationBuilder builder, Uri? origin, string? data)
    {
        static Guid Id(string name) => Guid.TryParse(AccountsModule.Setting(name), out var id) && id != Guid.Empty ? id :
            throw new InvalidOperationException($"Set a valid INTERVIEW_PREP_{name} for customer authentication.");
        if (origin?.Scheme != "https" || string.IsNullOrWhiteSpace(data) || !Path.IsPathFullyQualified(data) ||
            AccountsModule.Setting("DEMO_ONLY") == "1" || AccountsModule.Setting("TESTER_OID") != null ||
            AccountsModule.Setting("CUSTOMER_CLIENT_SECRET") is not { Length: > 0 } secret ||
            (AccountsModule.FirebaseEnabled || AccountsModule.Setting("CUSTOMER_MIGRATE_FIREBASE") == "1") && !Migration)
            throw new InvalidOperationException("Customer mode needs a dedicated HTTPS origin, data directory and Entra credentials; demo, private test and legacy login settings cannot be reused.");
        var host = AccountsModule.Setting("CUSTOMER_LOGIN_HOST");
        if (host != null && (!host.Contains('.') || Uri.CheckHostName(host) != UriHostNameType.Dns))
            throw new InvalidOperationException("CUSTOMER_LOGIN_HOST must be a tenant-verified DNS hostname without a scheme, port or path.");
        var auth = new CustomerAuth(Id("CUSTOMER_TENANT_ID"), Id("CUSTOMER_CLIENT_ID"), origin, host);
        if (!OperatingSystem.IsWindows()) Directory.CreateDirectory(data, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        builder.Services.AddDataProtection().SetApplicationName("interview-prep-" + Realm)
            .PersistKeysToFileSystem(Directory.CreateDirectory(Path.Combine(data, "customer-keys")));
        builder.Logging.AddFilter("Microsoft.AspNetCore.Hosting.Diagnostics", LogLevel.Warning);
        builder.Services.AddAuthentication().AddCookie("customer-exchange").AddOpenIdConnect(Scheme, o => {
            // Handle the validated ticket ourselves; the only app credential is a revocable database session.
            o.SignInScheme = "customer-exchange";
            o.Authority = auth.Authority;
            o.ClientId = Id("CUSTOMER_CLIENT_ID").ToString("D"); o.ClientSecret = secret;
            o.CallbackPath = "/auth/callback"; o.ResponseType = OpenIdConnectResponseType.Code;
            o.ResponseMode = OpenIdConnectResponseMode.Query; o.UsePkce = true; o.SaveTokens = false; o.MapInboundClaims = false;
            o.Scope.Clear(); foreach (var scope in new[] { "openid", "profile", "email" }) o.Scope.Add(scope);
            o.ClaimActions.Clear();
            o.PushedAuthorizationBehavior = PushedAuthorizationBehavior.Disable;
            o.RemoteAuthenticationTimeout = TimeSpan.FromMinutes(10);
            o.Events.OnRedirectToIdentityProvider = c => {
                if (c.Properties.Items.TryGetValue("hint", out var hint)) c.ProtocolMessage.DomainHint = hint;
                c.ProtocolMessage.Prompt = "login";
                if (Item(c.Properties, "action") != "login") c.ProtocolMessage.MaxAge = "0";
                return Task.CompletedTask;
            };
            o.Events.OnTicketReceived = async c => {
                c.HandleResponse();
                var result = await auth.Complete(c.HttpContext, c.HttpContext.RequestServices.GetRequiredService<PracticeDb>(), c.Principal, c.Properties);
                await result.ExecuteAsync(c.HttpContext);
            };
            o.Events.OnRemoteFailure = c => {
                c.HandleResponse(); c.Response.Redirect("/#signin/failed"); return Task.CompletedTask;
            };
        });
        return auth;
    }

    internal void Use(WebApplication app)
    {
        app.Use(async (c, next) => {
            if (!string.Equals(c.Request.Host.Value, origin.Authority, StringComparison.OrdinalIgnoreCase))
            { c.Response.StatusCode = 400; return; }
            c.Request.Scheme = "https";
            if (c.Request.Path.StartsWithSegments("/auth"))
            {
                c.Response.Headers.CacheControl = "no-store"; c.Response.Headers["Referrer-Policy"] = "no-referrer";
                if (HttpMethods.IsPost(c.Request.Method) && c.Request.Headers.Origin != origin.GetLeftPart(UriPartial.Authority))
                { c.Response.StatusCode = 403; return; }
            }
            await next();
        });
        app.UseAuthentication();
        app.MapGet("/auth/sign-in/{method}", (string method) => method switch {
            "apple" => Start("login", hint: "apple"), "google" => Start("login", hint: "google"),
            "microsoft" => Start("login", hint: "login.live.com"), "local" => Start("login"),
            _ => (IResult)Results.NotFound()
        });
        app.MapPost("/auth/{action:regex(^(link|verify)$)}", async (string action, HttpContext c, PracticeDb db) => {
            if (await AccountsModule.IdentifyAsync(c, db) is not Guid owner || AccountsModule.Session(c) is not { LoginId: not null } session)
                return Results.Redirect("/#signin");
            if (action == "link" && AccountsModule.RequireRecent(c, owner) != null)
                return Results.Redirect("/#workspace/account/verify-first");
            return Start(action, session.Digest);
        });
        app.MapDelete("/api/account/methods/{id:guid}", Remove);
        if (Migration)
        {
            app.MapPost("/api/account/migration", BeginMigration);
            app.MapGet("/auth/migrate", (HttpContext c) => MigrationProof(c) is { } ticket
                ? Start("migrate", AccountsModule.Hash(ticket)) : Results.Redirect("/#signin/failed"));
        }
    }

    private static IResult Start(string action, string? binding = null, string? hint = null)
    {
        var properties = new AuthenticationProperties { RedirectUri = "/" };
        properties.Items["action"] = action;
        if (binding != null) properties.Items["binding"] = binding;
        if (hint != null) properties.Items["hint"] = hint;
        return Results.Challenge(properties, [Scheme]);
    }

    private static string? Item(AuthenticationProperties? props, string key) =>
        props != null && props.Items.TryGetValue(key, out var value) ? value : null;

    private static string? MigrationProof(HttpContext c) => c.Request.Cookies[MigrationCookie] is { Length: > 0 and < 4096 } proof ? proof : null;
    private static ITimeLimitedDataProtector Protector(HttpContext c) => c.RequestServices.GetRequiredService<IDataProtectionProvider>()
        .CreateProtector("customer-migration", Realm, AccountsIdentity.Issuer).ToTimeLimitedDataProtector();

    private static async Task<IResult> BeginMigration(AccountsModule.LoginRequest input, HttpContext c, PracticeDb db, AccountsIdentity firebase)
    {
        if (!Migration || AccountsModule.Session(c) != null) return Results.Conflict("Sign out before moving an existing account.");
        var proof = await firebase.Verify(input.IdToken, c.RequestAborted);
        if (proof == null || !await db.Set<AccountProfile>().AnyAsync(a => a.Issuer == AccountsIdentity.Issuer && a.Subject == proof.Subject && !a.Deleting, c.RequestAborted))
            return Results.Unauthorized();
        c.Response.Cookies.Append(MigrationCookie, Protector(c).Protect(proof.Subject, TimeSpan.FromMinutes(5)), MigrationOptions);
        return Results.NoContent();
    }

    internal async Task<IResult> Complete(HttpContext c, PracticeDb db, ClaimsPrincipal? user, AuthenticationProperties? properties)
    {
        var now = AccountsModule.Now;
        string? Claim(string name) => user?.FindFirstValue(name);
        var action = Item(properties, "action");
        var binding = Item(properties, "binding");
        var tokenIssuer = Claim("iss");
        if (user?.Identity?.IsAuthenticated != true || tokenIssuer == null || tokenIssuer != Issuer && tokenIssuer != Authority || Claim("aud") != client.ToString("D") ||
            !Guid.TryParse(Claim("tid"), out var tokenTenant) || tokenTenant != tenant || Claim("sub") is not { Length: > 0 and <= 256 } sub ||
            !long.TryParse(Claim("exp"), out var expires) || expires <= now || action is not ("login" or "link" or "verify" or "migrate"))
            return Results.Redirect("/#signin/failed");
        var authTime = long.TryParse(Claim("auth_time"), out var at) && at > 0 && at <= now + 30 ? at : 0;
        if (action != "login" && authTime < now - 600) return Results.Redirect("/#signin/verification-failed");
        var email = Claim("email") is { Length: > 0 and <= 320 } contact ? contact : "";
        var label = Claim("idp") switch {
            "apple.com" or "https://appleid.apple.com" => "Apple", "google.com" or "https://accounts.google.com" => "Google",
            "live.com" or "https://login.live.com" => "Microsoft", _ => "Interview Prep sign-in"
        };
        var ct = c.RequestAborted;
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var owner = await AccountsModule.IdentifyAsync(c, db);
        var session = AccountsModule.Session(c);
        var login = await db.Set<CustomerLogin>().SingleOrDefaultAsync(l => l.Issuer == tokenIssuer && l.Subject == sub, ct);
        if (action is "link" or "verify")
        {
            if (owner == null || session?.LoginId == null || binding == null || binding != session.Digest)
                return Results.Redirect("/#signin/failed");
            if (action == "verify" && (login?.WorkspaceId != owner || login.Id != session.LoginId))
                return Results.Redirect("/#workspace/account/wrong-method");
            if (action == "link")
            {
                if (AccountsModule.RequireRecent(c, owner.Value) != null) return Results.Redirect("/#workspace/account/verify-first");
                if (login != null && login.WorkspaceId != owner) return Results.Redirect("/#workspace/account/conflict");
                if (login == null) db.Add(NewLogin(owner.Value));
                await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
                return Results.Redirect("/#workspace/account");
            }
        }
        AccountProfile? profile;
        if (action == "migrate")
        {
            if (!Migration || owner != null || login != null || MigrationProof(c) is not { } ticket || AccountsModule.Hash(ticket) != binding)
                return Results.Redirect("/#signin/migration-failed");
            string legacy;
            try { legacy = Protector(c).Unprotect(ticket); }
            catch (CryptographicException) { return Results.Redirect("/#signin/migration-failed"); }
            profile = await db.Set<AccountProfile>().SingleOrDefaultAsync(a => a.Issuer == AccountsIdentity.Issuer && a.Subject == legacy && !a.Deleting, ct);
            if (profile == null || profile.Customer != null && !AccountsStripe.Enabled) return Results.Redirect("/#signin/migration-failed");
            await db.Set<AccountSession>().Where(s => s.WorkspaceId == profile.WorkspaceId).ExecuteDeleteAsync(ct);
            profile.Issuer = Realm; profile.Subject = profile.WorkspaceId.ToString("N");
            c.Response.Cookies.Delete(MigrationCookie, MigrationOptions);
        }
        else if (login == null)
        {
            var workspace = new Workspace { TokenHash = AccountsModule.Hash(Convert.ToHexString(RandomNumberGenerator.GetBytes(32))), ExpiresAt = DateTime.MaxValue };
            db.Add(workspace);
            profile = new AccountProfile { WorkspaceId = workspace.Id, Issuer = Realm, Subject = workspace.Id.ToString("N"), Email = email };
            db.Add(profile);
        }
        else
        {
            profile = await db.Set<AccountProfile>().SingleOrDefaultAsync(a => a.WorkspaceId == login.WorkspaceId && a.Issuer == Realm, ct);
            if (profile == null) return Results.Redirect("/#signin/failed");
        }
        if (login == null) { login = NewLogin(profile.WorkspaceId); db.Add(login); }
        await AccountsModule.IssueSession(c, db, tx, profile.WorkspaceId, login.Id, authTime, expires);
        return Results.Redirect(action == "verify" ? "/#workspace/account" : "/#workspace");

        CustomerLogin NewLogin(Guid id) => new() { WorkspaceId = id, Issuer = tokenIssuer, Subject = sub, Label = label };
    }

    private static async Task<IResult> Remove(Guid id, HttpContext c, PracticeDb db)
    {
        await using var tx = await db.Database.BeginTransactionAsync(c.RequestAborted);
        if (await AccountsModule.IdentifyAsync(c, db) is not Guid owner) return Results.Unauthorized();
        if (AccountsModule.RequireRecent(c, owner) is { } denied) return denied;
        if (AccountsModule.Session(c)!.LoginId == id) return Results.Conflict("Keep the method you are signed in with.");
        var removed = await db.Set<CustomerLogin>().Where(l => l.Id == id && l.WorkspaceId == owner).ExecuteDeleteAsync(c.RequestAborted);
        await tx.CommitAsync(c.RequestAborted);
        return removed == 1 ? Results.NoContent() : Results.NotFound();
    }
}
