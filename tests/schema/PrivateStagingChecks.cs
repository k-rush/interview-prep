using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Azure.Core;
using InterviewPrep;
using Microsoft.Data.Sqlite;

internal static class PrivateStagingChecks
{
    private sealed class FixtureToken : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext context, CancellationToken ct) => new("synthetic", DateTimeOffset.UtcNow.AddMinutes(2));
        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken ct) => ValueTask.FromResult(GetToken(context, ct));
    }
    private sealed class ResponsesFixture : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            using var doc = JsonDocument.Parse(await req.Content!.ReadAsStringAsync(ct));
            var input = doc.RootElement.GetProperty("input");
            if (req.RequestUri?.AbsoluteUri != "https://fixture.openai.azure.com/openai/v1/responses" ||
                req.Headers.Authorization?.Parameter != "synthetic" || doc.RootElement.GetProperty("store").GetBoolean() ||
                input[0].GetProperty("role").GetString() != "developer" || !input[0].GetProperty("content").GetString()!.Contains("JSON") ||
                input[1].GetProperty("role").GetString() != "user" || !input[1].GetProperty("content").GetString()!.Contains("packing checklist"))
                throw new Exception("Invalid authenticated Responses request or missing JSON-mode instruction in input messages.");
            return new(System.Net.HttpStatusCode.OK) {
                Content = new StringContent("""{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"{\"reply\":\"Which step did you test?\"}"}]}]}""", Encoding.UTF8, "application/json")
            };
        }
    }
    internal static async Task Run()
    {
        var root = Directory.CreateTempSubdirectory("interview-synthetic-test-");
        try {
            var stage = new PrivateStaging { Tester = Guid.NewGuid(), Tenant = Guid.NewGuid(),
                Expires = DateTimeOffset.UtcNow.AddMinutes(5), Share = root.FullName };
            static ClaimsPrincipal Principal(Guid tenant, Guid oid) => new(new ClaimsIdentity(
                [new Claim("tid", tenant.ToString()), new Claim("oid", oid.ToString())], "verified"));
            if (!stage.IsTester(Principal(stage.Tenant, stage.Tester)) || stage.IsTester(Principal(stage.Tenant, Guid.NewGuid())) ||
                stage.IsTester(Principal(Guid.NewGuid(), stage.Tester)) || stage.IsTester(new ClaimsPrincipal()))
                throw new Exception("Staging allowed an anonymous, different-tenant, or different-user identity.");

            var dbPath = Path.Combine(root.FullName, "local.db");
            void Sql(string sql) {
                using var db = new SqliteConnection($"Data Source={dbPath};Pooling=False"); db.Open();
                using var cmd = db.CreateCommand(); cmd.CommandText = sql; cmd.ExecuteNonQuery();
            }
            using (stage.Restore(dbPath)) {
                Sql("CREATE TABLE sample (line TEXT); INSERT INTO sample VALUES ('fictional');");
                stage.Checkpoint(dbPath);
            }
            SqliteConnection.ClearAllPools();
            File.Delete(dbPath);
            using (stage.Restore(dbPath)) {
                using var db = new SqliteConnection($"Data Source={dbPath};Pooling=False"); db.Open();
                using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT line FROM sample";
                if ((string?)cmd.ExecuteScalar() != "fictional") throw new Exception("Cold replica lost the last checkpoint.");
            }
            StagingModel Model(DateTimeOffset until) => new(until, root.FullName, "https://fixture.openai.azure.com/", "test-model", Guid.NewGuid());
            var first = Model(stage.Expires);
            var slots = await Task.WhenAll(Enumerable.Range(0, 15).Select(_ => Task.Run(() => first.Reserve(true))));
            if (slots.Count(x => x) != 10 || Model(stage.Expires).Reserve(true) || !first.Reserve(false) ||
                Model(DateTimeOffset.UtcNow.AddSeconds(-1)).Reserve(false))
                throw new Exception("Parallel, restart, or expired test escaped the persistent model budget.");
            using var http = new HttpClient(new ResponsesFixture());
            var fixture = new StagingModel(stage.Expires, root.FullName, "https://fixture.openai.azure.com/", "test-model", Guid.NewGuid(), new FixtureToken());
            var reply = await new LocalCoach(http, fixture).Call<string>("Ask a follow-up.", new { example = "packing checklist" }, "reply", default);
            if (reply != "Which step did you test?") throw new Exception("Azure model reply was not used.");
        }
        finally { root.Delete(true); }
    }
}
