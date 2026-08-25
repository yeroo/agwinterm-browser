// Where Electron lives, and how to start it without a shell in the middle.
//
// The unix original built one `/bin/sh -c` line: the shell supplied `exec`, POSIX
// single-quote escaping, and `2>>` redirection into the log. Windows has none of
// those, so this builds a plain (file, args, cwd) triple plus the log path — the
// caller opens the log itself and hands the descriptor to `spawn` as fd 2. That
// is the same shape on every platform, so the shell goes away everywhere rather
// than only here.
//
// This module deliberately imports nothing but `node:path`, so it can be loaded
// and exercised without the workspace packages `main.ts` pulls in.

import path from "node:path";

export type Platform = NodeJS.Platform;

/** Electron's own executable, relative to `node_modules/electron/dist`. */
export function electronBinaryParts(platform: Platform): string[] {
  if (platform === "darwin") return ["Electron.app", "Contents", "MacOS", "Electron"];
  if (platform === "win32") return ["electron.exe"];
  return ["electron"];
}

/** The packaged executable, relative to `<dist root>/electron`. */
export function distBinaryParts(platform: Platform): string[] {
  if (platform === "darwin") {
    return ["terminal-browser.app", "Contents", "MacOS", "terminal-browser"];
  }
  if (platform === "win32") return ["electron.exe"];
  return ["electron"];
}

export function electronBinaryPath(options: {
  platform: Platform;
  browserDir: string;
  distRoot?: string | null;
}): string {
  const { platform, browserDir, distRoot } = options;
  return distRoot
    ? path.join(distRoot, "electron", ...distBinaryParts(platform))
    : path.join(browserDir, "node_modules", "electron", "dist", ...electronBinaryParts(platform));
}

/** Chromium flags the platform needs but the caller did not ask for. */
export function platformChromiumArgs(
  platform: Platform,
  env: Record<string, string | undefined>,
): string[] {
  // headless ozone reports a 1x1 screen unless told otherwise:
  // https://source.chromium.org/chromium/chromium/src/+/refs/tags/150.0.7871.212:ui/ozone/platform/headless/headless_screen.cc;l=37-46
  if (platform !== "linux") return [];
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return [];
  return ["--ozone-platform=headless", "--screen-info={8192x8192}"];
}

export interface LaunchPlan {
  /** The executable to spawn. Never a shell. */
  file: string;
  args: string[];
  cwd: string;
  /** Opened by the caller and passed to `spawn` as fd 2, in place of `2>>`. */
  stderrLog: string;
}

export function browserLaunchPlan(options: {
  platform: Platform;
  env: Record<string, string | undefined>;
  electron: string;
  main: string;
  argv: string[];
  browserDir: string;
  logDir: string;
}): LaunchPlan {
  const { platform, env, electron, main, argv, browserDir, logDir } = options;
  return {
    file: electron,
    args: [main, ...argv, ...platformChromiumArgs(platform, env)],
    cwd: browserDir,
    stderrLog: path.join(logDir, "stderr.log"),
  };
}

/**
 * Which required artifact is missing, and the fix that applies to that one.
 *
 * A missing `electron.exe` is an install problem, not a build problem; telling
 * the reader to build the browser sends them to the wrong place.
 */
export function missingLaunchArtifact(
  electron: string,
  main: string,
  exists: (candidate: string) => boolean,
): string | null {
  if (!exists(electron)) {
    return `missing ${electron} — install the browser's dependencies first (pnpm install)`;
  }
  if (!exists(main)) {
    return `missing ${main} — build the browser first (pnpm --filter terminal-browser build)`;
  }
  return null;
}

/**
 * The variable the engine reads to find the process that owns the pane's console.
 *
 * Named here rather than inline at the spawn, so the one string the whole
 * foreground process model rests on has a definition a test can point at. Its
 * other end is `CONSOLE_PID_VAR` in `engine/crates/pixel-core/src/terminal_windows.rs`;
 * `tools/launcher/launch.test.mjs` asserts the two still spell it the same way.
 */
export const CONSOLE_PID_VAR = "TERMINAL_BROWSER_CONSOLE_PID";

/**
 * The variable the browser reads to find the directory the CLI was run in.
 *
 * The child is spawned with `cwd: browser/` (that is where its `main.js` and its
 * `node_modules` are), so `process.cwd()` inside it is not the user's directory.
 * On unix that never mattered: the daemon request carried `cwd` from the caller.
 * The Windows foreground path has no request to put it in, and without this a
 * relative `open ./page.html`, `--preload=./x.js` or `--main-script=./y.js`
 * resolved against `browser/` and silently became a web search.
 */
export const CALLER_CWD_VAR = "TERMINAL_BROWSER_CALLER_CWD";

/**
 * The environment a foreground browser is started with: the caller's, plus the two
 * things the child cannot work out for itself.
 */
export function foregroundSpawnEnv(
  env: Record<string, string | undefined>,
  consolePid: number,
  cwd: string,
): Record<string, string | undefined> {
  return { ...env, [CONSOLE_PID_VAR]: String(consolePid), [CALLER_CWD_VAR]: cwd };
}

/**
 * The signals a foreground browser's CLI must not die on, and the exit code each
 * one means. `SIGBREAK` is Windows' Ctrl+Break and has no unix equivalent;
 * `SIGTERM` and `SIGHUP` are never raised by a Windows console but are what
 * `process.kill` and a closing unix terminal send, so all four are listened for on
 * both platforms.
 *
 * The point of listening is not to handle them but to *not be killed by them*:
 * Node terminates immediately on an unhandled SIGINT, which would skip the pane
 * clear and leave the browser's last frame painted over the shell.
 */
export const FOREGROUND_SIGNALS: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGBREAK", 130],
  ["SIGHUP", 129],
];

/**
 * How long the CLI waits, after a signal, for a browser that got the same signal
 * to leave on its own before taking the pane back. Long enough for an ordinary
 * teardown (the engine's `Drop` clears its own frame); short enough that a wedged
 * browser does not hold the pane's picture hostage.
 */
export const FOREGROUND_SIGNAL_GRACE_MS = 2_000;
