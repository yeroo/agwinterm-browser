// Which shape the browser process runs in.
//
// Upstream has only one: `main.tsx` called `runDaemon(cdpPort)` unconditionally
// and never looked at the `--daemon` argument the CLI passes, because a daemon was
// the only thing it could be. The Windows port needs a second shape — see
// `docs/design/03-process-model.md` — because a detached daemon has no console and
// Windows has no path that names another process's ConPTY.
//
// Kept free of imports on purpose: this is the one piece of the entry point that
// can be tested without an Electron process or a built native engine.

export type EntryMode = "daemon" | "foreground";

/// The flag the CLI passes when it wants the multi-session daemon.
export const DAEMON_FLAG = "--daemon";

/**
 * Picks the shape from the arguments after `main.js`.
 *
 * Matched exactly rather than by substring: a URL or profile name containing
 * "daemon" is an ordinary argument, and treating it as the flag would start a
 * daemon in a pane that asked for a browser.
 */
export function entryMode(argv: readonly string[]): EntryMode {
  return argv.includes(DAEMON_FLAG) ? "daemon" : "foreground";
}

/**
 * The arguments a session should see: everything except the mode flag itself.
 */
export function sessionArgv(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg !== DAEMON_FLAG);
}
