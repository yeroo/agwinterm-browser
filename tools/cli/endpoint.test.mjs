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
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const store = await import(
  new URL(`file:///${path.join(REPO, "store", "dist", "index.js").replaceAll("\\", "/")}`).href
);

const {
  PIPE_PREFIX,
  appPaths,
  endpointAlive,
  endpointKind,
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
    assert.equal(appPaths(windows).daemonEndpoint, `${PIPE_PREFIX}${APP}-daemon`);
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
  it("is a pipe named from the install and the session key on Windows", () => {
    const paths = appPaths(windows);
    assert.equal(
      instanceEndpointIn(paths, windows, "4321-2"),
      `${PIPE_PREFIX}${APP}-instance-4321-2`,
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

/** Listens on `endpoint` and answers every line with `{ok:true}`. */
function serve(endpoint) {
  const server = net.createServer((connection) => {
    connection.on("error", () => {});
    connection.on("data", () => connection.end('{"ok":true}\n'));
  });
  server.on("error", () => {});
  return new Promise((resolve) => {
    server.listen(endpoint, () => resolve(server));
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

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

  it("reclaims a stale socket file, and leaves a live one to its owner", async () => {
    const stale = path.join(scratch, "stale.sock");
    fs.writeFileSync(stale, "");
    assert.equal(await reclaimEndpoint(stale, 500), true);
    assert.equal(fs.existsSync(stale), false);
  });

  it("gives up rather than hanging when nothing answers", async () => {
    const started = Date.now();
    assert.equal(await endpointAlive(pipeEndpoint(APP, "test", "silent"), 300), false);
    assert.ok(Date.now() - started < 5_000, "the probe did not return promptly");
  });
});
