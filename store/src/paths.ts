import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pipeEndpoint } from "./endpoint";

const HOME = os.homedir();

// Where the application's own files live.
//
// Upstream is XDG throughout: four independent base directories, each overridable
// by its own environment variable, with a fifth — `XDG_RUNTIME_DIR` — holding the
// sockets. Windows has one convention in place of all five: `%LOCALAPPDATA%`, one
// directory per application, subdivided by the application rather than by the OS.
// Sockets have no location at all there, because a named pipe is not a file.
//
// So the layout branches, and `appPaths` is a pure function of (platform, env,
// home, app name) so both branches can be checked from one test run on one machine.

export interface AppPaths {
  dataDir: string;
  logsDir: string;
  faviconsDir: string;
  instancesDir: string;
  agentSocketsDir: string;
  daemonEndpoint: string;
  dbFile: string;
}

export interface PathOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  appDirName: string;
}

function xdgBase(env: NodeJS.ProcessEnv, home: string, variable: string, fallback: string): string {
  const value = env[variable];
  return value && path.posix.isAbsolute(value) ? value : path.posix.join(home, fallback);
}

/** `%LOCALAPPDATA%`, or where it would be if the variable is missing or relative. */
function windowsBase(env: NodeJS.ProcessEnv, home: string): string {
  const local = env.LOCALAPPDATA;
  return local && path.win32.isAbsolute(local)
    ? local
    : path.win32.join(home, "AppData", "Local");
}

/**
 * Each branch joins with the flavour of `path` its own platform uses, rather than
 * with the ambient one. On the platform in question these are the same function;
 * the difference is that it makes the *other* branch checkable from here, which is
 * what lets one test run cover both columns of the layout table.
 */
export function appPaths(options: PathOptions): AppPaths {
  const { platform, env, home, appDirName } = options;
  if (platform === "win32") {
    const join = path.win32.join;
    // One root, so an uninstall is one directory and a stale install is visible as
    // one. `data`/`cache`/`logs` under it mirror what XDG splits across the home
    // directory; `instances` stays because the *endpoints* stopped being files but
    // nothing says a future per-instance file cannot live there.
    const root = join(windowsBase(env, home), appDirName);
    return {
      dataDir: join(root, "data"),
      logsDir: join(root, "logs"),
      faviconsDir: join(root, "cache", "favicons"),
      instancesDir: join(root, "instances"),
      agentSocketsDir: join(root, "agent-browser"),
      daemonEndpoint: pipeEndpoint(appDirName, "daemon"),
      dbFile: join(root, "data", "terminal-browser.db"),
    };
  }
  const join = path.posix.join;
  const dataHome = xdgBase(env, home, "XDG_DATA_HOME", ".local/share");
  const stateHome = xdgBase(env, home, "XDG_STATE_HOME", ".local/state");
  const cacheHome = xdgBase(env, home, "XDG_CACHE_HOME", ".cache");
  const runtimeHome = env.XDG_RUNTIME_DIR ?? stateHome;
  const dataDir = join(dataHome, appDirName);
  return {
    dataDir,
    logsDir: join(stateHome, appDirName, "logs"),
    faviconsDir: join(cacheHome, appDirName, "favicons"),
    instancesDir: join(runtimeHome, appDirName, "instances"),
    agentSocketsDir: join(runtimeHome, appDirName, "agent-browser"),
    daemonEndpoint: join(runtimeHome, appDirName, "daemon.sock"),
    dbFile: join(dataDir, "terminal-browser.db"),
  };
}

/**
 * Where one browser listens.
 *
 * On unix this is the socket file upstream created under the runtime directory. On
 * Windows it is a pipe named from the same two parts — the install-scoped app
 * directory name and the session key — so two installs, or two panes, never
 * collide, and neither does a Windows pipe with a unix path.
 */
export function instanceEndpointIn(paths: AppPaths, options: PathOptions, key: string): string {
  if (options.platform === "win32") {
    return pipeEndpoint(options.appDirName, "instance", key);
  }
  return path.posix.join(paths.instancesDir, `${key}.sock`);
}

function installRoot(): { root: string; dev: boolean } {
  const dist = process.env.TERMINAL_BROWSER_DIST_ROOT;
  if (dist) return { root: physical(dist), dev: false };
  for (let dir = __dirname; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return { root: dir, dev: true };
  }
  return { root: physical(__dirname), dev: true };
}

function physical(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

export const INSTALL_ROOT = installRoot();

const suffix = crypto.createHash("sha256").update(INSTALL_ROOT.root).digest("hex").slice(0, 8);

export const APP_DIR_NAME = `terminal-browser${INSTALL_ROOT.dev ? "-dev" : ""}-${suffix}`;

const OPTIONS: PathOptions = {
  platform: process.platform,
  env: process.env,
  home: HOME,
  appDirName: APP_DIR_NAME,
};

const PATHS = appPaths(OPTIONS);

export const DATA_DIR = PATHS.dataDir;
export const LOGS_DIR = PATHS.logsDir;
export const FAVICONS_DIR = PATHS.faviconsDir;
export const INSTANCES_DIR = PATHS.instancesDir;
export const AGENT_SOCKETS_DIR = PATHS.agentSocketsDir;
export const DAEMON_ENDPOINT = PATHS.daemonEndpoint;
export const DB_FILE = PATHS.dbFile;

/** Where the browser with this session key listens, on this platform. */
export function instanceEndpoint(key: string): string {
  return instanceEndpointIn(PATHS, OPTIONS, key);
}

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "install"), `${INSTALL_ROOT.root}\n`);
}
