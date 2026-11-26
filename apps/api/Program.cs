using System.Net;
using InterviewPrep;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
var port = int.Parse(Environment.GetEnvironmentVariable("INTERVIEW_PREP_PORT") ?? "5187");
builder.WebHost.ConfigureKestrel(k =>
{
    k.Listen(IPAddress.Loopback, port);
    k.Limits.MaxRequestBodySize = 32 * 1024;
});
var data = Environment.GetEnvironmentVariable("INTERVIEW_PREP_DATA") ??
    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "InterviewPrep");
if (OperatingSystem.IsWindows()) Directory.CreateDirectory(data);
else Directory.CreateDirectory(data, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
var connection = new SqliteConnectionStringBuilder { DataSource = Path.Combine(data, "practice.sqlite"), ForeignKeys = true };
builder.Services.AddDbContext<PracticeDb>(db => db.UseSqlite(connection.ToString()));

var modelPort = Environment.GetEnvironmentVariable("INTERVIEW_PREP_MODEL_PORT");
if (modelPort is not null && (!int.TryParse(modelPort, out var n) || n is < 1 or > 65535))
    throw new InvalidOperationException("INTERVIEW_PREP_MODEL_PORT must be a local TCP port.");
builder.Services.AddHttpClient<LocalCoach>(http =>
{
    http.BaseAddress = new Uri($"http://127.0.0.1:{modelPort ?? "8080"}/");
    http.Timeout = TimeSpan.FromSeconds(45);
    http.MaxResponseContentBufferSize = 65536;
}).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false });

var app = builder.Build();
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<PracticeDb>();
    await db.Database.EnsureCreatedAsync();
    await db.Workspaces.Where(w => w.ExpiresAt <= DateTime.UtcNow).ExecuteDeleteAsync();
}
app.Use(async (ctx, next) =>
{
    ctx.Response.Headers["Content-Security-Policy"] = "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";
    ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    if (ctx.Request.Path.StartsWithSegments("/api"))
    {
        ctx.Response.Headers.CacheControl = "no-store";
        if (!HttpMethods.IsGet(ctx.Request.Method) &&
            (ctx.Request.Headers["X-Practice-Request"] != "1" ||
             (ctx.Request.Headers.TryGetValue("Origin", out var origin) && origin != $"{ctx.Request.Scheme}://{ctx.Request.Host}")))
        {
            ctx.Response.StatusCode = 403;
            return;
        }
        var db = ctx.RequestServices.GetRequiredService<PracticeDb>();
        var owner = await WorkspaceApi.Identify(ctx, db);
        if (owner is not null) ctx.Items["workspace"] = owner.Value;
        else if (!(HttpMethods.IsPost(ctx.Request.Method) && ctx.Request.Path == "/api/workspace"))
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
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapGet("/healthz", () => Results.Ok(new { status = "ok", mode = "local-practice" }));
WorkspaceApi.Map(app, modelPort is not null);
app.Run();
