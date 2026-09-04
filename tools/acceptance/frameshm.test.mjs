// `image.frameshm` against a live agwinterm: the fast path where the host has it,
// and the file path — latched, and explained when asked for — where it does not.
//
// Everything below the pipe is covered in-process: `frame_shm.rs` tests the mapping
// by opening it back with `OpenFileMappingW`, and `frame_file.rs` tests the request,
// the latch and the refusal count against a recording fake host. What none of that
// can say is whether a *real* agwinterm opens the mapping this producer created and
// places the pixels it finds there — which is the claim the plan makes, and a claim
// about two processes, a kernel object and a pipe. So this suite runs the shipped
// CLI in a session it asks the host to create, and reads what came out: the budget
// file the engine writes (`TERMINAL_BROWSER_FRAME_BUDGET`), the marker the publisher
// leaves on the first accepted placement (`FrameDir::mark_pane`), and the log the
// CLI gives the browser as fd 2.
//
// **Which host.** The verb is on agwinterm `main` from `8230d0e` and in no release
// as of 2026-09-03, so the installed release answers `unknown command` — and so does
// agliteterm, by design. The suite probes first, with a request the host refuses
// before it touches anything, and the capable-host cases skip with the reason when
// the verb is absent. The fallback case needs the *opposite* host and skips on a
// capable one. CI has no host at all and skips everything; a pane of a dev instance
// (`AGWINTERM_PIPE=agwinterm-dev`, agwinterm's README) runs the capable half.
//
// **Whose pane.** Unlike `pane-clear.test.mjs`, this suite *does* address the real
// host — that is the point — but never the pane it runs in. Every browser goes into
// a session this file asks the host to create (`session.new`, `no-select` so focus
// stays where it was) and closes afterwards, and `TERMINAL_BROWSER_ALLOW_PIPE` names
// that host explicitly so the engine's development guard lets the frames through.
// `TEMP` and `LOCALAPPDATA` are moved into the test's own root, so the frame
// directory, the budget file and the log are the test's to read and to delete.
//
// **Every wait is bounded** through `tools/lib/deadline.mjs`. Electron's cold start
// is the long one and gets `LAUNCH_MS`; a host that stops answering costs one
// `control` deadline, not the run.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { requireBuilt } from "../lib/built.mjs";
import { PIPE_PREFIX } from "../lib/control-host.mjs";
import { settlesWithin, teardown, withDeadline } from "../lib/deadline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

/** The page the milestone was brought up on: static, so every frame is the same. */
const PAGE = pathToFileURL(path.join(REPO, "tools", "milestone", "static-page.html")).href;

/** The plan's wording, so a skipped run says what would un-skip it. */
const LACKS_VERB = "host lacks image.frameshm (agwinterm main ≥ 8230d0e required)";

/** How long a session's browser gets to start, place three frames and log them. */
const LAUNCH_MS = 90_000;
/** How long one control-pipe exchange gets. */
const CONTROL_MS = 5_000;
/** How long a closed session's browser gets to go down before it is killed. */
const EXIT_MS = 15_000;

/**
 * The host, as the pane names it. Both variables are the ones `HostTarget::from_env`
 * reads; CI sets neither and the whole suite skips.
 */
const HOST =
  process.env.AGWINTERM_ENABLED === "1" && process.env.AGWINTERM_PIPE?.trim()
    ? process.env.AGWINTERM_PIPE.trim()
    : null;

/**
 * The target the probe names. This pane's own session where there is one — the
 * request is refused before the host touches the session, so nothing is drawn or
 * cleared on it — and `active` otherwise, which the host resolves and the CLI
 * refuses, for the same reason.
 */
const PROBE_TARGET = process.env.AGWINTERM_SESSION_ID?.trim() || "active";

// The escapes and names the browser leaves behind, from the same build the
// sessions run rather than copied; `tools/cli/pane-clear.test.mjs` pins them to
// the Rust. `cli/dist/pane.js` imports only node builtins.
const { FRAME_DIR_PREFIX, FRAME_PANE_FILE } = createRequire(import.meta.url)(
  path.join(REPO, "cli", "dist", "pane.js"),
);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-frameshm-"));
// Retried for the reason `launch`'s own teardown gives: a CLI still closing its
// database is the last thing to let go of a session's root.
after(() => {
  if (keep) return;
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
});

/**
 * The three artifacts a session runs, checked for staleness only once a host is
 * known to be there: a CI runner with no host has nothing to be stale *for*, and
 * `requireBuilt` throws rather than skips. The list under `pixel.node` is
 * `tools/vendor-check/native-build.test.mjs`'s, which owns it.
 */
function requireArtifacts() {
  const build = "corepack pnpm -r build";
  requireBuilt(REPO, "cli/dist/main.js", "cli/src", build);
  requireBuilt(REPO, "store/dist/index.js", "store/src", build);
  requireBuilt(REPO, "browser/dist/main.js", "browser/src", build);
  requireBuilt(
    REPO,
    "engine/packages/pixel-react/native/pixel.node",
    "engine/crates",
    "corepack pnpm --filter pixel-react build:native",
    [
      "engine/Cargo.toml",
      "engine/Cargo.lock",
      "engine/rust-toolchain.toml",
      "engine/assets/fonts/InterVariable.ttf",
      "engine/assets/fonts/JetBrainsMono-Regular.ttf",
      "engine/packages/pixel-react/scripts/build-native.mjs",
    ],
  );
}

// -- the control pipe ---------------------------------------------------------

/**
 * One request, one reply, on a connection of its own — the protocol as
 * `ControlClient::send` speaks it.
 *
 * A connect that fails is retried until the deadline: agwinterm serves one client
 * per pipe instance and creates the next instance only after the previous one
 * closed, so a connect that lands in that gap fails with `ENOENT` and a busy host
 * with `EBUSY`, and neither means the host is gone. A host that *is* gone costs the
 * full deadline and rejects with the last error, which the caller reads as "no
 * host" rather than as a failure.
 */
async function control(pipe, request, ms = CONTROL_MS) {
  const endpoint = PIPE_PREFIX + pipe;
  const until = Date.now() + ms;
  let last = null;
  for (;;) {
    try {
      return await withDeadline(exchange(endpoint, request), `${request.cmd} on ${pipe}`, ms);
    } catch (error) {
      last = error;
      if (!/^E[A-Z]+$/.test(error.code ?? "") || Date.now() >= until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function exchange(endpoint, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, at)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
    socket.once("close", () => reject(new Error(`${endpoint} closed before it answered`)));
  });
}

/**
 * Whether the host has the verb, decided by a request it refuses before it opens
 * anything: a name outside `Local\agwinterm-frame-` fails validation on a capable
 * host, and the dispatch on an older one — "unknown command" is the *only* answer
 * that means the verb is absent, which is `is_unknown_command`'s reading too.
 * `no session` says nothing about the verb: the host resolves the target before it
 * dispatches anything (`ControlServer.cs`), so it is every verb's answer to a
 * target the host does not have, and a probe that ends there is thrown rather than
 * read either way.
 */
async function probe(pipe) {
  const request = (target) => ({
    cmd: "image.frameshm",
    target,
    args: {
      images: [
        {
          id: 1,
          name: "not-a-mapping",
          slot: 0,
          seq: 0,
          width: 1,
          height: 1,
          stride: 4,
          format: 32,
          row: 0,
          col: 0,
          cols: 1,
          rows: 1,
        },
      ],
    },
  });
  let reply = await control(pipe, request(PROBE_TARGET));
  // A host that resolves the target before it dispatches answers `no session` for
  // *any* verb when the target is not its own — which is the case when the pipe
  // was pointed at another instance than the pane's. Ask again about the session
  // it does have, so the answer is about the verb.
  if (String(reply.error ?? "").trim() === "no session" && PROBE_TARGET !== "active") {
    reply = await control(pipe, request("active"));
  }
  assert.equal(reply.ok, false, `the host accepted a mapping outside the contract's prefix: ${JSON.stringify(reply)}`);
  const error = String(reply.error ?? "").trim();
  if (error === "no session") {
    throw new Error(
      `${pipe} resolves neither ${PROBE_TARGET} nor an active session, so its answer says nothing about image.frameshm; run this from a pane of that instance`,
    );
  }
  return { capable: !error.startsWith("unknown command"), error };
}

// -- the host, once ----------------------------------------------------------------

/** `null` until `before` ran; then `{ pipe, capable, error }` or `{ skip }`. */
let host = null;

before(async () => {
  if (process.platform !== "win32") {
    host = { skip: "the fast path is Windows-only (a named mapping under Local\\)" };
    return;
  }
  if (!HOST) {
    host = { skip: "no agwinterm host: AGWINTERM_ENABLED/AGWINTERM_PIPE are unset (CI)" };
    return;
  }
  try {
    host = { pipe: HOST, ...(await probe(HOST)) };
  } catch (error) {
    host = { skip: `AGWINTERM_PIPE=${HOST} could not be probed: ${error.message}` };
  }
});

// -- a browser in a session of its own -------------------------------------------

const strays = [];
after(async () => {
  const failures = await teardown(...strays.map((pid) => () => forceKill(pid)));
  assert.deepEqual(failures, [], "a browser of this suite would not die");
});

/** `taskkill /F /T`, which runs no destructor; the session's console is gone anyway. */
function forceKill(pid) {
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { timeout: 15_000, stdio: "ignore" });
  } catch {
    // Already gone, which is the state the caller wanted.
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

/**
 * The launcher a session runs: the environment `paneEnv` builds by hand in
 * `pane-clear.test.mjs`, spelled as a batch file because the host starts the
 * session's command in a fresh console and the variables have to be set *inside*
 * it. Everything the pane itself provides (`AGWINTERM_*`) is left to the pane.
 *
 * `transport` is the value for `TERMINAL_BROWSER_FRAME_TRANSPORT`; `null` clears it,
 * which is `auto`. The CLI is run rather than Electron directly, because the CLI is
 * what gives the browser its log file as fd 2 and clears the pane after it.
 */
function writeLauncher(root, pipe, transport) {
  const set = (name, value) => `set "${name}=${value ?? ""}"`;
  const lines = [
    "@echo off",
    set("TEMP", root),
    set("TMP", root),
    set("LOCALAPPDATA", path.join(root, "state")),
    set("TERMINAL_BROWSER_ALLOW_PIPE", pipe),
    set("TERMINAL_BROWSER_FRAME_BUDGET", path.join(root, "budget.tsv")),
    set("TERMINAL_BROWSER_FRAME_TRANSPORT", transport),
    `"${process.execPath}" "${path.join(REPO, "cli", "dist", "main.js")}" open "${PAGE}"`,
    "",
  ];
  const file = path.join(root, "launch.cmd");
  fs.writeFileSync(file, lines.join("\r\n"));
  return file;
}

/** The budget file's data rows, as arrays of columns; `[]` until there are any. */
function budgetRows(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, "budget.tsv"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split("\t"));
}

/** `transport` is the eighth column, appended after the seven the baseline had. */
const TRANSPORT_COLUMN = 7;

/** The publisher's frame directory under the session's `TEMP`, if it has made one. */
function frameDir(root) {
  const found = fs.readdirSync(root).filter((name) => name.startsWith(FRAME_DIR_PREFIX));
  return found.length > 0 ? path.join(root, found[0]) : null;
}

/** The pid in a frame directory's name, `terminal-browser-frames-<pid>-<n>`. */
function browserPid(root) {
  const dir = frameDir(root);
  if (!dir) return null;
  const match = /-(\d+)-\d+$/.exec(path.basename(dir));
  return match ? Number.parseInt(match[1], 10) : null;
}

/** The CLI's `stderr.log`, wherever `LOGS_DIR` put it under the session's `LOCALAPPDATA`. */
function stderrLog(root) {
  const state = path.join(root, "state");
  let apps;
  try {
    apps = fs.readdirSync(state).filter((name) => name.startsWith("terminal-browser"));
  } catch {
    return "";
  }
  for (const app of apps) {
    try {
      return fs.readFileSync(path.join(state, app, "logs", "stderr.log"), "utf8");
    } catch {
      // Not written yet.
    }
  }
  return "";
}

/** What the pane shows, for a failure message; never for an assertion. */
async function paneText(pipe, session) {
  try {
    const reply = await control(pipe, { cmd: "session.text", target: session });
    return String(reply.result ?? reply.error ?? "");
  } catch (error) {
    return `(session.text failed: ${error.message})`;
  }
}

/**
 * Starts the browser in a fresh session and resolves once its budget file has
 * `rows` data rows — which is `rows` frames the host answered, since a row is
 * written only past the `frame:0/0` guard. The session is closed and the browser
 * reaped in `t.after`, whether or not the test passed.
 */
async function launch(t, { transport, rows = 3 }) {
  const { pipe } = host;
  const root = fs.mkdtempSync(path.join(scratch, `${transport ?? "auto"}-`));
  const launcher = writeLauncher(root, pipe, transport);

  const created = await control(pipe, {
    cmd: "session.new",
    args: {
      name: `winterm-browser frameshm (${transport ?? "auto"})`,
      cwd: REPO,
      command: `cmd.exe /c "${launcher}"`,
      "no-select": true,
    },
  });
  assert.equal(created.ok, true, `session.new refused: ${JSON.stringify(created)}`);
  const session = String(created.result);

  t.after(async () => {
    const pid = browserPid(root);
    if (pid) strays.push(pid);
    await control(pipe, { cmd: "session.close", target: session }).catch(() => {});
    if (pid) {
      // The closed console delivers SIGHUP to the CLI and the browser, and the
      // browser's `stop` runs `Session.shutdown` — the engine's `Drop` clears the
      // placement. Given that a bounded chance; then the hammer.
      await settlesWithin(() => !alive(pid), "the browser to leave with its session", EXIT_MS).catch(
        () => forceKill(pid),
      );
    }
    // The CLI outlives the browser by the time its `clearOwnedPaneFrame` takes,
    // and holds the store's database open until then; `EBUSY` on the way out is
    // that, not a leak. Retried across a bounded window rather than failing the
    // test that passed — and left behind rather than hung on, if it never frees.
    if (!keep) fs.rmSync(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  });

  // `session.new` answers with the id before the session exists — the host creates
  // it on its UI thread. Wait for it to be addressable before waiting on anything
  // it does, so a `no session` here is told apart from a browser that never drew.
  await withDeadline(
    (async () => {
      for (;;) {
        const reply = await control(pipe, { cmd: "session.text", target: session, args: { lines: 1 } });
        if (reply.ok) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })(),
    `session ${session} to be addressable`,
    CONTROL_MS,
  );

  try {
    await settlesWithin(
      () => budgetRows(root).length >= rows,
      `${rows} budget rows from the browser in session ${session}`,
      LAUNCH_MS,
      250,
    );
  } catch (error) {
    // Everything a reader needs to tell "Electron never started" from "the engine
    // drew into a pane with no room" from "the host refused every frame": the
    // pane's text, the browser's log, and what the browser left in its root.
    const log = stderrLog(root);
    const left = fs.readdirSync(root, { recursive: true }).filter((name) => !name.startsWith("state"));
    keep = true;
    throw new Error(
      `${error.message}\n--- pane ---\n${await paneText(pipe, session)}\n--- ${root} ---\n${left.join("\n")}\n--- stderr.log ---\n${log.slice(-4000)}`,
    );
  }
  return { root, session, pipe };
}

/**
 * Set on a launch that failed, so its root — the budget file, the frame directory
 * and the log — is left on disk for the reader the message is addressed to. The
 * message names the path.
 */
let keep = false;

/** The placement, as the publisher records it: the pipe and the pane it went to. */
function assertPlaced(run) {
  const dir = frameDir(run.root);
  assert.ok(dir, `no frame directory under ${run.root}, so no publisher ran`);
  const marker = fs.readFileSync(path.join(dir, FRAME_PANE_FILE), "utf8");
  // The first pane of a session shares the session's id, which is what the pane
  // exports as `AGWINTERM_SESSION_ID` and the engine records.
  assert.equal(
    marker,
    `${run.pipe}\n${run.session}\n`,
    "the publisher's marker does not name this host and session — the first accepted frame went elsewhere",
  );
}

// -- the cases -------------------------------------------------------------------

describe("the host", () => {
  it("was probed with a request it refuses before opening anything", (t) => {
    if (host.skip) return t.skip(host.skip);
    assert.ok(host.error.length > 0, "the probe got a refusal with no message");
    if (host.capable) {
      // A validation refusal names the verb: the host dispatched `image.frameshm`.
      assert.ok(host.error.startsWith("image.frameshm"), `not a refusal image.frameshm gives: ${host.error}`);
    } else {
      assert.equal(host.error, "unknown command 'image.frameshm'");
    }
  });
});

describe("a host with image.frameshm", () => {
  it("carries every frame over the mapping, and the pane holds the placement", async (t) => {
    if (host.skip) return t.skip(host.skip);
    if (!host.capable) return t.skip(LACKS_VERB);
    requireArtifacts();
    const run = await launch(t, { transport: null });
    const rows = budgetRows(run.root);
    assert.ok(rows.length >= 3, `${rows.length} rows`);
    assert.deepEqual(
      rows.map((row) => row[TRANSPORT_COLUMN]),
      rows.map(() => "shm"),
      `a frame went out over the file on a host that has the fast path:\n${rows.map((r) => r.join("\t")).join("\n")}`,
    );
    assertPlaced(run);
    // No frame was refused and resent: a fast path that works is one the log is
    // silent about (`FramePublisher::refused` is the warning it would carry).
    const log = stderrLog(run.root);
    assert.ok(!log.includes("did not carry this frame"), `the host refused a frame:\n${log.slice(-2000)}`);
  });

  it("still takes the file path when TERMINAL_BROWSER_FRAME_TRANSPORT=file, so the baseline stays measurable", async (t) => {
    if (host.skip) return t.skip(host.skip);
    if (!host.capable) return t.skip(LACKS_VERB);
    requireArtifacts();
    const run = await launch(t, { transport: "file" });
    const rows = budgetRows(run.root);
    assert.deepEqual(
      rows.map((row) => row[TRANSPORT_COLUMN]),
      rows.map(() => "file"),
      `a frame took the fast path under transport=file:\n${rows.map((r) => r.join("\t")).join("\n")}`,
    );
    assertPlaced(run);
    // The file path's evidence is on disk: the PNGs the host was pointed at, kept
    // to the publisher's retention.
    const pngs = fs.readdirSync(frameDir(run.root)).filter((name) => /^frame-\d+\.png$/.test(name));
    assert.ok(pngs.length >= 1, "transport=file wrote no PNG, so what did the host read?");
    // And no explanation: `file` asked for nothing it did not get.
    const log = stderrLog(run.root);
    assert.ok(!log.includes("image.frameshm"), `the file path was apologised for:\n${log.slice(-2000)}`);
  });
});

describe("a host without image.frameshm", () => {
  it("shows the page over the file path when shm was asked for, and says why exactly once", async (t) => {
    if (host.skip) return t.skip(host.skip);
    if (host.capable) {
      return t.skip(
        `${host.pipe} has image.frameshm; the fallback needs a host without it (every release as of 2026-09)`,
      );
    }
    requireArtifacts();
    const run = await launch(t, { transport: "shm" });
    const rows = budgetRows(run.root);
    assert.deepEqual(
      rows.map((row) => row[TRANSPORT_COLUMN]),
      rows.map(() => "file"),
      `a row says shm on a host that answered unknown command:\n${rows.map((r) => r.join("\t")).join("\n")}`,
    );
    assertPlaced(run);
    // `Transport::unavailable_reason`, forwarded by `browser/src/engine-log.ts` to
    // the fd 2 the CLI gave the browser. Once: the latch is per session, and the
    // first frame's reply is what set it. The wait is for the file, not the
    // warning — the warning was logged before the first row was, and the file is
    // appended to from another process.
    const said = "asked for `image.frameshm`, which this host does not implement";
    await settlesWithin(() => stderrLog(run.root).includes(said), "the explanation to reach stderr.log", CONTROL_MS);
    const log = stderrLog(run.root);
    const times = log.split(said).length - 1;
    assert.equal(times, 1, `the explanation was given ${times} times:\n${log.slice(-3000)}`);
    assert.match(log, /engine warn agwinterm: TERMINAL_BROWSER_FRAME_TRANSPORT=shm asked for/);
  });
});
