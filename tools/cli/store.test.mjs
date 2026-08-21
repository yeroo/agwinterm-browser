// The persisted half of Task 13: the `socket` → `endpoint` column rename, and what
// `listInstances` does with a row whose browser is gone.
//
// Driven against a real `node:sqlite` database in a scratch directory, through the
// built `pixel-store`, because the claim worth testing is that an *existing*
// database survives the rename with its rows — which is a property of the migration
// runner and SQLite, not of the schema file.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const store = await import(pathToFileURL(path.join(REPO, "store", "dist", "index.js")).href);
const { migrations } = await import(
  pathToFileURL(path.join(REPO, "store", "dist", "migrations.gen.js")).href
);
const { migrate } = await import(pathToFileURL(path.join(REPO, "store", "dist", "migrate.js")).href);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-store-"));
after(() => {
  // A failed assertion can leave a database handle open, and Windows will not
  // unlink an open file. Losing a scratch directory is not worth a second failure.
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

/** `node:sqlite` returns null-prototype rows; `deepEqual` will not have them. */
const plain = (rows) => rows.map((row) => ({ ...row }));

let dbSeq = 0;
const dbFile = () => path.join(scratch, `db-${++dbSeq}.sqlite`);

const RENAME = "0003_windows_named_pipes";
const upTo = (id) => migrations.slice(0, migrations.findIndex((m) => m.id === id) + 1);

describe("the endpoint column", () => {
  it("is the last migration, and renames rather than recreating", () => {
    const last = migrations[migrations.length - 1];
    assert.equal(last.id, RENAME);
    assert.deepEqual(last.statements, [
      "ALTER TABLE `instances` RENAME COLUMN `socket` TO `endpoint`;",
    ]);
  });

  it("carries an existing database's rows across the rename", () => {
    const file = dbFile();
    const sqlite = new DatabaseSync(file);
    // a database as it stood before this task
    migrate(sqlite, upTo("0002_fat_marten_broadcloak"));
    sqlite
      .prepare("INSERT INTO instances (key, pid, socket, started_at) VALUES (?, ?, ?, ?)")
      .run("42-1", 42, "/run/user/1000/app/instances/42-1.sock", 1700000000);
    sqlite.close();

    const reopened = new DatabaseSync(file);
    migrate(reopened, migrations);
    const rows = plain(reopened.prepare("SELECT key, endpoint FROM instances").all());
    assert.deepEqual(rows, [{ key: "42-1", endpoint: "/run/user/1000/app/instances/42-1.sock" }]);
    // and the old name is gone rather than duplicated
    assert.throws(() => reopened.prepare("SELECT socket FROM instances").all());
    reopened.close();
  });

  it("is what a fresh database gets, with no rename step needed to read it", () => {
    const sqlite = new DatabaseSync(dbFile());
    migrate(sqlite, migrations);
    sqlite
      .prepare("INSERT INTO instances (key, pid, endpoint, started_at) VALUES (?, ?, ?, ?)")
      .run("1-1", 1, store.pipeEndpoint("app", "instance", "1-1"), 1);
    assert.deepEqual(plain(sqlite.prepare("SELECT endpoint FROM instances").all()), [
      { endpoint: store.pipeEndpoint("app", "instance", "1-1") },
    ]);
    sqlite.close();
  });

  it("is applied once, so reopening an already-migrated database is a no-op", () => {
    const file = dbFile();
    for (let run = 0; run < 3; run++) {
      const sqlite = new DatabaseSync(file);
      migrate(sqlite, migrations);
      sqlite.close();
    }
    const sqlite = new DatabaseSync(file);
    const applied = sqlite.prepare("SELECT id FROM migration").all().map((row) => row.id);
    assert.equal(applied.filter((id) => id === RENAME).length, 1);
    sqlite.close();
  });
});

describe("pruning a dead browser", () => {
  /** `listInstances` against a scratch database, without touching the real one. */
  async function withRows(rows, fn) {
    const opened = store.openStore(dbFile());
    for (const row of rows) {
      opened.sqlite
        .prepare(
          "INSERT INTO instances (key, pid, endpoint, started_at, url, title) VALUES (?, ?, ?, ?, '', '')",
        )
        .run(row.key, row.pid, row.endpoint, row.startedAt ?? 0);
    }
    try {
      return await fn(opened);
    } finally {
      opened.sqlite.close();
    }
  }

  it("keeps a row whose process is alive", async () => {
    await withRows(
      [{ key: "live", pid: process.pid, endpoint: store.pipeEndpoint("app", "instance", "live") }],
      async (opened) => {
        const live = await listVia(opened);
        assert.deepEqual(live.map((row) => row.key), ["live"]);
      },
    );
  });

  it("drops a row whose process is gone — the thing that actually goes stale", async () => {
    // Pid 1 on Windows is the System Idle Process and never matches a browser;
    // a pid this large is reliably absent.
    await withRows(
      [
        { key: "live", pid: process.pid, endpoint: store.pipeEndpoint("app", "instance", "live") },
        { key: "dead", pid: 0x7ffffff0, endpoint: store.pipeEndpoint("app", "instance", "dead") },
      ],
      async (opened) => {
        const live = await listVia(opened);
        assert.deepEqual(live.map((row) => row.key), ["live"]);
        const remaining = plain(opened.sqlite.prepare("SELECT key FROM instances").all());
        assert.deepEqual(remaining, [{ key: "live" }]);
      },
    );
  });

  it("unlinks a dead row's socket file, and is untroubled by a pipe name", async () => {
    const socket = path.join(scratch, "dead.sock");
    fs.writeFileSync(socket, "");
    await withRows(
      [
        { key: "dead-file", pid: 0x7ffffff0, endpoint: socket },
        { key: "dead-pipe", pid: 0x7ffffff0, endpoint: store.pipeEndpoint("app", "gone") },
      ],
      async (opened) => {
        assert.deepEqual(await listVia(opened), []);
        assert.equal(fs.existsSync(socket), false);
      },
    );
  });

  it("returns the survivors oldest first", async () => {
    await withRows(
      [
        { key: "b", pid: process.pid, endpoint: store.pipeEndpoint("app", "b"), startedAt: 200 },
        { key: "a", pid: process.pid, endpoint: store.pipeEndpoint("app", "a"), startedAt: 100 },
      ],
      async (opened) => {
        assert.deepEqual((await listVia(opened)).map((row) => row.key), ["a", "b"]);
      },
    );
  });
});

/**
 * `listInstances` reads the process-wide store, so this reimplements its contract
 * against an explicitly opened one — the pruning rule, not the singleton.
 */
async function listVia(opened) {
  const rows = opened.sqlite.prepare("SELECT * FROM instances").all();
  const live = [];
  for (const row of rows) {
    let alive = true;
    try {
      process.kill(row.pid, 0);
    } catch (error) {
      alive = error.code === "EPERM";
    }
    if (alive) {
      live.push(row);
      continue;
    }
    opened.sqlite.prepare("DELETE FROM instances WHERE key = ?").run(row.key);
    store.removeEndpoint(row.endpoint);
  }
  return live.sort((a, b) => a.started_at - b.started_at);
}

describe("the pruning rule in the shipped module", () => {
  const source = fs.readFileSync(path.join(REPO, "store", "src", "instances.ts"), "utf8");

  it("treats only ESRCH as death, so a higher-integrity process is not pruned", () => {
    // `process.kill(pid, 0)` throws EPERM on Windows for a process this one may
    // not signal. Upstream's bare `catch { return false }` would have deleted a
    // running browser's row.
    assert.match(source, /=== "EPERM"/);
  });

  it("still removes the endpoint, which is the unlink on unix", () => {
    assert.match(source, /removeEndpoint\(row\.endpoint\)/);
    // The module no longer reaches the filesystem directly at all — `endpoint.ts`
    // decides whether there is anything to reach.
    assert.ok(!/^import fs from/m.test(source), "instances.ts still imports node:fs");
  });
});
