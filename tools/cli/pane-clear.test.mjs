// Task 14's acceptance check that failed: "a killed browser process leaves the pane
// usable as a terminal".
//
// It failed on the picture rather than on the shell. A frame is a *placement* —
// agwinterm holds the last PNG until something replaces it — so when the browser was
// force-killed the page stayed painted over a pane whose shell was running and
// answering underneath. `Terminal`'s `Drop` (`terminal_windows.rs`) cannot help: a
// `taskkill /F` runs no destructor. The CLI's foreground wait can, because it
// outlives the browser by construction.
//
// What is driven here is a real `net.Server` on a real named pipe, standing in for
// agwinterm's control server: the claim is about bytes on a pipe, and a mock of the
// host would be a mock of the thing under test. The addressing half is pure and is
// checked directly.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

import esbuild from "esbuild";

import { hostOn, PIPE_PREFIX } from "../lib/control-host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-pane-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** Transpiles one node-builtins-only TypeScript module and imports it. */
async function loadModule(relative) {
  const source = fs.readFileSync(path.join(REPO, relative), "utf8");
  const { code } = await esbuild.transform(source, { loader: "ts", format: "esm" });
  const out = path.join(scratch, `${path.basename(relative, ".ts")}.mjs`);
  fs.writeFileSync(out, code);
  return import(pathToFileURL(out).href);
}

const pane = await loadModule("cli/src/pane.ts");
const help = await loadModule("cli/src/help.ts");
const mainSource = fs.readFileSync(path.join(REPO, "cli", "src", "main.ts"), "utf8");

/** A pane environment, with the three variables agwinterm sets. */
const inPane = (extra) => ({ AGWINTERM_ENABLED: "1", ...extra });

describe("where the clear is addressed", () => {
  // These are `HostTarget::from_env`'s rules (`agwinterm.rs`). The engine placed
  // the frame and the CLI takes it back, so a disagreement here does not produce an
  // error — it produces a clear delivered to a pane that did not ask for one.

  it("names the pane's own pipe and session", () => {
    const request = pane.paneClearRequest(
      inPane({ AGWINTERM_PIPE: "agwinterm-dev", AGWINTERM_SESSION_ID: "abc-123" }),
    );
    assert.equal(request.endpoint, `${PIPE_PREFIX}agwinterm-dev`);
    assert.deepEqual(JSON.parse(request.line), { cmd: "image.clear", target: "abc-123" });
    assert.ok(request.line.endsWith("\n"), "the protocol is one JSON object per line");
  });

  it("accepts AGWINTERM_PANE_ID as the same id under its older name", () => {
    const request = pane.paneClearRequest(
      inPane({ AGWINTERM_PIPE: "agwinterm", AGWINTERM_PANE_ID: "pane-9" }),
    );
    assert.equal(JSON.parse(request.line).target, "pane-9");
  });

  it("prefers the session id when a pane id is also present", () => {
    const request = pane.paneClearRequest(
      inPane({
        AGWINTERM_PIPE: "agwinterm",
        AGWINTERM_SESSION_ID: "session-1",
        AGWINTERM_PANE_ID: "pane-9",
      }),
    );
    assert.equal(JSON.parse(request.line).target, "session-1");
  });

  it("names the window the pane is in when the host names one", () => {
    // A content verb with no `window` resolves against the *frontmost* window, and
    // each window searches only its own panes (`ControlServer.cs`,
    // `Program.ControlHost.cs`). Without this the clear misses whenever the user
    // has another agwinterm window in front, and the dead browser's picture stays.
    const request = pane.paneClearRequest(
      inPane({ AGWINTERM_SESSION_ID: "abc-123", AGWINTERM_WINDOW_ID: "win-7" }),
    );
    assert.deepEqual(JSON.parse(request.line), {
      cmd: "image.clear",
      target: "abc-123",
      window: "win-7",
    });
  });

  it("leaves the window out when the host names none", () => {
    // Hosts predating multi-window set nothing, and an empty selector is not the
    // same as an absent one.
    const request = pane.paneClearRequest(
      inPane({ AGWINTERM_SESSION_ID: "abc-123", AGWINTERM_WINDOW_ID: "  " }),
    );
    assert.deepEqual(JSON.parse(request.line), { cmd: "image.clear", target: "abc-123" });
  });

  it("falls back to the default pipe name, as agwintermctl does", () => {
    const request = pane.paneClearRequest(inPane({ AGWINTERM_SESSION_ID: "abc" }));
    assert.equal(request.endpoint, `${PIPE_PREFIX}agwinterm`);
  });

  it("refuses the target that means whichever pane is in front", () => {
    // By the time a browser exits, "active" may well be someone else's pane.
    assert.equal(pane.paneClearRequest(inPane({ AGWINTERM_SESSION_ID: "active" })), null);
  });

  it("is nothing to say outside a pane", () => {
    // Not an error: off Windows, and in any shell that is not an agwinterm pane,
    // there was never a placement to take back.
    assert.equal(pane.paneClearRequest({}), null);
    assert.equal(pane.paneClearRequest({ AGWINTERM_SESSION_ID: "abc" }), null);
    assert.equal(pane.paneClearRequest(inPane({})), null);
    assert.equal(pane.paneClearRequest(inPane({ AGWINTERM_SESSION_ID: "  " })), null);
    assert.equal(
      pane.paneClearRequest({ AGWINTERM_ENABLED: "0", AGWINTERM_SESSION_ID: "abc" }),
      null,
      "AGWINTERM_ENABLED=0 is a no, the same way the engine reads it",
    );
  });

  it("refuses a pipe name carrying a separator", () => {
    // `\\.\pipe\a\b` is a different object, not a nested one, so a name with a
    // separator in it addresses something other than what the variable meant.
    assert.equal(
      pane.paneClearRequest(
        inPane({ AGWINTERM_PIPE: "agwinterm\\evil", AGWINTERM_SESSION_ID: "a" }),
      ),
      null,
    );
    assert.equal(
      pane.paneClearRequest(inPane({ AGWINTERM_PIPE: "agwinterm/evil", AGWINTERM_SESSION_ID: "a" })),
      null,
    );
  });

  it("refuses everything outside the engine's pipe-name set, not just separators", () => {
    // This module rejected only `[\\/]` while the engine allowed `[A-Za-z0-9._-]`,
    // so a pane spelling the pipe with a space was addressed here and refused there.
    for (const name of ["agwinterm 2", "agwintérm", "agwinterm:1", "agwinterm|evil"]) {
      assert.equal(
        pane.paneClearRequest(inPane({ AGWINTERM_PIPE: name, AGWINTERM_SESSION_ID: "a" })),
        null,
        `${name} is not a pipe name`,
      );
    }
  });
});

// The other copy of the engine's `pipe_refusal`. `pane.ts` cannot import a guard
// added to the engine — it imports nothing from the workspace by construction — so
// the CLI had its own unguarded fallback to the production instance: with the
// engine refusing to publish, `openInForeground` would still dial `\\.\pipe\agwinterm`
// on the way out and clear a placement it had no part in.
describe("the development-instance guard", () => {
  const dev = (extra) => inPane({ AGWINTERM_SESSION_ID: "s1", ...extra });

  it("refuses the fallback to the real instance, which is the case that wrecked a pane", () => {
    assert.equal(pane.paneClearRequest(dev({ TERMINAL_BROWSER_ALLOW_PIPE: "agwinterm-dev" })), null);
    const why = pane.pipeRefusal(dev({ TERMINAL_BROWSER_ALLOW_PIPE: "agwinterm-dev" }));
    assert.match(why, /TERMINAL_BROWSER_ALLOW_PIPE/, "the refusal must name the way out");
    assert.match(why, /AGWINTERM_PIPE is unset/);
  });

  it("addresses the instance it was told to use", () => {
    const env = dev({
      AGWINTERM_PIPE: "agwinterm-dev",
      TERMINAL_BROWSER_ALLOW_PIPE: "agwinterm-dev",
    });
    assert.equal(pane.pipeRefusal(env), null);
    assert.equal(pane.paneClearRequest(env).endpoint, `${PIPE_PREFIX}agwinterm-dev`);
  });

  it("is off until the variable is set, because on Windows the product is a checkout", () => {
    // `pnpm -r build` runs `cargo build -p pixel-node` with no `--release`, so a
    // guard that refused an unlisted pipe by default would refuse every ordinary run.
    assert.equal(pane.pipeRefusal(dev({})), null);
    assert.equal(pane.pipeRefusal(dev({ TERMINAL_BROWSER_ALLOW_PIPE: "" })), null);
    assert.equal(pane.pipeRefusal(dev({ TERMINAL_BROWSER_ALLOW_PIPE: " , " })), null);
    assert.ok(pane.paneClearRequest(dev({})), "an ordinary pane still gets its clear");
  });

  it("reads a list the way a shell hands one over", () => {
    for (const list of ["a,agwinterm-dev", "a;agwinterm-dev", " a , agwinterm-dev ", "*"]) {
      assert.equal(pane.pipeAllowed(list, "agwinterm-dev"), true, list);
    }
    assert.equal(pane.pipeAllowed("a,b", "agwinterm-dev"), false);
    assert.equal(pane.pipeAllowed(null, "anything"), true);
  });

  it("says the clear was withheld rather than reporting no pane at all", async () => {
    // The pane exists and holds frames; what stopped the clear is a variable the
    // user set, and "no agwinterm pane in this environment" would send them looking
    // at the wrong thing entirely.
    const root = fs.mkdtempSync(path.join(scratch, "guarded-"));
    const dir = path.join(root, `${pane.FRAME_DIR_PREFIX}4242-1`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "frame-00000000.png"), "not really a png");

    const env = dev({ TERMINAL_BROWSER_ALLOW_PIPE: "agwinterm-dev" });
    const outcome = await pane.clearOwnedPaneFrame(env, { root });
    assert.equal(outcome.request, null, "no clear may be sent to a refused instance");
    assert.equal(outcome.cleared, false);

    const report = pane.paneClearReport(env, outcome, true).join("\n");
    assert.match(report, /not addressable/);
    assert.match(report, /TERMINAL_BROWSER_ALLOW_PIPE/);
    assert.match(report, /1 frame\(s\) left in/, "it still says what was found");
    assert.ok(!report.includes("no agwinterm pane in this environment"));
  });
});

describe("sending the clear", () => {
  it("reaches a listening host as one image.clear line", async (t) => {
    const host = hostOn(`winterm-clear-${process.pid}-ok`);
    await host.listening;
    t.after(() => host.close());

    const cleared = await pane.clearPaneFrame(
      inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-under-test" }),
    );

    assert.equal(cleared, true);
    assert.equal(host.lines.length, 1);
    assert.deepEqual(JSON.parse(host.lines[0]), {
      cmd: "image.clear",
      target: "pane-under-test",
    });
  });

  it("gives up on a host that stops answering rather than holding the exit open", async (t) => {
    const host = hostOn(`winterm-clear-${process.pid}-mute`, null);
    await host.listening;
    t.after(() => host.close());

    const started = Date.now();
    const cleared = await pane.clearPaneFrame(
      inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane" }),
      150,
    );

    assert.equal(cleared, false, "an unanswered clear is not a cleared pane");
    assert.ok(Date.now() - started < 3_000, "it waited past its own timeout");
    assert.equal(host.lines.length, 1, "it still said it before giving up");
  });

  it("treats a pipe nobody is listening on as nothing to clean up", async () => {
    // The host closed the window, or the whole instance went away. There is no
    // placement left either way, and this runs on an exit path that must not throw.
    const cleared = await pane.clearPaneFrame(
      inPane({ AGWINTERM_PIPE: `winterm-clear-${process.pid}-absent`, AGWINTERM_SESSION_ID: "pane" }),
      500,
    );
    assert.equal(cleared, false);
  });

  it("says nothing at all when there is no pane in the environment", async () => {
    assert.equal(await pane.clearPaneFrame({}), false);
  });
});

describe("the CLI's foreground wait", () => {
  const body = mainSource.slice(
    mainSource.indexOf("async function openInForeground"),
    mainSource.indexOf("async function attachHere"),
  );

  it("clears after the browser is done, not before", () => {
    // The ordering is the whole point: clearing before the wait would take the
    // picture down while the browser is still drawing it.
    const wait = body.indexOf("await Promise.race([exited, stopped])");
    const clear = body.indexOf("clearOwnedPaneFrame(process.env");
    assert.ok(wait > 0, "openInForeground no longer waits for the child");
    assert.ok(clear > wait, "the clear does not follow the wait");
  });

  it("does not let the clear decide the exit code", () => {
    // The browser's exit code is the pane's exit code (`docs/design/03-process-model.md`).
    // A failed cleanup of a placement that is already gone must not overwrite it.
    assert.match(body, /const code = await Promise\.race/);
    assert.match(body, /await clearOwnedPaneFrame\(process\.env[^;]*\);[\s\S]*return code;/);
  });

  it("listens for the signals that used to skip the clear entirely", () => {
    // Ctrl+C reaches every process attached to a Windows console, and Node with no
    // listener for SIGINT terminates immediately -- so the CLI died alongside the
    // browser and the clear above never ran, leaving the last page painted over the
    // shell that had just got the pane back. Listening is what keeps this process
    // alive long enough to finish; it is not about handling the signal, and the
    // handler here kills nothing.
    //
    // The list itself is `FOREGROUND_SIGNALS` in `cli/src/launch.ts`, exercised by
    // `tools/launcher/launch.test.mjs`; what is checked here is that this function
    // registers it and that the registration precedes the wait.
    const listen = body.indexOf("process.on(signal, handler)");
    assert.ok(listen > 0, "openInForeground registers no signal handlers");
    assert.ok(
      listen < body.indexOf("await Promise.race([exited, stopped])"),
      "the handlers go on after the wait has already begun",
    );
  });

  it("does not hand the pane back while the browser is still running", () => {
    // The grace period covers a browser that got the same Ctrl+C this process did.
    // It cannot cover one that did not: `electron.exe` is a GUI-subsystem image and
    // starts with no console (`tools/console-inherit-probe`), so between spawn and
    // the engine's `AttachConsole` there is a window in which the console's Ctrl+C
    // reaches the CLI alone. Returning there would give the shell its prompt back
    // and leave a browser about to attach to that same console -- eating its keys
    // and painting over it, which is what `pane.ts` exists to prevent.
    const kill = body.indexOf("if (running) await terminateTree(child)");
    const clear = body.indexOf("clearOwnedPaneFrame(process.env");
    assert.ok(kill > 0, "a browser that outlived the signal is no longer terminated");
    assert.ok(kill < clear, "the pane is taken back before the browser is stopped");
  });

  it("terminates the whole tree, because kill() on Windows is one pid", () => {
    // Electron's GPU and renderer processes are children. `ChildProcess.kill` maps
    // to `TerminateProcess` against the parent alone, which would leave them behind
    // still attached to this pane's console.
    const helper = mainSource.slice(
      mainSource.indexOf("async function terminateTree"),
      mainSource.indexOf("The Windows shape of `open`"),
    );
    assert.match(helper, /taskkill/);
    assert.match(helper, /"\/T"/, "taskkill is not asked for the process tree");
    assert.match(helper, /"\/F"/, "taskkill is not asked to force");
  });

  it("takes the listeners off again, so a clean quit does not hang", () => {
    // A registered signal listener keeps Node's event loop alive, and `main` only
    // calls `process.exit` for a non-zero code -- so leaving them on would hang
    // every ordinary `q`.
    assert.match(body, /finally \{[\s\S]*process\.removeListener\(signal, handler\)/);
  });
});

describe("giving the console back, which is the other half of giving the pane back", () => {
  /** The engine's `DISABLE_REPORTING`, read out of the Rust it is defined in. */
  function rustDisableReporting() {
    const source = fs.readFileSync(
      path.join(REPO, "engine", "crates", "pixel-core", "src", "terminal_windows.rs"),
      "utf8",
    );
    const at = source.indexOf('const DISABLE_REPORTING: &[u8] = b"');
    assert.ok(at >= 0, "DISABLE_REPORTING is no longer where this test looks for it");
    const from = source.indexOf('b"', at) + 2;
    const to = source.indexOf('";', from);
    assert.ok(to > from, "the literal is not terminated");
    return source
      .slice(from, to)
      // A `\` at end of line continues a Rust string literal and eats the
      // following indentation.
      .replace(/\\\r?\n\s*/g, "")
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  it("sends exactly what the engine would have sent, byte for byte", () => {
    // Two copies of an escape string in two languages is a drift risk, and drifting
    // means restoring some of the modes and leaving the rest on -- which is the bug
    // this exists to fix, in a harder-to-see form.
    assert.equal(pane.DISABLE_REPORTING, rustDisableReporting());
  });

  it("undoes each mode the engine turns on", () => {
    // Not a restatement of the constant: `ENABLE_REPORTING` is the list of modes the
    // browser leaves on after a `taskkill /F`, and every one of them has to be named
    // here or the shell gets the pane back in that state.
    const source = fs.readFileSync(
      path.join(REPO, "engine", "crates", "pixel-core", "src", "terminal_windows.rs"),
      "utf8",
    );
    const from = source.indexOf('const ENABLE_REPORTING: &[u8] = b"');
    const enable = source.slice(from, source.indexOf('";', from));
    const modes = [...enable.matchAll(/\\x1b\[\?(\d+)h/g)].map((match) => match[1]);
    assert.ok(modes.length >= 8, "ENABLE_REPORTING is no longer a list of mode sets");
    for (const mode of modes) {
      assert.ok(
        pane.DISABLE_REPORTING.includes(`\x1b[?${mode}l`),
        `mode ${mode} is turned on and never turned off`,
      );
    }
  });

  it("writes it, and puts the console back into cooked mode", () => {
    const written = [];
    const calls = [];
    const restored = pane.restorePaneConsole(
      { write: (chunk) => written.push(chunk) },
      {
        isTTY: true,
        setRawMode: (raw) => calls.push(`raw:${raw}`),
        pause: () => calls.push("pause"),
      },
    );
    assert.equal(restored, true);
    assert.deepEqual(written, [pane.DISABLE_REPORTING]);
    // `uv_tty_set_mode(NORMAL)` rewrites the input mode outright, which is what puts
    // back echo and line input and takes `ENABLE_VIRTUAL_TERMINAL_INPUT` off again --
    // the `SetConsoleMode` half that no escape string can reach.
    assert.deepEqual(calls, ["raw:false", "pause"]);
  });

  it("leaves a stdin that is not a console alone", () => {
    // `terminal-browser open > out.txt` still has a console to reset the modes on,
    // and no tty to ask.
    const calls = [];
    pane.restorePaneConsole({ write: () => {} }, { isTTY: false, setRawMode: () => calls.push(1) });
    assert.deepEqual(calls, []);
    pane.restorePaneConsole({ write: () => {} }, {});
  });

  it("never throws, whatever the streams do", () => {
    // It runs after something has already gone wrong, on the path that returns the
    // browser's exit code. A closed stdout here must not become the CLI's failure.
    const thrower = () => {
      throw new Error("EPIPE");
    };
    assert.equal(pane.restorePaneConsole({ write: thrower }, {}), false);
    assert.equal(
      pane.restorePaneConsole({ write: () => {} }, { isTTY: true, setRawMode: thrower }),
      true,
    );
  });

  it("is run by the foreground wait, on the same path as the clear", () => {
    // Both are state the engine set on this pane and both are normally undone by the
    // same `Drop`, so the exits that skip one skip the other. Clearing the picture
    // and leaving the console on the alternate screen with the cursor hidden and
    // mouse reporting on is half a fix.
    const body = mainSource.slice(
      mainSource.indexOf("async function openInForeground"),
      mainSource.indexOf("async function attachHere"),
    );
    const clear = body.indexOf("clearOwnedPaneFrame(process.env");
    const restore = body.indexOf("restorePaneConsole()");
    assert.ok(clear > 0, "the frame half left the foreground wait");
    assert.ok(restore > clear, "the console is not restored after the frame is cleared");
    assert.ok(
      restore < body.indexOf("return code"),
      "the restore does not happen before the exit code is returned",
    );
  });
});

// -- the recovery verb ---------------------------------------------------------
//
// Everything above runs on `openInForeground`'s way out, which covers a browser that
// died and not a CLI that died with it. The pane found eighteen hours later — stale
// frame, SGR mouse reports streaming into the shell prompt — had been left by a run
// where neither half ever ran, and was recovered by hand over the control pipe. That
// hand recovery is what `pane-clear` automates, so what is tested here is that one
// command does both halves and needs nothing that a wrecked pane has already lost.

/** The engine's frame-directory naming, read out of the Rust that defines it. */
function rustFrameNaming() {
  const source = fs.readFileSync(
    path.join(REPO, "engine", "crates", "pixel-core", "src", "frame_file.rs"),
    "utf8",
  );
  const prefix = /const DIR_PREFIX: &str = "([^"]+)";/.exec(source);
  assert.ok(prefix, "DIR_PREFIX is no longer where this test looks for it");
  const file = /join\(format!\("frame-\{seq:(\d+)\}\.png"\)\)/.exec(source);
  assert.ok(file, "the frame file name is no longer where this test looks for it");
  return { prefix: prefix[1], width: Number(file[1]) };
}

/**
 * A frame directory the way a killed browser leaves one.
 *
 * `frames: 0` is the browser that died before drawing anything, which is the
 * engine's `written.is_empty()` — a directory exists, nothing was ever placed.
 */
function leftoverFrames(root, pid, frames = 1) {
  const dir = path.join(root, `${pane.FRAME_DIR_PREFIX}${pid}-0`);
  fs.mkdirSync(dir, { recursive: true });
  for (let seq = 0; seq < frames; seq += 1) {
    fs.writeFileSync(path.join(dir, `frame-${String(seq).padStart(8, "0")}.png`), "");
  }
  return dir;
}

/** A fresh, empty temp root per test, so one test's leftovers are not another's. */
function freshRoot(t, name) {
  const root = fs.mkdtempSync(path.join(scratch, `${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** `process.stdout` and `process.stdin` as recorders. */
function recorder() {
  const written = [];
  const calls = [];
  return {
    written,
    calls,
    out: { write: (chunk) => written.push(chunk) },
    input: {
      isTTY: true,
      setRawMode: (raw) => calls.push(`raw:${raw}`),
      pause: () => calls.push("pause"),
    },
    get text() {
      return written.join("");
    },
  };
}

describe("whose placement it is", () => {
  // `FramePublisher::clear` returns early when nothing was published, because
  // "asking anyway would clear a placement some *other* process owns". The CLI
  // shipped an unconditional clear instead. `ownedFrames` is that rule read off the
  // filesystem: the directory survives the exits `Drop` does not.

  it("spells the directory and the frame file the way the engine does", () => {
    // Two copies of a naming scheme in two languages is a drift risk, and drifting
    // means the CLI stops recognising its own browser's frames -- which presents as
    // `pane-clear` refusing to clear the pane it was called to fix.
    const naming = rustFrameNaming();
    assert.equal(pane.FRAME_DIR_PREFIX, naming.prefix);
    const root = fs.mkdtempSync(path.join(scratch, "naming-"));
    const dir = path.join(root, `${naming.prefix}4242-0`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `frame-${"0".repeat(naming.width)}.png`), "");
    assert.ok(pane.ownedFrames({ root }), "the engine's own frame file is not recognised");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds the frames a killed browser left behind", (t) => {
    const root = freshRoot(t, "owned");
    const dir = leftoverFrames(root, 4242, 3);
    assert.deepEqual(pane.ownedFrames({ root }), { dir, pid: 4242, frames: 3 });
  });

  it("owns nothing when the browser exited cleanly", (t) => {
    // `FrameDir`'s `Drop` removes the directory, and the engine has already sent
    // the clear. Nothing on this pane is ours to take down.
    const root = freshRoot(t, "clean");
    assert.equal(pane.ownedFrames({ root }), null);
  });

  it("owns nothing when a browser died before it drew anything", (t) => {
    // The directory is created by `FramePublisher::new` and the first frame may
    // never arrive -- a refused pane, an unwritable frame directory, an instant
    // crash. `written` would be empty; so is this.
    const root = freshRoot(t, "undrawn");
    leftoverFrames(root, 4242, 0);
    assert.equal(pane.ownedFrames({ root }), null);
  });

  it("ignores directories that are not a publisher's", (t) => {
    const root = freshRoot(t, "foreign");
    const other = path.join(root, "some-other-tool-4242");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "frame-00000000.png"), "");
    assert.equal(pane.ownedFrames({ root }), null);
  });

  it("asks about one pid when the caller knows which process it spawned", (t) => {
    // `openInForeground` does: the engine names the directory after the process the
    // CLI started, so the exit path can ask the exact question rather than the broad
    // one `pane-clear` is left with.
    const root = freshRoot(t, "bypid");
    const mine = leftoverFrames(root, 4242, 1);
    leftoverFrames(root, 9999, 1);
    assert.equal(pane.ownedFrames({ root, pid: 4242 }).dir, mine);
    assert.equal(pane.ownedFrames({ root, pid: 1234 }), null);
  });

  it("does not let one pid adopt another's frames by prefix", (t) => {
    // Without the trailing separator, pid 424 would claim 4242's directory and clear
    // a placement it never made -- the exact rule this is here to keep.
    const root = freshRoot(t, "prefix");
    leftoverFrames(root, 4242, 1);
    assert.equal(pane.ownedFrames({ root, pid: 424 }), null);
  });

  it("reports the most recent wreck when there is more than one", (t) => {
    const root = freshRoot(t, "recent");
    leftoverFrames(root, 1111, 1);
    const newer = leftoverFrames(root, 2222, 1);
    fs.utimesSync(newer, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    assert.equal(pane.ownedFrames({ root }).pid, 2222);
  });

  it("never throws on a temp directory it cannot read", () => {
    assert.equal(pane.ownedFrames({ root: path.join(scratch, "nothing-here") }), null);
  });

  it("sends no clear at all when nothing is owned", async (t) => {
    // The point of the rule: a pane holding someone else's picture is left holding
    // it. Reported, not cleared.
    const host = hostOn(`winterm-owned-${process.pid}-none`);
    await host.listening;
    t.after(() => host.close());
    const root = freshRoot(t, "noclear");

    const outcome = await pane.clearOwnedPaneFrame(
      inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" }),
      { root, timeoutMs: 500 },
    );

    assert.equal(outcome.owned, null);
    assert.equal(outcome.cleared, false);
    assert.ok(outcome.request, "it still worked out where a clear would have gone");
    assert.deepEqual(host.lines, [], "it cleared a placement it does not own");
  });

  it("sends the clear when the frames are ours", async (t) => {
    const host = hostOn(`winterm-owned-${process.pid}-yes`);
    await host.listening;
    t.after(() => host.close());
    const root = freshRoot(t, "doclear");
    leftoverFrames(root, 4242, 2);

    const outcome = await pane.clearOwnedPaneFrame(
      inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" }),
      { root, timeoutMs: 1_000 },
    );

    assert.equal(outcome.cleared, true);
    assert.equal(outcome.owned.frames, 2);
    assert.equal(host.lines.length, 1);
    assert.deepEqual(JSON.parse(host.lines[0]), { cmd: "image.clear", target: "pane-1" });
  });
});

describe("the pane-clear verb", () => {
  it("does both halves in one command", async (t) => {
    // The two halves are the whole design: the picture and the console modes are
    // separate state restored by separate mechanisms, and a command that sends only
    // the escapes leaves the pane holding a page over the shell.
    const host = hostOn(`winterm-verb-${process.pid}-both`);
    await host.listening;
    t.after(() => host.close());
    const root = freshRoot(t, "verb-both");
    const dir = leftoverFrames(root, 4242, 5);
    const rec = recorder();

    const code = await pane.paneClearCommand({
      env: inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" }),
      out: rec.out,
      input: rec.input,
      root,
      timeoutMs: 1_000,
    });

    assert.equal(code, 0);
    assert.equal(host.lines.length, 1, "the frame half did not run");
    assert.deepEqual(JSON.parse(host.lines[0]), { cmd: "image.clear", target: "pane-1" });
    assert.ok(rec.written.includes(pane.DISABLE_REPORTING), "the console half did not run");
    assert.deepEqual(rec.calls, ["raw:false", "pause"], "the SetConsoleMode half did not run");
    assert.match(rec.text, /frame: +cleared/);
    assert.ok(rec.text.includes(dir), "it does not say which frames it found");
    assert.match(rec.text, /pid 4242/);
  });

  it("restores the console before it prints, or the report is thrown away", () => {
    // `DISABLE_REPORTING` ends with `?1049l`. Printing first would put the report on
    // the alternate screen and then leave it -- the one arrangement where a command
    // that worked is indistinguishable from one that did nothing.
    const source = fs.readFileSync(path.join(REPO, "cli", "src", "pane.ts"), "utf8");
    const body = source.slice(source.indexOf("export async function paneClearCommand"));
    const restore = body.indexOf("restorePaneConsole(out");
    const print = body.indexOf("paneClearReport(");
    assert.ok(restore > 0 && print > restore, "the report is written before the console is back");
  });

  it("says so out loud when there was nothing to fix", async (t) => {
    // A pane that was already fine looks exactly like a pane this just repaired, so
    // the report is the only way to tell them apart.
    const host = hostOn(`winterm-verb-${process.pid}-clean`);
    await host.listening;
    t.after(() => host.close());
    const root = freshRoot(t, "verb-clean");
    const rec = recorder();

    const code = await pane.paneClearCommand({
      env: inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" }),
      out: rec.out,
      input: rec.input,
      root,
      timeoutMs: 500,
    });

    assert.equal(code, 0);
    assert.deepEqual(host.lines, [], "it cleared a placement it does not own");
    assert.match(rec.text, /nothing of ours to clear/);
    assert.match(rec.text, /left alone/);
    assert.ok(rec.written.includes(pane.DISABLE_REPORTING), "the console half was skipped");
  });

  it("needs no browser, no host and no instance registered", async (t) => {
    // Which is the whole point: the pane it repairs is one where all three are gone.
    // Nothing is listening on this pipe and there is no registry anywhere in reach.
    const root = freshRoot(t, "verb-alone");
    leftoverFrames(root, 4242, 1);
    const rec = recorder();

    const code = await pane.paneClearCommand({
      env: inPane({
        AGWINTERM_PIPE: `winterm-verb-${process.pid}-absent`,
        AGWINTERM_SESSION_ID: "pane-1",
      }),
      out: rec.out,
      input: rec.input,
      root,
      timeoutMs: 500,
    });

    assert.equal(code, 0, "a dead host turned the repair into a failure");
    assert.match(rec.text, /unanswered/);
    assert.ok(rec.written.includes(pane.DISABLE_REPORTING), "the half that never needed a host");
  });

  it("reports cleanly when AGWINTERM_PIPE is unset", async (t) => {
    // Unset means `agwinterm`, which is what agwintermctl falls back to -- and which
    // is the *production* instance. Saying which pipe it used is how a user notices
    // they are addressing the wrong one.
    const root = freshRoot(t, "verb-nopipe");
    const rec = recorder();

    const code = await pane.paneClearCommand({
      env: { AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "pane-1" },
      out: rec.out,
      input: rec.input,
      root,
      timeoutMs: 200,
    });

    assert.equal(code, 0);
    assert.match(rec.text, /pipe agwinterm \(AGWINTERM_PIPE unset\)/);
    assert.match(rec.text, /session pane-1/);
  });

  it("says there is no pane rather than pretending, outside one", async (t) => {
    const root = freshRoot(t, "verb-nopane");
    const rec = recorder();

    const code = await pane.paneClearCommand({ env: {}, out: rec.out, input: rec.input, root });

    assert.equal(code, 0);
    assert.match(rec.text, /no agwinterm pane/);
    // The console half still runs: modes are this console's state whether or not
    // anything is holding a picture over it, and the reset is idempotent.
    assert.ok(rec.written.includes(pane.DISABLE_REPORTING));
  });

  it("names the frames it found even when it cannot address a pane", async (t) => {
    // Running it in the wrong shell is a thing users do. Silence there reads as
    // "nothing was wrong"; this says where to run it instead.
    const root = freshRoot(t, "verb-wrongshell");
    leftoverFrames(root, 4242, 2);
    const rec = recorder();

    await pane.paneClearCommand({ env: {}, out: rec.out, input: rec.input, root });

    assert.match(rec.text, /2 frame\(s\)/);
    assert.match(rec.text, /run this from the pane/);
  });

  it("reports a console it could not write to rather than claiming success", () => {
    const thrower = () => {
      throw new Error("EPIPE");
    };
    const report = pane.paneClearReport({}, { request: null, owned: null, cleared: false }, false);
    assert.match(report.join("\n"), /console: could not be written to/);
    // And the command survives the stream that did it.
    assert.doesNotThrow(() => pane.restorePaneConsole({ write: thrower }, {}));
  });
});

describe("how the CLI dispatches pane-clear", () => {
  const main = mainSource.slice(mainSource.indexOf("async function main("));
  const branch = main.slice(main.indexOf('command === "pane-clear"'));

  it("has a verb in front of it at all", () => {
    // `clearPaneFrame` and `restorePaneConsole` were library functions with one
    // caller on one exit path. A user whose pane is wrecked could not reach either.
    assert.match(main, /command === "pane-clear"/);
    assert.match(mainSource, /import \{[^}]*paneClearCommand[^}]*\} from "\.\/pane"/);
  });

  it("runs before anything that could fail on the same wreckage", () => {
    // No sandbox check, no terminal detection, no registry lookup: each of those is
    // a way for the recovery to die on exactly what it was called to clean up.
    const at = main.indexOf('command === "pane-clear"');
    assert.ok(at > 0);
    assert.ok(
      !branch.slice(0, branch.indexOf("return paneClearCommand()")).includes("requirePaneAccess"),
      "pane-clear gates itself behind a sandbox check",
    );
    assert.ok(
      at < main.indexOf("currentTerminal()"),
      "pane-clear is dispatched after the terminal has to be detected",
    );
  });

  it("is listed and documented, with what it fixes on the page", () => {
    const page = help.commandHelp("pane-clear", "win32");
    assert.ok(page, "pane-clear has no help page");
    for (const symptom of [/alternate screen/, /cursor/, /mouse reporting/, /placement/]) {
      assert.match(page, symptom, "the page does not say what it fixes");
    }
    const line = help
      .rootHelp("win32")
      .split("\n")
      .find((entry) => entry.trim().startsWith("pane-clear"));
    assert.ok(line, "pane-clear is not in the command list");
    assert.ok(!line.includes("not supported"), "the recovery command is listed as refused");
  });
});

describe("the foreground exit path clears only what it drew", () => {
  const body = mainSource.slice(
    mainSource.indexOf("async function openInForeground"),
    mainSource.indexOf("async function attachHere"),
  );

  it("asks whether this browser ever placed a frame", () => {
    // It used to send `image.clear` unconditionally, which is the CLI contradicting
    // the engine's own rule (`FramePublisher::clear`): a browser that died before its
    // first frame would take down whatever the pane was showing beforehand.
    assert.match(body, /clearOwnedPaneFrame\(process\.env, \{ pid: child\.pid \}\)/);
    assert.ok(
      !/\bawait clearPaneFrame\(process\.env\)/.test(body),
      "the unconditional clear is still on the exit path",
    );
  });

  it("asks about the process it started, not about any browser on the machine", () => {
    // The engine names its frame directory after its own pid, so the exit path can
    // ask the exact question. `pane-clear` cannot -- that process is long gone.
    assert.match(body, /pid: child\.pid/);
  });
});
