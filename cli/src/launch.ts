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
