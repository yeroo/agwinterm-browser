import fs from "node:fs";
import path from "node:path";

import { app } from "electron";
// A deep import, because `pixel-react`'s index does not export the store and
// adding an export there would be a divergence from a vendored file for one
// symbol. The package has no `exports` map, so the path is stable.
import { engineLogs } from "pixel-react/dist/devtools/stores.js";

import { forwardEngineWarnings } from "./engine-log";
import { callerCwd, FOREGROUND_SIGNALS } from "./entry";
import { createSession } from "./session/session";
import type { SessionHandle } from "./session/session";

// The other half of the process model decided in `docs/design/03-process-model.md`:
// one browser process per pane, hosting exactly one session, running in the
// console it was launched from.
//
// The only thing that distinguishes it from a daemon session is the absence of a
// `tty` path. That is not a gap to fill later — it is the whole point. `tty` names
// *someone else's* terminal, which is the thing Windows cannot express; leaving it
// unset routes `createRoot` down its existing no-tty branch
// (`pixel-react/src/index.ts:262-264`), where the engine talks to the console the
// process is already in. Upstream already supports that shape; the port supplies
// the Windows backend behind it (Task 4/5).

/**
 * The file `claimProfile` writes into the profile directory it took.
 *
 * Spelled out again rather than imported because `browser/src/profile.ts` is
 * vendored and does not export it, and adding an export there would buy a second
 * divergence from upstream for a string. `docs/design/UPSTREAM.md` names the one
 * divergence that file is worth; this is not it. The name is pinned against
 * `profile.ts` by `tools/browser/foreground.test.mjs`, so the duplication cannot
 * drift silently.
 */
const PROFILE_LOCK = "terminal-browser.lock";

/**
 * Drops this process's claim on its profile, if it still holds one.
 *
 * `claimProfile` removes the lock from Electron's `will-quit`, and `will-quit` is
 * the one event this shape never sees: Electron specifies that `app.exit`
 * terminates immediately without emitting it, and `app.exit` is how a foreground
 * browser ordinarily ends — both on a signal and when the session closes itself.
 * So upstream's cleanup is correct upstream and unreachable here, and the lock
 * outlived every normal quit. The next launch then read a lock naming a pid
 * Windows had since reissued to something living, skipped to the next numbered
 * directory, and gave the user a profile with none of their cookies in it. That
 * reads as being logged out, which is why this is worth a fix and not a note.
 *
 * Exported, and called from `main.tsx` and `daemon.ts` as well as from here,
 * because `claimProfile()` runs in `main.tsx` *before* the shape is chosen: every
 * `app.exit` in this process leaks the lock, not only the two below. It lives in
 * this file rather than a module of its own because this is the shape that actually
 * reaches those exits on Windows; `tools/browser/foreground.test.mjs` checks every
 * exit site in `browser/src` against it, so a new one cannot be added silently.
 *
 * Three properties, each of which is a way this could be worse than the leak:
 *
 *   - **Only our own lock.** A holder that is not this pid is someone else's live
 *     browser, and unlinking it would invite a third process onto their profile —
 *     the same ownership rule `FramePublisher::clear` and `pane-clear` follow.
 *   - **Safe with nothing owned.** `claimProfile` falls back to a `mkdtemp`
 *     directory with no lock in it when all 32 are taken, and this runs on that
 *     path too.
 *   - **Safe twice.** Both exit routes below are in flight on every signal exit, and
 *     `closing` is not what keeps that to one release. `stop` sets the flag itself
 *     and then calls `session.close`, which is `Session.shutdown`, which ends by
 *     calling `onClose` *synchronously* — so `onClose` schedules its `setImmediate`
 *     from inside `stop`, and `stop` then schedules its own 200 ms timer on top. What
 *     makes that a single release is the first `app.exit` ending the process before
 *     the second callback runs; the `closing` guard covers the other ordering, a
 *     signal arriving after the session already closed itself. The wider reason this
 *     has to be idempotent is `main.tsx`, which registers this as a Node `exit`
 *     handler *as well* as calling it explicitly, because neither covers the other: a
 *     throw from a callback the IIFE is no longer awaiting reaches no explicit call,
 *     and `app.exit` is not specified to run Node's exit handlers. On any exit where
 *     both do run this is called twice, and a shutdown path that throws on its second
 *     call is a strictly worse bug than the one it was added to fix.
 *
 * All three land as "read it, check it, remove it, and treat every failure as
 * nothing to do" — there is no failure here worth interrupting an exit for.
 */
export function releaseProfileLock(): void {
  try {
    const lock = path.join(app.getPath("userData"), PROFILE_LOCK);
    if (Number(fs.readFileSync(lock, "utf8")) !== process.pid) return;
    fs.rmSync(lock, { force: true });
  } catch {
    // Nothing owned, already released, or the directory went with the profile.
  }
}

export async function runForeground(cdpPort: number | null, argv: string[]): Promise<void> {
  let session: SessionHandle | null = null;
  let closing = false;

  const stop = (code: number) => {
    if (closing) return;
    closing = true;
    try {
      session?.close(code);
    } catch {}
    // The fallback exit, not a grace period: whenever `session.close` reaches
    // `Session.shutdown`'s last line, `onClose` fires synchronously from inside the
    // `try` above and its `setImmediate` ends the process long before this timer —
    // see the "Safe twice" note on `releaseProfileLock`. What is left for this to
    // cover is the paths where `onClose` never runs at all: a signal arriving before
    // `createSession` has assigned `session`, or a `shutdown` that threw into the
    // `catch {}` on its way there. The delay is what gives a session that is midway
    // through tearing its surfaces down a chance to finish first.
    setTimeout(() => {
      releaseProfileLock();
      app.exit(code);
    }, 200);
  };
  // All four, and for the reason `cli/src/launch.ts` gives for its own list: the
  // point of listening is not to handle them but to *not be killed by them*. Node
  // terminates immediately on one of these with no listener, and terminating here
  // skips `Session.shutdown` — no `flushStorageData`, so storage written since
  // Chromium's last autosave is lost; no `Registry.dispose`, so the `instances` row
  // outlives the process with a pid Windows will hand to someone else; and no
  // `root.stop()`, so the engine's `Drop` never runs and the pane keeps the last
  // frame and the alternate screen. SIGBREAK is Ctrl+Break and SIGHUP a closing
  // console window — both reach every process attached to the console, and both
  // were missing. `tools/process-model/entry.test.mjs` pins this against the CLI's
  // list, which the two halves have to agree on.
  for (const [signal, code] of FOREGROUND_SIGNALS) process.on(signal, () => stop(code));

  // The engine's warnings, to fd 2 — which under the CLI is the log file
  // `openInForeground` opened (`stderr.log` under `LOGS_DIR`), and is the only
  // place a foreground browser's warnings can be read back from: devtools are off
  // in this shape, and `engineLogs` is otherwise a buffer nothing reads
  // (`engine-log.ts`). Not when fd 2 is a console: that is a browser started by
  // hand (`tools/milestone/run-milestone.cmd`), and a line written there paints
  // over the frame the host is holding as a placement — the same reason the CLI
  // redirects Electron's own chatter. Installed before the session so the first
  // warning the engine emits is not missed; never uninstalled, because the process
  // ends with the session.
  if (process.stderr.isTTY !== true) {
    forwardEngineWarnings(engineLogs, (line) => {
      process.stderr.write(line);
    });
  }

  session = createSession({
    key: `${process.pid}-1`,
    argv,
    env: process.env,
    // Not `process.cwd()`: that is `browser/`, the directory this process was
    // spawned in. The caller's is the one a relative url, `--preload` or
    // `--main-script` has to resolve against.
    cwd: callerCwd(process.env, process.cwd()),
    cdpPort,
    onClose: (code) => {
      closing = true;
      // Deferred by one turn of the loop, and that turn is load-bearing.
      // `Session.shutdown` ends here synchronously, and one of the things it has
      // just done is `Registry.dispose`, which deletes this browser's `instances`
      // row through the store's *async* proxy client. `app.exit` in the same tick
      // runs before that microtask ever drains, so the row outlived the process --
      // and `listInstances` prunes by pid, so once Windows recycled the pid the
      // phantom row was permanent and every `ls` and `new-tab` had to disambiguate
      // against a browser that had been gone for days. `setImmediate` drains the
      // microtask queue first, which is exactly what the delete is waiting in.
      setImmediate(() => {
        releaseProfileLock();
        app.exit(code);
      });
    },
  });
  await session.ready;
}
