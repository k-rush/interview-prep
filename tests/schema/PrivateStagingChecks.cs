using System.Security.Claims;
using InterviewPrep;
using Microsoft.Data.Sqlite;

internal static class PrivateStagingChecks
{
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
        }
        finally { root.Delete(true); }
    }
}
