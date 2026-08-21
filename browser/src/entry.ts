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

/**
 * The variable the CLI uses to tell a foreground browser which directory the user
 * ran the command in.
 *
 * The browser is spawned with `cwd: browser/`, because that is where its `main.js`
 * and its `node_modules` are, so `process.cwd()` inside it is not the caller's
 * directory. On unix that never came up: the daemon request carried `cwd` from the
 * client. The Windows foreground path has no request to carry it in.
 *
 * Its other end is `CALLER_CWD_VAR` in `cli/src/launch.ts`, and
 * `tools/process-model/entry.test.mjs` asserts the two still spell it the same way.
 */
export const CALLER_CWD_VAR = "TERMINAL_BROWSER_CALLER_CWD";

/**
 * The directory a session should resolve relative paths against.
 *
 * Falls back to the process's own, which is right for the daemon shape (where the
 * request supplies `cwd` separately) and is the honest answer when the launcher did
 * not say. A blank value is treated as absent rather than as the root.
 */
export function callerCwd(
  env: Record<string, string | undefined>,
  fallback: string,
): string {
  const named = env[CALLER_CWD_VAR]?.trim();
  return named ? named : fallback;
}
