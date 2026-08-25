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
// So the CLI does it too. `openInForeground` is the pane's foreground job, so it
// outlives the browser whenever the browser is what died — and only then. A
// `taskkill /F` on the *CLI* takes the browser with it, because libuv puts a child
// spawned without `detached` into a job object that dies with its parent, so that
// exit runs neither half. That third path is what `pane-clear` below exists for
// (`docs/design/06-acceptance.md` §4, which measured it).
//
// Nor is an extra `image.clear` free. A placement belongs to the pane, not to the
// process that made it, so a clear sent when this browser owns nothing takes down
// whatever *is* on the pane — which may be a picture someone else drew. That is the
// ownership rule below: the engine's `written.is_empty()`, read off the filesystem.
//
// The picture is only half of what the browser leaves behind, and `restorePaneConsole`
// below is the other half: the same `Drop` that clears the frame also takes the
// console off the alternate screen and out of raw mode, and it is skipped by exactly
// the same exits.
//
// Kept apart from `main.ts` and importing only node builtins, so the addressing
// rules can be tested without a pane, a pipe or an Electron. `pane-clear` — the
// recovery verb `main.ts` dispatches to — lives down here for the same reason: it
// runs when the engine is gone, the registry is empty and no browser is alive, so
// every rule it needs has to be one this file can state on its own. It buys no
// protection from a workspace module failing to *load*, and does not claim any:
// `main.ts`'s imports are static and top-level, so all of them are evaluated before
// the `pane-clear` branch is ever reached.

import { execFileSync } from "node:child_process";
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
 * `agwinterm.rs`'s `trimmed`, as an edge trim: the Unicode `White_Space` property,
 * plus U+FEFF. That set is neither language's own trim but the union of the two,
 * which is why the engine spells `trimmed` out instead of calling `str::trim`.
 *
 * `String.trim` is not the same set as `str::trim`, and every rule this module
 * shares with the engine is applied to a trimmed value, so the two disagree on the
 * two code points where the sets part. ECMAScript counts U+FEFF ZWNBSP as
 * whitespace and Unicode `White_Space` does not, so `String.trim` takes a byte-order
 * mark off the front of an entry and `str::trim` leaves it on — a
 * `TERMINAL_BROWSER_ALLOW_PIPE` written by an editor that prefixes one would clear
 * CLI preflight and be refused by the engine. U+0085 NEL parts the other way, and
 * refuses at the CLI a list the engine would have allowed. Trimming the union keeps
 * the two readers on one answer; which answer matters less than that it is one.
 */
const PADDING = /^[\s\u0085]+|[\s\u0085]+$/g;

/** A value with the shell's padding taken off, the way the engine's `trimmed` takes it. */
function trimmed(value: string): string {
  return value.replace(PADDING, "");
}

/**
 * Rust's `str::eq_ignore_ascii_case`, as a fold: `A`-`Z` and nothing else.
 *
 * `toLowerCase` is the Unicode fold and would map U+212A KELVIN SIGN onto `k`, which
 * no `eq_ignore_ascii_case` in the engine does. Where the two sides of a comparison
 * are both ASCII the difference cannot show, so this is for the operands `PIPE_NAME`
 * has not been over: an entry a developer typed into `TERMINAL_BROWSER_ALLOW_PIPE`
 * ([`pipeAllowed`]), and a pipe name read back off disk ([`sameMark`]).
 */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (upper) => upper.toLowerCase());
}

/**
 * Whether an allow-list names this pipe. `*` names every pipe, and a list with
 * nothing in it is an unset variable rather than a list that allows nothing —
 * `set TERMINAL_BROWSER_ALLOW_PIPE=` is how a shell spells "off".
 *
 * `allows_pipe` in `agwinterm.rs`, character for character, including the two
 * separators: a `cmd.exe` `set` treats a comma as an argument separator, so a
 * developer who writes one means a list.
 *
 * The entry compares case-insensitively for the reason [`sameMark`] does: the object
 * manager resolves pipe names case-insensitively, so `Agwinterm-Dev` and
 * `agwinterm-dev` are one instance and a guard that told them apart would refuse the
 * very instance the developer put on the list. `*` is matched before the fold because
 * it is a literal, not a name.
 *
 * The fold is ASCII-only, which is what `eq_ignore_ascii_case` means and what
 * `toLowerCase` would not have been. Only one of the two operands is constrained:
 * `pipe` has been through `PIPE_NAME` (`valid_pipe_name` in the engine), but a list
 * entry is whatever the variable held, split and trimmed and nothing else. An entry
 * that is not ASCII but Unicode-folds to the pipe — `AGWINTERM-KIOSK` with its first
 * `K` written as U+212A KELVIN SIGN, against a pipe of `agwinterm-kiosk` — is one
 * `toLowerCase` matches and `allows_pipe` cannot, since that weighs 17 bytes against
 * 15. Folding the way the engine folds is what keeps this copy character for
 * character, rather than letting the CLI pass a launch the engine then refuses.
 */
export function pipeAllowed(list: string | null | undefined, pipe: string): boolean {
  if (!list) return true;
  const entries = list
    .split(/[,;]/)
    .map((entry) => trimmed(entry))
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return true;
  const folded = asciiLower(pipe);
  return entries.some((entry) => entry === "*" || asciiLower(entry) === folded);
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

/** A variable with its padding taken off, or `null` when nothing is left. */
function nonempty(env: PaneEnv, key: string): string | null {
  const raw = env[key];
  const value = raw === undefined ? "" : trimmed(raw);
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

/**
 * Just enough of `process.stdout` to write the escape string, so tests need no tty.
 *
 * `isTTY` is here for the same reason [`PaneInput`] carries it: it is what tells a
 * console from a redirect, and the escape string only does anything on the first.
 * Node sets it to `true` on a console stream and leaves it `undefined` otherwise, so
 * the test is `=== true` and never `!== false`.
 */
export interface PaneOutput {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/**
 * Just enough of `process.stdin` to tell a console from a redirect, and to let go
 * of it again.
 *
 * No `setRawMode`: see [`cookConsoleModes`] for why this process cannot be the one
 * that calls it. Touching `process.stdin` at all constructs the tty handle, though,
 * and a handle constructed this late can hold the event loop open past the return —
 * which is what `pause` is for.
 */
export interface PaneInput {
  isTTY?: boolean;
  pause?(): unknown;
}

/**
 * Which of the two restores actually happened.
 *
 * Two flags rather than one because the halves fail independently and for unrelated
 * reasons, and the verb's whole value is a report that tells "it worked" from "it did
 * nothing". A redirected stdin is not the console the cooking child would have to
 * inherit, so on that run the modes stay exactly as the engine left them — and the
 * old single boolean, set from the write alone, made the report claim the console was
 * "out of raw mode" on precisely that run. Saying so is what tells the user to run it
 * again with stdin on the pane.
 *
 * A redirected *stdout* is the mirror of it, and cost the same mis-report: see
 * [`restorePaneConsole`] for why the write going out is not the same fact as the
 * console having received it.
 */
export interface ConsoleRestore {
  /** `DISABLE_REPORTING` reached a console, rather than merely a stream. */
  escapes: boolean;
  /** A process that could call `SetConsoleMode` ran, and exited cleanly. */
  modes: boolean;
}

/**
 * Seams for [`restorePaneConsole`], so the modes half is testable without a pane.
 *
 * `cook` stands in for the child process. A test that let the real one run would be
 * spawning `cmd.exe` against the test runner's own console and asserting on a
 * platform, which is the one thing this file is arranged not to need.
 */
export interface ConsoleRestoreOptions {
  cook?: () => boolean;
}

/** How long the cooking child gets before it is given up on. */
const CONSOLE_COOK_TIMEOUT_MS = 2_000;

/**
 * The Windows directory the CLI's own helper spawns are addressed from.
 *
 * Read from **this process's** environment and never from the pane environment the
 * rest of this file is threaded with. The two answer unrelated questions — one names
 * the pane to address, the other names the Windows this CLI is running on — and
 * reading a child's path out of the caller's addressing would let a caller that
 * named a pane without naming a Windows silently lose the modes half, and a caller
 * that named `SystemRoot` point the spawn wherever it liked.
 *
 * *Drive-qualified* is the test, and `path.isAbsolute` is not it. `??` rejects an
 * *unset* variable and nothing else, so an empty or relative one joins to a relative
 * `System32\…` and hands the spawn back to the current-directory-first search that
 * [`taskkillPath`] spells its path out to avoid — but `isAbsolute` only closes half
 * of that. It answers `true` for `\Windows`, which is drive-*relative*: `path.join`
 * keeps the leading separator and the spawn resolves against whatever drive the
 * process happens to be on, which is the same trap `browser/src/record/paths.ts`
 * records for the inherited `/tmp/recordings`. It also answers `true` for
 * `\\host\share`, which turns a local spawn into an outbound SMB connect on the exit
 * path of a pane. No Windows supplies either spelling, so requiring `X:\` costs
 * nothing real and leaves the `C:\Windows` fallback covering every other answer.
 *
 * @see taskkillPath in `main.ts`, which shares this and is where the
 * current-directory-first hazard is written out in full.
 */
export function windowsSystemRoot(): string {
  const named = process.env.SystemRoot ?? process.env.windir;
  return named && /^[A-Za-z]:[\\/]/.test(named) ? named : "C:\\Windows";
}

/**
 * Puts the console input modes back — from a *child process*, which is the only
 * place it can be done.
 *
 * The obvious call is `process.stdin.setRawMode(false)`, and it does nothing at all.
 * `uv_tty_set_mode` returns early when the requested mode equals the one it has
 * recorded, and a `uv_tty_t` is born `UV_TTY_MODE_NORMAL` — so a CLI that never
 * turned raw mode *on* (this one never does; the engine did it, in another process,
 * through `SetConsoleMode` directly) asks for NORMAL, matches, and no syscall is
 * made. Measured on Windows 11: a console left at `1008` — echo, line input and
 * processed input off, `ENABLE_VIRTUAL_TERMINAL_INPUT` on, which is exactly what
 * `raw_input_mode` leaves — is still `1008` after that call and after the process
 * exits.
 *
 * Nor does forcing the transition help. `setRawMode(true)` then `setRawMode(false)`
 * does reach `SetConsoleMode`, but the first call is also where libuv saves the mode
 * it found, and `uv_tty_reset_mode` puts that saved mode back when Node tears down
 * stdio — restoring the broken one. Measured the same way: `1008` again.
 *
 * So the restore has to outlive this process's exit, which means it has to happen in
 * a different one. `cmd.exe` sets the console to cooked mode when it starts, on the
 * console it inherits, and nothing undoes that when it leaves: `1008` becomes `999`
 * — echo, line input and processed input back on, mouse reporting off. That is the
 * reported symptom ("the shell comes back cursorless and echoless") and it is a
 * Windows built-in doing what shells do, not a trick.
 *
 * `stdio: "inherit"` is load-bearing twice over: the child has to be looking at
 * *this* console, and `cmd` cooks the console behind its own standard input. Which
 * is also why this is gated on `isTTY` rather than attempted blind.
 *
 * The child's path comes from [`windowsSystemRoot`], which is where the reasons for
 * spelling it out — and for reading it from this process rather than from the pane
 * environment threaded through the rest of this file — are written down.
 *
 * @see taskkillPath in `main.ts`, for why the path is spelled out in full.
 */
function cookConsoleModes(): boolean {
  if (process.platform !== "win32") return false;
  const root = windowsSystemRoot();
  try {
    execFileSync(path.join(root, "System32", "cmd.exe"), ["/c", "exit"], {
      stdio: "inherit",
      timeout: CONSOLE_COOK_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts the console back the way the engine found it, and never throws.
 *
 * The companion to `clearPaneFrame`, and it runs for the same reason and on the same
 * path: the picture and the console modes are both state the engine set on *this*
 * pane, both are normally undone by `ModeGuard::drop`, and neither is undone at all
 * when the browser exits without running a destructor. `openInForeground` is one
 * survivor of that and does both; [`paneClearCommand`] is the other, for the exit
 * `openInForeground` does not survive either — a `taskkill /F` on the CLI, which
 * takes the browser down with it.
 *
 * Run after an ordinary quit as well, which is why the call site does not try to tell
 * the two apart — but only one of the halves is actually free there. Asking a console
 * already on the primary buffer with a visible cursor to go there again is a no-op.
 * The modes half is not: [`cookConsoleModes`] *sets* the input mode to cmd's cooked
 * default, it does not put a saved one back, so after an exit that did run
 * `ModeGuard::drop` — which restores the exact mode read at entry, and says so
 * (`terminal_windows.rs`) — this replaces that exact mode with an ordinary one, and
 * a caller whose console had QuickEdit off, or mouse or window input on, gets cmd's
 * answer instead of its own.
 *
 * Accepted rather than gated, because there is nothing here to gate on. (There is one
 * question the *caller* can answer, and `openInForeground` asks it: a spawn that
 * never produced a process left no console for this to put back, so it skips the call
 * entirely rather than cooking a console the engine never touched. Everything that
 * reaches here had a browser behind it.) The frame
 * half has an ownership question to ask; the modes half has none — the engine sets
 * the modes before it publishes anything, so a browser that died between the two
 * leaves no evidence and still needs this. And the two errors are not the same size:
 * a console at cmd's default is one every shell is happy in, a console left raw is
 * one the user cannot type into. Sending nothing when the engine *did* die badly is
 * the failure this function exists for.
 *
 * Two halves, because the escape string cannot reach the second one. `?1049l` and
 * friends are answered by the terminal; echo, line input and
 * `ENABLE_VIRTUAL_TERMINAL_INPUT` are console *modes*, which `SetConsoleMode`
 * changed and only `SetConsoleMode` restores — and Node has no binding for it that
 * survives this process's own exit. [`cookConsoleModes`] is where that goes, and why.
 *
 * ## The escapes go to `out`, and `out` is not always the console
 *
 * The engine does not have this problem: `terminal_windows.rs` opens `CONOUT$` **by
 * name** and writes `ENABLE_REPORTING` there, so `terminal-browser open <url> >
 * log.txt` still gets the alternate screen, the hidden cursor and any-motion mouse
 * reporting applied to the *pane*. The compensating write here goes to this
 * process's stdout, so on that same run it goes to `log.txt` — and the console keeps
 * every mode the engine set.
 *
 * Following the engine and opening the device by name is not available from Node.
 * `fs.openSync` puts every path through `path.resolve` before it reaches
 * `CreateFileW`, and both spellings lose: `"CONOUT$"` resolves against the current
 * directory to `\\?\C:\...\CONOUT$`, which the `\\?\` prefix strips of all
 * DOS-device meaning — it creates a *file* called `CONOUT$` in the working directory
 * — and `"\\\\.\\CONOUT$"` resolves to `\\.\CONOUT$\`, a trailing separator
 * `CreateFileW` rejects. Measured on Node 22 / Windows 11; a `Buffer` path takes the
 * same road. So there is no console handle to be had here, and the honest thing is
 * not to claim one.
 *
 * Which is what `escapes` reports. The write still goes out — it is exactly right
 * when stdout *is* the pane, which is every ordinary run — but the flag is set from
 * the stream being a console, not from the write returning, so a redirected run says
 * the escapes did not land and names the re-run that would fix it. That is the same
 * bargain the modes half already makes with `isTTY`, for the same reason: a report
 * that says "restored" to someone still looking at the alternate screen is worse
 * than no report at all.
 */
export function restorePaneConsole(
  out: PaneOutput = process.stdout,
  input: PaneInput = process.stdin,
  options: ConsoleRestoreOptions = {},
): ConsoleRestore {
  let escapes = false;
  try {
    out.write(DISABLE_REPORTING);
    escapes = out.isTTY === true;
  } catch {}
  let modes = false;
  try {
    if (input.isTTY) modes = (options.cook ?? cookConsoleModes)();
  } catch {}
  // Its own `try`, and after the one above rather than inside it. Reading was never
  // started, but `pause` is what tells Node to `readStop` a tty handle that reading
  // `isTTY` has now constructed — without it a stdin touched this late can hold the
  // event loop open past the return. Sharing a `try` with the cook would let a cook
  // that threw skip it, which is the one exit this function is on: the CLI's.
  try {
    input.pause?.();
  } catch {}
  return { escapes, modes };
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

/**
 * Mirrors `FramePublisher::path_for`'s `frame-{seq:08}.png`. The eight is a minimum
 * width, not a cap: a long-lived publisher's sequence runs past it, and matching
 * exactly eight digits would stop counting frames at that point — which presents as
 * `pane-clear` declining to repair a pane that is still painted.
 */
const FRAME_FILE = /^frame-\d{8,}\.png$/;

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
   * The environment [`frameRoots`] reads `TMP` and `TEMP` out of, when `root` names
   * no directory of its own. Defaults to `process.env`.
   *
   * Threaded rather than left to `process.env` because the other half of
   * [`clearOwnedPaneFrame`] — the addressing — already answers for the caller's
   * environment. A caller that passes one and gets `process.env`'s temp directories
   * searched is told "nothing of ours to clear" over a list of roots it never named,
   * and the report's whole claim is that it names what it actually read.
   */
  env?: PaneEnv;
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
   * Narrowed, not replaced, when `pid` is given. The pid is the attribution on that
   * path and a directory with no marker is still adopted — an engine predating
   * `PANE_FILE` has to stay recoverable by the process that spawned it. What the
   * marker adds there is the one thing the pid cannot settle on its own: a pid names
   * a *live* process and nothing more, `frame_file.rs` burns a counter precisely
   * because Windows recycles them, and `sweep_stale` leaves a wreck standing for an
   * hour — a week, once it names a pane. So a pid handed out twice inside that window
   * would let the exit path of the second browser adopt the first's directory — clearing the pane that one is still
   * painted on, and deleting the only evidence that it is. A marker naming *another*
   * pane is therefore disqualifying on both paths.
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
 *
 * The fold is [`asciiLower`] for the reason [`pipeAllowed`]'s is, and this is the
 * other place that reason applies: `pane.pipe` has been through `PIPE_NAME`, but
 * `mark.pipe` is a line [`frameMark`] read out of a file in temp and trimmed, which
 * this module does not validate. `FrameDir::mark_pane` only ever writes a
 * `valid_pipe_name`, so a marker that is not ASCII is one something else planted —
 * and `toLowerCase` would fold `AGWINTERM-KIOSK` spelled with a U+212A KELVIN SIGN
 * onto a pane of `agwinterm-kiosk` and adopt that directory as ours to delete.
 */
function sameMark(mark: PaneMark, pane: PaneMark): boolean {
  return asciiLower(mark.pipe) === asciiLower(pane.pipe) && mark.target === pane.target;
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
  // `os.tmpdir()` reads *this process's* environment, never the one handed in, and it
  // is worth having only for that: it carries the `%SystemRoot%\temp` fallback neither
  // `TMP` nor `TEMP` spells out. So it is a root exactly when `env` is this process's
  // own. Adding it for a caller that named its own environment would put a directory
  // that caller never mentioned into `searched`, and let a wreck under it be adopted
  // and retired on that caller's behalf — which is the half of [`OwnedFramesOptions.env`]
  // that threading the variable through was for.
  const mine = env === process.env;
  const named = [env.TMP, env.TEMP];
  const candidates = mine ? [os.tmpdir(), ...named] : [...named];
  // The one place the two fallback chains part company. `os.tmpdir()` is
  // `TEMP ?? TMP ?? %SystemRoot%\temp`; `GetTempPath2` — which is what the engine's
  // `std::env::temp_dir()` calls — is `TMP ?? TEMP ?? %USERPROFILE% ?? %windir%`. With
  // both variables set, which is every ordinary Windows session, they agree and this
  // adds nothing. With *neither* set they disagree by a whole directory: the engine
  // writes its frames under the profile and the search above would look in
  // `%SystemRoot%\temp`, find nothing, and report "nothing of ours to clear" at a
  // painted pane — while `openInForeground`'s exit-path clear, which is gated on the
  // same answer, quietly declined too.
  if (mine && !named.some((value) => value?.trim())) candidates.push(env.USERPROFILE);
  const roots: string[] = [];
  for (const value of candidates) {
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
  return options.root === undefined ? frameRoots(options.env) : [options.root];
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
  return allOwnedFrames(options)[0] ?? null;
}

/**
 * Every directory [`ownedFrames`] would accept, newest first.
 *
 * The newest is the wreck the user is looking at, and it is the only one worth
 * reporting — but it is *not* the only one the clear settles. `image.clear` takes the
 * pane's placement, and a pane holds one: whatever an older wreck put there was
 * replaced long before this run. So once the host has answered, every one of these is
 * spent evidence, and leaving the older ones standing would let the next run treat a
 * consumed marker as fresh ownership and send a second `image.clear` at a pane some
 * other process may have painted since. See [`clearOwnedPaneFrame`].
 */
function allOwnedFrames(options: OwnedFramesOptions = {}): OwnedFrames[] {
  // A pid the caller asked about and does not have is not a licence to ask the
  // broad question. See [`OwnedFramesOptions.pid`].
  if ("pid" in options && options.pid === undefined) return [];
  // And neither is a pane the caller could not resolve.
  const pane = options.pane ?? null;
  if (options.pid === undefined && !pane) return [];
  // The trailing `-` matters: without it a pid of 123 would adopt 1234's frames.
  const wanted =
    options.pid === undefined ? FRAME_DIR_PREFIX : `${FRAME_DIR_PREFIX}${options.pid}-`;
  const found: { at: number; owned: OwnedFrames }[] = [];
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
      //
      // The two questions read a *missing* marker differently, and only that. The
      // broad question has nothing else to go on, so an unattributed wreck is not
      // ours. The pid question has the pid, so it adopts one — but a marker naming
      // some other pane outranks a pid that Windows may have handed out twice inside
      // the window `sweep_stale` waits — an hour, and a week for the marked wreck
      // this branch is reading. See [`OwnedFramesOptions.pane`].
      if (pane && pane !== "any") {
        const mark = frameMark(dir);
        if (mark ? !sameMark(mark, pane) : options.pid === undefined) continue;
      }
      const pid = Number.parseInt(name.slice(FRAME_DIR_PREFIX.length), 10);
      found.push({ at, owned: { dir, pid: Number.isFinite(pid) ? pid : null, frames } });
    }
  }
  // Stable, so directories whose mtimes tie keep the order they were read in — which
  // is the one the single-answer form has always returned.
  found.sort((a, b) => b.at - a.at);
  return found.map((entry) => entry.owned);
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
  // `pane` is deliberately not in the accepted shape: it is derived from `env` below
  // — the question is asked of *this* pane, not of one a caller names — and both
  // branches of the `allOwnedFrames` call overwrite it. Naming only what is honoured
  // makes passing it a type error rather than a silent no-op.
  //
  // `pane?: never` rather than leaving it off the `Pick`, because leaving it off only
  // rejects a *fresh literal*, through the excess-property check. A caller holding an
  // `OwnedFramesOptions` already typed — `const options: OwnedFramesOptions = { root,
  // pane: "any" }` — passes it by structural assignability with the property intact
  // and gets the silent no-op back. Declaring it as a property nothing can satisfy is
  // what makes the rejection about the shape rather than about how it was spelled.
  options: Pick<OwnedFramesOptions, "root" | "env" | "pid"> & {
    timeoutMs?: number;
    pane?: never;
  } = {},
): Promise<PaneClearOutcome> {
  // The addressing below answers for `env`, so root discovery has to as well — see
  // [`OwnedFramesOptions.env`].
  const scoped = { ...options, env: options.env ?? env };
  const searched = searchedRoots(scoped);
  const request = paneClearRequest(env);
  // The broad question is asked *of this pane*, not of the machine — except where no
  // clear can follow from the answer, and then the machine-wide one is what lets the
  // report say "these frames exist, but not from here". `paneAddress` rather than
  // `request` because the marker records the bare pipe name the engine read out of
  // the environment, not the `\\.\pipe\` path a client dials.
  const address = paneAddress(env);
  const here = request && address ? { pipe: address.pipe, target: address.target } : null;
  const wrecks = allOwnedFrames(
    "pid" in options
      ? // The pid still decides ownership; the pane only rules out a directory whose
        // marker names a different one, which a recycled pid cannot. A pane this
        // environment does not resolve leaves the pid question exactly as it was.
        { ...scoped, pane: here }
      : { ...scoped, pane: here ?? "any" },
  );
  const owned = wrecks[0] ?? null;
  if (!request || !owned) return { request, owned, cleared: false, refused: null, searched };
  const { cleared, refused } = await clearPaneFrame(env, options.timeoutMs ?? 1_000);
  // The evidence goes with the placement it authorised. `FrameDir`'s `Drop` is what
  // removes this directory on an ordinary exit, so one still standing is a browser
  // that ran no destructor — and once the host has answered the clear, that is no
  // longer true of it. Left in place it would report the same wreck as freshly found
  // on every later run, which is the one distinction this verb exists to draw, and it
  // would go on authorising clears against panes it never drew on until `sweep_stale`
  // reaches it — a week later, for a wreck that names a pane, because that marker is
  // the recovery's only evidence and the sweep holds it for as long as a user might
  // come back to the pane (`MARKED_STALE_AFTER`, `frame_file.rs`). Which is exactly
  // why retiring it here is not optional. Best-effort even so, because this runs on
  // paths that must not fail: a directory that will not delete is `sweep_stale`'s
  // problem, not the recovery's.
  //
  // Only on `cleared`, and `cleared` is now the host's own `ok:true` rather than the
  // arrival of bytes. A refusal leaves the directory exactly where it is: the pane is
  // still painted, and the evidence is what a later run — after the window that was
  // in front has moved, say — needs in order to try again.
  //
  // All of them, not only the one reported. A pane holds one placement, so a pane
  // wrecked twice has one picture on it and the older wreck's was replaced before this
  // run ever started; the clear that just went out settles every one of them. Retiring
  // only the newest would leave the older marker looking like fresh ownership, and the
  // next `pane-clear` would send a second `image.clear` at a pane that may by then be
  // painted by somebody else — the exact thing the ownership rule exists to stop.
  if (cleared) {
    for (const wreck of wrecks) retire(wreck.dir);
  }
  return { request, owned, cleared, refused, searched };
}

/**
 * Takes a spent wreck out of circulation, and never throws.
 *
 * Best-effort on the directory, because this runs on paths that must not fail: one
 * that will not delete is `sweep_stale`'s problem a week later, not the recovery's.
 * The marker is not best-effort in the same way, though — it *is* the directory's
 * claim on this pane, and a claim that outlives the placement it was made for is what
 * authorises the next run's clear. So when the directory will not go, the marker is
 * asked for on its own: what that leaves behind is an unattributed wreck, which the
 * broad question already declines to own.
 */
function retire(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch {}
  try {
    fs.rmSync(path.join(dir, FRAME_PANE_FILE), { force: true });
  } catch {}
}

// -- the recovery verb ---------------------------------------------------------

export interface PaneClearOptions {
  env?: PaneEnv;
  out?: PaneOutput;
  input?: PaneInput;
  timeoutMs?: number;
  root?: string;
  /** @see ConsoleRestoreOptions.cook */
  cook?: () => boolean;
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
  const restored = restorePaneConsole(out, options.input ?? process.stdin, {
    cook: options.cook,
  });
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
  consoleRestored: ConsoleRestore,
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
        "gets taken down. With no pane this build will address there is no marker to " +
        "compare against either, so that is the newest wreck on this machine rather " +
        "than provably this pane's",
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

  // Each half named separately, because they fail apart. Claiming the input modes
  // were put back when there was no tty to ask is the one report that sends a user
  // away from a console that still does not echo.
  if (!consoleRestored.escapes) {
    // Two ways to land here — a stdout that threw, and a stdout that is a file or a
    // pipe rather than the pane — and one report, on [`restorePaneConsole`]'s
    // reasoning: the escapes did not reach a console either way, and what the user
    // needs is that fact and the re-run that fixes it, not which of the two it was.
    const rerun =
      "; run this again with stdout on the pane that was drawn on, without a redirect";
    lines.push(
      consoleRestored.modes
        ? "  console: the escapes did not reach a console — the input modes are back, but " +
          `mouse reporting, the cursor and the alternate screen were left as they were${rerun}`
        : `  console: the escapes did not reach a console — nothing was restored${rerun}`,
    );
  } else if (consoleRestored.modes) {
    lines.push(
      "  console: mouse reporting off, bracketed paste off, cursor shown, back on the " +
        "primary buffer and out of raw mode",
    );
  } else {
    // Three ways to land here and one report for all of them, because they are the
    // same fact to the user: a redirected stdin with no console to ask, a platform
    // with no `SetConsoleMode` to call, and a cooking child that would not run.
    // Naming which one would be naming a cause for a console that is still broken
    // either way; what the user needs is to know it is, and where to run this next.
    lines.push(
      "  console: mouse reporting off, bracketed paste off, cursor shown, back on the " +
        "primary buffer — but the input modes could not be put back from here, so " +
        "echo and line input were left as the browser set them; run this again with " +
        "stdin on the pane that was drawn on",
    );
  }
  return lines;
}

function owner(owned: OwnedFrames): string {
  return owned.pid === null ? "" : ` (pid ${owned.pid})`;
}
