// Task 13's first half: where things live, what they are called, and what "stale"
// means when the name is a named pipe rather than a file.
//
// `store/src/endpoint.ts` and the naming half of `store/src/paths.ts` are imported
// from the built package, so these drive the real artifact the CLI loads. The
// platform-dependent half is driven through `appPaths`, which is a pure function of
// (platform, env, home, app name) precisely so both columns of the table in
// `docs/design/05-cli-and-endpoints.md` can be checked from one test run.
//
// The lifetime claims are not asserted against a mock of Win32. A real
// `net.Server` is opened on a real endpoint — a named pipe here, since that is what
// this machine has — and probed before and after it closes.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { requireBuilt } from "../lib/built.mjs";
import { closeServer, listen, teardown, withDeadline } from "../lib/deadline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

// These suites drive the *built* package rather than transpiled sources, so a
// missing or stale `dist/` would either die with a module-not-found stack or, worse,
// pass green against the previous build.
requireBuilt(REPO, "store/dist/index.js", "store/src", "corepack pnpm --filter pixel-store build");

const store = await import(
  new URL(`file:///${path.join(REPO, "store", "dist", "index.js").replaceAll("\\", "/")}`).href
);

const {
  PIPE_PREFIX,
  appPaths,
  endpointAlive,
  endpointKind,
  endpointStatus,
  instanceEndpointIn,
  isPipeEndpoint,
  pipeEndpoint,
  pipeSegment,
  reclaimEndpoint,
  removeEndpoint,
} = store;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-endpoint-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const APP = "terminal-browser-dev-0123abcd";

const windows = {
  platform: "win32",
  env: { LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" },
  home: "C:\\Users\\ada",
  appDirName: APP,
};

const linux = {
  platform: "linux",
  env: { XDG_RUNTIME_DIR: "/run/user/1000" },
  home: "/home/ada",
  appDirName: APP,
};

describe("telling a pipe from a path", () => {
  it("recognises both spellings of a local pipe address", () => {
    assert.equal(isPipeEndpoint(`${PIPE_PREFIX}whatever`), true);
    assert.equal(isPipeEndpoint("\\\\?\\pipe\\whatever"), true);
    // Case does not matter to the object manager, so it must not matter here.
    assert.equal(isPipeEndpoint("\\\\.\\PIPE\\whatever"), true);
  });

  it("does not mistake a unix socket path for one", () => {
    assert.equal(isPipeEndpoint("/run/user/1000/terminal-browser/daemon.sock"), false);
    assert.equal(isPipeEndpoint("/tmp/pipe/thing.sock"), false);
    // A remote pipe on another machine is not something this port ever builds,
    // and treating it as local would be wrong rather than merely unsupported.
    assert.equal(isPipeEndpoint("\\\\otherhost\\pipe\\thing"), false);
  });

  it("names the thing correctly in a message", () => {
    assert.equal(endpointKind(`${PIPE_PREFIX}x`), "named pipe");
    assert.equal(endpointKind("/run/x.sock"), "socket");
  });
});

describe("pipe naming", () => {
  it("joins segments with a single prefix", () => {
    assert.equal(pipeEndpoint(APP, "daemon"), `${PIPE_PREFIX}${APP}-daemon`);
    assert.equal(pipeEndpoint(APP, "instance", "1234-1"), `${PIPE_PREFIX}${APP}-instance-1234-1`);
  });

  it("refuses to let a segment nest the name", () => {
    // `\\.\pipe\a\b` is a different name, so a key carrying a separator must not
    // be able to reach one by accident.
    assert.equal(pipeSegment("a\\b"), "a_b");
    assert.equal(pipeSegment("a/b"), "a_b");
    assert.equal(pipeEndpoint("app", "a\\b"), `${PIPE_PREFIX}app-a_b`);
  });

  it("leaves the characters a session key actually uses alone", () => {
    // Keys are `${pid}-${seq}`; the app name adds dots and dashes.
    assert.equal(pipeSegment("12345-7"), "12345-7");
    assert.equal(pipeSegment("terminal-browser-dev-0123abcd"), "terminal-browser-dev-0123abcd");
    assert.equal(pipeSegment("a.b_c-1"), "a.b_c-1");
  });

  it("stays inside the 256-character limit for a realistic name", () => {
    const endpoint = pipeEndpoint(APP, "instance", "4294967295-999");
    assert.ok(endpoint.length < 256, `${endpoint.length} characters`);
  });
});

describe("application-data locations", () => {
  it("puts everything under one LOCALAPPDATA root on Windows", () => {
    const paths = appPaths(windows);
    const root = "C:\\Users\\ada\\AppData\\Local\\" + APP;
    assert.equal(paths.dataDir, path.win32.join(root, "data"));
    assert.equal(paths.logsDir, path.win32.join(root, "logs"));
    assert.equal(paths.faviconsDir, path.win32.join(root, "cache", "favicons"));
    assert.equal(paths.instancesDir, path.win32.join(root, "instances"));
    assert.equal(paths.agentSocketsDir, path.win32.join(root, "agent-browser"));
    assert.equal(paths.dbFile, path.win32.join(root, "data", "terminal-browser.db"));
  });

  it("falls back to the profile when LOCALAPPDATA is missing or relative", () => {
    for (const value of [undefined, "", "AppData\\Local"]) {
      const paths = appPaths({ ...windows, env: { LOCALAPPDATA: value } });
      assert.ok(
        paths.dataDir.startsWith(path.win32.join("C:\\Users\\ada", "AppData", "Local", APP)),
        `${value} produced ${paths.dataDir}`,
      );
    }
  });

  it("names the daemon a pipe on Windows and a socket file on unix", () => {
    const daemon = appPaths(windows).daemonEndpoint;
    assert.ok(daemon.startsWith(PIPE_PREFIX), daemon);
    // `u<8 hex>` is the user scope; see `userScope` in store/src/paths.ts.
    assert.match(daemon.slice(PIPE_PREFIX.length), new RegExp(`^${APP}-u[0-9a-f]{8}-daemon$`));
    assert.equal(appPaths(linux).daemonEndpoint, `/run/user/1000/${APP}/daemon.sock`);
  });

  it("leaves the XDG layout exactly as upstream had it", () => {
    const paths = appPaths({
      ...linux,
      env: {
        XDG_RUNTIME_DIR: "/run/user/1000",
        XDG_DATA_HOME: "/home/ada/data",
        XDG_STATE_HOME: "/home/ada/state",
        XDG_CACHE_HOME: "/home/ada/cache",
      },
    });
    assert.equal(paths.dataDir, `/home/ada/data/${APP}`);
    assert.equal(paths.logsDir, `/home/ada/state/${APP}/logs`);
    assert.equal(paths.faviconsDir, `/home/ada/cache/${APP}/favicons`);
    assert.equal(paths.instancesDir, `/run/user/1000/${APP}/instances`);
    assert.equal(paths.dbFile, `/home/ada/data/${APP}/terminal-browser.db`);
  });

  it("ignores a relative XDG override, as upstream did", () => {
    const paths = appPaths({ ...linux, env: { XDG_DATA_HOME: "relative/data" } });
    assert.equal(paths.dataDir, `/home/ada/.local/share/${APP}`);
  });
});

describe("per-browser endpoint resolution", () => {
  it("is a pipe named from the install, the user and the session key on Windows", () => {
    const endpoint = instanceEndpointIn(appPaths(windows), windows, "4321-2");
    assert.ok(endpoint.startsWith(PIPE_PREFIX), endpoint);
    // `u<8 hex>` is the user scope; see `userScope` in store/src/paths.ts.
    assert.match(
      endpoint.slice(PIPE_PREFIX.length),
      new RegExp(`^${APP}-u[0-9a-f]{8}-instance-4321-2$`),
      endpoint,
    );
  });

  it("gives two signed-in users different endpoints for the same install and key", () => {
    // The Win32 pipe namespace is machine-global and has no owner, unlike the 0700
    // XDG_RUNTIME_DIR the unix sockets live in. Without the user in the name two
    // people signed in to one machine collide — the second browser's listen fails
    // with EADDRINUSE — and any local process can take a name it can predict.
    const other = { ...windows, home: "C:\\Users\\grace" };
    assert.notEqual(
      instanceEndpointIn(appPaths(windows), windows, "1-1"),
      instanceEndpointIn(appPaths(other), other, "1-1"),
    );
  });

  it("gives the same user the same endpoint every time, so the CLI can find it", () => {
    assert.equal(
      instanceEndpointIn(appPaths(windows), windows, "1-1"),
      instanceEndpointIn(appPaths(windows), windows, "1-1"),
    );
  });

  it("is a socket file under the instances directory on unix", () => {
    const paths = appPaths(linux);
    assert.equal(
      instanceEndpointIn(paths, linux, "4321-2"),
      `/run/user/1000/${APP}/instances/4321-2.sock`,
    );
  });

  it("gives two installs different endpoints for the same key", () => {
    const other = { ...windows, appDirName: "terminal-browser-ffffffff" };
    assert.notEqual(
      instanceEndpointIn(appPaths(windows), windows, "1-1"),
      instanceEndpointIn(appPaths(other), other, "1-1"),
    );
  });
});

describe("removing an endpoint", () => {
  it("unlinks a socket path and says it did", () => {
    const file = path.join(scratch, "daemon.sock");
    fs.writeFileSync(file, "");
    assert.equal(removeEndpoint(file), true);
    assert.equal(fs.existsSync(file), false);
  });

  it("is not an error when the path was already gone", () => {
    assert.equal(removeEndpoint(path.join(scratch, "never-existed.sock")), true);
  });

  it("does nothing to a pipe, and says so rather than pretending", () => {
    // The return value is what lets a caller tell "cleaned up" from "nothing to
    // clean up". A silent `true` here would make the Windows path look handled.
    assert.equal(removeEndpoint(`${PIPE_PREFIX}${APP}-nobody-is-listening`), false);
  });
});

/**
 * Every server this file has bound and not yet closed.
 *
 * Each test closes its own in a `finally`, which covers a failed assertion but not
 * a failure that skips the block entirely — an `await` that rejects before the
 * `try`, or a `--test-timeout` firing mid-test. A pipe left listening then outlives
 * the file and the next run collides with the name it holds, so the `after` hook
 * below is the backstop.
 */
const open = new Set();
/** The same, for the child processes `busyServer` starts. */
const children = new Set();

async function close(server) {
  open.delete(server);
  await closeServer(server);
}

// The failures are asserted on, not dropped. A `closeServer` that hits its own
// deadline — a pipe a peer is still holding — is exactly the leak this file was
// fixed for, and an `after` hook that swallows it reports a clean run over a
// listening pipe.
after(async () => {
  const failures = await teardown(
    ...[...open].map((server) => () => close(server)),
    ...[...children].map((child) => () => {
      children.delete(child);
      child.kill();
    }),
  );
  assert.deepEqual(failures, [], "teardown left something open");
});

/** Listens on `endpoint` and answers every line with `{ok:true}`. */
function serve(endpoint) {
  const server = net.createServer((connection) => {
    connection.on("error", () => {});
    connection.on("data", () => connection.end('{"ok":true}\n'));
  });
  // No blanket `error` swallow here: a bind that fails is the case the callback
  // form of `listen` cannot report, and swallowing it would turn a name this suite
  // could not take into a wait with nothing to end it. `listen` subscribes to both.
  open.add(server);
  return listen(server, endpoint);
}

describe("stale-endpoint cleanup, against a real pipe", () => {
  it("reports a listening endpoint as alive and a free name as not", async () => {
    const endpoint = pipeEndpoint(APP, "test", "alive");
    assert.equal(await endpointAlive(endpoint, 500), false);
    const server = await serve(endpoint);
    try {
      assert.equal(await endpointAlive(endpoint, 500), true);
    } finally {
      await close(server);
    }
    // The name frees itself when the server goes: this is the whole reason there
    // is no `fs.rmSync` analogue to write.
    assert.equal(await endpointAlive(endpoint, 500), false);
  });

  it("frees the name for a second server once the first has closed", async () => {
    const endpoint = pipeEndpoint(APP, "test", "reuse");
    const first = await serve(endpoint);
    await close(first);
    const second = await serve(endpoint);
    try {
      assert.equal(await endpointAlive(endpoint, 500), true);
    } finally {
      await close(second);
    }
  });

  it("refuses to reclaim an endpoint someone is still listening on", async () => {
    const endpoint = pipeEndpoint(APP, "test", "held");
    const server = await serve(endpoint);
    try {
      assert.equal(await reclaimEndpoint(endpoint, 500), false);
      // and the owner is still reachable — reclaiming must not have detached it
      assert.equal(await endpointAlive(endpoint, 500), true);
    } finally {
      await close(server);
    }
  });

  it("reclaims a name nobody holds", async () => {
    assert.equal(await reclaimEndpoint(pipeEndpoint(APP, "test", "free"), 500), true);
  });

  it("reclaims a stale socket file", async () => {
    const stale = path.join(scratch, "stale.sock");
    fs.writeFileSync(stale, "");
    assert.equal(await reclaimEndpoint(stale, 500), true);
    assert.equal(fs.existsSync(stale), false);
  });

  it("leaves a live socket file to its owner, which is the change over upstream", async () => {
    // Upstream unlinked before `listen` without probing. A socket file is not the
    // server: unlinking a live one does not stop the process holding it, it just
    // makes it unreachable by name — the browser goes on running and every `ls`,
    // `new-tab` and `action` stops finding it. Probing first is the whole point of
    // `reclaimEndpoint`, and only the *stale* half of it was covered.
    //
    // Windows has no unix socket to listen on, so this asserts the rule where it
    // can be asserted and the platform decides whether it runs.
    if (process.platform === "win32") return;
    const live = path.join(scratch, "live.sock");
    const server = await serve(live);
    try {
      assert.equal(await reclaimEndpoint(live, 500), false);
      assert.equal(fs.existsSync(live), true, "a live socket file was unlinked");
      assert.equal(await endpointAlive(live, 500), true, "its owner was detached from it");
    } finally {
      await close(server);
    }
  });

  it("gives up rather than hanging when nothing answers", async () => {
    const started = Date.now();
    assert.equal(await endpointAlive(pipeEndpoint(APP, "test", "silent"), 300), false);
    assert.ok(Date.now() - started < 5_000, "the probe did not return promptly");
  });
});

/**
 * Starts `busy-pipe-server.mjs` on `endpoint` and takes up every instance it queued,
 * so the next connect has nothing to land on until its loop runs again — which it
 * will not, for as long as the child is holding it.
 */
async function busyServer(endpoint) {
  const child = spawn(process.execPath, [path.join(HERE, "busy-pipe-server.mjs"), endpoint], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.add(child);
  // Two ways this ends badly and one way it ends well: the child dies (rejects
  // immediately, naming that), the child lives but never prints (rejects on the
  // deadline), or it prints. Only the last leaves a process to clean up later, so
  // the two failures kill it here rather than leaking it into the run.
  await withDeadline(
    new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("exit", () => reject(new Error("the busy server never listened")));
    }),
    `the busy server on ${endpoint} to listen`,
  ).catch((error) => {
    children.delete(child);
    child.kill();
    throw error;
  });
  const held = [];
  for (let at = 0; at < 6; at += 1) {
    const socket = net.connect(endpoint);
    socket.on("error", () => {});
    held.push(socket);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { child, held };
}

describe("why a probe failed, which is not the same question as whether it did", () => {
  it("calls a name nobody has created `absent`", async () => {
    // The operating system refused the connect outright — `ENOENT` for a pipe name
    // that is not in the object manager, and for a socket path that is not there.
    // That is the only failure that is evidence about the owner.
    assert.equal(await endpointStatus(pipeEndpoint(APP, "test", "never-existed"), 500), "absent");
    assert.equal(await endpointStatus(path.join(scratch, "no-such.sock"), 500), "absent");
  });

  it("calls a listening endpoint `alive`", async () => {
    const endpoint = pipeEndpoint(APP, "test", "status-alive");
    const server = await serve(endpoint);
    try {
      assert.equal(await endpointStatus(endpoint, 500), "alive");
    } finally {
      await close(server);
    }
  });

  it("calls a live endpoint that ran out of budget `unknown`, not `absent`", async () => {
    // The distinction the whole type exists for, against a real browser-shaped
    // failure: a server that is *there* and not accepting. libuv arms a fixed number
    // of pipe instances with overlapped `ConnectNamedPipe`, so the kernel completes
    // the first few connects on its own; once those are spoken for, the next one
    // waits on a loop that is busy painting a frame. Collapsed into `false`, that
    // read as "gone" and `listInstances` deleted a running browser's row.
    //
    // Another process, because it cannot be staged in this one: the kernel would
    // accept for us however long our own loop is held (measured).
    if (process.platform !== "win32") return;
    const endpoint = pipeEndpoint(APP, "test", "busy");
    const { child, held } = await busyServer(endpoint);
    try {
      assert.equal(await endpointStatus(endpoint, 400), "unknown");
      // The boolean cannot tell this apart from a name nobody holds, which is why
      // the caller that deletes rows no longer uses it.
      assert.equal(await endpointAlive(endpoint, 400), false);
    } finally {
      for (const socket of held) socket.destroy();
      children.delete(child);
      child.kill();
    }
  });

  it("refuses to reclaim an endpoint whose probe was inconclusive", async () => {
    // The rule the three-state answer exists for, at the one call site that acts on
    // it destructively. A server too busy to accept inside the budget still owns its
    // name; reclaiming it would unlink a live socket on unix and, on either
    // platform, tell the caller to go ahead and bind a second server on top of a
    // browser that is running perfectly well.
    if (process.platform !== "win32") return;
    const endpoint = pipeEndpoint(APP, "test", "busy-reclaim");
    const { child, held } = await busyServer(endpoint);
    try {
      assert.equal(await endpointStatus(endpoint, 400), "unknown");
      assert.equal(await reclaimEndpoint(endpoint, 400), false);
    } finally {
      for (const socket of held) socket.destroy();
      children.delete(child);
      child.kill();
    }
  });

  it("keeps `endpointAlive` a strict yes, for the callers that only decline to act", async () => {
    // `reclaimEndpoint` must not unlink on an inconclusive probe either, so the
    // boolean stays "a connect completed" and nothing else.
    assert.equal(await endpointAlive(pipeEndpoint(APP, "test", "never-existed"), 500), false);
  });
});
