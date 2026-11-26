using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace InterviewPrep;

public static class PracticeSchema
{
    // Version 0 is the original EnsureCreated studio. Never replace its file or regenerate its tokens.
    public static async Task Open(PracticeDb db)
    {
        await db.Database.OpenConnectionAsync();
        var cx = db.Database.GetDbConnection();
        await using var tx = await db.Database.BeginTransactionAsync();
        async Task<object?> Query(string sql, bool scalar = false)
        {
            await using DbCommand cmd = cx.CreateCommand();
            cmd.Transaction = tx.GetDbTransaction(); cmd.CommandText = sql;
            return scalar ? await cmd.ExecuteScalarAsync() : await cmd.ExecuteNonQueryAsync();
        }
        var version = Convert.ToInt32(await Query("PRAGMA user_version", true));
        if (version > 5) throw new InvalidOperationException("This workspace requires a newer studio. No changes were made.");
        if (version < 4)
        {
            var existing = Convert.ToInt32(await Query("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='Facts'", true)) == 1;
            if (existing && version < 2)
            {
                await Query("""
                    ALTER TABLE Facts ADD COLUMN AllowDrafts INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE Facts ADD COLUMN AllowLive INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE Facts ADD COLUMN Origin TEXT NOT NULL DEFAULT 'candidate statement';
                    ALTER TABLE Facts ADD COLUMN SourceMockId TEXT NULL;
                    ALTER TABLE Facts ADD COLUMN SourceTurn INTEGER NULL;
                    ALTER TABLE Mocks ADD COLUMN Adaptive INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE Mocks ADD COLUMN TargetId TEXT NULL;
                    ALTER TABLE Mocks ADD COLUMN CompletedAt TEXT NULL;
                    """);
            }
            if (existing && Convert.ToInt32(await Query("SELECT count(*) FROM pragma_table_info('Mocks') WHERE name='StartKey'", true)) == 0)
                await Query("ALTER TABLE Mocks ADD COLUMN StartKey TEXT NULL");
            if (Convert.ToInt32(await Query("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='InterviewTarget'", true)) == 1 &&
                Convert.ToInt32(await Query("SELECT count(*) FROM pragma_table_info('InterviewTarget') WHERE name='InterviewAt'", true)) == 0)
                await Query("ALTER TABLE InterviewTarget ADD COLUMN InterviewAt TEXT NULL; ALTER TABLE InterviewTarget ADD COLUMN InterviewZone TEXT NULL;");
            // Only EF-generated table/index declarations are replayed, never candidate data.
            var schema = db.Database.GenerateCreateScript()
                .Replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", StringComparison.Ordinal)
                .Replace("CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ", StringComparison.Ordinal)
                .Replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ", StringComparison.Ordinal);
            await Query(schema);
        }
        if (version < 5)
        {
            if (Convert.ToInt32(await Query("SELECT count(*) FROM pragma_table_info('ExperienceSource') WHERE name='Description'", true)) == 0)
                await Query("ALTER TABLE ExperienceSource ADD COLUMN Description TEXT NULL");
            if (Convert.ToInt32(await Query("SELECT count(*) FROM pragma_table_info('ExperienceCitation') WHERE name='Corroborates'", true)) == 0)
                await Query("ALTER TABLE ExperienceCitation ADD COLUMN Corroborates INTEGER NOT NULL DEFAULT 0");
            await Query("PRAGMA user_version=5");
        }
        await tx.CommitAsync();
        await db.Database.CloseConnectionAsync();
    }
}
