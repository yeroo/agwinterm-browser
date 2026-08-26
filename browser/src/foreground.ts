import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

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
 * Three properties, each of which is a way this could be worse than the leak:
 *
 *   - **Only our own lock.** A holder that is not this pid is someone else's live
 *     browser, and unlinking it would invite a third process onto their profile —
 *     the same ownership rule `FramePublisher::clear` and `pane-clear` follow.
 *   - **Safe with nothing owned.** `claimProfile` falls back to a `mkdtemp`
 *     directory with no lock in it when all 32 are taken, and this runs on that
 *     path too.
 *   - **Safe twice.** Both exit routes can be in flight at once (a signal during
 *     an `onClose` teardown), and a shutdown path that throws on its second call
 *     is a strictly worse bug than the one it was added to fix.
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
    // Give the session a beat to tear the surfaces down before the process goes.
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
