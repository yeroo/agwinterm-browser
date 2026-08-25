// What the omnibox and `open` do with a path the user spelled the Windows way.
//
// `CALLER_CWD_VAR` (`cli/src/launch.ts`, `browser/src/entry.ts`) exists so that a
// foreground browser — spawned with `cwd: browser/`, so its own `process.cwd()` is
// the wrong answer — resolves `open ./page.html` against the directory the user ran
// the CLI in. The variable is plumbed and tested; what it feeds was not. `localFile`
// matched `./` and `~/` only, so on Windows the two spellings the platform prefers,
// `.\page.html` and `~\pics\a.png`, matched nothing, and `normalizeUrl` handed
// Chromium a Google search for the literal text.
//
// Both halves are pinned here, because the fix is deliberately one-sided:
//
//  1. **Windows resolves both separators.** A relative path found on disk becomes a
//     `file://` URL, and a `~` one expands against the home directory.
//
//  2. **Unix is left exactly as it was.** A backslash is an ordinary filename
//     character there, so `.\page.html` names a file called `.\page.html` and must
//     not be re-read as `./page.html`. `url.ts` selects its patterns from
//     `process.platform`, so bundling with that value fixed is what lets this run
//     from a Windows machine.
//
// `os.homedir()` reads `USERPROFILE` on Windows and `HOME` elsewhere, both at call
// time, so the `~` cases point at a scratch directory rather than at the real home.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-url-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** `browser/src/url.ts` with `process.platform` fixed at build time. */
async function loadUrl(platform) {
  const out = path.join(scratch, `url-${platform}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(REPO, "browser/src/url.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    define: { "process.platform": JSON.stringify(platform) },
    logLevel: "silent",
  });
  return import(pathToFileURL(out).href);
}

const win32 = await loadUrl("win32");
const posix = await loadUrl("linux");

/** A directory holding `page.html`, plus a `sub/` to reach it from with `..`. */
function pageDir(name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  const page = path.join(dir, "page.html");
  fs.writeFileSync(page, "<html></html>");
  return { dir, page, sub: path.join(dir, "sub") };
}

/** Runs `body` with `os.homedir()` pointing at `dir`. */
function withHome(dir, body) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("normalizeUrl on Windows: the separator the platform prefers", () => {
  it("resolves .\\page.html against the caller's directory", () => {
    const { dir, page } = pageDir("backslash-dot");
    assert.equal(win32.normalizeUrl(".\\page.html", dir), pathToFileURL(page).toString());
  });

  it("still resolves the forward-slash spelling", () => {
    const { dir, page } = pageDir("slash-dot");
    assert.equal(win32.normalizeUrl("./page.html", dir), pathToFileURL(page).toString());
  });

  it("resolves ..\\ out of a subdirectory", () => {
    const { page, sub } = pageDir("backslash-dotdot");
    assert.equal(win32.normalizeUrl("..\\page.html", sub), pathToFileURL(page).toString());
  });

  it("expands ~\\ against the home directory", () => {
    const { dir, page } = pageDir("backslash-tilde");
    withHome(dir, () => {
      assert.equal(win32.normalizeUrl("~\\page.html", undefined), pathToFileURL(page).toString());
    });
  });

  it("searches for a relative path that is not on disk, rather than inventing a file", () => {
    const { dir } = pageDir("backslash-missing");
    assert.match(win32.normalizeUrl(".\\nope.html", dir), /^https:\/\/www\.google\.com\/search\?/);
  });

  it("hands the omnibox the path back, so the controller resolves it once", () => {
    const { dir } = pageDir("backslash-omnibox");
    assert.equal(win32.searchOrUrl(".\\page.html", dir), ".\\page.html");
  });
});

describe("unix keeps every backslash as a filename character", () => {
  it("does not read .\\page.html as ./page.html", () => {
    const { dir } = pageDir("posix-dot");
    assert.match(posix.normalizeUrl(".\\page.html", dir), /^https:\/\/www\.google\.com\/search\?/);
  });

  it("does not expand ~\\page.html", () => {
    const { dir } = pageDir("posix-tilde");
    withHome(dir, () => {
      assert.match(
        posix.normalizeUrl("~\\page.html", undefined),
        /^https:\/\/www\.google\.com\/search\?/,
      );
    });
  });

  it("still resolves ./ and ~/", () => {
    const { dir, page } = pageDir("posix-slash");
    assert.equal(posix.normalizeUrl("./page.html", dir), pathToFileURL(page).toString());
    withHome(dir, () => {
      assert.equal(posix.normalizeUrl("~/page.html", undefined), pathToFileURL(page).toString());
    });
  });
});
