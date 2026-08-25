#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { DAEMON_ENDPOINT, LOGS_DIR, ensureDataDir } from "pixel-store";
import {
  callerTty,
  canSplit,
  cannotOpenPanes,
  checkTerminal,
  detect,
  unsupportedGraphicsMessage,
} from "pixel-terminals";
import type { Direction, Terminal, TerminalCheck } from "pixel-terminals";
import { actionCommand } from "./action";
import { control } from "./control";
import { setupCommand } from "./editors";
import { commandHelp, helpTopics, rootHelp } from "./help";
import { browsers, describe, recordKey, scopeHere } from "./instances";
import type { Browser } from "./instances";
import {
  FOREGROUND_SIGNALS,
  FOREGROUND_SIGNAL_GRACE_MS,
  browserLaunchPlan,
  electronBinaryPath,
  foregroundSpawnEnv,
  missingLaunchArtifact,
} from "./launch";
import type { LaunchPlan } from "./launch";
import { lsCommand } from "./ls";
import {
  clearOwnedPaneFrame,
  paneClearCommand,
  restorePaneConsole,
  windowsSystemRoot,
} from "./pane";
import { instances } from "./registry";
import { apparmorSetup, deniedRefusal, linuxSandboxError, sandboxRefusal } from "./sandbox";
import { openSshTunnel, startBundle, validateBundleDir, validateSshTarget } from "./ssh";
import type { RemoteBundle } from "./ssh";
import type { InstanceRecord } from "./registry";
import { installedVersion, upgradeCommand } from "./upgrade";
import { splitUnsupported, windowsHostRefusal } from "./unsupported";

// The port runs one browser per pane, in the foreground, rather than sessions
// inside a shared daemon: `docs/design/03-process-model.md`. Every branch below
// that reads this constant is a consequence of that decision, not a platform
// quirk of its own.
const WINDOWS = process.platform === "win32";

const DIST_ROOT = process.env.TERMINAL_BROWSER_DIST_ROOT ?? null;
delete process.env.ELECTRON_RUN_AS_NODE;

function fail(message: string): never {
  process.stderr.write(`terminal-browser: ${message}\n`);
  process.exit(1);
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined) fail(`${name} requires a value`);
  args.splice(at, 2);
  return value;
}

function takeBoolFlag(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function browserDirectory(): string {
  return path.resolve(__dirname, "..", "..", "browser");
}

function electronBinary(): string {
  return electronBinaryPath({
    platform: process.platform,
    browserDir: browserDirectory(),
    distRoot: DIST_ROOT,
  });
}

function browserLaunchCommand(argv: string[]): LaunchPlan {
  const browserDir = browserDirectory();
  const electron = electronBinary();
  const main = path.join(browserDir, "dist", "main.js");
  const missing = missingLaunchArtifact(electron, main, (candidate) => fs.existsSync(candidate));
  if (missing) fail(missing);
  if (process.platform === "linux") {
    let sandboxError = linuxSandboxError(electron);
    if (sandboxError) {
      apparmorSetup(electron);
      sandboxError = linuxSandboxError(electron);
    }
    if (sandboxError) fail(sandboxError);
  }
  ensureDataDir();
  const logDir = LOGS_DIR;
  fs.mkdirSync(logDir, { recursive: true });
  return browserLaunchPlan({
    platform: process.platform,
    env: process.env,
    electron,
    main,
    argv,
    browserDir,
    logDir,
  });
}

function clientLaunchCommand(argv: string[]): string[] {
  const runner = DIST_ROOT
    ? [path.join(DIST_ROOT, "bin", "terminal-browser")]
    : [process.execPath, path.resolve(__dirname, "main.js")];
  return [...runner, "open", ...argv];
}

function ownTtyPath(): string | null {
  try {
    const out = execFileSync("tty", {
      stdio: ["inherit", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out.startsWith("/dev/") ? out : null;
  } catch {
    return null;
  }
}

function interactiveTty(): string | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  return ownTtyPath();
}

function browserBuildStamp(): string {
  const main = path.resolve(__dirname, "..", "..", "browser", "dist", "main.js");
  try {
    return String(Math.floor(fs.statSync(main).mtimeMs));
  } catch {
    return "unknown";
  }
}

function connectDaemon(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(DAEMON_ENDPOINT);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function spawnDaemon() {
  const plan = browserLaunchCommand(["--daemon"]);
  // stands in for the shell's stderr-append redirection: the log is ours to
  // open, and the child inherits it as fd 2. Closing our copy leaves the
  // child's alive.
  let stderr: number | "ignore" = "ignore";
  try {
    stderr = fs.openSync(plan.stderrLog, "a");
  } catch {}
  try {
    const child = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: ["ignore", "ignore", stderr],
    });
    // spawn reports its failures asynchronously, and this child is unref'd, so
    // without a listener an ENOENT here either throws out of the event loop or —
    // if the process exits first — vanishes, leaving `daemonSocket` to spend 15
    // seconds failing to connect and then blame the socket. Say what happened.
    child.on("error", (error) => {
      process.stderr.write(`could not start ${plan.file}: ${error.message}\n`);
    });
    child.unref();
  } finally {
    if (typeof stderr === "number") fs.closeSync(stderr);
  }
}

async function daemonSocket(): Promise<net.Socket> {
  try {
    return await connectDaemon();
  } catch {}
  spawnDaemon();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return await connectDaemon();
    } catch {
      await sleep(200);
    }
  }
  throw new Error("daemon did not start");
}

interface DaemonReply {
  ok?: boolean;
  error?: string;
  session?: string;
  event?: string;
  code?: number;
  sessions?: number;
}

function nextReply(socket: net.Socket, onLine: (reply: DaemonReply) => void): void {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      try {
        onLine(JSON.parse(line) as DaemonReply);
      } catch {}
    }
  });
}


async function openSession(argv: string[], tty: string): Promise<{ socket: net.Socket; reply: DaemonReply }> {
  const request = `${JSON.stringify({
    cmd: "open",
    tty,
    argv,
    env: process.env,
    cwd: process.cwd(),
    build: browserBuildStamp(),
  })}\n`;
  const ask = (socket: net.Socket) =>
    new Promise<DaemonReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon open timed out")), 20_000);
      nextReply(socket, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      socket.once("close", () => {
        clearTimeout(timer);
        reject(new Error("daemon closed the connection"));
      });
      socket.write(request);
    });
  let socket = await daemonSocket();
  let reply = await ask(socket);
  if (reply.ok === false && reply.error === "stale") {
    // the stale daemon steps aside when idle; give it a beat and respawn
    socket.destroy();
    await sleep(700);
    socket = await daemonSocket();
    reply = await ask(socket);
  }
  return { socket, reply };
}

async function daemonPid(): Promise<number | null> {
  for (const record of await instances()) {
    try {
      process.kill(record.pid, 0);
      return record.pid;
    } catch {}
  }
  return null;
}

async function gone(pid: number, within: number): Promise<boolean> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function shutdownDaemon(): Promise<number> {
  // On Windows there is no daemon to stop, and this must return before
  // `daemonPid()` runs: that function returns the first live *instance* pid, which
  // in the foreground shape is a browser someone is using, and `kill` would then
  // stop it while reporting that it stopped a daemon.
  if (WINDOWS) {
    process.stdout.write(
      "no daemon on Windows — each browser runs in its own pane. Close one with q, or stop its process.\n",
    );
    return 0;
  }
  let socket: net.Socket | null = null;
  try {
    socket = await connectDaemon();
  } catch {}
  const pid = await daemonPid();
  if (!socket) {
    if (pid === null) {
      process.stdout.write("no daemon running\n");
      return 0;
    }
    return kill(pid, "it was not listening");
  }
  const answer = await new Promise<DaemonReply | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 2500);
    const settle = (value: DaemonReply | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    nextReply(socket!, settle);
    socket!.once("close", () => settle({ ok: true }));
    socket!.write('{"cmd":"shutdown"}\n');
  });
  socket.destroy();
  if (answer === null) {
    if (pid === null) fail("the daemon did not answer and no browser names its process");
    return kill(pid, "it did not answer");
  }
  const browsers = answer.sessions ?? 0;
  process.stdout.write(
    browsers === 0 ? "daemon stopped\n" : `daemon stopped, with ${browsers} open\n`,
  );
  return 0;
}

async function kill(pid: number, why: string): Promise<number> {
  process.kill(pid, "SIGTERM");
  if (!(await gone(pid, 2000))) process.kill(pid, "SIGKILL");
  process.stdout.write(`daemon stopped, killed ${pid} because ${why}\n`);
  return 0;
}

/**
 * How long `terminateTree` will wait for `taskkill.exe`.
 *
 * `execFileSync` blocks the event loop, so an unbounded one is not "slow" but
 * *stuck*: the two recovery steps that run after it — `clearOwnedPaneFrame` and
 * `restorePaneConsole`, in `openInForeground`'s `try`, not its `finally`, which
 * holds only the listener removal — would never run, and the pane would keep the
 * dead browser's frame and its raw console, which is the exact wreck this path
 * exists to prevent. Being in the `try` is also why `terminateTree` is written never
 * to throw: an exception out of it would skip them just as surely as a hang.
 * Matches `cookConsoleModes`'s bound in `pane.ts`, the other blocking spawn on the
 * same exit path.
 */
const TASKKILL_TIMEOUT_MS = 2_000;

/**
 * Ends a browser that outlived the signal meant to stop it.
 *
 * Forceful on purpose: this is only reached after `FOREGROUND_SIGNAL_GRACE_MS` of a
 * process that either never received the console's Ctrl+C or declined to act on it,
 * so asking politely a second time has nothing new to offer. The whole tree, not
 * the one process — Electron's GPU and renderer helpers are children, and
 * `ChildProcess.kill` on Windows is `TerminateProcess` against a single pid, which
 * would leave them behind still holding this pane's console.
 *
 * Never throws: the browser being gone already is the outcome this wants, and a
 * failure here must not become the exit code the pane reports. Swallowing is not the
 * same as giving up, though — see the `catch`, which still has a second route to try
 * and still owes the caller the wait.
 *
 * @see taskkillPath, for why the killer is spelled out in full.
 * @see TASKKILL_TIMEOUT_MS, for why the spawn is bounded.
 */
async function terminateTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const dead = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    if (WINDOWS) {
      execFileSync(taskkillPath(), ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: TASKKILL_TIMEOUT_MS,
      });
    } else child.kill("SIGKILL");
  } catch {
    // Most arrivals here are the outcome this wanted: `taskkill` exits 128 when the
    // pid is already gone. The one that is not — a refusal, or the bound above
    // expiring with the tree alive — used to `return`, which skipped the wait below
    // as well and told the caller a live browser was stopped. The caller then retires
    // this pane's frame and cooks its console, and the CLI exits: libuv's job object
    // takes the browser down with it (see `pane.ts`'s header), *after* the evidence
    // and the repair are both gone. So try the other route Node has — one pid rather
    // than the tree, but the Electron parent is the one holding this console — and
    // fall through to the wait either way.
    try {
      child.kill();
    } catch {}
  }
  await Promise.race([dead, new Promise<void>((resolve) => setTimeout(resolve, 1_000).unref())]);
}

/**
 * `taskkill.exe` by absolute path, never by name.
 *
 * `CreateProcess` — and therefore libuv's `search_path`, and therefore
 * `execFileSync` with no shell — looks in the *current directory* before it looks
 * at `PATH`. This runs in whatever directory the user launched the CLI from, so a
 * bare `"taskkill"` would run a `taskkill.exe` sitting in an unpacked download
 * folder in preference to the system one, with this user's privileges, on the
 * ordinary path where a browser outlived its Ctrl+C.
 *
 * Which is why `%SystemRoot%` is checked and not merely defaulted: `??` only rejects
 * an *unset* variable, so an empty or relative one joins to a relative
 * `System32\taskkill.exe` and hands the search straight back to the current
 * directory. [`windowsSystemRoot`] is what makes the fallback cover that too, and it
 * is shared with `cookConsoleModes` rather than copied — the guard was on one copy
 * and not the other once already.
 */
function taskkillPath(): string {
  return path.join(windowsSystemRoot(), "System32", "taskkill.exe");
}

/**
 * The Windows shape of `open`: the browser runs here, in this pane's console.
 *
 * There is no daemon in this path and no tty in the request, because Windows has
 * neither to offer — see `docs/design/03-process-model.md`. What replaces the tty
 * path is the console the CLI is already attached to: `stdio: "inherit"` hands the
 * child the same handles, and `TERMINAL_BROWSER_CONSOLE_PID` names this process so
 * the engine's `AttachConsole` has an explicit target rather than relying on the
 * process tree staying one level deep (`terminal_windows.rs:347`). Electron is a
 * GUI-subsystem binary and is given no console of its own, which is measured, not
 * assumed (`tools/console-inherit-probe`).
 *
 * Not detached, and not unref'd: this process is the pane's foreground job, so it
 * stays until the browser exits and carries its exit code out.
 */
async function openInForeground(argv: string[]): Promise<number> {
  const plan = browserLaunchCommand(argv);
  // Chromium's stderr goes to the log rather than to the pane. fd 0 and 1 stay
  // inherited — they are the pane's console, which is the point — but fd 2 is
  // where Electron writes its GPU and sandbox chatter, and one line of that
  // painted over a frame agwinterm is holding as a placement corrupts a picture
  // the browser has no way to know it needs to repair. `spawnDaemon` already
  // redirects it; this path was the one that did not.
  let stderr: number | "inherit" = "inherit";
  try {
    stderr = fs.openSync(plan.stderrLog, "a");
  } catch {}
  let child: ChildProcess;
  try {
    child = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      stdio: ["inherit", "inherit", stderr],
      env: foregroundSpawnEnv(process.env, process.pid, process.cwd()),
    });
  } finally {
    // Closing our copy leaves the child's open.
    if (typeof stderr === "number") fs.closeSync(stderr);
  }

  let running = true;
  const exited = new Promise<number>((resolve) => {
    child.on("error", (error) => {
      running = false;
      process.stderr.write(`could not start ${plan.file}: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      running = false;
      resolve(code ?? (signal ? 1 : 0));
    });
  });

  // Ctrl+C is how a foreground job is normally stopped, and a Windows console
  // delivers it to *every* process attached to that console — this one and the
  // browser. Node with no listener for it terminates immediately, so without these
  // the CLI died alongside the browser and the clear below never ran: the last
  // page stayed painted over the shell that had just got the pane back. That is
  // the exact failure `pane.ts` exists to prevent, reached by the most common way
  // a user stops a browser.
  //
  // The handlers kill nothing *yet*. A browser already attached to this console
  // received the same Ctrl+C, and all this process has to do is outlive it — which
  // is what the grace period is for. What the grace period cannot cover is a
  // browser that never got the signal at all: `electron.exe` is a GUI-subsystem
  // image and starts with **no console** (measured, `tools/console-inherit-probe`),
  // so until the engine's `AttachConsole` has run there is a window in which Ctrl+C
  // reaches this process and not the child. Returning then would hand the shell its
  // prompt back and leave a browser that is about to attach to *that same console*,
  // start eating its keystrokes and paint frames over it — which is the failure
  // `pane.ts` exists to prevent, not a milder version of it. So anything still
  // running when the grace period is up is terminated before the pane is taken
  // back; a browser that is wedged rather than absent ends the same way, and the
  // clear still runs.
  const handlers = new Map<NodeJS.Signals, () => void>();
  const stopped = new Promise<number>((resolve) => {
    for (const [signal, code] of FOREGROUND_SIGNALS) {
      const handler = () => {
        // `unref` for the same reason the listeners are removed below, and it has
        // to be here rather than there: a pending timer keeps Node's event loop
        // alive exactly as a signal listener does, and this one outlives the race.
        // Ctrl+C reaches the browser too, so `exited` normally wins in a couple of
        // hundred milliseconds — and without this the CLI then sat on the grace
        // timer for the rest of the two seconds before the shell got its prompt
        // back, once per Ctrl+C. The race does not need the loop held open: if the
        // timer is the only thing left, there is nothing to wait for anyway.
        setTimeout(() => resolve(code), FOREGROUND_SIGNAL_GRACE_MS).unref();
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  });

  try {
    const code = await Promise.race([exited, stopped]);
    // Only reachable through `stopped`: `exited` cannot win with the child alive.
    if (running) await terminateTree(child);
    // Whatever just happened to the browser, the pane is ours again — and a frame
    // is a placement agwinterm holds until something replaces it, so without this
    // the last page stays painted over a shell that is running underneath. The
    // engine clears it on an ordinary exit; this covers the exits that run no
    // destructor. Failure means the placement is gone anyway, so it cannot change
    // the exit code.
    //
    // `clearOwnedPaneFrame` rather than `clearPaneFrame`, and the pid is the point:
    // this used to fire unconditionally, which is the CLI contradicting the engine's
    // own rule that a publisher which never published has nothing to take back and
    // "asking anyway would clear a placement some *other* process owns"
    // (`frame_file.rs`). A browser that failed before its first frame — a missing
    // artifact, a refused pane, an instant crash — would otherwise take down
    // whatever the pane was showing before it started. The engine names its frame
    // directory after this process, so this is the exact question, not the broad one
    // `pane-clear` has to settle for.
    //
    // A spawn that failed outright leaves `child.pid` undefined, and that is the most
    // extreme case of the same thing: no process, so no frame, so nothing of ours to
    // take back. `ownedFrames` reads the *present* `pid` key as the precise question
    // and answers "nothing" — the one thing it must not do here is read a missing pid
    // as "any pid", which would be the unconditional clear again under a new name.
    await clearOwnedPaneFrame(process.env, { pid: child.pid });
    // And the console with it. The engine put *this* process's console on the
    // alternate screen, hid the cursor and turned on mouse reporting; `ModeGuard`
    // undoes that on an ordinary exit and not on any of the exits above, so the
    // shell was getting the pane back unreadable — cursorless, echoless, and typing
    // escape bytes on every mouse move.
    //
    // Unconditional, and not because it is free. The escapes half is a no-op against
    // a console already on the primary buffer, but the modes half is a `cmd.exe`
    // child that *sets* the input mode to cmd's cooked default rather than restoring
    // a saved one — so on an exit that did run `ModeGuard::drop`, which restores the
    // exact mode read at entry (`terminal_windows.rs`), this overwrites a correct
    // restore with a merely-ordinary one, and any non-default bit the caller's
    // console had (QuickEdit off, mouse or window input on) is lost. It runs anyway
    // because nothing here can tell the two exits apart — `clearOwnedPaneFrame`'s
    // evidence is a frame directory, and a browser can set the modes and die before
    // its first frame — and the two mistakes are not the same size: a console left
    // at cmd's default is one a shell is happy in, and a console left raw is one the
    // user cannot type into. See `restorePaneConsole`, which says the same thing
    // from the other end.
    //
    // With one exception, and it is the same expression the clear above reads. A
    // spawn that failed outright never produced a process, so nothing ever ran
    // `SetConsoleMode` on this console — there is no bad restore to prefer over a
    // worse one, only the cook itself, which would take QuickEdit, mouse input and
    // window input off a console the engine never touched as collateral of an error
    // message. That is the one exit where the gating question the paragraph above
    // says does not exist does exist, and it is already answered.
    if (child.pid !== undefined) restorePaneConsole();
    return code;
  } finally {
    // A registered signal listener keeps Node's event loop alive, and `main`
    // only calls `process.exit` for a non-zero code — so leaving these on would
    // hang every clean quit.
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}

async function attachHere(argv: string[]): Promise<never> {
  const tty = ownTtyPath();
  if (!tty) throw new Error("not running on a tty");
  const { socket, reply } = await openSession(argv, tty);
  if (reply.ok === false || !reply.session) {
    socket.destroy();
    throw new Error(reply.error ?? "daemon refused the session");
  }
  nextReply(socket, (message) => {
    if (message.event === "closed") process.exit(message.code ?? 0);
  });
  socket.on("close", () => process.exit(0));
  socket.on("error", () => process.exit(1));
  process.on("SIGWINCH", () => {
    try {
      socket.write('{"cmd":"resize"}\n');
    } catch {}
  });
  const requestClose = () => {
    try {
      socket.write('{"cmd":"close"}\n');
    } catch {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", requestClose);
  process.on("SIGTERM", requestClose);
  process.on("SIGHUP", requestClose);
  return new Promise<never>(() => {});
}

async function openHere(argv: string[]): Promise<never> {
  await sshSetup(argv).catch((error) =>
    fail(error instanceof Error ? error.message : String(error)),
  );
  return attachHere(argv).catch((error) => fail(`could not start the browser: ${String(error)}`));
}

function flagEq(argv: string[], flag: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

async function sshSetup(argv: string[]): Promise<void> {
  const target = flagEq(argv, "--ssh");
  if (!target) return;
  const status = (line: string) => process.stdout.write(`ssh: ${line}\n`);
  const interrupt = () => process.exit(130);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, interrupt);
  let bundle: RemoteBundle | null = null;
  const tunnel = await openSshTunnel(target, status);
  process.on("exit", () => {
    try {
      bundle?.stop();
    } catch {}
    tunnel.stop();
  });
  argv.push(`--socks-port=${tunnel.socksPort}`);
  const bundleDir = flagEq(argv, "--ssh-bundle");
  if (bundleDir) {
    const remoteBase = flagEq(argv, "--ssh-bundle-dir");
    bundle = await startBundle(tunnel, bundleDir, status, remoteBase || undefined);
    if (!argv.some((arg) => !arg.startsWith("-"))) argv.unshift(bundle.url);
  }
  for (const signal of signals) process.removeListener(signal, interrupt);
}

const DIRECTIONS: Direction[] = ["right", "left", "down", "up"];

function isDirection(value: string): value is Direction {
  return (DIRECTIONS as string[]).includes(value);
}

function takeSplitFlag(args: string[]): Direction | null {
  const raw = takeFlag(args, "--split");
  if (raw === undefined) return null;
  // Refused before the direction is validated, so an unsupported flag is not
  // reported as a mistyped one.
  const unsupported = splitUnsupported(process.platform);
  if (unsupported) fail(unsupported);
  if (!isDirection(raw)) fail(`invalid --split ${raw} (right, left, down, up)`);
  return raw;
}

function takeSizeFlag(args: string[]): number | null {
  const raw = takeFlag(args, "--size");
  if (raw === undefined || raw === null) return null;
  const size = Number(raw);
  if (!Number.isFinite(size) || size < 0.2 || size > 0.95) {
    fail(`invalid --size ${raw} (fraction between 0.2 and 0.95)`);
  }
  return size;
}





async function launchInSplit(
  terminal: Terminal,
  direction: Direction,
  argv: string[],
  size?: number | null,
): Promise<InstanceRecord> {
  const from = await terminal.getCurrentPane?.({ tty: ownTtyPath() ?? callerTty().path, cwd: process.cwd() });
  if (!from) fail(`could not work out which ${terminal.name} pane you are in`);
  const before = new Set((await instances()).map(recordKey));
  await terminal.split!({
    from,
    direction,
    command: clientLaunchCommand(argv),
    size: size ?? null,
    tty: ownTtyPath() ?? callerTty().path,
  });
  // ssh auth prompts and bundle installs run inside the new pane first
  const patience = argv.some((arg) => arg.startsWith("--ssh=")) ? 600_000 : 20_000;
  const deadline = Date.now() + patience;
  while (Date.now() < deadline) {
    const fresh = (await instances()).find((record) => !before.has(recordKey(record)));
    if (fresh) {
      return fresh;
    }
    await sleep(250);
  }
  fail(`browser did not register within ${Math.round(patience / 1000)}s (is the split open?)`);
}

let asked: Promise<TerminalCheck> | null = null;

function currentTerminal(): Promise<TerminalCheck> {
  // The Kitty graphics probe writes an APC escape to the terminal and waits for a
  // reply. ConPTY strips APC, so on Windows it can only ever time out — and the
  // answer would be about the wrong channel anyway, since frames leave over
  // agwinterm's control pipe. `windowsHostRefusal` asks the question that decides
  // it there, and `checkTerminal` is never given the chance to guess.
  if (WINDOWS) {
    asked ??= Promise.resolve({ terminal: null, graphics: "supported" as const });
    return asked;
  }
  asked ??= checkTerminal(detect());
  return asked;
}

async function newTabCommand(url: string | undefined, key: string | undefined): Promise<number> {
  const check = await currentTerminal();
  const found = await browsers(check.terminal);
  const here = key
    ? found.filter((browser) => recordKey(browser) === key)
    : scopeHere(found);
  const list = (browsers: Browser[]) => browsers.map((browser) => `  ${describe(browser)}`).join("\n");
  if (key && here.length === 0) fail(`no browser ${key}. Running:\n${list(found)}`);
  if (here.length > 1) {
    fail(`${here.length} ${WINDOWS ? "browsers running" : "browsers in this tab"}, so say which with --browser:\n${list(here)}`);
  }
  const target = here[0];
  if (target) {
    const where = url ? { cmd: "open-tab", url, cwd: process.cwd() } : { cmd: "open-tab" };
    print(await control(target.endpoint, where));
    return 0;
  }
  await requireGraphics(check);
  const argv = url ? [url] : [];
  if (WINDOWS) return openInForeground(argv);
  if (interactiveTty()) return openHere(argv);
  if (!canSplit(check.terminal)) fail(cannotOpenPanes(check.terminal));
  const split = url && fs.existsSync(url) ? [path.resolve(url)] : argv;
  split.push("--split-dir=right");
  const tty = ownTtyPath() ?? callerTty().path;
  if (tty) split.push(`--parent-tty=${tty}`);
  print(await launchInSplit(check.terminal!, "right", split, null));
  return 0;
}

async function requireGraphics(check: TerminalCheck) {
  const refusal = windowsHostRefusal(process.platform, process.env);
  if (refusal) fail(refusal);
  if (check.graphics !== "unsupported") return;
  process.stderr.write(unsupportedGraphicsMessage(process.stderr.isTTY === true));
  process.exit(1);
}

const BROWSER_FLAGS = [
  "--app-mode",
  "--no-toolbar",
  "--no-shortcuts",
  "--no-context-menu",
  "--no-overlays",
  "--no-frame",
  "--open-tabs-in-popup-stack",
  "--allow-clipboard-read",
  "--partition=",
  "--ssh=",
  "--ssh-bundle=",
  "--ssh-bundle-dir=",
  "--preload=",
  "--main-script=",
  "--palette-key=",
  "--find-key=",
  "--devtools-key=",
  "--console-key=",
  "--split-dir=",
  "--parent-tty=",
];

function rejectUnknownFlags(args: string[]) {
  for (const arg of args) {
    if (!arg.startsWith("-")) continue;
    const known = BROWSER_FLAGS.some((flag) =>
      flag.endsWith("=") ? arg.startsWith(flag) : arg === flag,
    );
    if (!known) fail(`unknown option ${arg.split("=")[0]} (terminal-browser open --help)`);
  }
}

function takeSshFlags(args: string[]): void {
  const ssh = takeFlag(args, "--ssh");
  if (ssh !== undefined) args.push(`--ssh=${ssh}`);
  const bundle = takeFlag(args, "--ssh-bundle");
  if (bundle !== undefined) args.push(`--ssh-bundle=${bundle}`);
  const bundleDir = takeFlag(args, "--ssh-bundle-dir");
  if (bundleDir !== undefined) args.push(`--ssh-bundle-dir=${bundleDir}`);
  const at = args.findIndex((arg) => arg.startsWith("--ssh-bundle="));
  if (at >= 0) {
    args[at] = `--ssh-bundle=${path.resolve(args[at].slice("--ssh-bundle=".length))}`;
  }
  // Presence, not truthiness. `--ssh=` and `--ssh ""` are how an unset shell
  // variable spells itself, and an empty target that reads as *absent* skips
  // `validateSshTarget` — the only place `sshUnsupported` is raised. On Windows the
  // documented refusal would never print; everywhere else `sshSetup` would return
  // early and the request the user asked to be tunnelled would go out from this
  // machine instead, with nothing said. `validateSshTarget("")` rejects on both
  // platforms, so handing it the empty string is the whole fix.
  const target = args.find((arg) => arg.startsWith("--ssh="))?.slice("--ssh=".length);
  if (at >= 0 && target === undefined) fail("--ssh-bundle needs --ssh");
  if (args.some((arg) => arg.startsWith("--ssh-bundle-dir=")) && at < 0) {
    fail("--ssh-bundle-dir needs --ssh-bundle");
  }
  try {
    if (target !== undefined) validateSshTarget(target);
    if (at >= 0) validateBundleDir(args[at].slice("--ssh-bundle=".length));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function requirePaneAccess(): void {
  const refusal = sandboxRefusal();
  if (refusal) fail(refusal);
}

async function openCommand(args: string[]) {
  requirePaneAccess();
  const split = takeSplitFlag(args);
  const size = takeSizeFlag(args);
  if (size !== null && !split) fail("--size only applies to a split (--split <direction>)");
  takeSshFlags(args);
  rejectUnknownFlags(args);
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  if (positionals.length > 1) {
    fail(`unexpected ${positionals[1]} (one url; --split <direction> opens a new pane)`);
  }
  await requireGraphics(await currentTerminal());
  // `split` is always null here on Windows — `takeSplitFlag` refuses first — so
  // this is the only Windows path out of `open`, and it is the foreground one.
  if (WINDOWS) {
    const code = await openInForeground(args);
    if (code !== 0) process.exit(code);
    return;
  }
  if (!split && interactiveTty()) {
    return openHere(args);
  }
  const terminal = (await currentTerminal()).terminal;
  const direction = split ?? "right";
  if (!canSplit(terminal)) fail(cannotOpenPanes(terminal));
  const url = args.find((arg) => !arg.startsWith("-"));
  const own = ownTtyPath();
  const caller = own ? null : callerTty();
  if (caller?.denied) {
    const refusal = deniedRefusal();
    if (refusal) fail(refusal);
  }
  const tty = own ?? caller?.path ?? null;
  const argv = args.map((arg) => (arg === url && fs.existsSync(arg) ? path.resolve(arg) : arg));
  argv.push(`--split-dir=${direction}`);
  if (tty) argv.push(`--parent-tty=${tty}`);
  print(await launchInSplit(terminal!, direction, argv, size));
}

function splitPassthrough(args: string[]): { own: string[]; passthrough: string[] } {
  const at = args.indexOf("--");
  if (at < 0) return { own: args, passthrough: [] };
  return { own: args.slice(0, at), passthrough: args.slice(at + 1) };
}

function takeTabFlag(args: string[]): number | undefined {
  const raw = takeFlag(args, "--tab");
  if (raw === undefined) return undefined;
  const id = Number(raw.replace(/^t/, ""));
  if (!Number.isInteger(id)) fail(`invalid --tab ${raw} (a tab id from terminal-browser ls)`);
  return id;
}

function asksForHelp(args: string[]): boolean {
  const end = args.indexOf("--");
  const own = end < 0 ? args : args.slice(0, end);
  return own.includes("--help") || own.includes("-h");
}

function helpCommand(topic: string | undefined): number {
  if (!topic) {
    process.stdout.write(rootHelp());
    return 0;
  }
  const help = commandHelp(topic);
  if (!help) fail(`no help for ${topic} (try ${helpTopics().join(", ")})`);
  process.stdout.write(help);
  return 0;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    process.stdout.write(rootHelp());
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`terminal-browser ${installedVersion() ?? "dev"}\n`);
    return 0;
  }
  if (command === "help") return helpCommand(args[0]);
  if (asksForHelp(args)) {
    process.stdout.write(commandHelp(command) ?? rootHelp());
    return 0;
  }
  // Deliberately ahead of everything that needs something to be working. No
  // `requirePaneAccess`, no terminal detection, no registry lookup: the pane this
  // repairs is one whose browser is gone, and every check above would be a way for
  // the recovery to fail on the same wreckage it was called to clean up.
  if (command === "pane-clear") {
    if (args.length > 0) fail(`unexpected ${args[0]} — pane-clear takes no arguments`);
    return paneClearCommand();
  }
  if (command === "open") {
    await openCommand(args);
    return 0;
  }
  if (command === "ls") {
    requirePaneAccess();
    const all = takeBoolFlag(args, "--all");
    const json = takeBoolFlag(args, "--json");
    await lsCommand((await currentTerminal()).terminal, all, json);
    return 0;
  }
  if (command === "setup") {
    const sandbox = apparmorSetup(electronBinary());
    const editors = setupCommand();
    return editors !== 0 ? editors : sandbox;
  }
  if (command === "upgrade") return upgradeCommand();
  if (command === "shutdown") return shutdownDaemon();
  if (command === "new-tab") {
    requirePaneAccess();
    const key = takeFlag(args, "--browser");
    return newTabCommand(args.find((arg) => !arg.startsWith("-")), key);
  }
  if (command === "action") {
    requirePaneAccess();
    const { own, passthrough } = splitPassthrough(args);
    const options = {
      browserKey: takeFlag(own, "--browser"),
      tabId: takeTabFlag(own),
      targetId: takeFlag(own, "--target"),
      follow: takeBoolFlag(own, "--follow"),
      passthrough,
    };
    if (own.length > 0) fail(`unexpected ${own[0]} — put agent-browser arguments after --`);
    return actionCommand((await currentTerminal()).terminal, options);
  }
  const rest = process.argv.slice(2);
  if (asksForHelp(rest)) {
    process.stdout.write(commandHelp("open") ?? rootHelp());
    return 0;
  }
  await openCommand(rest);
  return 0;
}

void main()
  .then((code) => {
    if (code) process.exit(code);
  })
  .catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
