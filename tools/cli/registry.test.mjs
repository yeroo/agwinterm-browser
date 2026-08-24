// Task 13's second half: the per-browser control protocol, end to end, over a real
// named pipe on this machine.
//
// `browser/src/registry.ts` is the server and `cli/src/control.ts` is the client;
// between them sits the endpoint whose address is persisted in the instances table.
// This drives both against each other rather than reading the sources, because the
// claim being tested is behavioural: a browser listening on a pipe, a CLI reaching
// it by the string the browser wrote down, and the name freeing itself when the
// browser disposes.
//
// Both are bundled with the repo's own esbuild. `pixel-store` is *not* stubbed
// where it matters — `instanceEndpoint`, `isPipeEndpoint` and `removeEndpoint` are
// re-exported from the built package, so the naming under test is the real one —
// but `upsertInstance`/`removeInstance` are replaced with recorders, so no database
// is opened in the user's LOCALAPPDATA to run a test. `pixel-terminals` is stubbed
// down to `callerTty`, which is the only thing `registry.ts` uses from it.

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

import esbuild from "esbuild";

import { requireBuilt } from "../lib/built.mjs";
import { closeServer, listen, teardown, withDeadline } from "../lib/deadline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const STORE = requireBuilt(
  REPO,
  "store/dist/index.js",
  "store/src",
  "corepack pnpm --filter pixel-store build",
);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-registry-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// The real built package, handed to the stub through a global rather than through
// an import esbuild would have to resolve — which keeps the naming rules under test
// genuine while leaving `client.ts` (and therefore the database) out of the bundle.
const store = await import(pathToFileURL(STORE).href);
globalThis.__store = store;

const stubWorkspace = {
  name: "stub-workspace",
  setup(build) {
    build.onResolve({ filter: /^(pixel-store|pixel-terminals)$/ }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /^pixel-store$/, namespace: "stub" }, () => ({
      contents: [
        // the real naming and lifetime rules, from the built package
        `const real = globalThis.__store;`,
        `export const INSTANCES_DIR = real.INSTANCES_DIR;`,
        `export const instanceEndpoint = (...a) => real.instanceEndpoint(...a);`,
        `export const isPipeEndpoint = (...a) => real.isPipeEndpoint(...a);`,
        `export const removeEndpoint = (...a) => real.removeEndpoint(...a);`,
        `export const endpointKind = (...a) => real.endpointKind(...a);`,
        `export const reclaimEndpoint = (...a) => real.reclaimEndpoint(...a);`,
        // and a recorder in place of the database
        `export async function upsertInstance(row) { (globalThis.__rows ??= []).push(row); }`,
        `export async function removeInstance(key) { (globalThis.__removed ??= []).push(key); }`,
      ].join("\n"),
      loader: "js",
    }));
    build.onLoad({ filter: /^pixel-terminals$/, namespace: "stub" }, () => ({
      contents: `export function callerTty() { return { path: null, denied: false }; }\n`,
      loader: "js",
    }));
  },
};

async function bundle(relative, name) {
  const out = path.join(scratch, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(REPO, relative)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    plugins: [stubWorkspace],
    logLevel: "silent",
  });
  return import(pathToFileURL(out).href);
}

const { Registry } = await bundle("browser/src/registry.ts", "registry");
const { control } = await bundle("cli/src/control.ts", "control");

/** The smallest `ControlHost` the registry will accept. */
function host(key, overrides = {}) {
  return {
    key,
    tty: null,
    where: async () => ({ terminal: "agwinterm", tab: null, pane: "s1" }),
    splitDir: null,
    parentTty: null,
    state: () => ({
      url: "https://example.com",
      title: "Example",
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      findMatches: null,
      zoom: 1,
    }),
    openTab: () => 7,
    activateTab: () => true,
    closeTab: () => true,
    tabs: () => [],
    targets: async () => [{ id: 7, url: "https://example.com", title: "", active: true }],
    viewport: () => ({ width: 800, height: 600 }),
    ...overrides,
  };
}

let seq = 0;
const uniqueKey = () => `${process.pid}-t${++seq}`;

// Every registry this file constructs, so a test that throws before its own
// `dispose` cannot leave a `net.Server` listening. A live server handle keeps the
// event loop alive after the last test has reported, which `--test-timeout` can
// notice but cannot drain — the run would fail *and* hang, which is worse than the
// unbounded wait this suite was fixed for.
const opened = new Set();
after(async () => {
  const failures = await teardown(...[...opened].map((registry) => () => registry.dispose()));
  assert.deepEqual(failures, [], "a registry would not dispose");
});

/** A registry tracked for teardown, bound within a deadline. */
async function openRegistry(key, overrides = {}) {
  const registry = new Registry(host(key, overrides));
  opened.add(registry);
  // Binding is asynchronous: the endpoint is probed before it is taken, and the
  // row is written only once `listen` has actually succeeded, so that nothing
  // advertises a control channel it does not have. `ready` is that moment.
  //
  // Bounded, because a bind that never completes is the one thing this whole file
  // is downstream of: an unbounded `await` here hangs before a single assertion
  // has run, and the failure would name the file rather than the pipe. Tracked
  // *before* the wait, because the bind that will not finish is exactly the one
  // whose server has to be closed by the `after` hook.
  await withDeadline(registry.ready, `the registry for ${key} to bind`);
  return registry;
}

/** Disposes a registry and stops tracking it. Idempotent, as `dispose` is. */
function disposeRegistry(registry) {
  opened.delete(registry);
  registry.dispose();
}

/** Opens a registry and guarantees it is disposed even if an assertion throws. */
async function withRegistry(fn, overrides = {}) {
  const key = uniqueKey();
  const registry = await openRegistry(key, overrides);
  try {
    return await fn(registry, key);
  } finally {
    disposeRegistry(registry);
  }
}

describe("where a browser listens", () => {
  it("records the endpoint the shared abstraction chose, not a path it built", async () => {
    await withRegistry((registry, key) => {
      assert.equal(registry.record().endpoint, store.instanceEndpoint(key));
    });
  });

  it("is a named pipe on Windows, so nothing appears under the instances directory", async () => {
    if (process.platform !== "win32") return;
    await withRegistry((registry) => {
      const endpoint = registry.record().endpoint;
      assert.equal(store.isPipeEndpoint(endpoint), true);
      // Upstream created INSTANCES_DIR unconditionally to hold the socket file.
      // With no file to hold, creating it would be a directory that never fills.
      assert.equal(fs.existsSync(path.join(store.INSTANCES_DIR, `${registry.record().key}.sock`)), false);
    });
  });

  it("writes a row carrying that endpoint, so the CLI can find it", async () => {
    globalThis.__rows = [];
    await withRegistry((registry, key) => {
      const row = globalThis.__rows.find((entry) => entry.key === key);
      assert.ok(row, "no row was written");
      assert.equal(row.endpoint, registry.record().endpoint);
      assert.equal(row.pid, process.pid);
    });
  });
});

describe("the control protocol over that endpoint", () => {
  it("answers `state` with the row the CLI would have read", async () => {
    await withRegistry(async (registry) => {
      const reply = await control(registry.record().endpoint, { cmd: "state" }, 4000);
      assert.equal(reply.url, "https://example.com");
      assert.equal(reply.endpoint, registry.record().endpoint);
    });
  });

  it("answers `where`, which is what `ls` uses to place a browser", async () => {
    await withRegistry(async (registry) => {
      const reply = await control(registry.record().endpoint, { cmd: "where" }, 4000);
      assert.deepEqual(reply, { terminal: "agwinterm", tab: null, pane: "s1" });
    });
  });

  it("answers `open-tab` with the new tab id and the target list", async () => {
    await withRegistry(async (registry) => {
      const reply = await control(
        registry.record().endpoint,
        { cmd: "open-tab", url: "https://example.org" },
        4000,
      );
      assert.equal(reply.openedTab, 7);
      assert.equal(reply.tabs.length, 1);
    });
  });

  it("rejects an unknown command as an error rather than hanging", async () => {
    await withRegistry(async (registry) => {
      await assert.rejects(
        () => control(registry.record().endpoint, { cmd: "nonsense" }, 4000),
        /unknown command: nonsense/,
      );
    });
  });

  it("reports a browser-side refusal as the browser worded it", async () => {
    await withRegistry(async (registry) => {
      await assert.rejects(
        () => control(registry.record().endpoint, { cmd: "activate-tab" }, 4000),
        /activate-tab needs a tab id/,
      );
    });
  });

  it("serves several requests, each on its own connection", async () => {
    await withRegistry(async (registry) => {
      const endpoint = registry.record().endpoint;
      const replies = await Promise.all([
        control(endpoint, { cmd: "state" }, 4000),
        control(endpoint, { cmd: "state" }, 4000),
        control(endpoint, { cmd: "targets" }, 4000),
      ]);
      assert.equal(replies.length, 3);
      for (const reply of replies) assert.equal(reply.endpoint, endpoint);
    });
  });
});

describe("disposal", () => {
  it("stops answering, and frees the name", async () => {
    const key = uniqueKey();
    const registry = await openRegistry(key);
    const endpoint = registry.record().endpoint;
    assert.equal(await store.endpointAlive(endpoint, 1000), true);
    disposeRegistry(registry);
    assert.equal(await store.endpointAlive(endpoint, 1000), false);
    // and the name is free for the next browser with the same key
    const again = await openRegistry(key);
    try {
      assert.equal(await store.endpointAlive(endpoint, 1000), true);
    } finally {
      disposeRegistry(again);
    }
  });

  it("drops its row on the way out", async () => {
    globalThis.__removed = [];
    const key = uniqueKey();
    const registry = await openRegistry(key);
    disposeRegistry(registry);
    assert.ok(globalThis.__removed.includes(key), "the row was not removed");
  });

  it("is idempotent, so a second close is not an error", async () => {
    const key = uniqueKey();
    const registry = await openRegistry(key);
    disposeRegistry(registry);
    registry.dispose();
  });
});

describe("a CLI reaching an endpoint nobody holds", () => {
  it("fails rather than hanging when the browser is gone", async () => {
    const endpoint = store.pipeEndpoint("winterm-test", "no-such-browser");
    await assert.rejects(() => control(endpoint, { cmd: "state" }, 2000));
  });

  it("times out with a message naming what it could not reach", async () => {
    // A server that accepts and never answers is the case a stale row produces
    // when the pid was reused by something else that listens.
    const endpoint = store.pipeEndpoint("winterm-test", `mute-${process.pid}`);
    const accepted = [];
    const server = net.createServer((connection) => {
      connection.on("error", () => {});
      accepted.push(connection);
    });
    await listen(server, endpoint);
    try {
      await assert.rejects(
        () => control(endpoint, { cmd: "state" }, 300),
        (error) => error.message.includes("timed out") && error.message.includes("named pipe"),
      );
    } finally {
      for (const connection of accepted) connection.destroy();
      await closeServer(server);
    }
  });
});
