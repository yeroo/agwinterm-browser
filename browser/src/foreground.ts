import { app } from "electron";

import { callerCwd } from "./entry";
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
    setTimeout(() => app.exit(code), 200);
  };
  process.on("SIGINT", () => stop(130));
  process.on("SIGTERM", () => stop(143));

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
      setImmediate(() => app.exit(code));
    },
  });
  await session.ready;
}
