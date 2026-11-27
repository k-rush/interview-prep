using System.Globalization;
using System.Net.ServerSentEvents;
using System.Text;
using System.Text.Json;

namespace InterviewPrep;

internal sealed class ModelReplyStream(string? parent, string field, int limit, Func<string, Task> preview)
{
    internal static ModelReplyStream? For(Func<string, Task>? preview, string field, int limit, string? parent = null) =>
        preview is null ? null : new(parent, field, limit, preview);

    internal async Task<string?> Read(HttpContent body, bool responsesApi, CancellationToken ct)
    {
        var content = new StringBuilder();
        using var source = await body.ReadAsStreamAsync(ct);
        await foreach (var item in SseParser.Create(source).EnumerateAsync(ct))
        {
            if (!responsesApi && item.Data == "[DONE]") return content.ToString();
            if (item.Data.Length > 131072) return null;
            using var frame = JsonDocument.Parse(item.Data);
            var root = frame.RootElement;
            string? delta;
            if (responsesApi)
            {
                var type = root.GetProperty("type").GetString();
                if (type == "response.completed") return StagingModel.Output(root.GetProperty("response"));
                if (type is "error" or "response.failed" or "response.incomplete") return null;
                if (type != "response.output_text.delta") continue;
                delta = root.GetProperty("delta").GetString();
            }
            else
            {
                var choices = root.GetProperty("choices");
                if (choices.GetArrayLength() == 0 || !choices[0].GetProperty("delta").TryGetProperty("content", out var part)) continue;
                delta = part.GetString();
            }
            if (string.IsNullOrEmpty(delta)) continue;
            if (content.Length + delta.Length > 65536) return null;
            content.Append(delta);
            if (VisibleText(content.ToString()) is { Length: > 0 } text && text.Length <= limit) await preview(text);
        }
        return null; // A disconnected provider has not completed the structured result.
    }

    // Locate the display field with a JSON reader; never forward tool output, labels or raw JSON.
    private string? VisibleText(string content)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        var reader = new Utf8JsonReader(bytes, isFinalBlock: false, state: default);
        bool inParent = parent is null;
        while (reader.Read())
        {
            if (reader.TokenType != JsonTokenType.PropertyName) continue;
            if (parent is not null && reader.CurrentDepth == 1) { inParent = reader.ValueTextEquals(parent); continue; }
            if (!inParent || reader.CurrentDepth != (parent is null ? 1 : 2) || !reader.ValueTextEquals(field)) continue;
            if (reader.Read()) return reader.TokenType == JsonTokenType.String ? reader.GetString() : null;

            var partial = Encoding.UTF8.GetString(bytes.AsSpan((int)reader.BytesConsumed)).TrimStart();
            if (!partial.StartsWith('"')) return null;
            // Close the unfinished string at a complete escape, including across split \uXXXX pairs.
            int end = partial.Length;
            for (int i = 1; i < end; i++)
            {
                if (partial[i] != '\\') continue;
                int escape = i++;
                var width = i < end && partial[i] == 'u' ? 5 : 1;
                if (width == 5 && end - i >= 5 && ushort.TryParse(partial.AsSpan(i + 1, 4), NumberStyles.HexNumber,
                    CultureInfo.InvariantCulture, out var code) && char.IsHighSurrogate((char)code)) width += 6;
                if (end - i < width) { end = escape; break; }
                i += width - 1;
            }
            try { return JsonSerializer.Deserialize<string>(partial[..end] + "\""); }
            catch (JsonException) { return null; }
        }
        return null;
    }
}
