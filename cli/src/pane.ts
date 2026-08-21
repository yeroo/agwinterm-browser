// Taking the browser's last frame back off the pane.
//
// A frame on Windows is a *placement*: the engine sends agwinterm a PNG path over
// the control pipe and agwinterm holds it until something replaces it. That is what
// makes switching sessions free — but it also means the picture outlives the process
// that drew it. `Terminal`'s `Drop` (`terminal_windows.rs`) covers an ordinary quit
// and an unwind. It cannot cover the exits that skip destructors: `taskkill /F`, a
// renderer crash that takes the main process with it, `TerminalProcess` killed from
// another pane.
//
// Task 14's acceptance check is exactly that case — "a killed browser process leaves
// the pane usable as a terminal" — and it failed on the picture, not on the shell:
// the shell underneath was running and answering, and none of it could be read.
//
// So the CLI does it too. `openInForeground` is the pane's foreground job and it
// outlives the browser by construction, whatever killed it. Sending `image.clear`
// twice is harmless (the second finds nothing placed); never sending it is not.
//
// Kept apart from `main.ts` and importing only `node:net`, so the addressing rules
// can be tested without a pane, a pipe or an Electron.

import net from "node:net";

/** agwinterm's control-pipe verb for "take the placement off this pane". */
export const CLEAR_CMD = "image.clear";

/** The prefix every local named pipe address carries. */
const PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * What `agwintermctl` falls back to when `AGWINTERM_PIPE` is unset
 * (`Agwinterm.Ctl/Program.cs:371`). Matched by `agwinterm.rs`'s `DEFAULT_PIPE` and
 * matched again here, so the engine and the CLI address the same pane.
 */
const DEFAULT_PIPE = "agwinterm";

export type PaneEnv = Record<string, string | undefined>;

export interface ClearRequest {
  /** The pipe to dial. */
  endpoint: string;
  /** The single JSON line to write, newline included. */
  line: string;
}

/**
 * What to say, and where — or `null` when there is no pane to say it to.
 *
 * These are `HostTarget::from_env`'s rules (`agwinterm.rs`), deliberately repeated
 * rather than approximated: the engine placed the frame and the CLI takes it back,
 * so the two must resolve the same pane or the clear lands somewhere else.
 *
 *   - `AGWINTERM_ENABLED` decides whether this is a pane at all, and `"0"` is a no.
 *   - `AGWINTERM_SESSION_ID`, or `AGWINTERM_PANE_ID` for hosts predating the
 *     session/pane merge, names the pane. `"active"` is refused: it addresses
 *     whichever pane is in front, which by the time a browser exits may be someone
 *     else's.
 *   - `AGWINTERM_PIPE` carries the *bare* pipe name; the client spells the prefix.
 *     Unset means `agwinterm`, which is what `agwintermctl` falls back to.
 *
 * Pure, so the addressing is testable without a pipe on the other end.
 */
export function paneClearRequest(env: PaneEnv): ClearRequest | null {
  const enabled = nonempty(env, "AGWINTERM_ENABLED");
  if (!enabled || enabled === "0") return null;
  const target = nonempty(env, "AGWINTERM_SESSION_ID") ?? nonempty(env, "AGWINTERM_PANE_ID");
  if (!target || target === "active") return null;
  const pipe = nonempty(env, "AGWINTERM_PIPE") ?? DEFAULT_PIPE;
  // A pipe name may not contain a separator: `\\.\pipe\a\b` names something else.
  if (/[\\/]/.test(pipe)) return null;
  return {
    endpoint: PIPE_PREFIX + pipe,
    line: `${JSON.stringify({ cmd: CLEAR_CMD, target })}\n`,
  };
}

function nonempty(env: PaneEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

/**
 * Sends the clear, and never throws.
 *
 * Best-effort by design: this runs after the browser has already gone, often
 * because something went wrong, and every failure here means the same thing as
 * success — there is no placement of ours left on that pane. A host that has closed
 * the window, a pipe that is gone and a reply that never comes are all "nothing to
 * clean up", and none of them should turn a browser's exit code into a CLI error.
 *
 * Resolves once the host has answered or `timeoutMs` has passed, so the process does
 * not exit with the write still in flight.
 */
export function clearPaneFrame(env: PaneEnv, timeoutMs = 1_000): Promise<boolean> {
  const request = paneClearRequest(env);
  if (!request) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (cleared: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(cleared);
    };
    const socket = net.connect(request.endpoint);
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => socket.write(request.line));
    socket.once("data", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}
