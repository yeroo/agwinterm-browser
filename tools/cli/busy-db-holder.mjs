// A second process holding the database's write lock — the concurrent open that
// `store/src/client.ts` and `store/src/migrate.ts` are both hardened for.
//
// It has to be a separate process. SQLite's locks are per *connection*, so a
// second `DatabaseSync` opened in the test's own process would contend for real,
// but the test would then be blocked inside a synchronous `exec` with no way to
// release the lock — `execFileSync`-style deadlock against itself. A child can be
// told to let go on a timer.
//
// `argv[2]` is the database file, `argv[3]` how many milliseconds to hold the
// exclusive lock for. "locked" on stdout is the moment the lock is actually held.

import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
const holdMs = Number(process.argv[3] ?? 700);

const sqlite = new DatabaseSync(file);
sqlite.exec("BEGIN EXCLUSIVE");
process.stdout.write("locked\n");
setTimeout(() => {
  sqlite.exec("COMMIT");
  sqlite.close();
  process.exit(0);
}, holdMs);
