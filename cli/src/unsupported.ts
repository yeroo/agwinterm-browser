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
  if (env.AGWINTERM_ENABLED === "1" && (env.AGWINTERM_SESSION_ID || env.AGWINTERM_PANE_ID)) {
    return null;
  }
  return [
    "terminal-browser on Windows draws into an agwinterm pane and there is no other host.",
    "Frames leave over agwinterm's control pipe rather than through the terminal's own",
    "output, because ConPTY strips the graphics escapes every other terminal would use.",
    "Run this from inside an agwinterm pane (AGWINTERM_ENABLED=1).",
  ].join(" ");
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
