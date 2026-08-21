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
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

import esbuild from "esbuild";

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
const mainSource = fs.readFileSync(path.join(REPO, "cli", "src", "main.ts"), "utf8");

const PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * A control server on a real pipe, recording the lines it is sent.
 *
 * `answer: null` accepts the line and never replies, which is the host that has
 * stopped answering — the case the client's timeout exists for.
 */
function hostOn(name, answer = '{"ok":true,"result":"cleared"}') {
  const endpoint = PIPE_PREFIX + name;
  const lines = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        lines.push(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (answer !== null) socket.write(`${answer}\n`);
      }
    });
    socket.on("error", () => {});
  });
  const listening = new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(endpoint);
  });
  return { endpoint, name, lines, server, listening, close: () => server.close() };
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
    const clear = body.indexOf("clearPaneFrame(process.env)");
    assert.ok(wait > 0, "openInForeground no longer waits for the child");
    assert.ok(clear > wait, "the clear does not follow the wait");
  });

  it("does not let the clear decide the exit code", () => {
    // The browser's exit code is the pane's exit code (`docs/design/03-process-model.md`).
    // A failed cleanup of a placement that is already gone must not overwrite it.
    assert.match(body, /const code = await Promise\.race/);
    assert.match(body, /await clearPaneFrame\(process\.env\);[\s\S]*return code;/);
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
    const clear = body.indexOf("clearPaneFrame(process.env)");
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
    const clear = body.indexOf("clearPaneFrame(process.env)");
    const restore = body.indexOf("restorePaneConsole()");
    assert.ok(restore > clear, "the console is not restored after the frame is cleared");
    assert.ok(
      restore < body.indexOf("return code"),
      "the restore does not happen before the exit code is returned",
    );
  });
});
