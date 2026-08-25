import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The two prefixes this file keys on, in the separator the running platform spells
 * them with.
 *
 * Upstream matched `~/` and `./` only, which is every spelling that exists on unix.
 * Windows has two more — `~\pics\a.png` and `.\page.html` — and they are the ones a
 * Windows user actually types. Neither matched, so both fell past `localFile`
 * entirely and `normalizeUrl` turned them into a Google search: exactly the failure
 * `CALLER_CWD_VAR` (`cli/src/launch.ts`) was added to end, surviving for the
 * spelling the platform it was written for prefers.
 *
 * Widened on Windows only, and deliberately not everywhere. A backslash is an
 * ordinary filename character on unix, where `.\page.html` is a legal *relative*
 * name for a file called `.\page.html` in the current directory — resolving it as
 * `./page.html` would open the wrong file rather than fail to find one. Selected
 * from `process.platform` rather than `path.sep` so a bundler can fix the branch at
 * build time, which is how `tools/browser/url.test.mjs` reaches the unix half from
 * a Windows machine.
 */
const HOME_PREFIX = process.platform === "win32" ? /^~[\\/]/ : /^~\//;
const DOT_PREFIX = process.platform === "win32" ? /^\.\.?(?:[\\/]|$)/ : /^\.\.?(?:\/|$)/;

function localFile(input: string, cwd?: string): string | null {
  const expanded =
    input === "~" || HOME_PREFIX.test(input) ? path.join(os.homedir(), input.slice(1)) : input;
  let absolute: string | null = null;
  if (path.isAbsolute(expanded)) absolute = expanded;
  else if (cwd && DOT_PREFIX.test(expanded)) absolute = path.resolve(cwd, expanded);
  if (!absolute) return null;
  return fs.existsSync(absolute) ? absolute : null;
}

export function searchOrUrl(text: string, cwd?: string): string {
  const trimmed = text.trim();
  if (HAS_AUTHORITY.test(trimmed) || SCHEMES_WITHOUT_HOST.test(trimmed)) return trimmed;
  if (localFile(trimmed, cwd)) return trimmed;
  if (!trimmed.includes(" ") && trimmed.includes(".")) return trimmed;
  if (/^[\w-]+:\d+(\/.*)?$/.test(trimmed)) return trimmed;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export function normalizeUrl(value: string, cwd?: string): string {
  const input = value.trim();
  if (!input) return "about:blank";
  if (HAS_AUTHORITY.test(input) || SCHEMES_WITHOUT_HOST.test(input)) {
    try {
      return new URL(input).toString();
    } catch {}
  }
  const file = localFile(input, cwd);
  if (file) return pathToFileURL(file).toString();
  if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(input)) {
    const host = input.split(/[:/]/)[0].toLowerCase();
    const scheme = host === "localhost" || host === "127.0.0.1" ? "http" : "https";
    return new URL(`${scheme}://${input}`).toString();
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

const HAS_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCHEMES_WITHOUT_HOST = /^(?:data|mailto|tel|about|blob|chrome|view-source):/i;

/** Compact form shown in the tab strip. */
export function displayUrl(url: string): string {
  if (!url || url === "about:blank") return "new tab";
  if (url.startsWith("file://")) return homeRelative(url);
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function homeRelative(url: string): string {
  try {
    const file = fileURLToPath(url);
    const home = os.homedir();
    if (file === home) return "~";
    return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
  } catch {
    return url;
  }
}

export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
