using InterviewPrep;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

// Exercise the upgrade on an isolated in-memory database. A real studio is only ever opened read-only.
using var copy = new SqliteConnection("Data Source=:memory:;Foreign Keys=true");
copy.Open();
using var db = new PracticeDb(new DbContextOptionsBuilder<PracticeDb>().UseSqlite(copy).Options);
if (args is ["--check-copy", var path])
{
    using var original = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = SqliteOpenMode.ReadOnly }.ToString());
    original.Open();
    original.BackupDatabase(copy);
}
else if (args.Length == 0)
{
    await db.Database.ExecuteSqlRawAsync("""
        CREATE TABLE Workspaces (Id TEXT NOT NULL PRIMARY KEY, TokenHash TEXT NOT NULL, ExpiresAt TEXT NOT NULL);
        CREATE TABLE Facts (Id TEXT NOT NULL PRIMARY KEY, WorkspaceId TEXT NOT NULL REFERENCES Workspaces(Id) ON DELETE CASCADE,
            Project TEXT NOT NULL, Source TEXT NOT NULL, Claim TEXT NOT NULL, Confirmed INTEGER NOT NULL);
        CREATE TABLE Mocks (Id TEXT NOT NULL PRIMARY KEY, WorkspaceId TEXT NOT NULL REFERENCES Workspaces(Id) ON DELETE CASCADE,
            Target TEXT NOT NULL, Rubric TEXT NOT NULL, QuestionsJson TEXT NOT NULL, Tailored INTEGER NOT NULL, StartedAt TEXT NOT NULL,
            AnswersJson TEXT NOT NULL, ReportJson TEXT NULL, Retry TEXT NULL, Revision INTEGER NOT NULL);
        INSERT INTO Workspaces VALUES ('00000000-0000-0000-0000-000000000001','synthetic-token-hash','2099-01-01');
        INSERT INTO Facts VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Pilot','We ran a pilot.','I ran a pilot.',1);
        INSERT INTO Mocks VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Engineer','behavioral-v1',
            '["Question?"]',0,'2025-01-01','["A saved answer."]',NULL,NULL,1);
        """);
}
else throw new ArgumentException("Use no arguments for the synthetic upgrade or --check-copy <sqlite-file>.");

static long Count(SqliteConnection cx, string table)
{
    using var cmd = cx.CreateCommand(); cmd.CommandText = $"SELECT count(*) FROM {table}";
    return Convert.ToInt64(cmd.ExecuteScalar());
}
var counts = new[] { "Workspaces", "Facts", "Mocks" }.ToDictionary(s => s, s => Count(copy, s));
await PracticeSchema.Open(db);
await PracticeSchema.Open(db);
if (counts.Any(pair => Count(copy, pair.Key) != pair.Value)) throw new Exception("Upgrade lost records.");
using var integrity = copy.CreateCommand();
integrity.CommandText = "PRAGMA integrity_check";
if ((string?)integrity.ExecuteScalar() != "ok") throw new Exception("SQLite integrity check failed.");
integrity.CommandText = "PRAGMA foreign_key_check";
if (integrity.ExecuteScalar() is not null) throw new Exception("Foreign key check failed.");
if (args.Length == 0)
{
    var fact = await db.Facts.AsNoTracking().SingleAsync();
    var mock = await db.Mocks.AsNoTracking().SingleAsync();
    if (!fact.Confirmed || fact.AllowLive || fact.AllowDrafts || fact.Claim != "I ran a pilot." || fact.Source != "We ran a pilot." ||
        mock.Answers().Single() != "A saved answer." || mock.ReportJson is not null ||
        (await db.Workspaces.SingleAsync()).TokenHash != "synthetic-token-hash") throw new Exception("Legacy workspace changed.");
    await db.AddAsync(new InterviewTarget { WorkspaceId = fact.WorkspaceId, Role = "Engineering", Round = "Hiring manager", Level = "Senior" });
    var source = new ExperienceSource { WorkspaceId = fact.WorkspaceId, Category = "resume", Title = "Existing source" };
    db.Add(source);
    await db.SaveChangesAsync();
    await db.Database.ExecuteSqlRawAsync("ALTER TABLE ExperienceSource DROP COLUMN Description; ALTER TABLE ExperienceCitation DROP COLUMN Corroborates; PRAGMA user_version=4;");
    await PracticeSchema.Open(db);
    var upgraded = await db.Set<ExperienceSource>().AsNoTracking().SingleAsync(s => s.Id == source.Id);
    if (upgraded.Description is not null || upgraded.Title != source.Title) throw new Exception("Existing source changed during upgrade.");
    await db.Database.ExecuteSqlRawAsync("""
        INSERT INTO DiscoveryDigest (Id, WorkspaceId, LocalDate, Zone, TargetRole, CreatedUtc, Trigger, Status, CoverageJson, WebSearchJson, NextStep, DraftNote)
        VALUES ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','2025-01-01','UTC','Engineer','2025-01-01','manual','complete','[]','','Saved digest','');
        ALTER TABLE DiscoveryDigest DROP COLUMN WebSearchJson;
        PRAGMA user_version=5;
        """);
    await PracticeSchema.Open(db);
    integrity.CommandText = "SELECT count(*) FROM DiscoveryDigest WHERE NextStep='Saved digest' AND WebSearchJson=''";
    if (Convert.ToInt32(integrity.ExecuteScalar()) != 1) throw new Exception("Scout search upgrade changed a saved digest.");
    var chat = new ChatSession { WorkspaceId = fact.WorkspaceId, Kind = "builder" };
    db.Add(chat); await db.SaveChangesAsync();
    await db.Database.ExecuteSqlRawAsync("""
        DROP TABLE ChatNote;
        CREATE TABLE ChatNote (Id TEXT PRIMARY KEY, WorkspaceId TEXT NOT NULL, ChatId TEXT NOT NULL, Text TEXT NOT NULL,
            FOREIGN KEY (WorkspaceId, ChatId) REFERENCES ChatSession (WorkspaceId, Id) ON DELETE CASCADE);
        INSERT INTO ChatNote SELECT '00000000-0000-0000-0000-000000000005', WorkspaceId, Id, 'Ask one question at a time.' FROM ChatSession;
        PRAGMA user_version=6;
        """);
    await PracticeSchema.Open(db); await PracticeSchema.Open(db);
    integrity.CommandText = "SELECT count(*) FROM ChatNote WHERE ChatId IS NOT NULL AND FactId IS NULL AND Text='Ask one question at a time.'";
    if (Convert.ToInt32(integrity.ExecuteScalar()) != 1) throw new Exception("Agent memory upgrade lost an existing coaching note.");
    integrity.CommandText = "PRAGMA foreign_key_check";
    if (integrity.ExecuteScalar() is not null) throw new Exception("Agent memory upgrade broke source ownership.");
    db.Add(new AccountProfile { WorkspaceId = fact.WorkspaceId, Issuer = "legacy-fixture", Subject = "existing-user", Email = "test@example.invalid" });
    await db.SaveChangesAsync();
    await db.Database.ExecuteSqlRawAsync("""
        DROP TABLE AccountSessions;
        DROP TABLE CustomerLogins;
        CREATE TABLE AccountSessions (Digest TEXT NOT NULL PRIMARY KEY, WorkspaceId TEXT NOT NULL REFERENCES AccountProfiles(WorkspaceId) ON DELETE CASCADE,
            AuthTime INTEGER NOT NULL, Expires INTEGER NOT NULL);
        INSERT INTO AccountSessions SELECT 'saved-session', WorkspaceId, 10, 20 FROM AccountProfiles;
        PRAGMA user_version=7;
        """);
    await PracticeSchema.Open(db); await PracticeSchema.Open(db);
    var session = await db.Set<AccountSession>().AsNoTracking().SingleAsync(s => s.Digest == "saved-session");
    if (session.WorkspaceId != fact.WorkspaceId || session.LoginId != null || await db.Set<CustomerLogin>().AnyAsync())
        throw new Exception("Customer sign-in upgrade changed legacy ownership or silently linked an identity.");
    await db.Database.ExecuteSqlRawAsync("PRAGMA user_version=9999");
    try { await PracticeSchema.Open(db); throw new Exception("Newer version not rejected."); }
    catch (InvalidOperationException ex) when (ex.Message.Contains("newer studio")) { }
}
Console.WriteLine("Compatible schema; records preserved on the isolated copy.");
await ScoutWebSearchChecks.Run();
Console.WriteLine("Scout web search request, citation validation and failure checks passed.");
await PrivateStagingChecks.Run();
