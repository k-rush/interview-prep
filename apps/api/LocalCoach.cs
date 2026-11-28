using System.Text.Json;

namespace InterviewPrep;

public sealed class LocalCoach(HttpClient http, StagingModel? staging = null, PromptPack? prompts = null)
{
    internal string Prompt(string id) => (prompts ?? PromptPack.Bundled)[id];
    internal static bool Enabled => PrivateStaging.Enabled || Environment.GetEnvironmentVariable("INTERVIEW_PREP_MODEL_PORT") is not null;
    internal static string Label => PrivateStaging.Enabled ? "Azure OpenAI" : "local model";
    internal static string Assessor => PrivateStaging.Enabled ? "azure" : "local";
    private sealed record Evaluation(string? Competency, int? Points, string? Quote, string? Feedback);
    private sealed record Question(string? Competency, string? Text);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<string[]?> Plan(string target, CancellationToken ct)
    {
        var questions = await Call<Question[]>(Prompt("mock.plan"), new { target, competencies = Practice.Probes.Select(p => new { p.Name, p.Anchor }) }, "questions", ct);
        if (questions?.Length != Practice.Probes.Length) return null;
        var text = new List<string>();
        for (int i = 0; i < questions.Length; i++)
        {
            var q = questions[i];
            if (q?.Competency != Practice.Probes[i].Name || string.IsNullOrWhiteSpace(q.Text) ||
                q.Text.Length > 300 || !q.Text.TrimEnd().EndsWith('?')) return null;
            text.Add(q.Text.Trim());
        }
        return text.ToArray();
    }

    public async Task<Mark[]?> Assess(string target, string[] questions, string[] answers, CancellationToken ct)
    {
        var packet = new { target, turns = Practice.Probes.Select((p, i) => new { competency = p.Name, question = questions[i], p.Anchor, answer = answers[i] }) };
        var marks = await Call<Evaluation?[]>(Prompt("mock.assess"), packet, "marks", ct);
        if (marks is null || marks.Length != answers.Length) return null;
        var result = new List<Mark>();
        for (int i = 0; i < marks.Length; i++)
        {
            var m = marks[i];
            if (m is null || m.Competency != Practice.Probes[i].Name || m.Points is not (>= 0 and <= 4) ||
                string.IsNullOrWhiteSpace(m.Quote) || m.Quote.Length > 320 || !answers[i].Contains(m.Quote, StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(m.Feedback) || m.Feedback.Length > 600) return null;
            result.Add(new(m.Points.Value, m.Quote, m.Feedback));
        }
        return result.ToArray();
    }

    public async Task<string?> NextQuestion(string role, string priorQuestion, string answer, Probe next, CancellationToken ct,
        Func<string, Task>? preview = null)
    {
        var text = await Call<string>(Prompt("mock.next"), new { role, priorQuestion, answer, competency = next.Name, next.Anchor }, "question", ct, 1000, null,
            ModelReplyStream.For(preview, "question", 300));
        return text?.Trim() is { Length: > 8 and <= 300 } q && q.EndsWith('?') ? q : null;
    }

    public Task<T?> Call<T>(string instruction, object packet, string? property, CancellationToken ct, int maxTokens = 1000,
        object? schema = null) where T : class => Call<T>(instruction, packet, property, ct, maxTokens, schema, null);

    internal async Task<T?> Call<T>(string instruction, object packet, string? property, CancellationToken ct, int maxTokens,
        object? schema, ModelReplyStream? stream) where T : class
    {
        var model = Environment.GetEnvironmentVariable("INTERVIEW_PREP_MODEL_ID") ?? "local";
        object format = schema is not null && model == "studio-qwen2.5-1.5b"
            ? new { type = "json_schema", json_schema = new { name = "studio_result", strict = true, schema } }
            : new { type = "json_object" };
        var request = new
        {
            messages = new[] { new { role = "system", content = instruction }, new { role = "user", content = JsonSerializer.Serialize(packet) } },
            model, temperature = 0, max_tokens = maxTokens, response_format = format, stream = stream is not null
        };
        try
        {
            string? content;
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(http.Timeout); // ResponseHeadersRead does not time out subsequent reads.
            var token = deadline.Token;
            if (staging != null) content = await staging.Complete(http, instruction, packet, maxTokens, stream, token);
            else
            {
                using var post = new HttpRequestMessage(HttpMethod.Post, "v1/chat/completions") { Content = JsonContent.Create(request) };
                using var response = await http.SendAsync(post, HttpCompletionOption.ResponseHeadersRead, token);
                if (!response.IsSuccessStatusCode) return null;
                if (stream != null && response.Content.Headers.ContentType?.MediaType == "text/event-stream")
                    content = await stream.Read(response.Content, false, token);
                else
                {
                    await response.Content.LoadIntoBufferAsync(http.MaxResponseContentBufferSize, token);
                    using var envelope = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(token));
                    content = envelope.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString();
                }
            }
            if (content is null) return null;
            using var body = JsonDocument.Parse(content);
            return (property is null ? body.RootElement : body.RootElement.GetProperty(property)).Deserialize<T>(Json);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested && ex is HttpRequestException or JsonException or KeyNotFoundException or InvalidOperationException
            or IndexOutOfRangeException or Azure.Identity.AuthenticationFailedException or IOException or OperationCanceledException)
        {
            return null;
        }
    }
}
