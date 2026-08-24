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
  /** The pane the line addresses, carried out rather than re-parsed back off it. */
  target: string;
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
    target,
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
 * only under `debug_assertions`; the CLI has no build kind to consult — `tsc` produces
 * the same JavaScript either way — so it honours the variable whenever it is set.
 *
 * Two things follow from that and they are not the same weight, so both are written
 * down. `inAgwintermPane` (`cli/src/unsupported.ts`) refuses the *launch*, which is a
 * visible failure a user could hit from a stale shell profile — mitigated only by the
 * shipped Windows build being a checkout, where `debug_assertions` is on and the
 * engine would have refused every frame anyway (see the README's "Working on the
 * browser"). This copy is the milder half: it withholds an `image.clear` against an
 * instance the guard says is not ours, and the report says so rather than staying
 * quiet.
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

/** What the host said about the clear. */
export interface ClearReply {
  /** True only for `{"ok":true,…}` — the host says the placement is off the pane. */
  cleared: boolean;
  /**
   * Why the host said no, when it said no. `null` when it agreed, and `null` when it
   * never spoke at all — a refusal is a host that is there and disagrees, which is a
   * different thing to report than a pipe with nobody on it.
   */
  refused: string | null;
}

/** The most a single-line reply may grow to. Matches `MAX_REPLY_BYTES` in `control.ts`. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

/** No answer at all: the timeout, a dead pipe, a peer that hung up. */
const UNANSWERED: ClearReply = { cleared: false, refused: null };

/**
 * Sends the clear, and never throws.
 *
 * Best-effort by design: this runs after the browser has already gone, often
 * because something went wrong, and most failures here mean the same thing as
 * success — there is no placement of ours left on that pane. A host that has closed
 * the window, a pipe that is gone and a reply that never comes are all "nothing to
 * clean up", and none of them should turn a browser's exit code into a CLI error.
 *
 * The one failure that does **not** mean that is a host which answered
 * `{"ok":false,…}`. `no session "s-abc"` — the pane is gone, or another window is in
 * front and this one names none — is a pane that is still painted and a clear that
 * did not happen. Reading the reply is what tells the two apart: the protocol is the
 * `{"ok":…}` envelope the engine's `Reply::parse` and `control.ts` both read, and
 * taking the arrival of *bytes* as success reports "cleared" for the exact case the
 * verb exists to catch — and, worse, throws away the evidence that would let a second
 * run try again.
 *
 * Resolves once the host has answered or `timeoutMs` has passed, so the process does
 * not exit with the write still in flight.
 */
export function clearPaneFrame(env: PaneEnv, timeoutMs = 1_000): Promise<ClearReply> {
  const request = paneClearRequest(env);
  if (!request) return Promise.resolve(UNANSWERED);
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (reply: ClearReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const socket = net.connect(request.endpoint);
    const timer = setTimeout(() => finish(UNANSWERED), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(request.line));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      // A reply is one line. A peer that streams without ever sending a newline would
      // otherwise grow this until the timeout, and on Windows the pipe name is one any
      // local process can take.
      if (buffer.length > MAX_REPLY_BYTES) {
        const refused = `the reply passed ${MAX_REPLY_BYTES} bytes with no newline`;
        finish({ cleared: false, refused });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(readClearReply(buffer.slice(0, newline)));
    });
    socket.once("error", () => finish(UNANSWERED));
    socket.once("close", () => finish(UNANSWERED));
  });
}

/** One `{"ok":…}` envelope, read the way `Reply::parse` reads it. */
function readClearReply(line: string): ClearReply {
  let reply: { ok?: unknown; error?: unknown };
  try {
    reply = JSON.parse(line) as { ok?: unknown; error?: unknown };
  } catch {
    return { cleared: false, refused: `the reply was not JSON: ${line.slice(0, 200)}` };
  }
  if (reply.ok === true) return { cleared: true, refused: null };
  const error = typeof reply.error === "string" ? reply.error.trim() : "";
  return { cleared: false, refused: error || `the host said no: ${line.slice(0, 200)}` };
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

/** Mirrors `PANE_FILE` in `frame_file.rs`: the pipe, then the session id. */
export const FRAME_PANE_FILE = "pane";

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
  /**
   * Where publishers put their directories. Defaults to [`frameRoots`] — every temp
   * directory the engine could have chosen, not only the one Node prefers.
   */
  root?: string;
  /**
   * Only accept the directory this pid left behind.
   *
   * `openInForeground` knows which process it spawned and the engine names its
   * directory after that pid, so the exit path can ask the precise question. The
   * `pane-clear` verb runs when that process is long gone and its pid unknowable,
   * so it asks the broad one.
   *
   * The key being *present* is what selects the precise question, and a present key
   * whose value is `undefined` owns **nothing** rather than everything. That is not
   * pedantry: `spawn` leaves `child.pid` undefined when it could not start the
   * process at all, so `{ pid: child.pid }` on that path would widen back to the
   * machine-wide search and restore the unconditional clear this rule exists to
   * remove — on precisely the case it was written for, a browser that failed before
   * its first frame.
   */
  pid?: number;
  /**
   * Only accept a directory whose `pane` marker names this pane.
   *
   * This is what makes the broad question a question about *this* pane rather than
   * about the machine. Without it the newest directory anywhere wins, and two panes
   * wrecked at once means `pane-clear` in one of them repairs it on the other's
   * evidence, names the other's pid in the report, and then deletes the other's
   * directory — leaving the second pane painted with nothing left that knows a
   * browser drew there. A live browser in another pane is worse still: its directory
   * gains a file every frame, so it is always the newest match.
   *
   * Ignored when `pid` is given: the pid *is* the attribution there, and the exit
   * path knows it first-hand.
   *
   * Required for the broad question — a caller that names no pane owns nothing —
   * because "any pane" is the machine-wide search under a different name.
   *
   * `"any"` asks that machine-wide question deliberately, and is only correct where
   * the answer cannot authorise a clear: run outside a pane, or with the pipe guard
   * refusing this instance, there is nowhere to send an `image.clear` and the only
   * thing left to do with a wreck is name it so the user knows where to go.
   */
  pane?: PaneMark | "any" | null;
}

/** The pane a frame directory was placed on, as `PANE_FILE` records it. */
export interface PaneMark {
  /** The bare pipe name, as `AGWINTERM_PIPE` spells it. */
  pipe: string;
  /** The session id the frame was addressed to. */
  target: string;
}

/**
 * The pane a publisher's directory says it drew on, or `null` when it says nothing.
 *
 * A directory with no marker is one this build did not write — an engine predating
 * `PANE_FILE`, or a marker that could not be written. It is deliberately *not* read
 * as "mine": the whole point of the file is that an unattributed wreck cannot be
 * told apart from another pane's.
 */
function frameMark(dir: string): PaneMark | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, FRAME_PANE_FILE), "utf8");
  } catch {
    return null;
  }
  const [pipe, target] = text.split("\n").map((line) => line.trim());
  if (!pipe || !target) return null;
  return { pipe, target };
}

/**
 * Whether a marker names the pane the caller is standing in.
 *
 * The pipe compares case-insensitively because the object manager does: a pane whose
 * `AGWINTERM_PIPE` is `Agwinterm-Dev` and an engine that recorded `agwinterm-dev`
 * addressed the same instance. The session id is agwinterm's own opaque string and
 * is compared as given.
 */
function sameMark(mark: PaneMark, pane: PaneMark): boolean {
  return mark.pipe.toLowerCase() === pane.pipe.toLowerCase() && mark.target === pane.target;
}

/**
 * Every temp directory a publisher could have put its frames in.
 *
 * The engine asks Rust for `std::env::temp_dir()`, which on Windows is
 * `GetTempPath2`: `TMP` first, then `TEMP`, then the profile directory. Node's
 * `os.tmpdir()` reads `TEMP` first. The two agree on any machine that sets the pair
 * to one value, which is most of them and not the one that matters — a shell that
 * sets only `TMP`, or sets the two apart, puts the engine's frame directory
 * somewhere `os.tmpdir()` alone would never look, and the recovery verb would report
 * "nothing of ours to clear" at a pane that is still painted. So both are searched,
 * and the report names what it searched rather than a directory it assumed.
 */
function frameRoots(env: PaneEnv = process.env): string[] {
  const roots: string[] = [];
  for (const value of [os.tmpdir(), env.TMP, env.TEMP]) {
    const root = value?.trim();
    if (!root) continue;
    const full = path.resolve(root);
    if (!roots.some((seen) => samePath(seen, full))) roots.push(full);
  }
  return roots;
}

/** Path equality as the filesystem sees it, which on Windows ignores case. */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The directories [`ownedFrames`] will read, in the order it reads them. */
export function searchedRoots(options: OwnedFramesOptions = {}): string[] {
  return options.root === undefined ? frameRoots() : [options.root];
}

/**
 * The frame directory proving a browser drew on this machine and did not clean up,
 * or `null`. Never throws — it is read on paths that must not fail.
 *
 * Returns the *newest* match, so a pane wrecked twice reports the wreck the user is
 * actually looking at.
 *
 * Two questions, and both of them narrow. `pid` is the exit path's: the engine names
 * the directory after the process this CLI spawned, so the pid settles ownership on
 * its own. `pane` is the recovery verb's: the process is gone, so what is left is the
 * marker the engine wrote naming the pane it drew on. Neither is "the newest frame
 * directory on this machine" — see [`OwnedFramesOptions.pane`] for what that costs.
 */
export function ownedFrames(options: OwnedFramesOptions = {}): OwnedFrames | null {
  // A pid the caller asked about and does not have is not a licence to ask the
  // broad question. See [`OwnedFramesOptions.pid`].
  if ("pid" in options && options.pid === undefined) return null;
  // And neither is a pane the caller could not resolve.
  const pane = options.pid === undefined ? (options.pane ?? null) : null;
  if (options.pid === undefined && !pane) return null;
  // The trailing `-` matters: without it a pid of 123 would adopt 1234's frames.
  const wanted =
    options.pid === undefined ? FRAME_DIR_PREFIX : `${FRAME_DIR_PREFIX}${options.pid}-`;
  let best: OwnedFrames | null = null;
  let bestAt = -Infinity;
  for (const root of searchedRoots(options)) {
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
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
      // The marker is written with the first frame the host took, so a directory with
      // frames in it and no marker for this pane belongs to another one.
      if (pane && pane !== "any") {
        const mark = frameMark(dir);
        if (!mark || !sameMark(mark, pane)) continue;
      }
      if (at <= bestAt) continue;
      const pid = Number.parseInt(name.slice(FRAME_DIR_PREFIX.length), 10);
      best = { dir, pid: Number.isFinite(pid) ? pid : null, frames };
      bestAt = at;
    }
  }
  return best;
}

/** What one attempt at taking the picture back actually did. */
export interface PaneClearOutcome {
  /** Where the clear would have gone, or `null` when the environment names no pane. */
  request: ClearRequest | null;
  /** The frames a dead browser left behind, or `null` when it owns nothing here. */
  owned: OwnedFrames | null;
  /** True only when the host answered `{"ok":true}`. */
  cleared: boolean;
  /** Why the host refused, when it refused. See [`ClearReply.refused`]. */
  refused: string | null;
  /** The temp directories that were actually read, so the report can name them. */
  searched: string[];
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
  const searched = searchedRoots(options);
  const request = paneClearRequest(env);
  // The broad question is asked *of this pane*, not of the machine — except where no
  // clear can follow from the answer, and then the machine-wide one is what lets the
  // report say "these frames exist, but not from here". `paneAddress` rather than
  // `request` because the marker records the bare pipe name the engine read out of
  // the environment, not the `\\.\pipe\` path a client dials.
  const address = paneAddress(env);
  const owned = ownedFrames(
    "pid" in options
      ? options
      : {
          ...options,
          pane: request && address ? { pipe: address.pipe, target: address.target } : "any",
        },
  );
  if (!request || !owned) return { request, owned, cleared: false, refused: null, searched };
  const { cleared, refused } = await clearPaneFrame(env, options.timeoutMs ?? 1_000);
  // The evidence goes with the placement it authorised. `FrameDir`'s `Drop` is what
  // removes this directory on an ordinary exit, so one still standing is a browser
  // that ran no destructor — and once the host has answered the clear, that is no
  // longer true of it. Left in place it would report the same wreck as freshly found
  // on every later run, which is the one distinction this verb exists to draw, and it
  // would go on authorising clears against panes it never drew on until `sweep_stale`
  // reaches it an hour later. Best-effort, because this runs on paths that must not
  // fail: a directory that will not delete is `sweep_stale`'s problem, not the
  // recovery's.
  //
  // Only on `cleared`, and `cleared` is now the host's own `ok:true` rather than the
  // arrival of bytes. A refusal leaves the directory exactly where it is: the pane is
  // still painted, and the evidence is what a later run — after the window that was
  // in front has moved, say — needs in order to try again.
  if (cleared) {
    try {
      fs.rmSync(owned.dir, { recursive: true, force: true });
    } catch {}
  }
  return { request, owned, cleared, refused, searched };
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
    lines.push(`pane-clear: ${where}, session ${outcome.request.target}`);
  } else if (refusal) {
    lines.push(`pane-clear: this pane's instance is not addressable — ${refusal}`);
  } else {
    lines.push("pane-clear: no agwinterm pane in this environment");
  }

  // Named rather than assumed: `os.tmpdir()` is not necessarily where the engine put
  // them, which is the whole reason [`frameRoots`] searches more than one place.
  const roots = outcome.searched.join(" or ");
  if (!outcome.owned) {
    if (outcome.request) {
      lines.push(
        `  frame:   nothing of ours to clear — no ${FRAME_DIR_PREFIX}* directory under ` +
          `${roots} holds a frame placed on this pane, so any picture on it was put ` +
          "there by something else and was left alone",
      );
    } else if (refusal) {
      // "There is no pane here" would be a lie to someone standing in one. The pane
      // exists and the guard above is why nothing was sent to it.
      lines.push(
        `  frame:   nothing of ours to clear — no ${FRAME_DIR_PREFIX}* directory under ` +
          `${roots} holds a frame, and the guard above would have withheld the ` +
          "image.clear in any case",
      );
    } else {
      lines.push(
        "  frame:   nothing to clear — no frames of ours were left behind, and there " +
          "is no pane here to address anyway",
      );
    }
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
  } else if (outcome.refused) {
    // The host is there and said no, which is neither "cleared" nor "nobody home".
    // Most often `no session`: the pane closed, or this build named no window and
    // another one is in front. The pane is still painted and the frames are still on
    // disk, so the next run has something to try again with — which is why this
    // branch says so rather than reporting a repair that did not happen.
    lines.push(
      `  frame:   the host refused the image.clear — ${outcome.refused}. A browser` +
        `${owner(outcome.owned)} left ${outcome.owned.frames} frame(s) in ` +
        `${outcome.owned.dir}; they were left in place, so run this again from the ` +
        "pane that was drawn on, with that pane's window in front",
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
