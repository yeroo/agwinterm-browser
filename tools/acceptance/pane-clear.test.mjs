// The plan's acceptance criteria, run against the shipped CLI rather than its parts.
//
// `tools/cli/pane-clear.test.mjs` checks the recovery mechanism function by function:
// what `paneClearRequest` addresses, what `ownedFrames` recognises, what
// `paneClearReport` says. Every one of those is in-process, and every one of them
// would still pass if `cli/dist/main.js` never reached them — a verb that throws on
// an import, a dispatch that runs the sandbox check first, a build that is not the
// source. What the plan asks for here is the other question: *kill a browser and run
// one command*, which is a claim about a process, a real pipe and the bytes between
// them.
//
// So this suite spawns `node cli/dist/main.js pane-clear` and reads what came out.
// The browser it recovers from is a real process that plants a publisher's frame
// directory and is then killed with `taskkill /F`, which runs no destructor — the
// exit the whole mechanism exists for, reproduced rather than simulated.
//
// The one part that stays manual is the eye: whether the pane *looks* right
// afterwards. What can be checked is that the bytes which make it look right were
// written, and they are asserted here against the same `DISABLE_REPORTING` the
// engine's `ModeGuard::drop` sends.
//
// **Nothing here may address a real agwinterm.** The wreck this plan exists to fix was
// a dev build publishing into the machine's live terminal, and a test that inherited
// `AGWINTERM_PIPE` from the pane it runs in would recreate it — clearing a working
// pane on the way past. Every child gets a scrubbed environment naming a pipe this
// file bound itself, and `TERMINAL_BROWSER_ALLOW_PIPE` is set on top of that so a
// leak is refused rather than delivered.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { requireBuilt } from "../lib/built.mjs";
import { hostOn } from "../lib/control-host.mjs";
import { teardown, withDeadline } from "../lib/deadline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

// The built CLI, and the built package it loads before it can dispatch anything.
// Either being stale would make this suite pass against yesterday's recovery verb,
// which is the failure `built.mjs` exists to name.
const CLI = requireBuilt(REPO, "cli/dist/main.js", "cli/src", "corepack pnpm -r build");
requireBuilt(REPO, "store/dist/index.js", "store/src", "corepack pnpm -r build");

// The escapes the verb owes the console, taken from the same build the children run
// rather than copied — `cli/dist/pane.js` imports only node builtins, so it loads
// here as-is. `tools/cli/pane-clear.test.mjs` is what pins it to the Rust.
const { DISABLE_REPORTING, FRAME_DIR_PREFIX, FRAME_PANE_FILE } = createRequire(import.meta.url)(
  path.join(REPO, "cli", "dist", "pane.js"),
);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-accept-"));
const strays = [];
after(async () => {
  const failures = await teardown(...strays.map((pid) => () => forceKill(pid, { tree: true })));
  fs.rmSync(scratch, { recursive: true, force: true });
  assert.deepEqual(failures, [], "a child of this suite would not die");
});

/** How long a child of this suite gets before it is a hang rather than a run. */
const CHILD_MS = 30_000;

/** A frame root of its own per test, so one test's wreck is not another's. */
function freshRoot(t, tag) {
  const root = fs.mkdtempSync(path.join(scratch, `${tag}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * The environment a pane hands a browser, with every inherited agwinterm variable
 * taken back out first.
 *
 * `TEMP`/`TMP` move `os.tmpdir()` — which is where the CLI looks for a publisher's
 * leftovers — into the test's own root, and `LOCALAPPDATA` moves the instance
 * registry into an empty directory, which is the "no instance registered" half of
 * the criterion rather than an assumption about the machine.
 */
function paneEnv({ root, pipe, session = "s-accept", window = null, allow = pipe }) {
  const base = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("AGWINTERM_") || key.startsWith("TERMINAL_BROWSER_")) continue;
    base[key] = value;
  }
  const env = {
    ...base,
    TEMP: root,
    TMP: root,
    LOCALAPPDATA: path.join(root, "state"),
    AGWINTERM_ENABLED: "1",
    AGWINTERM_SESSION_ID: session,
    TERMINAL_BROWSER_ALLOW_PIPE: allow,
  };
  if (pipe !== null) env.AGWINTERM_PIPE = pipe;
  if (window) env.AGWINTERM_WINDOW_ID = window;
  return env;
}

/** `Stop-Process -Force`, which is `taskkill /F` and runs no destructor. */
function forceKill(pid, { tree = false } = {}) {
  try {
    if (process.platform === "win32") {
      const args = ["/F", ...(tree ? ["/T"] : []), "/PID", String(pid)];
      execFileSync("taskkill", args, { timeout: 15_000, stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Already gone, which is the state the caller wanted.
  }
}

/** Whether `pid` is still a process we can see. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Resolves once `predicate()` holds, and rejects at the deadline rather than
 * spinning forever.
 *
 * A process a job object is tearing down does not die on the same tick its parent
 * does, so this is a wait on a state with no event behind it. Bounded like every
 * other wait in the tree — `tools/lib/deadline.mjs` is why.
 */
async function settles(predicate, what, ms = CHILD_MS) {
  const until = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= until) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Runs one node script as a child and resolves once it has printed `ready`. */
async function launch(t, source, { env = process.env, ready = "ready" } = {}) {
  const child = spawn(process.execPath, ["-e", source], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  strays.push(child.pid);
  t.after(() => forceKill(child.pid, { tree: true }));
  let out = "";
  child.stdout.setEncoding("utf8");
  const said = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes(ready)) resolve(out);
    });
    child.once("exit", (code) => reject(new Error(`child exited ${code} before ${ready}: ${out}`)));
    child.once("error", reject);
  });
  await withDeadline(said, `the child to say ${ready}`, CHILD_MS);
  return { child, out };
}

/**
 * A browser: it creates the publisher's frame directory, writes a frame into it and
 * then stays up. `FrameDir`'s `Drop` would remove that directory on an ordinary
 * quit, so killing this process is what leaves the pane holding a picture nobody
 * owns any more.
 */
const BROWSER = `
  const fs = require("node:fs"), path = require("node:path");
  const dir = path.join(process.env.TEMP, "${FRAME_DIR_PREFIX}" + process.pid + "-0");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "frame-00000000.png"), "");
  // FrameDir::mark_pane: the pipe, then the session id. The engine writes it with the
  // first frame the host takes, and it is what tells this pane's wreck from another
  // pane's — without it pane-clear rightly declines to adopt these frames at all.
  fs.writeFileSync(
    path.join(dir, "${FRAME_PANE_FILE}"),
    (process.env.AGWINTERM_PIPE || "agwinterm") + "\\n" + process.env.AGWINTERM_SESSION_ID + "\\n",
  );
  process.stdout.write("drew " + process.pid + "\\n");
  setInterval(() => {}, 1000);
`;

/** A CLI: it starts the browser above and waits on it, the way `openInForeground` does. */
const CLI_WRAPPER = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(BROWSER)}], {
    env: process.env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
  });
  child.on("exit", () => process.exit(0));
  setInterval(() => {}, 1000);
`;

/** Runs the built CLI's recovery verb, and never waits on it forever. */
async function paneClear(env) {
  const child = spawn(process.execPath, [CLI, "pane-clear"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const started = Date.now();
  let code;
  try {
    [code] = await withDeadline(once(child, "exit"), "pane-clear to exit", CHILD_MS);
  } catch (error) {
    // A recovery command that hangs is the defect, not a slow machine: leave nothing
    // running behind the failure.
    forceKill(child.pid, { tree: true });
    throw error;
  }
  return { code, stdout, stderr, ms: Date.now() - started };
}

/** The `image.clear` lines a host was sent, parsed. */
const clears = (host) => host.lines.map((line) => JSON.parse(line));

describe("a browser killed with Stop-Process -Force", () => {
  it("is given back by one pane-clear: the picture comes off and the console returns", async (t) => {
    const root = freshRoot(t, "killed-browser");
    const env = paneEnv({ root, pipe: `winterm-accept-${process.pid}-killed`, window: "w-1" });
    const host = hostOn(env.AGWINTERM_PIPE);
    t.after(() => host.close());
    await host.listening;

    const { child } = await launch(t, BROWSER, { env, ready: "drew " });
    forceKill(child.pid);
    await withDeadline(once(child, "exit"), "the killed browser to be reaped", CHILD_MS);

    // The precondition, asserted rather than assumed: a force-kill runs no
    // destructor, so the frame directory is still there with a frame in it. If this
    // fails the rest of the test is checking recovery from a pane that was never wrecked.
    const left = fs.readdirSync(root).filter((name) => name.startsWith(FRAME_DIR_PREFIX));
    assert.equal(left.length, 1, `the killed browser left no frame directory in ${root}`);
    assert.ok(
      fs.readdirSync(path.join(root, left[0])).includes("frame-00000000.png"),
      "the frame directory survived without the frame in it",
    );

    const run = await paneClear(env);
    assert.equal(run.code, 0, `pane-clear exited ${run.code}: ${run.stderr}`);
    assert.deepEqual(
      clears(host),
      [{ cmd: "image.clear", target: "s-accept", window: "w-1" }],
      "the host was not sent exactly one clear for this pane",
    );
    assert.ok(
      run.stdout.includes(DISABLE_REPORTING),
      "the console half was skipped — mouse reporting would still be on",
    );
    assert.match(run.stdout, /frame:\s+cleared/, run.stdout);
    assert.match(run.stdout, /console: mouse reporting off/, run.stdout);
  });
});

describe("a CLI killed rather than the browser", () => {
  it("is the case the exit path cannot cover, and pane-clear covers it", async (t) => {
    // `openInForeground` clears the pane because it outlives the browser. Kill *it*
    // and nothing does — and on Windows the browser goes with it: libuv puts a child
    // spawned without `detached` into a job object that terminates when the parent
    // does, and `openInForeground` documents spawning exactly that way ("Not
    // detached, and not unref'd: this process is the pane's foreground job"). So one
    // `taskkill /F` on the CLI takes down both halves of the mechanism at once —
    // `ModeGuard::drop` never runs in the browser, and the CLI's clear never runs
    // either. The frames stay on disk with nobody left who knows they are there.
    const root = freshRoot(t, "killed-cli");
    const env = paneEnv({ root, pipe: `winterm-accept-${process.pid}-cli`, session: "s-cli" });
    const host = hostOn(env.AGWINTERM_PIPE);
    t.after(() => host.close());
    await host.listening;

    const { child: cli, out } = await launch(t, CLI_WRAPPER, { env, ready: "drew " });
    const browser = Number.parseInt(out.match(/drew (\d+)/)[1], 10);
    strays.push(browser);
    forceKill(cli.pid); // no /T: whatever dies here dies because the CLI did
    await withDeadline(once(cli, "exit"), "the killed CLI to be reaped", CHILD_MS);
    await settles(() => !alive(browser), "the browser to go down with the CLI's job object");
    const left = fs.readdirSync(root).filter((name) => name.startsWith(FRAME_DIR_PREFIX));
    assert.equal(left.length, 1, "no frame directory survived, so nothing was left to recover");
    assert.deepEqual(host.lines, [], "something cleared the pane before the recovery verb ran");

    const run = await paneClear(env);
    assert.equal(run.code, 0, `pane-clear exited ${run.code}: ${run.stderr}`);
    assert.deepEqual(clears(host), [{ cmd: "image.clear", target: "s-cli" }]);
    assert.ok(run.stdout.includes(DISABLE_REPORTING), "the console was left as the browser set it");
    assert.match(run.stdout, /frame:\s+cleared/, run.stdout);
  });
});

describe("a placement this browser never made", () => {
  it("is reported rather than taken down", async (t) => {
    // The engine's rule (`FramePublisher::clear`): with nothing published, asking
    // anyway clears a picture some other process owns. A recovery verb runs against
    // a pane that is already broken, which is where guessing costs the most.
    const root = freshRoot(t, "not-ours");
    fs.mkdirSync(path.join(root, "some-other-tool-4242"));
    fs.writeFileSync(path.join(root, "some-other-tool-4242", "frame-00000000.png"), "");
    const env = paneEnv({ root, pipe: `winterm-accept-${process.pid}-foreign` });
    const host = hostOn(env.AGWINTERM_PIPE);
    t.after(() => host.close());
    await host.listening;

    const run = await paneClear(env);
    assert.equal(run.code, 0, `pane-clear exited ${run.code}: ${run.stderr}`);
    assert.deepEqual(host.lines, [], "a placement that was not ours was cleared anyway");
    assert.match(run.stdout, /frame:\s+nothing of ours to clear/, run.stdout);
    // Reporting is not the same as doing nothing: the console half still runs, since
    // whatever wrecked the modes did not have to be the thing that drew the picture.
    assert.ok(run.stdout.includes(DISABLE_REPORTING), "the console was left alone too");
    assert.match(run.stdout, /pane-clear: pipe winterm-accept/, run.stdout);
  });
});

describe("the development-instance guard, from the shipped CLI", () => {
  // The engine's guard stops a dev build *publishing* into the terminal it is being
  // developed in. Without the CLI's copy the browser would still dial that instance
  // on the way out and clear a placement it had no part in — the two are one
  // mechanism, and the plan asks for both to be confirmed.

  it("withholds the clear from an instance this build was not named at", async (t) => {
    const root = freshRoot(t, "guard-refused");
    const wrong = `winterm-accept-${process.pid}-wrong`;
    const env = paneEnv({ root, pipe: wrong, allow: `winterm-accept-${process.pid}-dev` });
    const host = hostOn(wrong);
    t.after(() => host.close());
    await host.listening;

    const { child } = await launch(t, BROWSER, { env, ready: "drew " });
    forceKill(child.pid);
    await withDeadline(once(child, "exit"), "the killed browser to be reaped", CHILD_MS);

    const run = await paneClear(env);
    assert.equal(run.code, 0, `pane-clear exited ${run.code}: ${run.stderr}`);
    assert.deepEqual(
      host.lines,
      [],
      "the CLI dialled an instance the guard says this build does not address",
    );
    assert.match(run.stdout, /not addressable/, run.stdout);
    assert.match(run.stdout, /TERMINAL_BROWSER_ALLOW_PIPE/, run.stdout);
    assert.match(run.stdout, /no image\.clear was sent/, run.stdout);
  });

  it("refuses the unset fallback, which is the instance that got wrecked", async (t) => {
    // With `AGWINTERM_PIPE` unset both readers resolve to `agwinterm` — the real
    // terminal on this machine. Nothing is bound for it here on purpose: the claim is
    // that no socket is opened at all, and binding the production name to prove it
    // would be the very thing being guarded against.
    const root = freshRoot(t, "guard-fallback");
    const env = paneEnv({ root, pipe: null, allow: `winterm-accept-${process.pid}-dev` });
    const { child } = await launch(t, BROWSER, { env, ready: "drew " });
    forceKill(child.pid);
    await withDeadline(once(child, "exit"), "the killed browser to be reaped", CHILD_MS);

    const run = await paneClear(env);
    assert.equal(run.code, 0, `pane-clear exited ${run.code}: ${run.stderr}`);
    assert.match(run.stdout, /AGWINTERM_PIPE is unset, so this pane resolves to "agwinterm"/, run.stdout);
    assert.match(run.stdout, /no image\.clear was sent/, run.stdout);
  });

  it("addresses the instance it was named at", async (t) => {
    // The guard has to be a guard and not an off switch: a dev build told which
    // instance it may use still recovers that instance's pane.
    const root = freshRoot(t, "guard-allowed");
    const env = paneEnv({ root, pipe: `winterm-accept-${process.pid}-dev`, session: "s-dev" });
    const host = hostOn(env.AGWINTERM_PIPE);
    t.after(() => host.close());
    await host.listening;

    const { child } = await launch(t, BROWSER, { env, ready: "drew " });
    forceKill(child.pid);
    await withDeadline(once(child, "exit"), "the killed browser to be reaped", CHILD_MS);

    const run = await paneClear(env);
    assert.equal(run.code, 0, `pane-clear exited ${run.code}: ${run.stderr}`);
    assert.deepEqual(clears(host), [{ cmd: "image.clear", target: "s-dev" }]);
    assert.match(run.stdout, /frame:\s+cleared/, run.stdout);
  });
});

describe("a control-pipe host that accepts and never answers", () => {
  it("does not wedge the recovery command", async (t) => {
    // The CLI's half of Task 5's claim. The engine bounds its exchange with an
    // overlapped deadline; this one bounds it with a timer, and both exist so that a
    // host which has stopped answering cannot hold a process open. A recovery tool
    // that hangs against a broken host is no recovery tool.
    const root = freshRoot(t, "stalled-host");
    const env = paneEnv({ root, pipe: `winterm-accept-${process.pid}-stall` });
    const host = hostOn(env.AGWINTERM_PIPE, null);
    t.after(() => host.close());
    await host.listening;

    const { child } = await launch(t, BROWSER, { env, ready: "drew " });
    forceKill(child.pid);
    await withDeadline(once(child, "exit"), "the killed browser to be reaped", CHILD_MS);

    const run = await paneClear(env);
    assert.equal(run.code, 0, `pane-clear exited ${run.code}: ${run.stderr}`);
    assert.equal(host.lines.length, 1, "the stalled host was not sent the clear");
    // `clearPaneFrame`'s own budget is a second. The bound here is loose enough not
    // to be a benchmark and tight enough that only the client's timer can have ended
    // this — `CHILD_MS` alone would be satisfied by a hang the harness cut short.
    assert.ok(run.ms < 10_000, `pane-clear took ${run.ms}ms against a host that never answered`);
    // The report says the host went quiet rather than claiming a clear it never got
    // an answer to, and the console is restored either way — that half needs no host.
    assert.match(run.stdout, /image\.clear went unanswered/, run.stdout);
    assert.ok(run.stdout.includes(DISABLE_REPORTING), "a stalled host cost the user the console");
  });
});
