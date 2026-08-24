// Guards Task 9's launcher port: how the Electron binary is resolved, and what
// is actually spawned once it is found.
//
// Three separate unix assumptions lived in `cli/src/main.ts` and all three fail
// on Windows in ways that misreport their own cause:
//
//   - `ELECTRON_DEV_BIN = ["electron"]` for every non-darwin platform, so the
//     `fs.existsSync` guard looked for an extensionless file that Windows never
//     produces and blamed the browser build for a binary that was there
//   - `["/bin/sh", "-c", line]`, a path Windows does not have
//   - POSIX single-quote escaping and `2>>` redirection inside that line
//
// The port moves all of it into `cli/src/launch.ts`, which imports only
// `node:path` so it can be loaded here without the workspace packages `main.ts`
// pulls in (`pixel-store` has no build on Windows until Task 13).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-launch-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** Transpiles one node-builtins-only TypeScript module and imports it. */
async function loadModule(relative) {
  const source = fs.readFileSync(path.join(REPO, relative), "utf8");
  const { code } = await esbuild.transform(source, { loader: "ts", format: "esm" });
  const out = path.join(scratch, `${path.basename(relative, ".ts")}.mjs`);
  fs.writeFileSync(out, code);
  return import(pathToFileURL(out).href);
}

const launch = await loadModule("cli/src/launch.ts");
const mainSource = fs.readFileSync(path.join(REPO, "cli", "src", "main.ts"), "utf8");

const BROWSER_DIR = path.join(REPO, "browser");

const devPath = (platform) =>
  launch.electronBinaryPath({ platform, browserDir: BROWSER_DIR, distRoot: null });
const distPath = (platform, distRoot) =>
  launch.electronBinaryPath({ platform, browserDir: BROWSER_DIR, distRoot });

describe("electron binary resolution", () => {
  it("resolves the Windows dev binary with its .exe suffix", () => {
    assert.equal(
      devPath("win32"),
      path.join(BROWSER_DIR, "node_modules", "electron", "dist", "electron.exe"),
    );
  });

  it("finds the binary pnpm actually installed", () => {
    // The whole bug was a path that named nothing. Drive the real tree rather
    // than a string comparison that would agree with any consistent mistake.
    assert.ok(
      fs.existsSync(devPath(process.platform)),
      `no electron at ${devPath(process.platform)} — was the install run?`,
    );
  });

  it("leaves the darwin app bundle and the linux name alone", () => {
    assert.equal(
      devPath("darwin"),
      path.join(
        BROWSER_DIR,
        "node_modules",
        "electron",
        "dist",
        "Electron.app",
        "Contents",
        "MacOS",
        "Electron",
      ),
    );
    assert.equal(
      devPath("linux"),
      path.join(BROWSER_DIR, "node_modules", "electron", "dist", "electron"),
    );
  });

  it("suffixes the packaged binary too, so a distribution is not a second bug", () => {
    const root = path.join(scratch, "dist-root");
    assert.equal(distPath("win32", root), path.join(root, "electron", "electron.exe"));
    assert.equal(distPath("linux", root), path.join(root, "electron", "electron"));
    assert.equal(
      distPath("darwin", root),
      path.join(
        root,
        "electron",
        "terminal-browser.app",
        "Contents",
        "MacOS",
        "terminal-browser",
      ),
    );
  });
});

describe("the missing-artifact diagnosis", () => {
  const electron = devPath("win32");
  const main = path.join(BROWSER_DIR, "dist", "main.js");
  const present = new Set([electron, main]);

  it("says nothing when both artifacts are there", () => {
    assert.equal(launch.missingLaunchArtifact(electron, main, (p) => present.has(p)), null);
  });

  it("blames the install, not the build, for a missing electron", () => {
    const message = launch.missingLaunchArtifact(electron, main, (p) => p !== electron);
    assert.match(message, /electron\.exe/);
    assert.match(message, /install/);
    assert.ok(
      !/build the browser/.test(message),
      "a missing electron is an install problem; sending the reader to the build is the wrong fix",
    );
  });

  it("still blames the build for a missing main.js", () => {
    const message = launch.missingLaunchArtifact(electron, main, (p) => p !== main);
    assert.match(message, /main\.js/);
    assert.match(message, /build the browser first/);
  });
});

describe("launch plan construction", () => {
  const base = {
    electron: devPath("win32"),
    main: path.join(BROWSER_DIR, "dist", "main.js"),
    browserDir: BROWSER_DIR,
    logDir: path.join(scratch, "logs"),
  };
  const plan = (platform, argv, env = {}) =>
    launch.browserLaunchPlan({ ...base, platform, env, argv });

  it("spawns electron itself, never a shell", () => {
    const windows = plan("win32", ["--daemon"]);
    assert.equal(windows.file, base.electron);
    assert.ok(!windows.file.includes("sh"), "the shell is gone from the Windows path");
    // and from the unix path too, now that nothing needs `exec` or `2>>`
    assert.equal(plan("linux", ["--daemon"], { DISPLAY: ":0" }).file, base.electron);
    assert.equal(plan("darwin", ["--daemon"]).file, base.electron);
  });

  it("passes the entry script first and the caller's argv verbatim", () => {
    assert.deepEqual(plan("win32", ["--daemon"]).args, [base.main, "--daemon"]);
  });

  it("applies no quoting, because there is no shell left to quote for", () => {
    // A profile directory with a space or an apostrophe is ordinary on Windows.
    const awkward = ["--partition=C:\\Users\\a b\\it's", "--url=x&y"];
    assert.deepEqual(plan("win32", awkward).args, [base.main, ...awkward]);
  });

  it("runs from the browser directory", () => {
    assert.equal(plan("win32", []).cwd, BROWSER_DIR);
  });

  it("names the log file the caller opens in place of 2>>", () => {
    assert.equal(plan("win32", []).stderrLog, path.join(base.logDir, "stderr.log"));
  });

  it("keeps the headless-ozone flags on linux, and only there", () => {
    assert.deepEqual(launch.platformChromiumArgs("linux", {}), [
      "--ozone-platform=headless",
      "--screen-info={8192x8192}",
    ]);
    assert.deepEqual(launch.platformChromiumArgs("linux", { DISPLAY: ":0" }), []);
    assert.deepEqual(launch.platformChromiumArgs("linux", { WAYLAND_DISPLAY: "wayland-0" }), []);
    assert.deepEqual(launch.platformChromiumArgs("win32", {}), []);
    assert.deepEqual(launch.platformChromiumArgs("darwin", {}), []);
  });

  it("appends those flags after the caller's own, as the shell line did", () => {
    assert.deepEqual(plan("linux", ["https://example.com"], {}).args, [
      base.main,
      "https://example.com",
      "--ozone-platform=headless",
      "--screen-info={8192x8192}",
    ]);
    assert.deepEqual(plan("win32", ["https://example.com"], {}).args, [
      base.main,
      "https://example.com",
    ]);
  });
});

describe("the CLI's use of the plan", () => {
  it("has no POSIX shell left in it", () => {
    assert.ok(!mainSource.includes("/bin/sh"), "/bin/sh is back in cli/src/main.ts");
    assert.ok(!mainSource.includes("2>>"), "shell redirection is back in cli/src/main.ts");
    assert.ok(!mainSource.includes("exec "), "the shell `exec` prefix is back");
  });

  it("hands spawn a file and an argument array, not a command line", () => {
    assert.match(mainSource, /spawn\(plan\.file,\s*plan\.args/);
  });

  it("redirects stderr by descriptor, which is what replaced the redirection", () => {
    assert.match(mainSource, /openSync\(plan\.stderrLog, "a"\)/);
    assert.match(mainSource, /stdio: \["ignore", "ignore", stderr\]/);
  });

  it("still detaches the daemon and drops its handle", () => {
    assert.match(mainSource, /detached: true/);
    assert.match(mainSource, /child\.unref\(\)/);
  });

  it("leaves the registry, ssh, sandbox and upgrade surface for Task 13", () => {
    // Named here so a later reader can see the scope line was deliberate.
    for (const module of ["./registry", "./sandbox", "./ssh", "./upgrade"]) {
      assert.ok(mainSource.includes(`from "${module}"`), `${module} import went missing`);
    }
  });
});

describe("the environment a foreground browser is started with", () => {
  // The two variables the child cannot work out for itself, and the whole reason
  // the Windows foreground shape works at all. Both were inline string literals at
  // the spawn until this suite gave them a definition to point at.
  const rust = fs.readFileSync(
    path.join(REPO, "engine", "crates", "pixel-core", "src", "terminal_windows.rs"),
    "utf8",
  );
  const entry = fs.readFileSync(path.join(REPO, "browser", "src", "entry.ts"), "utf8");

  it("names the console pid variable the engine actually reads", () => {
    // Rename it on one side and the browser starts, draws, and never receives a
    // keystroke -- `AttachConsole` falls back to the parent process, which under a
    // wrapper is not the pane. Nothing else in either suite would notice.
    assert.match(
      rust,
      new RegExp(`CONSOLE_PID_VAR: &str = "${launch.CONSOLE_PID_VAR}"`),
      `terminal_windows.rs does not read ${launch.CONSOLE_PID_VAR}`,
    );
  });

  it("names the caller-cwd variable the browser actually reads", () => {
    assert.match(
      entry,
      new RegExp(`CALLER_CWD_VAR = "${launch.CALLER_CWD_VAR}"`),
      `browser/src/entry.ts does not read ${launch.CALLER_CWD_VAR}`,
    );
  });

  it("carries the caller's environment through, and adds the two", () => {
    // Backslashes doubled: `\w` and `\s` are unrecognised escapes, so "C:\work\site"
    // written singly collapses to "C:worksite" on both sides and the assertion passes
    // while testing nothing about a path. CALLER_CWD_VAR is always backslash-separated.
    const cwd = "C:\\work\\site";
    assert.ok(cwd.includes("\\"), "the fixture must keep its separators to be worth asserting");
    const env = launch.foregroundSpawnEnv({ PATH: "/x", TERM: "dumb" }, 4242, cwd);
    assert.equal(env.PATH, "/x");
    assert.equal(env.TERM, "dumb");
    assert.equal(env[launch.CONSOLE_PID_VAR], "4242");
    assert.equal(env[launch.CALLER_CWD_VAR], cwd);
  });

  it("does not mutate the environment it was handed", () => {
    const original = { PATH: "/x" };
    launch.foregroundSpawnEnv(original, 1, "/here");
    assert.deepEqual(original, { PATH: "/x" });
  });

  it("overrides an inherited value rather than deferring to it", () => {
    // A browser opened from inside a browser's own shell would otherwise inherit
    // the *outer* pane's console pid and attach to the wrong console.
    const env = launch.foregroundSpawnEnv(
      { [launch.CONSOLE_PID_VAR]: "11", [launch.CALLER_CWD_VAR]: "/old" },
      22,
      "/new",
    );
    assert.equal(env[launch.CONSOLE_PID_VAR], "22");
    assert.equal(env[launch.CALLER_CWD_VAR], "/new");
  });

  it("stringifies the pid, because spawn refuses a numeric env value", () => {
    assert.equal(typeof launch.foregroundSpawnEnv({}, 7, "/here")[launch.CONSOLE_PID_VAR], "string");
  });
});

describe("the signals a foreground CLI must not die on", () => {
  it("covers Ctrl+C, Ctrl+Break and both unix stop signals", () => {
    assert.deepEqual(
      launch.FOREGROUND_SIGNALS.map(([signal]) => signal),
      ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"],
      "SIGBREAK is Ctrl+Break and has no unix equivalent; dropping it loses that key",
    );
  });

  it("reports the conventional 128+signo exit code for each", () => {
    assert.deepEqual(
      launch.FOREGROUND_SIGNALS.map(([, code]) => code),
      [130, 143, 130, 129],
    );
  });

  it("gives the browser a grace period that is neither zero nor unbounded", () => {
    // Zero would take the pane's picture back while an ordinary teardown was still
    // running; unbounded would let a wedged browser hold it for ever.
    assert.ok(launch.FOREGROUND_SIGNAL_GRACE_MS >= 500);
    assert.ok(launch.FOREGROUND_SIGNAL_GRACE_MS <= 5_000);
  });
});
