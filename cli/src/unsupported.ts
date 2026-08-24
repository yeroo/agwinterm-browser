// What the Windows port refuses, and why.
//
// Each of these is a command, a flag or a host that upstream offers and Windows
// cannot honour.
// The rule they follow is the one Task 13 states: **do not leave a command that
// appears to work but does not.** A silent no-op is worse than an error, because the
// user has no way to tell "nothing needed doing" from "nothing was done".
//
// So each returns a reason string on the platforms where it applies and `null`
// elsewhere, and the caller turns a reason into a refusal. The reason names the
// specific obstacle rather than the platform, because "not supported on Windows" is
// the part the user already knows.
//
// Import-free on purpose, like `launch.ts`: this is the module a test can load and
// drive without a database, a terminal or a built engine.

export type Platform = NodeJS.Platform;

/**
 * `--ssh` opens a multiplexed tunnel and reuses it for every later command
 * (`ssh -S <control path>`, `ssh -O exit`), and the bundle path adds `tar` over
 * the same channel. ControlMaster multiplexing is a unix-socket feature that
 * Win32 OpenSSH does not implement — the client accepts `-S` and then fails to
 * establish the master — so the tunnel cannot be held open between invocations.
 * That is the obstacle; the rest of `ssh.ts` would port.
 */
export function sshUnsupported(platform: Platform): string | null {
  if (platform !== "win32") return null;
  return [
    "--ssh is not supported on Windows.",
    "The tunnel is multiplexed over an ssh control socket (ssh -S), and Win32 OpenSSH",
    "does not implement ControlMaster, so it cannot be held open between commands.",
    "Run terminal-browser on the remote host instead.",
  ].join(" ");
}

/**
 * `upgrade` fetches a release manifest and then runs its `install` URL through
 * `bash -c 'curl … | bash'`. There is no Windows release channel publishing such a
 * script, and no bash to run it in a default install, so the command has nothing
 * correct to do.
 */
export function upgradeUnsupported(platform: Platform): string | null {
  if (platform !== "win32") return null;
  return [
    "terminal-browser upgrade is not supported on Windows.",
    "It runs the release channel's `curl | bash` installer, and no Windows release",
    "channel publishes one. Update by pulling the repository and re-running the build.",
  ].join(" ");
}

/**
 * `--split` asks the host terminal to open a new pane running a given command.
 *
 * Two things are missing, not one. `pixel-terminals` has no agwinterm detector, so
 * `detect()` returns null in an agwinterm pane and there is no `split` to call; and
 * agwinterm's own `session.split` takes an operation but not a command
 * (`ControlServer.cs:134-135,163`), so even with a detector the pane it opened
 * could not be told to run the browser. Lifting this needs a host change, which is
 * why the port plan puts it out of scope rather than deferring it.
 */
export function splitUnsupported(platform: Platform): string | null {
  if (platform !== "win32") return null;
  return [
    "--split is not supported on Windows.",
    "agwinterm's session.split takes an operation but not a command, so a new pane",
    "cannot be told to run the browser. Open a pane yourself and run terminal-browser in it.",
  ].join(" ");
}

/**
 * Whether the browser can draw where it is being asked to run.
 *
 * On unix this question is asked by writing a Kitty graphics query to the terminal
 * and reading the reply (`pixel-terminals`' `probeGraphics`). On Windows that probe
 * answers the wrong question twice over: ConPTY strips the APC escape it is made
 * of, and the port does not send frames through the terminal stream anyway — they
 * leave over agwinterm's control pipe (`docs/design/00-port-brief.md`). So what
 * decides it here is whether we are in an agwinterm pane, which the pane's own
 * environment states outright.
 */
export function windowsHostRefusal(
  platform: Platform,
  env: Record<string, string | undefined>,
): string | null {
  if (platform !== "win32") return null;
  if (inAgwintermPane(env)) return null;
  // A pane that is a pane, and is refused on the pipe, gets the refusal it earned.
  // The generic "run this from inside a pane" would be a lie to someone who is.
  const refusal = paneNamed(env) ? pipeRefusal(env) : null;
  if (refusal) {
    return [
      "terminal-browser will not address this pane's agwinterm instance:",
      `${refusal}.`,
      "Frames and the clear that takes them back both go to that instance, so a",
      "browser started here would draw somewhere this build was told not to.",
    ].join(" ");
  }
  return [
    "terminal-browser on Windows draws into an agwinterm pane and there is no other host.",
    "Frames leave over agwinterm's control pipe rather than through the terminal's own",
    "output, because ConPTY strips the graphics escapes every other terminal would use.",
    "Run this from inside an agwinterm pane (AGWINTERM_ENABLED=1).",
  ].join(" ");
}

/**
 * The one rule for "am I in an agwinterm pane", shared by everything that asks.
 *
 * There were three, and they disagreed. This one is the engine's, because the
 * engine is what actually has to draw: `agwinterm.rs`'s `hosted` accepts any
 * non-empty `AGWINTERM_ENABLED` other than `"0"`, and `cli/src/pane.ts` matches it.
 * Requiring exactly `"1"` here made the CLI refuse to open a browser the engine
 * would have drawn into perfectly well, for a host that spelled the flag `true`.
 *
 * The addressing rule is the engine's too. `"active"` names whichever pane happens
 * to be in front, which is not the same pane a moment later, so it is refused
 * rather than accepted -- taking it would have let the CLI launch a browser that
 * then refused every frame, which is a browser that starts and shows nothing.
 *
 * The pipe is the engine's too, and was the axis on which "one rule" was still
 * three. `HostTarget::from_env` refuses a pane whose `AGWINTERM_PIPE` is not a pipe
 * name, `paneClearRequest` rejected only `[\\/]`, and this function did not look at
 * the variable at all — so a pane spelling it `agwinterm 2` passed here, launched a
 * browser, and the engine then had nowhere to draw. All three now apply
 * [`PIPE_NAME`] and the `TERMINAL_BROWSER_ALLOW_PIPE` guard, and
 * `tools/cli/unsupported.test.mjs`'s `HOST_CASES` carries `AGWINTERM_PIPE` rows so
 * they cannot drift apart again.
 *
 * `pane.ts` deliberately repeats this instead of importing it: that module is kept
 * free of workspace imports so it can run after the browser has gone. What is
 * shared is the rule, and `tools/cli/unsupported.test.mjs` drives the same table
 * through both.
 */
export function inAgwintermPane(env: Record<string, string | undefined>): boolean {
  return paneNamed(env) !== null && pipeRefusal(env) === null;
}

/** The pane this environment addresses, before the pipe is considered. */
function paneNamed(env: Record<string, string | undefined>): string | null {
  const enabled = env.AGWINTERM_ENABLED?.trim();
  if (!enabled || enabled === "0") return null;
  const target = env.AGWINTERM_SESSION_ID?.trim() || env.AGWINTERM_PANE_ID?.trim();
  if (!target || target === "active") return null;
  return target;
}

/** `agwinterm.rs`'s `valid_pipe_name`, and `pane.ts`'s `PIPE_NAME`. */
const PIPE_NAME = /^[A-Za-z0-9._-]+$/;

/** `agwinterm.rs`'s `DEFAULT_PIPE`, and `pane.ts`'s. */
const DEFAULT_PIPE = "agwinterm";

/** `agwinterm.rs`'s `ALLOW_PIPE_VAR`, and `pane.ts`'s. */
export const ALLOW_PIPE_VAR = "TERMINAL_BROWSER_ALLOW_PIPE";

/**
 * Why this pane's instance may not be addressed, or `null`.
 *
 * The third copy of `pane.ts`'s `pipeRefusal`, which is the third copy of the
 * engine's `valid_pipe_name` + `pipe_refusal`. Repeated rather than imported for the
 * same reason as everything else here: this module imports nothing, so the CLI's
 * refusals can be transpiled and driven on their own.
 *
 * Assumes a pane — the caller has already established one. See `pane.ts`'s copy for
 * why the CLI honours `TERMINAL_BROWSER_ALLOW_PIPE` whenever it is set while the
 * engine consults it only under `debug_assertions`.
 */
function pipeRefusal(env: Record<string, string | undefined>): string | null {
  const pipe = env.AGWINTERM_PIPE?.trim() || DEFAULT_PIPE;
  if (!PIPE_NAME.test(pipe)) {
    return (
      `AGWINTERM_PIPE=${JSON.stringify(pipe)} is not a pipe name — it may contain ` +
      "only letters, digits, `.`, `_` and `-`"
    );
  }
  const allow = env[ALLOW_PIPE_VAR]?.trim();
  const entries = (allow ?? "")
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return null;
  if (entries.some((entry) => entry === "*" || entry === pipe)) return null;
  const source = env.AGWINTERM_PIPE?.trim()
    ? `AGWINTERM_PIPE names ${JSON.stringify(pipe)}`
    : `AGWINTERM_PIPE is unset, so this pane resolves to ${JSON.stringify(pipe)}`;
  return (
    `${source}, and ${ALLOW_PIPE_VAR}=${JSON.stringify(allow)} does not list it — ` +
    `add ${JSON.stringify(pipe)} to ${ALLOW_PIPE_VAR}, or set it to \`*\` to allow ` +
    "any instance, or unset it to turn the guard off"
  );
}

/**
 * What `terminal-browser setup` has to say about sandboxing on this platform.
 *
 * Not an "unsupported" in the same sense: Chromium *is* sandboxed on Windows, by
 * the OS, with no host configuration to install. The AppArmor step exists because
 * Ubuntu withholds unprivileged user namespaces, which is a Linux-only problem.
 * Returning a sentence rather than nothing is the point — `setup` returning 0 in
 * silence reads as "a sandbox was configured", and nothing was.
 */
export function sandboxSetupNote(platform: Platform): string | null {
  if (platform === "linux") return null;
  if (platform === "win32") {
    return "sandbox: nothing to set up on Windows — Chromium sandboxes its own processes, and the AppArmor profile this step installs is a Linux-only workaround for unprivileged user namespaces.";
  }
  return `sandbox: nothing to set up on ${platform} — the AppArmor profile this step installs is Linux-only.`;
}
