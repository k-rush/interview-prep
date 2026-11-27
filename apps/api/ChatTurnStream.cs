using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;

namespace InterviewPrep;

internal static class ChatTurnStream
{
    internal const string MediaType = "application/x-ndjson";
    internal sealed record Saved(Guid Id, string? Text) : IResult
    {
        public Task ExecuteAsync(HttpContext c) => Results.Ok(new { Id }).ExecuteAsync(c);
    }

    internal static async Task<IResult> Run(HttpContext c, Func<Func<string, Task>?, Task<IResult>> turn)
    {
        if (c.Request.GetTypedHeaders().Accept?.Any(a => string.Equals(a.MediaType.Value, MediaType, StringComparison.OrdinalIgnoreCase) && a.Quality != 0) != true)
            return await turn(null);

        async Task Write(object frame)
        {
            if (!c.Response.HasStarted)
            {
                c.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
                c.Response.ContentType = MediaType;
                c.Response.Headers["X-Accel-Buffering"] = "no";
            }
            try
            {
                await c.Response.WriteAsync(JsonSerializer.Serialize(frame) + "\n", c.RequestAborted);
                await c.Response.Body.FlushAsync(c.RequestAborted);
            }
            catch (IOException) { c.Abort(); throw; }
        }
        var sent = "";
        async Task Preview(string text)
        {
            if (text.Length <= sent.Length || !text.StartsWith(sent, StringComparison.Ordinal)) return;
            await Write(new { type = "delta", text = text[sent.Length..] });
            sent = text;
        }

        IResult result;
        try { result = await turn(Preview); }
        catch (DbUpdateConcurrencyException) when (c.Response.HasStarted)
        { result = Results.Conflict("This chat changed. Reload its latest turn."); }
        if (result is Saved saved)
        {
            c.Features.Get<PrivateStaging.WriteCheckpoint>()?.Save();
            await Write(new { type = "done", id = saved.Id, text = saved.Text });
        }
        else if (c.Response.HasStarted)
        {
            var status = (result as IStatusCodeHttpResult)?.StatusCode ?? 500;
            var message = (result as IValueHttpResult)?.Value as string ?? "Could not finish this turn. Reload before trying again.";
            await Write(new { type = "error", status, message });
        }
        else return result;
        return Results.Empty;
    }
}
