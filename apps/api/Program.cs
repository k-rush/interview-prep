using System.Net;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Reflection;
using InterviewPrep;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args, WebRootPath = Environment.GetEnvironmentVariable("INTERVIEW_PREP_WEBROOT")
});
var port = int.Parse(Environment.GetEnvironmentVariable("INTERVIEW_PREP_PORT") ?? "5187");
var container = Environment.GetEnvironmentVariable("INTERVIEW_PREP_PRIVATE_CONTAINER") == "1" &&
    Environment.GetEnvironmentVariable("DOTNET_RUNNING_IN_CONTAINER") == "true";
var originSetting = Environment.GetEnvironmentVariable("INTERVIEW_PREP_PUBLIC_ORIGIN");
Uri? publicOrigin = null;
if (!string.IsNullOrWhiteSpace(originSetting))
{
    if (!Uri.TryCreate(originSetting, UriKind.Absolute, out publicOrigin) || publicOrigin.UserInfo != "" ||
        publicOrigin.PathAndQuery != "/" || publicOrigin.Fragment != "" ||
        !(publicOrigin.Scheme == "https" || (publicOrigin.Scheme == "http" && publicOrigin.IsLoopback && AccountsModule.LocalWorkspaceEnabled)))
        throw new InvalidOperationException("INTERVIEW_PREP_PUBLIC_ORIGIN must be the trusted HTTPS site origin, or a local HTTP origin in desktop mode.");
    builder.Configuration["AllowedHosts"] = "127.0.0.1;localhost;" + publicOrigin.Host;
}
builder.WebHost.ConfigureKestrel(k =>
{
    k.Listen(container ? IPAddress.Any : IPAddress.Loopback, port);
    k.Limits.MaxRequestBodySize = 32 * 1024;
});
var data = Environment.GetEnvironmentVariable("INTERVIEW_PREP_DATA") ??
    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "InterviewPrep");
if (OperatingSystem.IsWindows()) Directory.CreateDirectory(data);
else Directory.CreateDirectory(data, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
var connection = new SqliteConnectionStringBuilder { DataSource = Path.Combine(data, "practice.sqlite"), ForeignKeys = true };
builder.Services.AddDbContext<PracticeDb>(db => db.UseSqlite(connection.ToString()));
DiscoveryModule.Register(builder.Services);
AccountsModule.Register(builder.Services);
builder.Services.AddHttpClient<PublicResearch>(client =>
{
    client.Timeout = TimeSpan.FromSeconds(8); client.MaxResponseContentBufferSize = 256000;
}).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
var speechPort = Environment.GetEnvironmentVariable("INTERVIEW_PREP_SPEECH_PORT");
if (speechPort is not null && (!int.TryParse(speechPort, out var voicePort) || voicePort is < 1 or > 65535))
    throw new InvalidOperationException("INTERVIEW_PREP_SPEECH_PORT must be a local TCP port.");
builder.Services.AddHttpClient("speech", client =>
{
    client.BaseAddress = new Uri($"http://127.0.0.1:{speechPort ?? "8081"}/"); client.Timeout = TimeSpan.FromSeconds(35);
    client.MaxResponseContentBufferSize = 64000;
}).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false, UseCookies = false });

var modelPort = Environment.GetEnvironmentVariable("INTERVIEW_PREP_MODEL_PORT");
if (modelPort is not null && (!int.TryParse(modelPort, out var n) || n is < 1 or > 65535))
    throw new InvalidOperationException("INTERVIEW_PREP_MODEL_PORT must be a local TCP port.");
builder.Services.AddHttpClient<LocalCoach>(http =>
{
    http.BaseAddress = new Uri($"http://127.0.0.1:{modelPort ?? "8080"}/");
    http.Timeout = TimeSpan.FromSeconds(90);
    http.MaxResponseContentBufferSize = 65536;
    if (modelPort is not null && Environment.GetEnvironmentVariable("INTERVIEW_PREP_MODEL_KEY_FILE") is { Length: > 0 } file)
        http.DefaultRequestHeaders.Authorization = new("Bearer", File.ReadAllText(file).Trim());
}).RemoveAllLoggers().ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false, UseCookies = false });

var app = builder.Build();
using var metrics = new Meter("InterviewPrep.Studio");
var latency = metrics.CreateHistogram<double>("studio.api.duration", unit: "s");
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<PracticeDb>();
    await PracticeSchema.Open(db);
    await db.Workspaces.Where(w => w.ExpiresAt <= DateTime.UtcNow).ExecuteDeleteAsync();
}
app.Use(async (ctx, next) =>
{
    ctx.Response.Headers["Content-Security-Policy"] = "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; connect-src 'self'" +
        (AccountsModule.FirebaseEnabled ? " https://identitytoolkit.googleapis.com" : "");
    ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    if (ctx.Request.Path.StartsWithSegments("/api"))
    {
        ctx.Response.Headers.CacheControl = "no-store";
        bool MatchesOrigin(string origin) => origin == $"{ctx.Request.Scheme}://{ctx.Request.Host}" ||
            (publicOrigin is not null && origin == publicOrigin.GetLeftPart(UriPartial.Authority) &&
             string.Equals(ctx.Request.Host.Value, publicOrigin.Authority, StringComparison.OrdinalIgnoreCase));
        if (!HttpMethods.IsGet(ctx.Request.Method) && !AccountsModule.IsWebhook(ctx.Request) &&
            (ctx.Request.Headers["X-Practice-Request"] != "1" ||
             (ctx.Request.Headers.TryGetValue("Origin", out var origin) && !MatchesOrigin(origin.ToString()))))
        {
            ctx.Response.StatusCode = 403;
            return;
        }
        var db = ctx.RequestServices.GetRequiredService<PracticeDb>();
        var owner = await AccountsModule.IdentifyAsync(ctx, db);
        if (owner is null && AccountsModule.LocalWorkspaceEnabled && !ctx.Request.Cookies.ContainsKey("practice_account"))
            owner = await WorkspaceApi.Identify(ctx, db);
        if (owner is not null) ctx.Items["workspace"] = owner.Value;
        else if (!AccountsModule.IsPublic(ctx.Request) &&
            !(AccountsModule.LocalWorkspaceEnabled && !ctx.Request.Cookies.ContainsKey("practice_account") &&
              HttpMethods.IsPost(ctx.Request.Method) && ctx.Request.Path == "/api/workspace"))
        {
            ctx.Response.StatusCode = 401;
            return;
        }
    }
    try { await next(); }
    catch (DbUpdateConcurrencyException)
    {
        await Results.Conflict("This attempt changed in another tab. Reload before continuing.").ExecuteAsync(ctx);
    }
});
app.Use(async (ctx, next) =>
{
    var start = Stopwatch.GetTimestamp();
    try { await next(); }
    finally
    {
        if (ctx.Request.Path.StartsWithSegments("/api"))
            latency.Record(Stopwatch.GetElapsedTime(start).TotalSeconds, new KeyValuePair<string, object?>("http.status", ctx.Response.StatusCode));
    }
});
app.UseDefaultFiles();
app.UseStaticFiles();
var version = typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
app.MapGet("/healthz", () => Results.Ok(new { status = "ok", mode = "local-practice", version }));
app.MapGet("/readyz", async (PracticeDb db, CancellationToken ct) => await db.Database.CanConnectAsync(ct)
    ? Results.Ok(new { status = "ready" }) : Results.StatusCode(503));
WorkspaceApi.Map(app, modelPort is not null);
ChatModule.Map(app);
Preparation.Map(app);
LiveGuide.Map(app);
PracticeSpeech.Map(app, speechPort is not null);
ExperienceModule.Map(app);
DiscoveryModule.Map(app);
AccountsModule.Map(app);
app.Run();
