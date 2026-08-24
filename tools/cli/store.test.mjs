// The persisted half of Task 13: the `socket` → `endpoint` column rename, and what
// `listInstances` does with a row whose browser is gone.
//
// Driven against a real `node:sqlite` database in a scratch directory, through the
// built `pixel-store`, because the claim worth testing is that an *existing*
// database survives the rename with its rows — which is a property of the migration
// runner and SQLite, not of the schema file.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import { requireBuilt } from "../lib/built.mjs";
import { closeServer, listen, teardown, withDeadline } from "../lib/deadline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

// Before the import, and that order is the whole trick. `store/src/paths.ts`
// resolves `DB_FILE` from the environment once, at module load, and `store()` is a
// lazy singleton over it -- so pointing the roots at a scratch directory *first* is
// what lets these tests call the shipped `listInstances` rather than restate its
// contract against a database they opened themselves. The previous version of this
// suite reimplemented the pruning rule in the test file, which meant inverting the
// rule in `instances.ts` left every assertion green.
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-store-root-"));
process.env.LOCALAPPDATA = stateRoot;
process.env.XDG_DATA_HOME = path.join(stateRoot, "data");
process.env.XDG_STATE_HOME = path.join(stateRoot, "state");
process.env.XDG_CACHE_HOME = path.join(stateRoot, "cache");
process.env.XDG_RUNTIME_DIR = path.join(stateRoot, "run");

requireBuilt(REPO, "store/dist/index.js", "store/src", "corepack pnpm --filter pixel-store build");

const store = await import(pathToFileURL(path.join(REPO, "store", "dist", "index.js")).href);
assert.ok(
  store.DB_FILE.startsWith(stateRoot),
  `the scratch roots did not take: ${store.DB_FILE}`,
);
const { migrations } = await import(
  pathToFileURL(path.join(REPO, "store", "dist", "migrations.gen.js")).href
);
const { migrate } = await import(pathToFileURL(path.join(REPO, "store", "dist", "migrate.js")).href);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-store-"));
after(() => {
  // A failed assertion can leave a database handle open, and Windows will not
  // unlink an open file. Losing a scratch directory is not worth a second failure.
  for (const dir of [scratch, stateRoot]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
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
  const sqlite = () => store.store().sqlite;
  const rowsNow = () => plain(sqlite().prepare("SELECT key FROM instances ORDER BY key").all());

  /** Nothing carried between tests: the store is one process-wide singleton. */
  function seed(rows) {
    sqlite().exec("DELETE FROM instances");
    for (const row of rows) {
      sqlite()
        .prepare(
          "INSERT INTO instances (key, pid, endpoint, started_at, url, title) VALUES (?, ?, ?, ?, '', '')",
        )
        .run(row.key, row.pid, row.endpoint, row.startedAt ?? 0);
    }
  }

  /** An endpoint of the shape this platform actually uses, with a server on it. */
  const servers = [];
  async function listening(name) {
    const endpoint =
      process.platform === "win32"
        ? store.pipeEndpoint("winterm-test", String(process.pid), name)
        : path.join(scratch, `${name}-${process.pid}.sock`);
    const server = net.createServer(() => {});
    servers.push(server);
    await listen(server, endpoint);
    return endpoint;
  }

  /** An endpoint of the same shape with nothing behind it. */
  const gone = (name) =>
    process.platform === "win32"
      ? store.pipeEndpoint("winterm-test", String(process.pid), `${name}-gone`)
      : path.join(scratch, `${name}-gone.sock`);

  // Awaited and bounded, unlike the fire-and-forget `server.close()` this used to
  // be: a close that never completes because a connection is still up would have
  // held the pipe past the end of the file with nothing reporting it, and one
  // server that refuses must not skip the next one's teardown.
  after(() => teardown(...servers.map((server) => () => closeServer(server))));

  it("keeps a browser whose process is alive and whose endpoint answers", async () => {
    seed([{ key: "live", pid: process.pid, endpoint: await listening("live") }]);
    const live = await store.listInstances();
    assert.deepEqual(live.map((row) => row.key), ["live"]);
  });

  it("drops a row whose process is gone - the thing that actually goes stale", async () => {
    // A pid this large is reliably absent; pid 1 on Windows is the System Idle
    // Process and would look alive.
    seed([
      { key: "live", pid: process.pid, endpoint: await listening("survivor") },
      { key: "dead", pid: 0x7ffffff0, endpoint: gone("dead") },
    ]);
    const live = await store.listInstances();
    assert.deepEqual(live.map((row) => row.key), ["live"]);
    assert.deepEqual(rowsNow(), [{ key: "live" }], "the dead row is still in the table");
  });

  it("drops a row whose pid is alive but whose pipe is nobody's - the recycled pid", async () => {
    // The failure this rule exists for: a browser that exited without deleting its
    // row leaves one behind, and the moment the operating system hands that pid to
    // any other process the row starts looking alive again. Permanently, with no
    // command to clear it, and on Windows `scopeHere` puts every browser in scope --
    // so one phantom made every `new-tab` ask which browser was meant.
    //
    // A pipe name cannot be recycled with the pid: it went with the process that
    // owned it. `process.pid` here is this test runner, which is certainly alive.
    if (process.platform !== "win32") return;
    seed([{ key: "phantom", pid: process.pid, endpoint: gone("phantom") }]);
    assert.deepEqual(await store.listInstances(), []);
    assert.deepEqual(rowsNow(), [], "the phantom row survived");
  });

  it("trusts a socket file to the pid alone, because a socket file outlives its server", async () => {
    // The asymmetry `endpoint.ts` is about. A pipe that does not answer is proof the
    // server is gone; a socket *file* that does not answer proves nothing about
    // whether it is about to be listened on again, so upstream's rule -- the pid
    // decides -- is the right one for it.
    if (process.platform === "win32") return;
    const orphan = path.join(scratch, "orphan.sock");
    fs.writeFileSync(orphan, "");
    seed([{ key: "filed", pid: process.pid, endpoint: orphan }]);
    assert.deepEqual((await store.listInstances()).map((row) => row.key), ["filed"]);
  });

  it("unlinks a dead row's socket file, and is untroubled by a pipe name", async () => {
    const socket = path.join(scratch, "dead.sock");
    fs.writeFileSync(socket, "");
    seed([
      { key: "dead-file", pid: 0x7ffffff0, endpoint: socket },
      { key: "dead-pipe", pid: 0x7ffffff0, endpoint: store.pipeEndpoint("app", "gone") },
    ]);
    assert.deepEqual(await store.listInstances(), []);
    assert.equal(fs.existsSync(socket), false);
  });

  it("keeps a live browser whose probe merely ran out of budget", async () => {
    // The row is deleted on "nobody is there", and a probe that did not *finish*
    // does not say that. A browser busy enough not to accept inside
    // `ENDPOINT_PROBE_MS` -- libuv arms a fixed number of pipe instances and creates
    // more only when its loop comes round -- used to be evicted, and `Registry.write`
    // only runs on a state change, so an idle one evicted this way never came back.
    //
    // The busy server is a real process (`busy-pipe-server.mjs`), for the reason
    // `endpoint.test.mjs` gives: an in-process one cannot be made to stall, because
    // the kernel completes the connect whatever this loop is doing.
    if (process.platform !== "win32") return;
    const endpoint = store.pipeEndpoint("winterm-test", String(process.pid), "busy");
    const child = spawn(process.execPath, [path.join(HERE, "busy-pipe-server.mjs"), endpoint, "6000"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const held = [];
    try {
      await withDeadline(
        new Promise((resolve, reject) => {
          child.stdout.once("data", resolve);
          child.once("exit", () => reject(new Error("the busy server never listened")));
        }),
        `the busy server on ${endpoint} to listen`,
      );
      for (let at = 0; at < 6; at += 1) {
        const socket = net.connect(endpoint);
        socket.on("error", () => {});
        held.push(socket);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      seed([{ key: "busy", pid: process.pid, endpoint }]);
      assert.deepEqual((await store.listInstances()).map((row) => row.key), ["busy"]);
      assert.deepEqual(rowsNow(), [{ key: "busy" }], "a running browser's row was deleted");
    } finally {
      for (const socket of held) socket.destroy();
      child.kill();
    }
  });

  it("returns the survivors oldest first", async () => {
    seed([
      { key: "b", pid: process.pid, endpoint: await listening("b"), startedAt: 200 },
      { key: "a", pid: process.pid, endpoint: await listening("a"), startedAt: 100 },
    ]);
    assert.deepEqual((await store.listInstances()).map((row) => row.key), ["a", "b"]);
  });
});

describe("the pruning rule in the shipped module", () => {
  const source = fs.readFileSync(path.join(REPO, "store", "src", "instances.ts"), "utf8");

  it("treats only ESRCH as death, so a higher-integrity process is not pruned", () => {
    // `process.kill(pid, 0)` throws EPERM on Windows for a process this one may
    // not signal. Upstream's bare `catch { return false }` would have deleted a
    // running browser's row.
    assert.match(source, /=== "EPERM"/);
  });

  it("deletes only on a definite absence", () => {
    // `unknown` -- a probe that timed out rather than one that was refused -- keeps
    // the row. The two mistakes are not the same size: a row kept in error costs one
    // failed request, and a row deleted in error costs the browser.
    assert.match(source, /!== "absent"/);
    assert.ok(!/endpointAlive/.test(source), "instances.ts is back on the boolean probe");
  });

  it("does not let a failed prune abort the listing", () => {
    // Cleanup is opportunistic; a listing is not. A locked database here used to
    // reject `listInstances`, so `ls`, `new-tab` and `action` failed outright
    // instead of reporting the live browsers they had already identified.
    assert.match(source, /removeInstance\(row\.key\)\.catch\(\(\) => \{\}\)/);
  });

  it("still removes the endpoint, which is the unlink on unix", () => {
    assert.match(source, /removeEndpoint\(row\.endpoint\)/);
    // The module no longer reaches the filesystem directly at all — `endpoint.ts`
    // decides whether there is anything to reach.
    assert.ok(!/^import fs from/m.test(source), "instances.ts still imports node:fs");
  });
});
