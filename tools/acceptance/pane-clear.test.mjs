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
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { requireBuilt } from "../lib/built.mjs";
import { hostOn } from "../lib/control-host.mjs";
import { onceWithin, teardown, withDeadline } from "../lib/deadline.mjs";

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

/**
 * Runs the built CLI's recovery verb, and never waits on it forever.
 *
 * `stdin` is a knob rather than a constant because one thing the verb has to
 * survive is input *arriving* while it runs — see "stdin that does not stop while
 * the verb runs" below. Everything else here wants `ignore`, which is what a
 * caller that says nothing gets.
 */
async function runClear(env, args = [], { stdin = "ignore", onSpawn = null } = {}) {
  const child = spawn(process.execPath, [CLI, "pane-clear", ...args], {
    env,
    stdio: [stdin, "pipe", "pipe"],
    windowsHide: true,
  });
  onSpawn?.(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const started = Date.now();
  let code;
  try {
    code = await onceWithin(child, "exit", "pane-clear to exit", CHILD_MS);
  } catch (error) {
    // A recovery command that hangs is the defect, not a slow machine: leave nothing
    // running behind the failure.
    forceKill(child.pid, { tree: true });
    throw error;
  }
  return { code, stdout, stderr, ms: Date.now() - started };
}

/** The ordinary run: no stdin, and the verb's own command line. */
const paneClear = (env, ...args) => runClear(env, args);

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
    await onceWithin(child, "exit", "the killed browser to be reaped", CHILD_MS);

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
    // Neither half of the console restore can *land* on a run observed this way, and
    // the report has to say so rather than claim the repair. `paneClear` reads the
    // child through pipes — it is the only way to assert on what it wrote — so its
    // stdout is not a console and its stdin is not a tty: the escapes go into the
    // pipe above rather than to the pane, and no cooking child runs. Both are the
    // *not-restored* branches, and asserting the restored wording here would have
    // pinned a claim that is false for every run this suite can make. What the
    // restored wording says is pinned in `tools/cli/pane-clear.test.mjs`, where a
    // console can be named without one being present.
    assert.match(run.stdout, /console: the escapes did not reach a console/, run.stdout);
    assert.match(run.stdout, /run this again with stdout on the pane/, run.stdout);
    assert.ok(!/mouse reporting off/.test(run.stdout), run.stdout);
    assert.ok(!/out of raw mode/.test(run.stdout), run.stdout);
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
    await onceWithin(cli, "exit", "the killed CLI to be reaped", CHILD_MS);
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
    await onceWithin(child, "exit", "the killed browser to be reaped", CHILD_MS);

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
    await onceWithin(child, "exit", "the killed browser to be reaped", CHILD_MS);

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
    await onceWithin(child, "exit", "the killed browser to be reaped", CHILD_MS);

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
    await onceWithin(child, "exit", "the killed browser to be reaped", CHILD_MS);

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

describe("pane-clear's own argument list", () => {
  it("refuses a stray argument rather than repairing something else", async (t) => {
    // "Always exits 0" is a claim about the repair, not about a command line this
    // verb does not have. `pane-clear` takes nothing: a user who typed `--force` out
    // of habit has to be told the flag does not exist, because a run that ignored it
    // and exited 0 reads as "the flag did what it said". Dispatch is the only place
    // this can be checked -- the verb is reached before terminal detection, so a
    // wrong argument must not fall through into a search for a pane.
    const root = freshRoot(t, "stray-arg");
    const env = paneEnv({ root, pipe: `winterm-accept-${process.pid}-stray` });
    const host = hostOn(env.AGWINTERM_PIPE);
    t.after(() => host.close());
    await host.listening;

    const run = await paneClear(env, "--force");
    assert.equal(run.code, 1, `a stray argument exited ${run.code}: ${run.stdout}`);
    assert.match(`${run.stdout}${run.stderr}`, /--force/);
    assert.match(`${run.stdout}${run.stderr}`, /takes no arguments/);
    assert.deepEqual(host.lines, [], "a rejected command line still spoke to the host");
  });
});

// -- stdin that does not stop while the verb runs -------------------------------
//
// `pane-clear` hung once, on a real pane, on 2026-08-25, and left the shell refusing
// input. Recovery took `image.clear` over the control pipe plus recreating the
// session, which destroyed the evidence — so what is known about it is what was on
// screen at the time, and four scenarios built since have not got it back: a clean
// pane, a console-wrecked pane, a browser killed with the CLI surviving, and a CLI
// killed leaving an orphaned frame. All of them pass. Three explanations were tried
// and disproved with them: not the `cookConsoleModes` half on its own, not a slow
// `%TEMP%` scan, and not a hang before the first output.
//
// The one condition none of them recreate is the one the real pane had. Mouse
// reporting was live with a pointer moving over it, so SGR motion reports were
// arriving on the CLI's stdin *continuously while the verb ran* — and
// `cookConsoleModes` hands that stdin to a `cmd.exe` child with `stdio: "inherit"`
// (`cli/src/pane.ts`). Every existing test either gives the verb no stdin at all
// (`ignore`, above) or replaces the cooking child with a seam
// (`tools/cli/pane-clear.test.mjs`), so the inherited-stdin handoff has never run
// against input that was moving.
//
// ## What this covers, and what it cannot
//
// The traffic is real: a live pipe on the child's fd 0, written to at the rate a
// moving pointer produces reports, from before the verb starts until after it ends,
// and `cmd.exe` really does inherit that fd mid-flight. What it is not is a
// *console*. Node cannot create one for a child — there is no `CREATE_NEW_CONSOLE`
// on `spawn`, and the only console this suite could otherwise hand over is the test
// runner's own, which is a real pane: cooking its modes and clearing its picture is
// precisely the wreck `paneEnv` scrubs the environment to avoid. A pseudoconsole
// needs `CreatePseudoConsole`, which is `tools/conpty-probe`'s territory and a
// standalone cargo package by design (`docs/design/06-acceptance.md`).
//
// So a console input buffer filling with `INPUT_RECORD`s is still uncovered, and
// that is the half of the hypothesis that stays open. What is covered is the other
// half — a child inheriting a stdin with unread bytes still arriving on it — and
// that is the dimension no test exercised before.

/** The rate a pointer moving over a pane reports at: one motion event per ~8ms. */
const POINTER_HZ = 125;

/**
 * Writes SGR any-motion reports into `stream` until stopped.
 *
 * `\e[<35;C;RM` is the `?1006` encoding with button 35 — motion with no button
 * held, which is what `?1003h` sends for a pointer crossing the pane and what
 * `tools/conpty-probe` measured surviving a real ConPTY. The coordinates move so a
 * reader cannot be satisfied by one report repeated.
 *
 * Errors are swallowed rather than raised: the child closing its end mid-write is
 * an `EPIPE` on a pipe this test is deliberately still writing to, and it means the
 * verb finished — which is the outcome being asserted, not a failure.
 */
function feedPointer(stream) {
  let sent = 0;
  stream.on("error", () => {});
  const timer = setInterval(() => {
    if (stream.destroyed || stream.writableEnded) return;
    try {
      stream.write(`\x1b[<35;${20 + (sent % 60)};${5 + (sent % 20)}M`);
      sent += 1;
    } catch {
      // The child is gone. Nothing to report and nothing to fix.
    }
  }, Math.round(1000 / POINTER_HZ));
  // Unref'd so a feeder outliving its assertion cannot hold the runner open. It
  // still fires for as long as the test is awaiting something, which is the whole
  // window that matters.
  timer.unref?.();
  return {
    get sent() {
      return sent;
    },
    stop() {
      clearInterval(timer);
      try {
        stream.end();
      } catch {
        // Already closed by the child's exit.
      }
    },
  };
}

/**
 * The console-restore half on its own, in a real process, with the real cooking
 * child rather than a seam.
 *
 * `restorePaneConsole` gates the cook on `input.isTTY`, and a spawned child's stdin
 * is a pipe — so the gate is opened here by defining `isTTY` on the *real*
 * `process.stdin` rather than by passing a stand-in. That matters twice: the
 * `execFileSync(cmd.exe, …, { stdio: "inherit" })` inside `cookConsoleModes`
 * inherits this process's actual fd 0, which is the pipe being fed; and the
 * `input.pause()` that follows runs against the actual stdin stream, which is the
 * one that could hold the event loop open past the return. A stand-in object would
 * have covered neither.
 *
 * `out` *is* a stand-in, because the alternative is writing `?1049l` and friends
 * into the pipe this test reads the result off.
 */
const CONSOLE_RESTORE = `
  const pane = require(${JSON.stringify(path.join(REPO, "cli", "dist", "pane.js"))});
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  process.stdout.write("ready\\n");
  // Long enough that the feeder is established and its bytes are queued on fd 0
  // before the cooking child inherits it, rather than arriving only after.
  setTimeout(() => {
    const started = Date.now();
    const restored = pane.restorePaneConsole({ write() {}, isTTY: true }, process.stdin);
    process.stdout.write(JSON.stringify({ ...restored, ms: Date.now() - started }) + "\\n");
  }, 300);
`;

describe("stdin that does not stop while the verb runs", () => {
  it("does not stop pane-clear finishing, reporting both halves and exiting 0", async (t) => {
    const root = freshRoot(t, "fed-stdin");
    const env = paneEnv({ root, pipe: `winterm-accept-${process.pid}-fed`, session: "s-fed" });
    const host = hostOn(env.AGWINTERM_PIPE);
    t.after(() => host.close());
    await host.listening;

    // A real wreck behind it, so both halves have work to do: the frame half has a
    // directory to find and a host to dial, and the console half runs either way.
    const { child } = await launch(t, BROWSER, { env, ready: "drew " });
    forceKill(child.pid);
    await onceWithin(child, "exit", "the killed browser to be reaped", CHILD_MS);

    let feeder = null;
    t.after(() => feeder?.stop());
    const run = await runClear(env, [], {
      stdin: "pipe",
      onSpawn: (verb) => (feeder = feedPointer(verb.stdin)),
    });
    feeder.stop();

    assert.equal(run.code, 0, `pane-clear exited ${run.code}: ${run.stderr}`);
    // The coverage claim, asserted rather than assumed: a run that finished before
    // any reports were written would pass everything below while exercising nothing.
    assert.ok(feeder.sent >= 5, `only ${feeder.sent} pointer reports reached the verb's stdin`);
    // Both halves named. `CHILD_MS` alone would be satisfied by a hang the harness
    // cut short, so the bound is the one that tells a run from a wedge.
    assert.match(run.stdout, /frame:\s+cleared/, run.stdout);
    assert.match(run.stdout, /console: the escapes did not reach a console/, run.stdout);
    assert.deepEqual(clears(host), [{ cmd: "image.clear", target: "s-fed" }]);
    assert.ok(run.ms < 15_000, `pane-clear took ${run.ms}ms with a pointer moving over its stdin`);
  });

  it("does not stop the console-restore half, which is where the inherited stdin goes", async (t) => {
    // The half the test above cannot reach: with fd 0 a pipe, `restorePaneConsole`
    // sees `isTTY` false and never spawns the cooking child at all, so the run
    // proves nothing about the handoff. Here the gate is opened on the real stdin
    // and the real `cookConsoleModes` runs — `cmd.exe`, `stdio: "inherit"`, on a fd
    // the parent is still being written to.
    const child = spawn(process.execPath, ["-e", CONSOLE_RESTORE], {
      env: paneEnv({ root: freshRoot(t, "fed-cook"), pipe: `winterm-accept-${process.pid}-cook` }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    strays.push(child.pid);
    t.after(() => forceKill(child.pid, { tree: true }));
    const feeder = feedPointer(child.stdin);
    t.after(() => feeder.stop());

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const started = Date.now();
    let code;
    try {
      code = await onceWithin(child, "exit", "the console restore to exit", CHILD_MS);
    } catch (error) {
      forceKill(child.pid, { tree: true });
      throw error;
    }
    const ms = Date.now() - started;
    feeder.stop();

    assert.equal(code, 0, `the console restore exited ${code}: ${stderr}`);
    assert.ok(feeder.sent >= 5, `only ${feeder.sent} pointer reports reached the restore's stdin`);
    const report = JSON.parse(stdout.split("\n").find((line) => line.startsWith("{")));
    // On Windows the cooking child is the whole point and it has to have run. On
    // anything else `cookConsoleModes` returns false by design, and asserting `true`
    // there would be asserting the platform rather than the behaviour.
    if (process.platform === "win32") {
      assert.equal(report.modes, true, `the cooking child did not run: ${stdout}`);
    }
    assert.equal(report.escapes, true, stdout);
    // `CONSOLE_COOK_TIMEOUT_MS` is 2s, and it is the only bound inside the call. A
    // restore that took longer than this either exceeded that budget or was never
    // held by it — both are the reproduction, and both fail here rather than wedge.
    assert.ok(report.ms < 10_000, `the console restore took ${report.ms}ms against moving stdin`);
    // And it exited on its own, rather than being reaped by the deadline above:
    // `input.pause()` ran against a stdin with bytes still arriving on it, which is
    // the one call standing between this process and an event loop held open.
    assert.ok(ms < 15_000, `the console restore took ${ms}ms to exit against moving stdin`);
  });
});
