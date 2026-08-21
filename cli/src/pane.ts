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
// The picture is only half of what the browser leaves behind, and `restorePaneConsole`
// below is the other half: the same `Drop` that clears the frame also takes the
// console off the alternate screen and out of raw mode, and it is skipped by exactly
// the same exits.
//
// Kept apart from `main.ts` and importing only `node:net`, so the addressing rules
// can be tested without a pane, a pipe or an Electron.

import net from "node:net";

/** agwinterm's control-pipe verb for "take the placement off this pane". */
export const CLEAR_CMD = "image.clear";

/**
 * The other half of giving the pane back: the engine's reporting modes, turned off.
 *
 * A byte-for-byte copy of `DISABLE_REPORTING`
 * (`engine/crates/pixel-core/src/terminal_windows.rs`), which the engine writes to
 * `CONOUT$` from `ModeGuard::drop` — and which therefore does not run for any of the
 * exits this module exists for. `Terminal::new` puts the console the *CLI* is
 * attached to on the alternate screen, hides the cursor and turns on any-motion SGR
 * mouse reporting; a `taskkill /F` leaves all of it on. Clearing the picture and
 * leaving that is half a fix: the shell comes back on the alternate buffer with no
 * cursor, and every mouse move over the pane types escape bytes into it.
 *
 * `tools/cli/pane-clear.test.mjs` reads the Rust constant and asserts the two are
 * the same string, so they cannot drift.
 */
export const DISABLE_REPORTING =
  "\x1b[?2048l\x1b[?2004l\x1b[?1004l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l";

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
 *   - `AGWINTERM_WINDOW_ID`, when the host sets it, says which window the pane
 *     is in. A content verb without it resolves against the *frontmost* window,
 *     and each window searches only its own panes, so a clear sent while another
 *     window is in front is answered "no session" and the dead browser's picture
 *     stays on the pane — the exact failure this module exists to prevent. Hosts
 *     predating multi-window set nothing, and the field is left out.
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
  const window = nonempty(env, "AGWINTERM_WINDOW_ID");
  const request = window ? { cmd: CLEAR_CMD, target, window } : { cmd: CLEAR_CMD, target };
  return {
    endpoint: PIPE_PREFIX + pipe,
    line: `${JSON.stringify(request)}\n`,
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

/** Just enough of `process.stdout` to write the escape string, so tests need no tty. */
export interface PaneOutput {
  write(chunk: string): unknown;
}

/** Just enough of `process.stdin` to put the console back into cooked mode. */
export interface PaneInput {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  pause?(): unknown;
}

/**
 * Puts the console back the way the engine found it, and never throws.
 *
 * The companion to `clearPaneFrame`, and it runs for the same reason and on the same
 * path: the picture and the console modes are both state the engine set on *this*
 * pane, both are normally undone by `ModeGuard::drop`, and neither is undone at all
 * when the browser exits without running a destructor. `openInForeground` is the
 * only survivor of that, so it does both.
 *
 * Safe to run after an ordinary quit as well, which is why the call site does not
 * try to tell the two apart: mode resets are idempotent, and asking a console that
 * is already on the primary buffer with a visible cursor to go there again is a
 * no-op. Sending nothing when the engine *did* die badly is not.
 *
 * Two halves, because the escape string cannot reach the second one. `?1049l` and
 * friends are answered by the terminal; echo, line input and
 * `ENABLE_VIRTUAL_TERMINAL_INPUT` are console *modes*, which `SetConsoleMode`
 * changed and only `SetConsoleMode` restores. Node's raw-mode setter is this
 * process's handle on that call: `uv_tty_set_mode(NORMAL)` rewrites the input mode
 * outright rather than clearing a bit, which is exactly the restore that was missed.
 */
export function restorePaneConsole(
  out: PaneOutput = process.stdout,
  input: PaneInput = process.stdin,
): boolean {
  let written = false;
  try {
    out.write(DISABLE_REPORTING);
    written = true;
  } catch {}
  try {
    if (input.isTTY && typeof input.setRawMode === "function") {
      input.setRawMode(false);
      // Reading was never started, but `pause` is what tells Node to `readStop` a
      // tty handle it has now constructed — without it a stdin touched this late
      // can hold the event loop open past the return.
      input.pause?.();
    }
  } catch {}
  return written;
}
