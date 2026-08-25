import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  id: string;
  statements: string[];
}

export function migrate(sqlite: DatabaseSync, migrations: Migration[]): void {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)",
  );
  const applied = new Set(
    (sqlite.prepare("SELECT id FROM migration").all() as Array<{ id: string }>).map(
      (row) => row.id,
    ),
  );
  const known = new Set(migrations.map((migration) => migration.id));
  const unknown = [...applied].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `database was migrated by a newer version of the app (unknown migrations: ${unknown.join(", ")}); refusing to open it`,
    );
  }
  const record = sqlite.prepare("INSERT INTO migration (id, time_completed) VALUES (?, ?)");
  const done = sqlite.prepare("SELECT id FROM migration WHERE id = ?");
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    // `BEGIN IMMEDIATE`, and the applied-set re-read inside it, are both about two
    // processes opening the database at once — which the Windows shape makes
    // ordinary, because every pane runs its own browser and each one opens the
    // store on startup. A deferred `BEGIN` takes no write lock until the first
    // write, so both transactions passed the check above and both ran the
    // statements; the loser of `0003`'s `RENAME COLUMN socket` then failed with
    // "no such column" and threw out of `openStore`, taking the browser with it.
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (done.get(migration.id)) {
        sqlite.exec("ROLLBACK");
        continue;
      }
      for (const statement of migration.statements) sqlite.exec(statement);
      record.run(migration.id, Date.now());
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
