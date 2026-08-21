import { app } from "electron";

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
    cwd: process.cwd(),
    cdpPort,
    onClose: (code) => {
      closing = true;
      app.exit(code);
    },
  });
  await session.ready;
}
