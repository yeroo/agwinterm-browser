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
  it("clears after the child exits, not before", () => {
    // The ordering is the whole point: clearing before the wait would take the
    // picture down while the browser is still drawing it.
    const wait = mainSource.indexOf('child.on("exit"');
    const clear = mainSource.indexOf("clearPaneFrame(process.env)");
    assert.ok(wait > 0, "openInForeground no longer waits for the child");
    assert.ok(clear > wait, "the clear does not follow the wait");
  });

  it("does not let the clear decide the exit code", () => {
    // The browser's exit code is the pane's exit code (`docs/design/03-process-model.md`).
    // A failed cleanup of a placement that is already gone must not overwrite it.
    const body = mainSource.slice(
      mainSource.indexOf("async function openInForeground"),
      mainSource.indexOf("async function attachHere"),
    );
    assert.match(body, /const exited = await new Promise<number>/);
    assert.match(body, /await clearPaneFrame\(process\.env\);\s*\n\s*return exited;/);
  });
});
