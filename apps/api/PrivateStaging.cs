using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.Sqlite;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

namespace InterviewPrep;

// A disposable, single-tester deployment; never an alternative login for normal workspaces.
internal sealed class PrivateStaging
{
    internal static bool Enabled => AccountsModule.Setting("PLANE") == "private-test";
    internal const string WorkspaceMarker = "entra-synthetic-workspace-v1";
    internal required Guid Tester { get; init; }
    internal required Guid Tenant { get; init; }
    internal required DateTimeOffset Expires { get; init; }
    internal required string Share { get; init; }
    private readonly SemaphoreSlim writes = new(1, 1);
    internal sealed record WriteCheckpoint(Action Save);

    internal static PrivateStaging Configure(WebApplicationBuilder builder, bool container, Uri? origin)
    {
        string Need(string key) => AccountsModule.Setting(key) is { Length: > 0 } s ? s :
            throw new InvalidOperationException($"Missing private staging setting: {key}");
        if (!container || origin?.Scheme != "https" || AccountsModule.FirebaseEnabled ||
            AccountsModule.Setting("MODEL_PORT") is not null || AccountsModule.Setting("DEMO_ONLY") == "1")
            throw new InvalidOperationException("Private staging requires its own HTTPS container, identity and model.");
        var stage = new PrivateStaging {
            Tester = Guid.Parse(Need("TESTER_OID")), Tenant = Guid.Parse(Need("TENANT_ID")),
            Expires = DateTimeOffset.Parse(Need("TEST_EXPIRES"), System.Globalization.CultureInfo.InvariantCulture),
            Share = Need("TEST_SHARE")
        };
        if (stage.Tester == Guid.Empty || stage.Tenant == Guid.Empty || stage.Expires > DateTimeOffset.UtcNow.AddHours(24.1) ||
            !Path.IsPathFullyQualified(stage.Share) || !Directory.Exists(stage.Share))
            throw new InvalidOperationException("Invalid tester, expiry or staging volume.");
        var client = Guid.Parse(Need("WEB_CLIENT_ID")).ToString();
        var authority = $"https://login.microsoftonline.com/{stage.Tenant:D}/v2.0";
        builder.Services.AddDataProtection().SetApplicationName("interview-prep-private-test")
            .PersistKeysToFileSystem(Directory.CreateDirectory(Path.Combine(stage.Share, "cookie-keys")));
        builder.Services.AddAuthentication("test-cookie")
            .AddCookie("test-cookie", o => {
                o.Cookie.Name = "__Host-interview-test"; o.Cookie.Path = "/"; o.Cookie.SecurePolicy = CookieSecurePolicy.Always;
                o.Cookie.SameSite = SameSiteMode.Lax; o.ExpireTimeSpan = TimeSpan.FromHours(4); o.SlidingExpiration = false;
            })
            .AddOpenIdConnect("entra", o => {
                o.SignInScheme = "test-cookie"; o.Authority = authority; o.ClientId = client;
                o.ClientSecret = Need("WEB_CLIENT_SECRET"); o.ResponseType = OpenIdConnectResponseType.Code;
                o.UsePkce = true; o.SaveTokens = false; o.MapInboundClaims = false;
                o.Scope.Clear(); o.Scope.Add("openid"); o.Scope.Add("profile");
                o.PushedAuthorizationBehavior = PushedAuthorizationBehavior.Disable;
            })
            .AddJwtBearer("test-api", o => {
                o.Authority = authority; o.Audience = client; o.MapInboundClaims = false;
            });
        builder.Services.AddSingleton(stage);
        builder.Services.AddSingleton(new StagingModel(stage.Expires, stage.Share, Need("AZURE_OPENAI_ENDPOINT"),
            Need("MODEL_ID"), Guid.Parse(Need("MODEL_CLIENT_ID"))));
        return stage;
    }

    internal bool IsTester(ClaimsPrincipal? user) => user?.Identity?.IsAuthenticated == true &&
        Guid.TryParse(user.FindFirstValue("tid"), out var tenant) && tenant == Tenant &&
        Guid.TryParse(user.FindFirstValue("oid"), out var oid) && oid == Tester;

    internal void Protect(WebApplication app, Uri origin, string database)
    {
        app.Use(async (c, next) => {
            c.Response.Headers.CacheControl = "no-store";
            if (DateTimeOffset.UtcNow >= Expires) { c.Response.StatusCode = 410; return; }
            if (!string.Equals(c.Request.Host.Value, origin.Authority, StringComparison.OrdinalIgnoreCase))
            { c.Response.StatusCode = 400; return; }
            // Only the configured HTTPS host is accepted. Never build an OIDC redirect from forwarded headers.
            c.Request.Scheme = "https";
            await next();
        });
        app.UseAuthentication();
        app.Use(async (c, next) => {
            var bearer = c.Request.Headers.ContainsKey("Authorization");
            var user = bearer ? (await c.AuthenticateAsync("test-api")).Principal : c.User;
            if (user?.Identity?.IsAuthenticated != true)
            {
                if (!bearer && HttpMethods.IsGet(c.Request.Method) && c.Request.Path == "/")
                    await c.ChallengeAsync("entra", new AuthenticationProperties { RedirectUri = "/" });
                else c.Response.StatusCode = 401;
                return;
            }
            if (!IsTester(user) || bearer && user.FindFirstValue("scp")?.Split(' ').Contains("access_as_user") != true)
            { c.Response.StatusCode = 403; return; }
            if (!c.Request.Path.StartsWithSegments("/api") || HttpMethods.IsGet(c.Request.Method))
            { await next(); return; }
            await writes.WaitAsync(c.RequestAborted);
            try
            {
                var checkpoint = new WriteCheckpoint(() => Checkpoint(database));
                c.Features.Set(checkpoint);
                c.Response.OnStarting(() => {
                    // A chat preview precedes the transaction; its terminal frame checkpoints after commit.
                    if (c.Response.StatusCode < 400 && c.Response.ContentType != ChatTurnStream.MediaType) checkpoint.Save();
                    return Task.CompletedTask;
                });
                await next();
                await c.Response.StartAsync();
            }
            finally { writes.Release(); }
        });
    }

    // Keep SQLite and all its locking on local disk. Only closed, consistent backups cross SMB.
    internal FileStream Restore(string database)
    {
        var lease = new FileStream(Path.Combine(Share, "writer.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        try {
            var snapshot = Path.Combine(Share, "workspace.bak");
            if (File.Exists(snapshot)) File.Copy(snapshot, database, true);
            return lease;
        }
        catch { lease.Dispose(); throw; }
    }

    internal void Checkpoint(string database)
    {
        var temp = database + ".backup";
        using (var source = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = database, Mode = SqliteOpenMode.ReadOnly }.ToString()))
        using (var dest = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = temp, Pooling = false }.ToString()))
        {
            source.Open(); dest.Open(); source.BackupDatabase(dest);
        }
        var pending = Path.Combine(Share, "workspace.pending");
        File.Copy(temp, pending, true);
        File.Move(pending, Path.Combine(Share, "workspace.bak"), true);
    }
}
