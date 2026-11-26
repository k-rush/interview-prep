using System.Buffers.Binary;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;

namespace InterviewPrep;

public static class PracticeSpeech
{
    public const int MaxBytes = 44 + 16000 * 2 * 45;
    public static void Map(WebApplication app, bool enabled)
    {
        app.MapGet("/api/speech", () => Results.Ok(new { localTranscriber = enabled }));
        app.MapPost("/api/speech/transcribe", async (HttpContext c, IHttpClientFactory clients, PracticeDb db) =>
        {
            if (!enabled) return Results.BadRequest("No local speech server is configured; type the answer instead.");
            var feature = c.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (feature is { IsReadOnly: false }) feature.MaxRequestBodySize = MaxBytes;
            if (c.Request.ContentType != "audio/wav" || c.Request.ContentLength is not (>= 46 and <= MaxBytes))
                return Results.BadRequest("Record a bounded mono PCM voice turn (45 seconds or less).");
            var wave = new byte[(int)c.Request.ContentLength.Value];
            var owner = Preparation.Owner(c); var key = Guid.NewGuid().ToString("N"); bool reserved = false, completed = false;
            try
            {
                await c.Request.Body.ReadExactlyAsync(wave, c.RequestAborted);
                if (wave.Length % 2 != 0 || !wave.AsSpan(0, 4).SequenceEqual("RIFF"u8) || BinaryPrimitives.ReadInt32LittleEndian(wave.AsSpan(4)) != wave.Length - 8 ||
                    !wave.AsSpan(8, 8).SequenceEqual("WAVEfmt "u8) || BinaryPrimitives.ReadInt32LittleEndian(wave.AsSpan(16)) != 16 ||
                    BinaryPrimitives.ReadInt16LittleEndian(wave.AsSpan(20)) != 1 || BinaryPrimitives.ReadInt16LittleEndian(wave.AsSpan(22)) != 1 ||
                    BinaryPrimitives.ReadInt32LittleEndian(wave.AsSpan(24)) != 16000 || BinaryPrimitives.ReadInt32LittleEndian(wave.AsSpan(28)) != 32000 ||
                    BinaryPrimitives.ReadInt16LittleEndian(wave.AsSpan(32)) != 2 || BinaryPrimitives.ReadInt16LittleEndian(wave.AsSpan(34)) != 16 ||
                    !wave.AsSpan(36, 4).SequenceEqual("data"u8) || BinaryPrimitives.ReadInt32LittleEndian(wave.AsSpan(40)) != wave.Length - 44)
                    return Results.BadRequest("Invalid mono 16 kHz PCM recording.");
                var seconds = (wave.Length - 44 + 31999) / 32000;
                if (!(reserved = await AccountsModule.TryReserveVoiceAsync(db, owner, key, seconds)))
                    return Results.Json("No practice transcription time remains. Type or use installed on-device dictation.", statusCode: 429);
                using var form = new MultipartFormDataContent();
                using var file = new ByteArrayContent(wave);
                file.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
                form.Add(file, "file", "turn.wav"); form.Add(new StringContent("json"), "response_format");
                using var client = clients.CreateClient("speech");
                using var reply = await client.PostAsync("inference", form, c.RequestAborted);
                reply.EnsureSuccessStatusCode();
                using var result = JsonDocument.Parse(await reply.Content.ReadAsByteArrayAsync(c.RequestAborted));
                if (result.RootElement.TryGetProperty("text", out var item) && item.GetString()?.Trim() is { Length: > 0 and <= 3000 } text)
                { completed = true; return Results.Ok(new { text }); }
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException or InvalidOperationException ||
                ex is OperationCanceledException && !c.RequestAborted.IsCancellationRequested) { }
            finally
            {
                CryptographicOperations.ZeroMemory(wave);
                if (reserved && !completed) await AccountsModule.ReleaseReservationAsync(db, owner, "voiceSeconds", key);
            }
            return Results.Json("Transcription unavailable. Nothing was submitted as your answer.", statusCode: 503);
        });
    }
}
