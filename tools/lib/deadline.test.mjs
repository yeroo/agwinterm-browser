// The bound on every other suite's waits, tested against the failures it exists for.
//
// `tools/cli/registry.test.mjs` awaited a named-pipe connection with no deadline on
// 2026-08-21, hung, and took `pnpm test` down with it — three `node` processes still
// alive eighteen hours later. `--test-timeout` in the `test` script is the backstop;
// `tools/lib/deadline.mjs` is the per-wait half that says *what* was being waited
// for. This file drives it against real pipes and real never-settling promises,
// because "fails instead of hanging" is only a claim if something actually stalls.
//
// Every test here is itself bounded: a bug in the helper must fail this file rather
// than wedge it, so nothing awaits an unbounded promise even to check the helper.

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DEADLINE_MS,
  closeServer,
  listen,
  onceWithin,
  teardown,
  withDeadline,
} from "./deadline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-deadline-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** An endpoint of the shape this platform actually uses, unique per name. */
let seq = 0;
const endpointFor = (name) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\winterm-deadline-${process.pid}-${name}-${++seq}`
    : path.join(scratch, `${name}-${++seq}.sock`);

/** Never settles. The thing the helper is defined against. */
const forever = () => new Promise(() => {});

describe("a wait that never completes", () => {
  it("fails on the deadline rather than hanging", async () => {
    // The regression in one line: without `withDeadline` this `await` is the
    // eighteen hours. `--test-timeout` would eventually kill the file, but the
    // report would name the file, not the wait.
    await assert.rejects(
      () => withDeadline(forever(), "a pipe nobody will answer", 50),
      /timed out after 50ms waiting for a pipe nobody will answer/,
    );
  });

  it("names what it was waiting for, which is the point of saying it at all", async () => {
    await assert.rejects(
      () => withDeadline(forever(), "\\\\.\\pipe\\agwinterm to accept", 50),
      (error) => error.message.includes("\\\\.\\pipe\\agwinterm to accept"),
    );
  });

  it("has a default, so a caller who forgets one is still bounded", () => {
    assert.equal(typeof DEFAULT_DEADLINE_MS, "number");
    assert.ok(DEFAULT_DEADLINE_MS > 0 && DEFAULT_DEADLINE_MS <= 30_000);
  });
});

describe("a wait that does complete", () => {
  it("passes the value through untouched", async () => {
    assert.equal(await withDeadline(Promise.resolve("bound"), "nothing", 1000), "bound");
  });

  it("reports the real failure, not a timeout, when the wait rejects", async () => {
    // A bind that fails with `EADDRINUSE` has to say `EADDRINUSE`. Replacing a
    // diagnosable error with "timed out" would make the helper worse than no
    // helper, because the message would be actively misleading.
    await assert.rejects(
      () => withDeadline(Promise.reject(new Error("EADDRINUSE")), "the bind", 1000),
      /EADDRINUSE/,
    );
  });

  it("does not hold the process open with a timer it no longer needs", async () => {
    // A helper meant to stop hangs must not become one: an uncleared 30s timer
    // after a 1ms resolution keeps the event loop alive for 30 seconds. Measured
    // rather than asserted on internals — the whole race resolves promptly.
    const started = process.hrtime.bigint();
    await withDeadline(Promise.resolve(1), "an immediate value", 30_000);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1000, `the resolved wait took ${elapsedMs}ms`);
  });
});

describe("binding a server", () => {
  const open = new Set();
  after(() => teardown(...[...open].map((server) => () => closeServer(server))));

  const track = (server) => (open.add(server), server);

  it("resolves the server once it is listening", async () => {
    const server = track(net.createServer(() => {}));
    assert.equal(await listen(server, endpointFor("bound")), server);
    assert.equal(server.listening, true);
    open.delete(server);
    await closeServer(server);
  });

  it("rejects a bind that fails instead of waiting for a callback that never runs", async () => {
    // `server.listen(name, cb)` does not call `cb` on failure — the failure goes to
    // the `error` event. A promise subscribed only to the callback waits forever,
    // which is how a name collision between two suites becomes a hung run.
    const endpoint = endpointFor("collide");
    const first = track(net.createServer(() => {}));
    await listen(first, endpoint);
    const second = net.createServer(() => {});
    second.on("error", () => {});
    await assert.rejects(() => listen(second, endpoint, 2000), (error) => {
      assert.doesNotMatch(error.message, /timed out/, "reported as a timeout, not a bind failure");
      return true;
    });
    open.delete(first);
    await closeServer(first);
  });
});

describe("closing a server", () => {
  it("completes even while a connection is still open", async () => {
    // `close` waits on every accepted connection, so a client that never hangs up
    // keeps the callback pending — teardown itself becomes the hang. This is the
    // exact shape of the mute-host tests in `tools/cli/`.
    const endpoint = endpointFor("held-open");
    const accepted = [];
    const server = net.createServer((connection) => {
      connection.on("error", () => {});
      accepted.push(connection);
    });
    await listen(server, endpoint);
    const client = net.connect(endpoint);
    client.on("error", () => {});
    await onceWithin(client, "connect", `a client to reach ${endpoint}`);
    try {
      await closeServer(server, 2000);
      assert.equal(server.listening, false);
    } finally {
      client.destroy();
      for (const connection of accepted) connection.destroy();
    }
  });

  it("frees the name, so the next test can take it", async () => {
    const endpoint = endpointFor("reuse");
    const first = net.createServer(() => {});
    await listen(first, endpoint);
    await closeServer(first);
    const second = net.createServer(() => {});
    await listen(second, endpoint, 2000);
    await closeServer(second);
  });
});

describe("waiting on one event", () => {
  it("fails on the deadline when the event never arrives", async () => {
    const idle = new net.Socket();
    await assert.rejects(
      () => onceWithin(idle, "data", "a host that answers", 50),
      /timed out after 50ms waiting for a host that answers/,
    );
    idle.destroy();
  });
});

describe("teardown that must happen anyway", () => {
  it("runs every step even when an earlier one throws", async () => {
    // One server that will not close must not skip the cleanup of the next: a
    // `finally` that throws halfway leaves pipes held for the rest of the run.
    const ran = [];
    const failures = await teardown(
      () => ran.push("first"),
      () => {
        ran.push("second");
        throw new Error("this one refused");
      },
      () => ran.push("third"),
    );
    assert.deepEqual(ran, ["first", "second", "third"]);
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /this one refused/);
  });

  it("awaits asynchronous steps rather than firing and forgetting", async () => {
    const ran = [];
    await teardown(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      ran.push("slow");
    });
    assert.deepEqual(ran, ["slow"]);
  });
});

describe("the suite-wide backstop", () => {
  it("keeps `--test-timeout` on the test script", () => {
    // The per-wait deadlines above cover the waits this repo knows about. The flag
    // covers the ones it does not — a future test, or a wait inside a dependency.
    // Losing it silently is how the run becomes hangable again, so it is pinned.
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
    assert.match(
      pkg.scripts.test,
      /--test-timeout[= ](\d+)/,
      "`pnpm test` can hang indefinitely again",
    );
    const [, ms] = pkg.scripts.test.match(/--test-timeout[= ](\d+)/);
    assert.ok(Number(ms) > 0, "a zero timeout disables the backstop");
  });
});
