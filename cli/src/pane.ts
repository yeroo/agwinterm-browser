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
// Kept apart from `main.ts` and importing only node builtins, so the addressing
// rules can be tested without a pane, a pipe or an Electron. That constraint is also
// why `pane-clear` — the recovery verb `main.ts` dispatches to — lives down here: it
// runs when the engine is gone, the registry is empty and nothing else in the
// workspace can be relied on to load.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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

/**
 * The characters a pipe name may carry — `agwinterm.rs`'s `valid_pipe_name`, and
 * `store/src/endpoint.ts`'s `pipeSegment` before it.
 *
 * This module used to reject only `[\\/]`, on the narrower reasoning that a
 * separator makes `\\.\pipe\a\b` name something else. That is true and not enough:
 * the engine refuses the wider set, so a pane whose `AGWINTERM_PIPE` held a space
 * passed here and failed there — a browser the CLI launched and the engine then had
 * nowhere to draw into.
 */
const PIPE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The agwinterm instances a development build may address.
 *
 * `agwinterm.rs`'s `ALLOW_PIPE_VAR`, repeated for the reason everything else in this
 * module is repeated. The engine's copy stops a dev build *publishing* into the
 * terminal the developer is working in; without this one the CLI would still send
 * that instance an `image.clear` on the way out, which is the half of the mechanism
 * that runs when the other half has already refused.
 */
export const ALLOW_PIPE_VAR = "TERMINAL_BROWSER_ALLOW_PIPE";

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
 *   - `TERMINAL_BROWSER_ALLOW_PIPE`, when set, is the development guard: this pane's
 *     instance has to be one of the ones it names. See [`pipeRefusal`].
 *
 * Pure, so the addressing is testable without a pipe on the other end.
 */
export function paneClearRequest(env: PaneEnv): ClearRequest | null {
  const address = paneAddress(env);
  if (!address || pipeRefusal(env)) return null;
  const { target, pipe, window } = address;
  const request = window ? { cmd: CLEAR_CMD, target, window } : { cmd: CLEAR_CMD, target };
  return {
    endpoint: PIPE_PREFIX + pipe,
    line: `${JSON.stringify(request)}\n`,
  };
}

interface PaneAddress {
  target: string;
  pipe: string;
  window: string | null;
}

/** The pane this environment names, before any guard is applied. */
function paneAddress(env: PaneEnv): PaneAddress | null {
  const enabled = nonempty(env, "AGWINTERM_ENABLED");
  if (!enabled || enabled === "0") return null;
  const target = nonempty(env, "AGWINTERM_SESSION_ID") ?? nonempty(env, "AGWINTERM_PANE_ID");
  if (!target || target === "active") return null;
  const pipe = nonempty(env, "AGWINTERM_PIPE") ?? DEFAULT_PIPE;
  return { target, pipe, window: nonempty(env, "AGWINTERM_WINDOW_ID") };
}

/**
 * Whether an allow-list names this pipe. `*` names every pipe, and a list with
 * nothing in it is an unset variable rather than a list that allows nothing —
 * `set TERMINAL_BROWSER_ALLOW_PIPE=` is how a shell spells "off".
 *
 * `allows_pipe` in `agwinterm.rs`, character for character, including the two
 * separators: a `cmd.exe` `set` treats a comma as an argument separator, so a
 * developer who writes one means a list.
 */
export function pipeAllowed(list: string | null | undefined, pipe: string): boolean {
  if (!list) return true;
  const entries = list
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return true;
  return entries.some((entry) => entry === "*" || entry === pipe);
}

/**
 * Why this pane's pipe may not be addressed, or `null` when it may.
 *
 * Two refusals, both of them the engine's. The name has to be a name
 * (`valid_pipe_name`), and under `TERMINAL_BROWSER_ALLOW_PIPE` the instance has to be
 * one the developer named (`pipe_refusal`). The second is what stops a browser built
 * in a checkout from publishing into the terminal that checkout is being edited in —
 * a pane of the real instance was found holding a dead browser's page, mouse
 * reporting still on, eighteen hours later.
 *
 * One asymmetry with the engine, deliberately. `agwinterm.rs` consults the variable
 * only under `debug_assertions`, so a value inherited from a shell profile cannot
 * stop a shipped browser drawing. The CLI has no build kind to consult — `tsc`
 * produces the same JavaScript either way — so it honours the variable whenever it is
 * set. That is the safe direction: the only thing the CLI withholds is an
 * `image.clear` against an instance the guard says is not ours, and the report says
 * so rather than staying quiet.
 *
 * Returns `null` when there is no pane at all; "nowhere to send" is a different
 * report line from "somewhere, and refused".
 */
export function pipeRefusal(env: PaneEnv): string | null {
  const address = paneAddress(env);
  if (!address) return null;
  const { pipe } = address;
  if (!PIPE_NAME.test(pipe)) {
    return (
      `AGWINTERM_PIPE=${JSON.stringify(pipe)} is not a pipe name — it may contain ` +
      "only letters, digits, `.`, `_` and `-`"
    );
  }
  const allow = nonempty(env, ALLOW_PIPE_VAR);
  if (!pipeAllowed(allow, pipe)) {
    const source = nonempty(env, "AGWINTERM_PIPE")
      ? `AGWINTERM_PIPE names ${JSON.stringify(pipe)}`
      : `AGWINTERM_PIPE is unset, so this pane resolves to ${JSON.stringify(pipe)}`;
    return (
      `${source}, and ${ALLOW_PIPE_VAR}=${JSON.stringify(allow)} does not list it — ` +
      `add ${JSON.stringify(pipe)} to ${ALLOW_PIPE_VAR}, or set it to \`*\` to allow ` +
      "any instance, or unset it to turn the guard off"
    );
  }
  return null;
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

// -- whose placement is it -----------------------------------------------------
//
// `FramePublisher::clear` (`engine/crates/pixel-core/src/frame_file.rs`) returns
// early when nothing was ever published, and says why: "asking anyway would clear a
// placement some *other* process owns". The CLI shipped the opposite rule — an
// unconditional `image.clear` on every exit path — and the recovery verb is where
// that matters most, because it runs against a pane that is already broken and may
// well be holding a picture this browser had no part in.
//
// The engine can consult `written`; the CLI cannot, because the process that held it
// is the one that died. What survives it is the frame directory. A publisher creates
// `%TEMP%\terminal-browser-frames-<pid>-<seq>` and writes `frame-00000000.png` into
// it per frame, and `FrameDir`'s `Drop` removes the whole directory on the way out —
// so the directory existing *with a frame file in it* is exactly the state the
// engine's `written` is non-empty in, left on disk for whoever comes after:
//
//   - ordinary quit — `Drop` ran, directory gone, engine already sent the clear
//   - `taskkill /F`  — directory survives with frames in it, nobody sent the clear
//   - died before drawing — directory survives, empty, nothing was ever placed
//
// which is `written.is_empty()` read from the filesystem instead of from memory.
// `tools/cli/pane-clear.test.mjs` reads the prefix and the frame-file name out of
// the Rust so the two spellings cannot drift.

/** Mirrors `DIR_PREFIX` in `frame_file.rs`. */
export const FRAME_DIR_PREFIX = "terminal-browser-frames-";

/** Mirrors `FramePublisher::path_for`'s `frame-{seq:08}.png`. */
const FRAME_FILE = /^frame-\d{8}\.png$/;

/** Evidence that a browser placed a frame and never took it back. */
export interface OwnedFrames {
  /** The frame directory it was left in. */
  dir: string;
  /** The pid in that directory's name, or null when it does not parse. */
  pid: number | null;
  /** How many frame files are in it. Never zero — an empty directory is not owned. */
  frames: number;
}

export interface OwnedFramesOptions {
  /** Where publishers put their directories. Defaults to `os.tmpdir()`. */
  root?: string;
  /**
   * Only accept the directory this pid left behind.
   *
   * `openInForeground` knows which process it spawned and the engine names its
   * directory after that pid, so the exit path can ask the precise question. The
   * `pane-clear` verb runs when that process is long gone and its pid unknowable,
   * so it asks the broad one.
   */
  pid?: number;
}

/**
 * The frame directory proving a browser drew on this machine and did not clean up,
 * or `null`. Never throws — it is read on paths that must not fail.
 *
 * Returns the *newest* match, so a pane wrecked twice reports the wreck the user is
 * actually looking at.
 */
export function ownedFrames(options: OwnedFramesOptions = {}): OwnedFrames | null {
  const root = options.root ?? os.tmpdir();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  // The trailing `-` matters: without it a pid of 123 would adopt 1234's frames.
  const wanted =
    options.pid === undefined ? FRAME_DIR_PREFIX : `${FRAME_DIR_PREFIX}${options.pid}-`;
  let best: OwnedFrames | null = null;
  let bestAt = -Infinity;
  for (const name of names) {
    if (!name.startsWith(wanted)) continue;
    const dir = path.join(root, name);
    let frames = 0;
    let at = -Infinity;
    try {
      for (const entry of fs.readdirSync(dir)) if (FRAME_FILE.test(entry)) frames += 1;
      at = fs.statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    // An empty directory is a browser that died before it drew anything, which is
    // the engine's `written.is_empty()` case: nothing was placed, so nothing is ours.
    if (frames === 0) continue;
    if (at <= bestAt) continue;
    const pid = Number.parseInt(name.slice(FRAME_DIR_PREFIX.length), 10);
    best = { dir, pid: Number.isFinite(pid) ? pid : null, frames };
    bestAt = at;
  }
  return best;
}

/** What one attempt at taking the picture back actually did. */
export interface PaneClearOutcome {
  /** Where the clear would have gone, or `null` when the environment names no pane. */
  request: ClearRequest | null;
  /** The frames a dead browser left behind, or `null` when it owns nothing here. */
  owned: OwnedFrames | null;
  /** True only when the host answered the clear. */
  cleared: boolean;
}

/**
 * `clearPaneFrame` under the engine's rule: send nothing when nothing is owned.
 *
 * Reports rather than clears, which is the resolution of the tension between "say so
 * loudly when there was nothing to fix" and "do not clear a placement this browser
 * did not make" — the caller gets a `null` `owned` to print, not a pane whose picture
 * was taken down on a guess.
 */
export async function clearOwnedPaneFrame(
  env: PaneEnv,
  options: OwnedFramesOptions & { timeoutMs?: number } = {},
): Promise<PaneClearOutcome> {
  const request = paneClearRequest(env);
  const owned = ownedFrames(options);
  if (!request || !owned) return { request, owned, cleared: false };
  const cleared = await clearPaneFrame(env, options.timeoutMs ?? 1_000);
  return { request, owned, cleared };
}

// -- the recovery verb ---------------------------------------------------------

export interface PaneClearOptions {
  env?: PaneEnv;
  out?: PaneOutput;
  input?: PaneInput;
  timeoutMs?: number;
  root?: string;
}

/**
 * `terminal-browser pane-clear`: give the pane back, from outside the browser.
 *
 * Everything above runs on `openInForeground`'s way out, which covers a browser that
 * died — and not a CLI that died with it. A `taskkill /F` on the *foreground job*, a
 * console that went away underneath both, a pane recovered by hand over the control
 * pipe eighteen hours later: those exits run neither half, and until this verb there
 * was no second chance at either. So it needs no engine, no instance in the registry
 * and no browser alive; a wrecked pane is defined by all three being gone.
 *
 * Always exits 0. It is a repair tool run against something already broken, and there
 * is no failure here that leaves the pane worse than it found it — a clear the host
 * never answered means the placement is gone anyway. What it owes the user instead is
 * a report specific enough to tell "it worked" from "it did nothing", because the
 * pane looking normal afterwards is consistent with both.
 */
export async function paneClearCommand(options: PaneClearOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const out = options.out ?? process.stdout;
  const outcome = await clearOwnedPaneFrame(env, {
    root: options.root,
    timeoutMs: options.timeoutMs,
  });
  // The console goes back before anything is printed. `DISABLE_REPORTING` ends with
  // `?1049l`, so a report written first lands on the alternate screen and is thrown
  // away with it — the one arrangement in which this command genuinely looks like it
  // did nothing.
  const restored = restorePaneConsole(out, options.input ?? process.stdin);
  for (const line of paneClearReport(env, outcome, restored)) out.write(`${line}\n`);
  return 0;
}

/**
 * What the verb says it did. Pure, so the wording is testable without a pane.
 *
 * Every branch names the state it found, not just the action it took: "nothing to
 * clear" and "cleared" have the same visible result on a pane whose browser exited
 * cleanly, and the difference between them is the whole diagnostic value.
 */
export function paneClearReport(
  env: PaneEnv,
  outcome: PaneClearOutcome,
  consoleRestored: boolean,
): string[] {
  const lines: string[] = [];
  // A pane that exists and is being refused is not the same report as no pane, and
  // the difference is a variable the user set — so it is named rather than folded
  // into "no agwinterm pane here", which would read as a shell problem.
  const refusal = outcome.request ? null : pipeRefusal(env);
  if (outcome.request) {
    const pipe = nonempty(env, "AGWINTERM_PIPE");
    const where = pipe ? `pipe ${pipe}` : `pipe ${DEFAULT_PIPE} (AGWINTERM_PIPE unset)`;
    const target = (JSON.parse(outcome.request.line) as { target: string }).target;
    lines.push(`pane-clear: ${where}, session ${target}`);
  } else if (refusal) {
    lines.push(`pane-clear: this pane's instance is not addressable — ${refusal}`);
  } else {
    lines.push("pane-clear: no agwinterm pane in this environment");
  }

  if (!outcome.owned) {
    lines.push(
      outcome.request
        ? `  frame:   nothing of ours to clear — no ${FRAME_DIR_PREFIX}* directory under ` +
          `${os.tmpdir()} holds a frame, so any picture on this pane was placed by ` +
          "something else and was left alone"
        : "  frame:   nothing to clear — no frames of ours were left behind, and there " +
          "is no pane here to address anyway",
    );
  } else if (refusal) {
    lines.push(
      `  frame:   ${outcome.owned.frames} frame(s) left in ${outcome.owned.dir}, and no ` +
        "image.clear was sent — the guard above says this instance is not one this " +
        "build addresses, and clearing it anyway is how a placement someone else owns " +
        "gets taken down",
    );
  } else if (!outcome.request) {
    lines.push(
      `  frame:   ${outcome.owned.frames} frame(s) left in ${outcome.owned.dir}, but this ` +
        "shell is not an agwinterm pane, so there is nowhere to send the clear — run " +
        "this from the pane that was drawn on",
    );
  } else if (outcome.cleared) {
    lines.push(
      `  frame:   cleared — a browser${owner(outcome.owned)} left ${outcome.owned.frames} ` +
        `frame(s) in ${outcome.owned.dir} and never took the picture back`,
    );
  } else {
    lines.push(
      `  frame:   image.clear went unanswered — a browser${owner(outcome.owned)} left ` +
        `${outcome.owned.frames} frame(s) in ${outcome.owned.dir}, and the host did not ` +
        "reply, so either that placement is already gone or that pane is",
    );
  }

  lines.push(
    consoleRestored
      ? "  console: mouse reporting off, bracketed paste off, cursor shown, back on the " +
        "primary buffer and out of raw mode"
      : "  console: could not be written to — nothing was restored",
  );
  return lines;
}

function owner(owned: OwnedFrames): string {
  return owned.pid === null ? "" : ` (pid ${owned.pid})`;
}
