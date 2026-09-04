// Task 14's acceptance check that failed: "a killed browser process leaves the pane
// usable as a terminal".
//
// It failed on the picture rather than on the shell. A frame is a *placement* —
// agwinterm holds the last PNG until something replaces it — so when the browser was
// force-killed the page stayed painted over a pane whose shell was running and
// answering underneath. `Terminal`'s `Drop` (`terminal_windows.rs`) cannot help: a
// `taskkill /F` runs no destructor. The CLI's foreground wait can, because it
// outlives the browser whenever the browser is what died — and when the CLI is what
// died it does not, which is what the `pane-clear` verb below is for.
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

/**
 * The source between two anchors, and a failure rather than a slice when either has
 * moved.
 *
 * A bare `source.slice(source.indexOf(a), source.indexOf(b))` answers `-1` for a
 * missing anchor, which `slice` reads as "one character from the end" -- a body that
 * is one character long, non-empty, and satisfies every "does not contain" assertion
 * made about it. A renamed function would silently turn these into tests that assert
 * nothing at all, which is the one failure mode a source-reading test has.
 */
function between(source, from, to = null) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `the source no longer contains ${JSON.stringify(from)}`);
  if (to === null) return source.slice(start);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `${JSON.stringify(to)} no longer follows ${JSON.stringify(from)}`);
  return source.slice(start, end);
}

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

  it("takes the same padding off the pane's own variables as the engine does", () => {
    // Not just the allow-list entries below: `nonempty` here and `nonempty` in
    // `agwinterm.rs` resolve the *address*, so a reader trimming its own set does not
    // refuse a launch -- it clears a pane the engine never drew into. U+0085 NEL is
    // Unicode `White_Space` and `str::trim` takes it; `String.trim` does not, so an
    // `AGWINTERM_SESSION_ID` of `"s1\u{85}"` had the CLI addressing `"s1\u{85}"` while
    // the engine had drawn on `"s1"`, and `sameMark` then declined the wreck the
    // engine's own marker names. U+FEFF parts the other way: `String.trim` took the
    // byte-order mark off a pipe name the engine kept and failed `valid_pipe_name` on.
    // Asserted on the resolved value, because a request that is merely non-null is a
    // request delivered to the wrong pane.
    const nel = pane.paneClearRequest(inPane({ AGWINTERM_SESSION_ID: "\u{85}s1\u{85}" }));
    assert.equal(nel.target, "s1");
    assert.deepEqual(JSON.parse(nel.line), { cmd: "image.clear", target: "s1" });
    const bom = pane.paneClearRequest(
      inPane({ AGWINTERM_SESSION_ID: "s1", AGWINTERM_PIPE: "\u{feff}agwinterm-dev\u{feff}" }),
    );
    assert.equal(bom.endpoint, `${PIPE_PREFIX}agwinterm-dev`);
    // And the window selector, which rides the same helper.
    const window = pane.paneClearRequest(
      inPane({ AGWINTERM_SESSION_ID: "s1", AGWINTERM_WINDOW_ID: "\u{feff}win-7\u{85}" }),
    );
    assert.deepEqual(JSON.parse(window.line), {
      cmd: "image.clear",
      target: "s1",
      window: "win-7",
    });
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

  it("compares the pipe the way the object manager resolves it", () => {
    // `sameMark` already folds case on this identifier and says why: `Agwinterm-Dev`
    // and `agwinterm-dev` address one instance. A guard that told them apart would
    // refuse the very instance the developer put on the list, with a message naming
    // a value they can see is already there.
    assert.equal(pane.pipeAllowed("agwinterm-dev", "Agwinterm-Dev"), true);
    assert.equal(pane.pipeAllowed("Agwinterm-Dev", "agwinterm-dev"), true);
    assert.equal(pane.pipeAllowed("other, AGWINTERM-DEV", "agwinterm-dev"), true);
    // Folding a name is not folding anything else: a different name is still one.
    assert.equal(pane.pipeAllowed("agwinterm-dev", "agwinterm-prod"), false);
    // `*` stays a literal, matched before the fold rather than through it.
    assert.equal(pane.pipeAllowed("*", "Agwinterm-Dev"), true);
    // And it folds the way `allows_pipe` folds, which is ASCII and no wider. The
    // entry is `AGWINTERM-KIOSK` with its first `K` written as U+212A KELVIN SIGN:
    // `toLowerCase` maps that onto `k` and the engine's `eq_ignore_ascii_case`
    // cannot, since it is weighing 17 bytes against the pipe's 15. A CLI folding the
    // Unicode way would pass this launch through preflight for the engine to refuse
    // a frame at a time later. Spelled as an escape, the way `agwinterm.rs` spells
    // it: raw, the character is invisible beside the ASCII control below it, and an
    // editor normalising it -- or a find-and-replace on `KIOSK` -- would leave two
    // identical-looking lines asserting opposite results.
    const kelvin = "AGWINTERM-\u{212a}IOSK";
    assert.equal(pane.pipeAllowed(kelvin, "agwinterm-kiosk"), false);
    // The all-ASCII control for the line above: the same entry, spelled with `K`.
    assert.equal(pane.pipeAllowed("AGWINTERM-KIOSK", "agwinterm-kiosk"), true);
    // And the padding it strips is the union both readers trim, which is neither
    // language's own trim: ECMAScript counts U+FEFF ZWNBSP as whitespace and Unicode
    // `White_Space` does not, and U+0085 NEL is the pair of that. Each reader trimming its own set is how an
    // entry an editor prefixed with a byte-order mark passes here and is refused by
    // `allows_pipe` -- so both sides trim the union, and both rows below are `true`.
    assert.equal(pane.pipeAllowed("other,\u{feff}agwinterm-dev", "agwinterm-dev"), true);
    assert.equal(pane.pipeAllowed("other,\u{85}agwinterm-dev", "agwinterm-dev"), true);
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

    const report = pane.paneClearReport(env, outcome, { escapes: true, modes: true }).join("\n");
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

    const reply = await pane.clearPaneFrame(
      inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-under-test" }),
    );

    assert.deepEqual(reply, { cleared: true, refused: null });
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
    const reply = await pane.clearPaneFrame(
      inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane" }),
      150,
    );

    assert.equal(reply.cleared, false, "an unanswered clear is not a cleared pane");
    assert.equal(reply.refused, null, "a host that never spoke did not refuse anything");
    assert.ok(Date.now() - started < 3_000, "it waited past its own timeout");
    assert.equal(host.lines.length, 1, "it still said it before giving up");
  });

  it("treats a pipe nobody is listening on as nothing to clean up", async () => {
    // The host closed the window, or the whole instance went away. There is no
    // placement left either way, and this runs on an exit path that must not throw.
    const reply = await pane.clearPaneFrame(
      inPane({ AGWINTERM_PIPE: `winterm-clear-${process.pid}-absent`, AGWINTERM_SESSION_ID: "pane" }),
      500,
    );
    assert.deepEqual(reply, { cleared: false, refused: null });
  });

  it("says nothing at all when there is no pane in the environment", async () => {
    assert.deepEqual(await pane.clearPaneFrame({}), { cleared: false, refused: null });
  });
});

describe("the CLI's foreground wait", () => {
  const body = between(mainSource, "async function openInForeground", "async function attachHere");

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

  it("does not cook a console no browser ever touched", () => {
    // `spawn` does not throw on a missing or unrunnable Electron binary: it returns
    // a `ChildProcess` with `pid === undefined` and emits `error` later. Nothing ran,
    // so nothing called `SetConsoleMode` -- and `restorePaneConsole`'s modes half
    // *sets* cmd's cooked default rather than putting a saved mode back, so running
    // it there would take QuickEdit, mouse input and window input off the user's own
    // console as collateral of an error message. The frame half already reads this
    // same pid; this is the one exit where the modes half has an answer too.
    const calls = body.match(/restorePaneConsole\(\)/g) ?? [];
    assert.equal(calls.length, 1, "the console is not restored exactly once");
    assert.match(
      body,
      /if \(child\.pid !== undefined\) restorePaneConsole\(\);/,
      "a spawn that never produced a process cooks the console anyway",
    );
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

  it("bounds that kill, because the two recovery steps run after it", () => {
    // `execFileSync` blocks the event loop, so an unbounded one is not slow but
    // stuck -- and what is downstream of it is `clearOwnedPaneFrame` and
    // `restorePaneConsole`, in `openInForeground`'s `try` (the `finally` holds only
    // the listener removal). A `taskkill.exe` that never returns would leave the
    // pane holding the dead browser's frame and its raw console, which is the wreck
    // this whole path exists to prevent.
    const helper = mainSource.slice(
      mainSource.indexOf("async function terminateTree"),
      mainSource.indexOf("The Windows shape of `open`"),
    );
    assert.match(
      helper,
      /timeout: TASKKILL_TIMEOUT_MS/,
      "the force-kill spawn is unbounded again",
    );
    assert.match(
      mainSource,
      /const TASKKILL_TIMEOUT_MS = [\d_]+;/,
      "the bound is no longer a named constant",
    );
  });

  it("still tries the other route, and still waits, when taskkill fails", () => {
    // The `catch` is not "give up": `taskkill` exits 128 when the pid is already
    // gone, but it also arrives here on a refusal or on the bound above expiring
    // with the tree alive. That used to `return`, which skipped the wait as well
    // and told the caller a live browser was stopped -- so `clearOwnedPaneFrame`
    // and `restorePaneConsole` ran, the CLI exited, and libuv's job object took the
    // browser down *after* the evidence and the repair were both gone. So the catch
    // owes two things: a second route (`child.kill`, one pid rather than the tree,
    // but the Electron parent is the one holding this console) and the wait.
    const helper = mainSource.slice(
      mainSource.indexOf("async function terminateTree"),
      mainSource.indexOf("The Windows shape of `open`"),
    );
    const caught = helper.indexOf("} catch {");
    const race = helper.indexOf("Promise.race");
    assert.ok(caught > 0, "the taskkill spawn is no longer guarded");
    assert.match(
      helper.slice(caught),
      /child\.kill\(\)/,
      "a failed taskkill no longer has a second route to try",
    );
    assert.ok(race > caught, "the wait no longer runs after the failure path");
    assert.doesNotMatch(
      helper.slice(caught, race),
      /^\s*return\b/m,
      "the failure path returns early again, so the caller is told a live browser is stopped",
    );
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

  it("writes it, and cooks the console modes from a child process", () => {
    const written = [];
    const calls = [];
    const restored = pane.restorePaneConsole(
      { write: (chunk) => written.push(chunk), isTTY: true },
      { isTTY: true, pause: () => calls.push("pause") },
      {
        cook: () => {
          calls.push("cook");
          return true;
        },
      },
    );
    assert.deepEqual(restored, { escapes: true, modes: true });
    assert.deepEqual(written, [pane.DISABLE_REPORTING]);
    // The `SetConsoleMode` half that no escape string can reach, and that this
    // process cannot make itself: see `cookConsoleModes`.
    assert.deepEqual(calls, ["cook", "pause"]);
  });

  it("reads the cooking child's path from this process, not from the pane's env", () => {
    // Two unrelated environments. `%SystemRoot%` names the Windows this CLI is
    // running on; the pane env names the pane to address, and a caller is free to
    // hand in one that mentions no Windows at all -- every test in this file does.
    // Reading the child's path out of that one silently lost the modes half on a
    // console that was perfectly restorable, and let a caller point the spawn
    // somewhere else by naming `SystemRoot` itself.
    const source = fs.readFileSync(path.join(REPO, "cli", "src", "pane.ts"), "utf8");
    const body = between(source, "export function windowsSystemRoot(", "\n}");
    assert.match(body, /process\.env\.SystemRoot/, "the child's path is not this process's");
    assert.ok(!/(?<!process\.)env\.SystemRoot/.test(body), "the pane env still decides the path");
    assert.match(
      between(source, "function cookConsoleModes(", "\n}"),
      /windowsSystemRoot\(\)/,
      "the cooking child no longer takes its root from the shared helper",
    );
  });

  it("requires a drive-qualified %SystemRoot%, not merely an absolute one", () => {
    // `??` rejects an *unset* variable and nothing else, so an empty or relative one
    // joined to a relative `System32\...` and handed the spawn back to exactly the
    // current-directory-first search the absolute path exists to avoid. But
    // `path.isAbsolute` only closed half of that: it answers `true` for `\Windows`,
    // which is drive-*relative* and resolves against whatever drive the process is
    // on -- `record/paths.ts`'s `/tmp/recordings` trap -- and for `\\host\share`,
    // which makes a pane's exit path an outbound SMB connect. No Windows spells
    // `%SystemRoot%` either way, so the drive test costs nothing and closes both.
    const source = fs.readFileSync(path.join(REPO, "cli", "src", "pane.ts"), "utf8");
    const body = between(source, "export function windowsSystemRoot(", "\n}");
    assert.ok(!body.includes("path.isAbsolute"), "the absoluteness test is back");
    const guard = /\/\^\[A-Za-z\]:\[\\\\\/\]\//;
    assert.match(body, guard, "the root is no longer required to name a drive");
  });

  it("spells taskkill's path out absolutely, the way cookConsoleModes cites it for", () => {
    // `cookConsoleModes` took its guard from `taskkillPath` by name and the guard was
    // only ever on the copy, which is why there is one function now rather than two
    // spellings of the same rule -- and why this asserts the sharing rather than the
    // regex, which lives with `windowsSystemRoot` above.
    const source = fs.readFileSync(path.join(REPO, "cli", "src", "main.ts"), "utf8");
    const body = between(source, "function taskkillPath(", "\n}");
    assert.match(body, /windowsSystemRoot\(\)/, "the guard is a second copy again");
    assert.match(body, /taskkill\.exe/, "the killer is no longer named by full path");
  });

  it("does not call setRawMode, because it does nothing and is not honest about it", () => {
    // The call this used to make. `uv_tty_set_mode` returns early when the mode
    // already matches the one it recorded, and a `uv_tty_t` starts at NORMAL -- so a
    // CLI that never turned raw mode *on* asks for NORMAL, matches, and reaches no
    // syscall at all. Forcing the transition is no better: libuv saves the mode it
    // found on the way in and `uv_tty_reset_mode` restores that saved -- broken --
    // mode when Node tears down stdio. Both measured on Windows 11.
    const source = fs.readFileSync(path.join(REPO, "cli", "src", "pane.ts"), "utf8");
    const body = between(source, "export function restorePaneConsole", "// -- whose placement is it");
    assert.ok(!body.includes("setRawMode"), "the restore is back on a call that does nothing");
  });

  it("pauses stdin even when the cooking child throws", () => {
    // `pause` is what lets the CLI's process exit: reading `isTTY` constructs the tty
    // handle, and a handle constructed this late holds the event loop open. It is the
    // cook that can throw -- `execFileSync` does -- so sharing a `try` with it made
    // the failure that hangs the CLI the same failure that skips the restore.
    const calls = [];
    const restored = pane.restorePaneConsole(
      { write: () => {}, isTTY: true },
      {
        isTTY: true,
        pause: () => calls.push("pause"),
      },
      {
        cook: () => {
          throw new Error("ENOENT");
        },
      },
    );
    assert.deepEqual(restored, { escapes: true, modes: false });
    assert.deepEqual(calls, ["pause"], "a throwing cook took the stdin pause with it");
  });

  it("leaves a stdin that is not a console alone, and says it did not touch it", () => {
    // `terminal-browser open > out.txt` still has a console to reset the modes on,
    // and no tty to ask. The half that did not run is reported as not having run: a
    // redirected stdin is not the console the child would have to inherit, so echo
    // and line input stay exactly as the engine set them, and a report claiming
    // otherwise sends the user away from a broken console.
    const calls = [];
    const cook = () => {
      calls.push(1);
      return true;
    };
    const console_ = { write: () => {}, isTTY: true };
    const redirected = pane.restorePaneConsole(console_, { isTTY: false }, { cook });
    assert.deepEqual(calls, []);
    assert.deepEqual(redirected, { escapes: true, modes: false });
    assert.deepEqual(pane.restorePaneConsole(console_, {}, { cook }), {
      escapes: true,
      modes: false,
    });
    assert.deepEqual(calls, []);
  });

  it("reports the modes as not restored when the cooking child does not run", () => {
    // A `%SystemRoot%` that is not set, a platform with no `SetConsoleMode`, a spawn
    // that hit the timeout: the child either ran and exited clean or it did not, and
    // only the first is a restore. Claiming one anyway is the mis-report the two
    // flags exist to prevent.
    assert.deepEqual(
      pane.restorePaneConsole({ write: () => {}, isTTY: true }, { isTTY: true }, { cook: () => false }),
      { escapes: true, modes: false },
    );
  });

  it("never throws, whatever the streams do", () => {
    // It runs after something has already gone wrong, on the path that returns the
    // browser's exit code. A closed stdout here must not become the CLI's failure.
    const thrower = () => {
      throw new Error("EPIPE");
    };
    assert.deepEqual(pane.restorePaneConsole({ write: thrower }, {}), {
      escapes: false,
      modes: false,
    });
    assert.deepEqual(
      pane.restorePaneConsole({ write: () => {}, isTTY: true }, { isTTY: true }, { cook: thrower }),
      { escapes: true, modes: false },
    );
  });

  it("does not call a redirected stdout a restored console", () => {
    // The mirror of the stdin case above, and it cost the same mis-report. The engine
    // turns the reporting modes *on* by writing to `CONOUT$` opened by name, so
    // `terminal-browser open <url> > log.txt` still gets the alternate screen, the
    // hidden cursor and any-motion mouse reporting applied to the pane -- while the
    // compensating write here goes into `log.txt`. Node cannot follow the engine to
    // the device (see `restorePaneConsole`), so the flag is set from the stream being
    // a console rather than from the write returning: the run that could not repair
    // the pane has to say so, or the report sends the user away from a pane that is
    // still on the alternate screen with escape bytes on every mouse move.
    const written = [];
    const redirected = pane.restorePaneConsole(
      { write: (chunk) => written.push(chunk) },
      { isTTY: true },
      { cook: () => true },
    );
    assert.deepEqual(redirected, { escapes: false, modes: true });
    // The write still goes out: it is free, and a stream Node did not mark is not
    // proof of a redirect. What it is not is evidence of a console.
    assert.deepEqual(written, [pane.DISABLE_REPORTING]);
    // `undefined` is what Node leaves on a pipe, so the test has to be `=== true`.
    const source = fs.readFileSync(path.join(REPO, "cli", "src", "pane.ts"), "utf8");
    const body = between(source, "export function restorePaneConsole", "// -- whose placement is it");
    assert.match(body, /out\.isTTY === true/, "a redirected stdout still counts as a console");
  });

  it("tells the user which redirect to drop when the escapes did not land", () => {
    // Naming the fix is the whole point of the flag. "could not be written to" was
    // the old wording and it describes only the EPIPE case -- a user whose stdout is
    // a file wrote it just fine, and needs to hear about the redirect instead.
    const outcome = { request: null, owned: null, cleared: false, searched: [] };
    const report = pane.paneClearReport({}, outcome, { escapes: false, modes: true }).join("\n");
    assert.match(report, /run this again with stdout on the pane/);
    assert.match(report, /without a redirect/);
    assert.ok(!/mouse reporting off/.test(report), report);
  });

  it("is run by the foreground wait, on the same path as the clear", () => {
    // Both are state the engine set on this pane and both are normally undone by the
    // same `Drop`, so the exits that skip one skip the other. Clearing the picture
    // and leaving the console on the alternate screen with the cursor hidden and
    // mouse reporting on is half a fix.
    const body = between(
      mainSource,
      "async function openInForeground",
      "async function attachHere",
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
  const marker = /const PANE_FILE: &str = "([^"]+)";/.exec(source);
  assert.ok(marker, "PANE_FILE is no longer where this test looks for it");
  const written = /format!\("\{\}\\n\{\}\\n", target\.pipe\(\), target\.session\(\)\)/.exec(source);
  assert.ok(written, "the marker's two lines are no longer written where this test looks");
  return { prefix: prefix[1], width: Number(file[1]), marker: marker[1] };
}

/** The pane every fixture below was drawn on, unless it says otherwise. */
const MINE = { pipe: "agwinterm", target: "pane-1" };

/**
 * A frame directory the way a killed browser leaves one.
 *
 * `mark` is `FrameDir::mark_pane`'s file: the pipe, then the session id. The engine
 * writes it with the first frame the host accepts over either route, so a directory
 * holding frames with no marker beside them is one this engine did not write — which
 * is why `mark: null` below is a fixture rather than an omission.
 *
 * `frames: 0` with a marker is a placement that went over shared memory: the
 * `image.frameshm` route (`frame_shm.rs`) writes no file, so the marker is the whole
 * of what it leaves. `frames: 0` with `mark: null` is the browser that died before
 * drawing anything, which is the engine's `!placed` — a directory exists, nothing
 * was ever placed.
 */
function leftoverFrames(root, pid, frames = 1, mark = MINE) {
  const dir = path.join(root, `${pane.FRAME_DIR_PREFIX}${pid}-0`);
  fs.mkdirSync(dir, { recursive: true });
  for (let seq = 0; seq < frames; seq += 1) {
    fs.writeFileSync(path.join(dir, `frame-${String(seq).padStart(8, "0")}.png`), "");
  }
  if (mark) {
    fs.writeFileSync(path.join(dir, pane.FRAME_PANE_FILE), `${mark.pipe}\n${mark.target}\n`);
  }
  return dir;
}

/** Path equality as the filesystem sees it, which on Windows ignores case. */
const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** A fresh, empty temp root per test, so one test's leftovers are not another's. */
function freshRoot(t, name) {
  const root = fs.mkdtempSync(path.join(scratch, `${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * `process.stdout` and `process.stdin` as recorders, plus the cooking child as one.
 *
 * `cook` is a seam rather than the real thing on purpose: letting it run would spawn
 * `cmd.exe` against the test runner's own console, and would only do anything at all
 * on one platform.
 */
function recorder() {
  const written = [];
  const calls = [];
  return {
    written,
    calls,
    // `isTTY` marks it as the pane's console rather than a redirect: without it the
    // escapes half reports as not having landed, which is its own test below.
    out: { write: (chunk) => written.push(chunk), isTTY: true },
    input: {
      isTTY: true,
      pause: () => calls.push("pause"),
    },
    cook: () => {
      calls.push("cook");
      return true;
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
    assert.equal(pane.FRAME_PANE_FILE, naming.marker);
    const root = fs.mkdtempSync(path.join(scratch, "naming-"));
    const dir = path.join(root, `${naming.prefix}4242-0`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `frame-${"0".repeat(naming.width)}.png`), "");
    fs.writeFileSync(path.join(dir, naming.marker), `${MINE.pipe}\n${MINE.target}\n`);
    assert.ok(
      pane.ownedFrames({ root, pane: MINE }),
      "the engine's own frame file is not recognised",
    );

    // The width is a pad, not a cap. A publisher whose sequence has run past it
    // writes a longer name, and a pattern anchored to the pad exactly would stop
    // recognising the frames right when the session has been up long enough to be
    // worth recovering.
    const long = path.join(root, `${naming.prefix}4243-0`);
    fs.mkdirSync(long);
    fs.writeFileSync(path.join(long, `frame-${"9".repeat(naming.width + 1)}.png`), "");
    fs.writeFileSync(path.join(long, naming.marker), `${MINE.pipe}\n${MINE.target}\n`);
    assert.equal(
      pane.ownedFrames({ root, pane: MINE, pid: 4243 })?.frames,
      1,
      "a sequence past the pad width is still this engine's frame",
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds the frames a killed browser left behind", (t) => {
    const root = freshRoot(t, "owned");
    const dir = leftoverFrames(root, 4242, 3);
    assert.deepEqual(pane.ownedFrames({ root, pane: MINE }), { dir, pid: 4242, frames: 3 });
  });

  it("owns nothing when the browser exited cleanly", (t) => {
    // `FrameDir`'s `Drop` removes the directory, and the engine has already sent
    // the clear. Nothing on this pane is ours to take down.
    const root = freshRoot(t, "clean");
    assert.equal(pane.ownedFrames({ root, pane: MINE }), null);
  });

  it("owns nothing when a browser died before it drew anything", (t) => {
    // The directory is created by `FramePublisher::new` and the first frame may
    // never arrive -- a refused pane, an unwritable frame directory, an instant
    // crash. `placed` would be false; so is this: no marker, no frame.
    const root = freshRoot(t, "undrawn");
    leftoverFrames(root, 4242, 0, null);
    assert.equal(pane.ownedFrames({ root, pane: MINE }), null);
    assert.equal(pane.ownedFrames({ root, pid: 4242 }), null);
  });

  it("owns a placement that went over shared memory, which left no frame file", (t) => {
    // `FramePublisher::publish_shm` marks the pane past the same `frame:0/0` guard
    // the file route does, and writes nothing else: the pixels went through a
    // mapping (`frame_shm.rs`). So the marker is the whole of the evidence, and a
    // rule that counted frame files read every wreck the fast path left as
    // "nothing of ours" -- on the exit path and in the verb alike, which left a
    // force-killed browser's page over a live shell with no command able to take it
    // down. The engine's own `clear` guard moved from `written` to `placed` for the
    // same reason; this is the CLI's half of that move.
    const root = freshRoot(t, "shm");
    const dir = leftoverFrames(root, 4242, 0);
    const owned = pane.ownedFrames({ root, pane: MINE });
    assert.equal(owned?.dir, dir);
    assert.equal(owned.frames, 0, "no frame file, and none invented");
    // The exit path's exact question adopts it too, marked for this pane or asked
    // without one.
    assert.equal(pane.ownedFrames({ root, pid: 4242, pane: MINE })?.dir, dir);
    assert.equal(pane.ownedFrames({ root, pid: 4242 })?.dir, dir);
    // And the marker still decides *whose*: another pane's is not ours.
    assert.equal(
      pane.ownedFrames({ root, pane: { pipe: "agwinterm", target: "pane-2" } }),
      null,
    );
  });

  it("is a shape the engine's fast path actually produces", () => {
    // Pinned against the Rust rather than assumed: the test above is only worth
    // having while `publish_shm` marks the pane and writes no frame. If the fast
    // path ever starts writing a file, or stops marking, the fixture is fiction.
    const source = fs.readFileSync(
      path.join(REPO, "engine", "crates", "pixel-core", "src", "frame_file.rs"),
      "utf8",
    );
    const body = between(source, "fn publish_shm(", "fn latch_unavailable(");
    assert.match(body, /self\.dir\.mark_pane\(/, "the fast path no longer marks the pane");
    assert.ok(
      !/write_frame\(|publish_encoded\(|next_path\(/.test(body),
      "the fast path now writes a frame file, so a marker-only wreck is no longer its shape",
    );
  });

  it("ignores directories that are not a publisher's", (t) => {
    const root = freshRoot(t, "foreign");
    const other = path.join(root, "some-other-tool-4242");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "frame-00000000.png"), "");
    assert.equal(pane.ownedFrames({ root, pane: MINE }), null);
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

  it("refuses a pid's own directory when the marker names another pane", (t) => {
    // A pid is unique among *live* processes and nothing more -- `frame_file.rs`
    // burns a counter because Windows recycles them, and `sweep_stale` leaves a
    // wreck standing for an hour. So the pid of a browser that died before drawing
    // can be the pid of one that drew on a different pane earlier the same hour, and
    // the exit path would clear that pane and delete the evidence it is still
    // painted. The marker outranks the pid on exactly that case.
    const root = freshRoot(t, "bypid-other");
    const theirs = leftoverFrames(root, 4242, 1, { pipe: "agwinterm", target: "pane-2" });
    assert.equal(pane.ownedFrames({ root, pid: 4242, pane: MINE }), null);
    assert.equal(fs.existsSync(theirs), true);
    // And the pid still owns its own, marked or not: an engine predating `PANE_FILE`
    // has to stay recoverable by the process that spawned it.
    const unmarked = freshRoot(t, "bypid-unmarked");
    leftoverFrames(unmarked, 4242, 1, null);
    assert.ok(
      pane.ownedFrames({ root: unmarked, pid: 4242, pane: MINE }),
      "the exit path lost frames no marker disowned",
    );
    // The marker folds case the way the object manager resolves a pipe name, and no
    // wider: `Agwinterm` recorded by the engine and `agwinterm` in this pane are one
    // instance. `AGWINTERM-<U+212A>IOSK` is not -- `FrameDir::mark_pane` only ever
    // writes a `valid_pipe_name`, so a marker that is not ASCII is one something
    // else planted, and a Unicode fold would adopt its directory as ours to delete.
    const cased = freshRoot(t, "marker-cased");
    leftoverFrames(cased, 4242, 1, { pipe: "Agwinterm", target: MINE.target });
    assert.ok(
      pane.ownedFrames({ root: cased, pane: MINE }),
      "one instance under two spellings read as two panes",
    );
    const kiosk = freshRoot(t, "marker-kelvin");
    const kelvinPane = { pipe: "agwinterm-kiosk", target: MINE.target };
    leftoverFrames(kiosk, 4242, 1, { pipe: "AGWINTERM-\u{212a}IOSK", target: MINE.target });
    assert.equal(pane.ownedFrames({ root: kiosk, pane: kelvinPane }), null);
  });

  it("owns nothing when the caller asked about a pid it does not have", (t) => {
    // `spawn` leaves `child.pid` undefined when it could not start the process at
    // all, and `openInForeground` passes `{ pid: child.pid }` regardless. Reading
    // that as "any pid" would restore the unconditional clear on the one path the
    // pid was added for: a browser that failed before its first frame -- a missing
    // artifact, a refused pane, an instant crash -- taking down whatever the pane
    // was showing before it started.
    const root = freshRoot(t, "nopid");
    leftoverFrames(root, 4242, 1);
    assert.ok(pane.ownedFrames({ root, pane: MINE }), "the broad question still finds it");
    assert.equal(pane.ownedFrames({ root, pid: undefined }), null);
  });

  it("sends no clear when the process it asked about never started", async (t) => {
    const host = hostOn(`winterm-owned-${process.pid}-nopid`);
    await host.listening;
    t.after(() => host.close());
    const root = freshRoot(t, "nopidclear");
    leftoverFrames(root, 4242, 1);

    const outcome = await pane.clearOwnedPaneFrame(
      inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" }),
      { root, pid: undefined, timeoutMs: 500 },
    );

    assert.equal(outcome.owned, null);
    assert.equal(outcome.cleared, false);
    assert.deepEqual(host.lines, [], "a failed spawn cleared a placement it never made");
  });

  it("sends no clear when the pid's directory was drawn on another pane", async (t) => {
    // A recycled pid, end to end: the exit path asks about the process it spawned and
    // the only directory named after it belongs to a browser that drew somewhere else
    // and is still there. Nothing is sent, and the evidence is not deleted.
    const host = hostOn(`winterm-owned-${process.pid}-recycled`);
    await host.listening;
    t.after(() => host.close());
    const root = freshRoot(t, "recycled");
    const theirs = leftoverFrames(root, 4242, 1, { pipe: host.name, target: "pane-2" });

    const outcome = await pane.clearOwnedPaneFrame(
      inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" }),
      { root, pid: 4242, timeoutMs: 500 },
    );

    assert.equal(outcome.owned, null);
    assert.equal(outcome.cleared, false);
    assert.deepEqual(host.lines, [], "a recycled pid cleared another pane's placement");
    assert.equal(fs.existsSync(theirs), true, "it deleted another pane's only evidence");
  });

  it("looks in every temp directory the engine could have chosen", (t) => {
    // Rust's `std::env::temp_dir()` is `GetTempPath2` -- TMP first -- and Node's
    // `os.tmpdir()` reads TEMP first. A shell that sets the two apart puts the
    // engine's frames somewhere `os.tmpdir()` alone would never look, and the verb
    // would report "nothing of ours to clear" at a pane that is still painted.
    const roots = pane.searchedRoots();
    for (const name of ["TMP", "TEMP"]) {
      const value = process.env[name]?.trim();
      if (!value) continue;
      const resolved = path.resolve(value);
      assert.ok(
        roots.some((root) =>
          process.platform === "win32"
            ? root.toLowerCase() === resolved.toLowerCase()
            : root === resolved,
        ),
        `${name} is not among the roots that would be searched`,
      );
    }
    // An explicit root is still the only one, which is what every test here relies on.
    const only = freshRoot(t, "onlyroot");
    assert.deepEqual(pane.searchedRoots({ root: only }), [only]);
  });

  it("searches the temp directories the caller's environment names", (t) => {
    // Root discovery and addressing are two halves of one answer. `clearOwnedPaneFrame`
    // addresses the pane out of the environment it was handed, so reading TMP and TEMP
    // off `process.env` instead would let it report "nothing of ours to clear" over a
    // list of roots the caller never named -- and the report's whole claim is that it
    // names what it actually read.
    const root = freshRoot(t, "envroot");
    const other = freshRoot(t, "envroot-temp");
    // The whole root set, not "is ours among them". `os.tmpdir()` answers for *this*
    // process's environment and never for the one handed in, so a caller that names
    // its own gets its own and nothing else -- otherwise a wreck under a directory it
    // never mentioned is adopted, reported and retired on its behalf.
    assert.deepEqual(pane.searchedRoots({ env: { TMP: root, TEMP: other } }), [root, other]);
    assert.deepEqual(pane.searchedRoots({ env: { TMP: root, TEMP: root } }), [root]);
    assert.deepEqual(pane.searchedRoots({ env: {} }), []);
    // And the default still reaches the fallback `TMP`/`TEMP` alone cannot spell.
    assert.ok(
      pane.searchedRoots().some((seen) => samePath(seen, os.tmpdir())),
      "the process's own temp directory is not searched by default",
    );
  });

  it("follows GetTempPath2 into the profile when neither TMP nor TEMP is set", () => {
    // The one point where the two fallback chains part company. `os.tmpdir()` ends at
    // `%SystemRoot%\\temp`; `GetTempPath2` -- which is what the engine's
    // `std::env::temp_dir()` calls -- ends at `%USERPROFILE%` first. With both
    // variables unset the engine writes its frames under the profile, and a search
    // that stopped at `os.tmpdir()` would report "nothing of ours to clear" at a
    // painted pane -- and `openInForeground`'s exit-path clear, gated on the same
    // answer, would decline too.
    //
    // Mutated and restored in the same tick rather than through `t.after`, because
    // `frameRoots` reads `process.env` live and nothing else here may see it changed.
    const saved = { TMP: process.env.TMP, TEMP: process.env.TEMP };
    const profile = process.env.USERPROFILE?.trim();
    let roots;
    try {
      delete process.env.TMP;
      delete process.env.TEMP;
      roots = pane.searchedRoots();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.deepEqual({ TMP: process.env.TMP, TEMP: process.env.TEMP }, saved);
    if (!profile) return; // no profile to fall back to; nothing this test can claim
    assert.ok(
      roots.some((root) => samePath(root, path.resolve(profile))),
      `the profile fallback is not searched: ${roots.join(" or ")}`,
    );
    // And it is not there on an ordinary machine, where both variables are set: an
    // extra root is a whole home directory read on every run, and a name in the
    // report the user never chose.
    if (process.env.TMP?.trim() || process.env.TEMP?.trim()) {
      assert.ok(
        !pane.searchedRoots().some((root) => samePath(root, path.resolve(profile))),
        "the profile is searched even though TMP or TEMP names a directory",
      );
    }
  });

  it("finds a wreck under the TMP the caller handed it, not the one node prefers", async (t) => {
    // The end of the same thread: a pipe nobody is listening on, so nothing is sent,
    // and what is under test is only which directories were read.
    const root = freshRoot(t, "envwreck");
    const pipe = `winterm-envroot-${process.pid}`;
    const dir = leftoverFrames(root, 4242, 1, { pipe, target: "pane-1" });
    const outcome = await pane.clearOwnedPaneFrame(
      inPane({ AGWINTERM_PIPE: pipe, AGWINTERM_SESSION_ID: "pane-1", TMP: root, TEMP: root }),
      { timeoutMs: 300 },
    );

    assert.equal(outcome.owned?.dir, dir, "the wreck under the caller's TMP was not found");
    assert.ok(
      outcome.searched.some((seen) =>
        process.platform === "win32" ? seen.toLowerCase() === root.toLowerCase() : seen === root,
      ),
      `the report named ${outcome.searched.join(" or ")} rather than the roots it read`,
    );
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
    assert.equal(pane.ownedFrames({ root, pane: MINE }).pid, 2222);
  });

  it("never throws on a temp directory it cannot read", () => {
    assert.equal(pane.ownedFrames({ root: path.join(scratch, "nothing-here"), pane: MINE }), null);
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
    leftoverFrames(root, 4242, 2, { pipe: host.name, target: "pane-1" });

    const outcome = await pane.clearOwnedPaneFrame(
      inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" }),
      { root, timeoutMs: 1_000 },
    );

    assert.equal(outcome.cleared, true);
    assert.equal(outcome.owned.frames, 2);
    assert.equal(host.lines.length, 1);
    assert.deepEqual(JSON.parse(host.lines[0]), { cmd: "image.clear", target: "pane-1" });
  });

  it("takes the evidence with the placement, so a repaired pane reads as repaired", async (t) => {
    // The directory is `FrameDir`'s `Drop` not having run. Once the host has
    // answered the clear that is no longer true of it, and leaving it would report
    // the same wreck as freshly found on every later run -- which is the one
    // distinction this verb exists to draw. It would also go on authorising clears
    // against panes it never drew on until `sweep_stale` reaches it an hour later.
    const host = hostOn(`winterm-owned-${process.pid}-consume`);
    await host.listening;
    t.after(() => host.close());
    const root = freshRoot(t, "consume");
    const dir = leftoverFrames(root, 4242, 2, { pipe: host.name, target: "pane-1" });
    const env = inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" });

    const first = await pane.clearOwnedPaneFrame(env, { root, timeoutMs: 1_000 });
    assert.equal(first.cleared, true);
    assert.equal(fs.existsSync(dir), false, "the frame directory outlived the clear");

    const again = await pane.clearOwnedPaneFrame(env, { root, timeoutMs: 500 });
    assert.equal(again.owned, null, "a second run found the wreck it had already fixed");
    assert.equal(again.cleared, false);
    assert.equal(host.lines.length, 1, "a second image.clear went to an already-clear pane");
  });

  it("retires every spent wreck, not only the one it reported", async (t) => {
    // A pane holds one placement, so a pane wrecked twice has one picture on it and
    // the older wreck's was replaced long before this run started. The clear that
    // just went out settles both. Retiring only the newest would leave the older
    // marker looking like fresh ownership, and the next `pane-clear` would send a
    // second `image.clear` at a pane somebody else may have painted since -- which
    // is the one thing the ownership rule exists to stop.
    const host = hostOn(`winterm-owned-${process.pid}-twice`);
    await host.listening;
    t.after(() => host.close());
    const root = freshRoot(t, "twice");
    const mark = { pipe: host.name, target: "pane-1" };
    const older = leftoverFrames(root, 1111, 1, mark);
    const newer = leftoverFrames(root, 2222, 1, mark);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(newer, later, later);
    const env = inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" });

    const first = await pane.clearOwnedPaneFrame(env, { root, timeoutMs: 1_000 });
    assert.equal(first.cleared, true);
    assert.equal(first.owned.pid, 2222, "it reported a wreck other than the newest");
    assert.equal(fs.existsSync(newer), false, "the reported wreck outlived the clear");
    assert.equal(
      fs.existsSync(path.join(older, pane.FRAME_PANE_FILE)),
      false,
      "an older marker was left standing to authorise a second clear",
    );

    const again = await pane.clearOwnedPaneFrame(env, { root, timeoutMs: 500 });
    assert.equal(again.owned, null, "a spent wreck was read as fresh ownership");
    assert.equal(host.lines.length, 1, "a second image.clear went to a repaired pane");
  });

  it("gives up its claim on the pane when the directory will not delete", async (t) => {
    // `retire`'s fallback, and the reason the marker is not best-effort in the way
    // the directory is: the marker *is* the directory's claim on this pane, so a
    // claim that outlives the placement it was made for authorises the next run's
    // `image.clear` at a pane somebody else may have painted since. What the
    // fallback leaves behind is an unattributed wreck, which the broad question
    // already declines to own.
    //
    // A directory somebody's working directory is inside is how Windows says no to
    // `fs.rmSync`; a platform that allows the delete has no fallback to reach.
    if (process.platform !== "win32") {
      t.skip("only Windows refuses to remove a directory a process is standing in");
      return;
    }
    const host = hostOn(`winterm-owned-${process.pid}-stuck`);
    await host.listening;
    t.after(() => host.close());
    // One teardown rather than `freshRoot`'s: the working directory has to move back
    // out before anything tries to remove the root, and `after` hooks run in the
    // order they were registered.
    const where = process.cwd();
    const root = fs.mkdtempSync(path.join(scratch, "stuck-"));
    t.after(() => {
      process.chdir(where);
      fs.rmSync(root, { recursive: true, force: true });
    });
    const dir = leftoverFrames(root, 4242, 1, { pipe: host.name, target: "pane-1" });
    const held = path.join(dir, "held");
    fs.mkdirSync(held);
    process.chdir(held);
    const env = inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" });

    const first = await pane.clearOwnedPaneFrame(env, { root, timeoutMs: 1_000 });
    assert.equal(first.cleared, true);
    assert.equal(first.owned.dir, dir);
    assert.equal(fs.existsSync(dir), true, "the directory went after all, so nothing fell back");
    assert.equal(
      fs.existsSync(path.join(dir, pane.FRAME_PANE_FILE)),
      false,
      "a spent claim on this pane was left standing",
    );

    const again = await pane.clearOwnedPaneFrame(env, { root, timeoutMs: 500 });
    assert.equal(again.owned, null, "an unattributed wreck was read as fresh ownership");
    assert.equal(again.cleared, false);
    assert.equal(host.lines.length, 1, "a second image.clear went to a repaired pane");
  });

  it("keeps the evidence when the host never answered", async (t) => {
    // Nothing was confirmed taken back, so nothing has been repaired. Deleting the
    // directory here would throw away the only record that the pane is still wrong.
    const root = freshRoot(t, "unanswered");
    const pipe = `winterm-nobody-${process.pid}`;
    const dir = leftoverFrames(root, 4242, 1, { pipe, target: "pane-1" });

    const outcome = await pane.clearOwnedPaneFrame(
      inPane({ AGWINTERM_PIPE: pipe, AGWINTERM_SESSION_ID: "pane-1" }),
      { root, timeoutMs: 300 },
    );

    assert.equal(outcome.cleared, false);
    assert.equal(fs.existsSync(dir), true, "the only record of the wreck was deleted");
  });

  it("reads the host's answer rather than treating any byte as a repair", async (t) => {
    // `{"ok":false,"error":"no session"}` is the failure the whole module exists for:
    // the pane closed, or this build named no window and another one is in front. It
    // arrives as bytes on the pipe exactly as a success does, so a client that
    // settles on `data` reports "cleared" at a pane that is still painted — and then
    // deletes the frames, so the next run reports nothing left to fix.
    const host = hostOn(
      `winterm-owned-${process.pid}-refused`,
      '{"ok":false,"error":"no session \\"pane-1\\""}',
    );
    await host.listening;
    t.after(() => host.close());
    const root = freshRoot(t, "refused");
    const dir = leftoverFrames(root, 4242, 2, { pipe: host.name, target: "pane-1" });
    const env = inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" });

    const outcome = await pane.clearOwnedPaneFrame(env, { root, timeoutMs: 1_000 });

    assert.equal(outcome.cleared, false, "a refusal was read as a cleared pane");
    assert.match(outcome.refused, /no session/);
    assert.equal(fs.existsSync(dir), true, "the evidence was consumed by a clear that failed");

    // And the report says so, rather than announcing a repair that did not happen.
    const report = pane.paneClearReport(env, outcome, { escapes: true, modes: true }).join("\n");
    assert.match(report, /the host refused the image\.clear/);
    assert.match(report, /no session/);
    assert.ok(!/frame: +cleared/.test(report), report);
  });

  it("leaves another pane's wreck to that pane", async (t) => {
    // Frame directories are named after a pid, never a pane, so the newest one on
    // the machine has nothing to do with the pane the verb was run in. Two browsers
    // wrecked in two panes used to mean the first `pane-clear` repaired its own pane
    // on the *other* pane's evidence -- naming the wrong pid, and then deleting the
    // directory the second pane's own run needed. A live browser elsewhere is worse:
    // its directory gains a file every frame, so it is always the newest match.
    const host = hostOn(`winterm-owned-${process.pid}-mine`);
    await host.listening;
    t.after(() => host.close());
    const root = freshRoot(t, "otherpane");
    const mine = leftoverFrames(root, 4242, 1, { pipe: host.name, target: "pane-1" });
    const theirs = leftoverFrames(root, 9999, 3, { pipe: host.name, target: "pane-2" });
    // Newer, so the machine-wide question would pick it every time.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(theirs, later, later);

    const outcome = await pane.clearOwnedPaneFrame(
      inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" }),
      { root, timeoutMs: 1_000 },
    );

    assert.equal(outcome.owned.dir, mine, "it adopted a wreck from another pane");
    assert.equal(outcome.owned.pid, 4242);
    assert.equal(fs.existsSync(theirs), true, "it deleted another pane's only evidence");
    assert.equal(fs.existsSync(mine), false, "its own evidence outlived the clear");
  });

  it("adopts nothing from a directory that names no pane at all", async (t) => {
    // An engine predating the marker, or one whose marker could not be written. The
    // safe reading is "not mine": an unattributed wreck is indistinguishable from
    // another pane's, and clearing on it is the guess the rule forbids.
    const root = freshRoot(t, "unmarked");
    leftoverFrames(root, 4242, 2, null);
    assert.equal(pane.ownedFrames({ root, pane: MINE }), null);
    // The pid question is unaffected: `openInForeground` knows first-hand which
    // process it spawned, and the directory is named after it.
    assert.ok(pane.ownedFrames({ root, pid: 4242 }), "the exit path lost its own frames");
    // And so is the question asked where no clear can follow from the answer.
    assert.ok(pane.ownedFrames({ root, pane: "any" }), "nothing could be reported at all");
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
    const dir = leftoverFrames(root, 4242, 5, { pipe: host.name, target: "pane-1" });
    const rec = recorder();

    const code = await pane.paneClearCommand({
      env: inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" }),
      out: rec.out,
      input: rec.input,
      cook: rec.cook,
      root,
      timeoutMs: 1_000,
    });

    assert.equal(code, 0);
    assert.equal(host.lines.length, 1, "the frame half did not run");
    assert.deepEqual(JSON.parse(host.lines[0]), { cmd: "image.clear", target: "pane-1" });
    assert.ok(rec.written.includes(pane.DISABLE_REPORTING), "the console half did not run");
    // Observed rather than read off the source: `DISABLE_REPORTING` ends with
    // `?1049l`, so a report written first lands on the alternate screen and goes with
    // it. The order is what makes a command that worked look like one that did.
    assert.equal(
      rec.written[0],
      pane.DISABLE_REPORTING,
      "the report was written before the console came back",
    );
    assert.deepEqual(rec.calls, ["cook", "pause"], "the SetConsoleMode half did not run");
    assert.match(rec.text, /out of raw mode/, "the modes half ran and was not reported");
    assert.match(rec.text, /frame: +cleared/);
    assert.ok(rec.text.includes(dir), "it does not say which frames it found");
    assert.match(rec.text, /pid 4242/);
  });

  it("repairs a pane the fast path painted, where there is no frame file to count", async (t) => {
    // The wreck a force-killed browser leaves on a host with `image.frameshm`: the
    // marker and nothing else. The report must not read "0 frame(s)" at a user
    // standing in front of a pane that is plainly painted.
    const host = hostOn(`winterm-verb-${process.pid}-shm`);
    await host.listening;
    t.after(() => host.close());
    const root = freshRoot(t, "verb-shm");
    const dir = leftoverFrames(root, 4242, 0, { pipe: host.name, target: "pane-1" });
    const rec = recorder();

    const code = await pane.paneClearCommand({
      env: inPane({ AGWINTERM_PIPE: host.name, AGWINTERM_SESSION_ID: "pane-1" }),
      out: rec.out,
      input: rec.input,
      cook: rec.cook,
      root,
      timeoutMs: 1_000,
    });

    assert.equal(code, 0);
    assert.equal(host.lines.length, 1, "the frame half did not run");
    assert.deepEqual(JSON.parse(host.lines[0]), { cmd: "image.clear", target: "pane-1" });
    assert.match(rec.text, /frame: +cleared/);
    assert.match(rec.text, /shared memory/, "it does not say what kind of wreck it found");
    assert.ok(!/0 frame\(s\)/.test(rec.text), `a marker-only wreck reported as nothing: ${rec.text}`);
    assert.ok(rec.text.includes(dir), "it does not say where the evidence was");
    assert.equal(fs.existsSync(dir), false, "the evidence did not go with the placement");
  });

  it("reports the modes as not restored when the verb's cooking child will not run", async (t) => {
    // The seam the verb forwards, driven the other way. `paneClearCommand` owns the
    // wiring between `PaneClearOptions.cook` and `restorePaneConsole`, and a report
    // that claims a restore the child never made is the one wording that sends a user
    // away from a console that still does not echo.
    const root = freshRoot(t, "verb-nocook");
    const rec = recorder();

    const code = await pane.paneClearCommand({
      env: {},
      out: rec.out,
      input: rec.input,
      cook: () => false,
      root,
    });

    assert.equal(code, 0);
    assert.match(rec.text, /the input modes could not be put back from here/);
    assert.ok(!/out of raw mode/.test(rec.text), rec.text);
    assert.deepEqual(rec.calls, ["pause"], "the recorder's own cook was used instead");
  });

  it("restores the console before it prints, or the report is thrown away", () => {
    // `DISABLE_REPORTING` ends with `?1049l`. Printing first would put the report on
    // the alternate screen and then leave it -- the one arrangement where a command
    // that worked is indistinguishable from one that did nothing.
    const source = fs.readFileSync(path.join(REPO, "cli", "src", "pane.ts"), "utf8");
    const body = between(source, "export async function paneClearCommand");
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
      cook: rec.cook,
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
    const absent = `winterm-verb-${process.pid}-absent`;
    leftoverFrames(root, 4242, 1, { pipe: absent, target: "pane-1" });
    const rec = recorder();

    const code = await pane.paneClearCommand({
      env: inPane({ AGWINTERM_PIPE: absent, AGWINTERM_SESSION_ID: "pane-1" }),
      out: rec.out,
      input: rec.input,
      cook: rec.cook,
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
      cook: rec.cook,
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

    const code = await pane.paneClearCommand({ env: {}, out: rec.out, input: rec.input, cook: rec.cook, root });

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

    await pane.paneClearCommand({ env: {}, out: rec.out, input: rec.input, cook: rec.cook, root });

    assert.match(rec.text, /2 frame\(s\)/);
    assert.match(rec.text, /run this from the pane/);
  });

  it("reports a console it could not write to rather than claiming success", () => {
    const thrower = () => {
      throw new Error("EPIPE");
    };
    const report = pane.paneClearReport(
      {},
      { request: null, owned: null, cleared: false, searched: pane.searchedRoots() },
      { escapes: false, modes: false },
    );
    assert.match(report.join("\n"), /console: the escapes did not reach a console/);
    // And the command survives the stream that did it.
    assert.doesNotThrow(() => pane.restorePaneConsole({ write: thrower }, {}));
  });

  it("names the guard, not a repair, when it found a wreck it may not clear", () => {
    // The refusal branch with something found. Under `TERMINAL_BROWSER_ALLOW_PIPE`
    // there is no pane this build will address, so the search that found these frames
    // was the machine-wide one -- the report has to say the clear was withheld, and
    // that what it named is the newest wreck rather than provably this pane's.
    const env = inPane({
      AGWINTERM_SESSION_ID: "pane-1",
      [pane.ALLOW_PIPE_VAR]: "agwinterm-dev",
    });
    // Backslash doubled, per the rule `tools/launcher/launch.test.mjs` states: `\w`
    // is an unrecognised escape, so "T:\wreck" written singly is "T:wreck", and `\w`
    // on the pattern side is the word-character class, which consumes the missing
    // separator's neighbour and passes. A frame directory is always
    // backslash-separated (`path.join(root, name)`), so the fixture has to be too.
    const dir = "T:\\wreck";
    assert.ok(dir.includes("\\"), "the fixture must keep its separators to be worth asserting");
    const report = pane
      .paneClearReport(
        env,
        {
          request: null,
          owned: { dir, pid: 4242, frames: 2 },
          cleared: false,
          refused: null,
          searched: ["T:\\"],
        },
        { escapes: true, modes: true },
      )
      .join("\n");
    assert.match(report, /not addressable/);
    assert.match(report, new RegExp(pane.ALLOW_PIPE_VAR));
    assert.match(report, /2 frame\(s\) left in T:\\wreck/);
    assert.match(report, /no image\.clear was sent/);
    assert.match(report, /rather than provably this pane's/);
    assert.ok(!/frame: +cleared/.test(report), report);
  });

  it("does not read a refused guard as there being no pane here", () => {
    // The same refusal with nothing found. "There is no agwinterm pane" would be a
    // lie to someone standing in one, and it reads as a shell problem rather than as
    // a variable they set -- which is the one thing they can undo.
    const env = inPane({
      AGWINTERM_SESSION_ID: "pane-1",
      [pane.ALLOW_PIPE_VAR]: "agwinterm-dev",
    });
    const report = pane
      .paneClearReport(
        env,
        { request: null, owned: null, cleared: false, refused: null, searched: ["T:\\"] },
        { escapes: true, modes: true },
      )
      .join("\n");
    assert.match(report, /not addressable/);
    assert.match(report, /would have withheld the image\.clear in any case/);
    assert.ok(!/no agwinterm pane in this environment/.test(report), report);
  });

  it("reports the escapes that never went out while the input modes did go back", () => {
    // The halves fail apart in both directions. A console whose stdout is a redirect
    // still has a console for the cooking child to inherit -- the modes half can land
    // where the escapes half did not -- and claiming the full restore there sends a
    // user away from a pane still on the alternate screen.
    const half = pane
      .paneClearReport(
        {},
        { request: null, owned: null, cleared: false, refused: null, searched: [] },
        { escapes: false, modes: true },
      )
      .join("\n");
    assert.match(half, /console: the escapes did not reach a console/);
    assert.match(half, /the input modes are back/);
    assert.ok(!/nothing was restored/.test(half), half);
  });

  it("does not claim the input modes are back when there was no tty to ask", () => {
    // `terminal-browser pane-clear | tee log.txt` gets the escapes and not the
    // `SetConsoleMode` half, because a redirected stdin is not the console the
    // cooking child would have to inherit. Reporting the full restore there is the
    // one wording that tells a user with a console that still does not echo that it
    // was fixed.
    const outcome = { request: null, owned: null, cleared: false, searched: pane.searchedRoots() };
    const half = pane.paneClearReport({}, outcome, { escapes: true, modes: false }).join("\n");
    assert.match(half, /console: mouse reporting off/);
    assert.match(half, /the input modes could not be put back from here/);
    assert.match(half, /run this again with stdin on the pane/);
    assert.ok(!/out of raw mode/.test(half), half);

    const whole = pane.paneClearReport({}, outcome, { escapes: true, modes: true }).join("\n");
    assert.match(whole, /out of raw mode/);
  });
});

describe("how the CLI dispatches pane-clear", () => {
  const main = between(mainSource, "async function main(");
  const branch = between(main, 'command === "pane-clear"');

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
  const body = between(mainSource, "async function openInForeground", "async function attachHere");

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
