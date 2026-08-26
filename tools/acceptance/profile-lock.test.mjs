// The plan's profile acceptance criteria, run against real processes.
//
// `tools/browser/profile.test.mjs` and `tools/browser/foreground.test.mjs` check the
// two fixes function by function, and both do it with `process.kill` replaced: the
// probe answers whatever the test says it answers, and the pids are numbers nobody
// ever spawned. That is the right shape for pinning which branch each error code
// takes — there is no way to *make* Windows return `EPERM` on demand — but it leaves
// one thing unasserted, and it is the thing the criteria are written about: that a
// real second browser, probing a real first one that is really running, actually
// takes a different profile.
//
// So nothing here stubs the probe. Every pid is a process this file spawned, live or
// force-killed, and `alive()` runs against it exactly as it would in a browser:
//
//   - a live holder is skipped, and its lock is still its own afterwards;
//   - a holder killed with `taskkill /F` — no destructor, so its lock survives it,
//     which is the crash this recovery exists for — has its profile reclaimed;
//   - a foreground process that quits normally leaves no lock, asserted after the
//     process is genuinely gone rather than against a recorded `app.exit` call.
//
// **On integrity levels.** The `EPERM` case this whole divergence exists for needs a
// holder at a *higher* integrity level than the prober, and a test suite cannot
// elevate one. Two children of this file are peers, so the real probe succeeds
// outright. That is still a live holder taking the alive branch, which is what the
// criterion asks; the `EPERM` route into the same branch is pinned by
// `tools/browser/profile.test.mjs`. What this file adds on top is that the probe's
// real answer is *reported* rather than assumed — a platform that started saying
// `ESRCH` for a running process would fail here by name instead of quietly turning
// the criterion into a tautology.
//
// `profile.ts` and `foreground.ts` import Electron, which cannot run here, so both
// are bundled once against a stub that is a working object rather than a recorder:
// `setPath` really moves `userData`, `exit` really ends the process, and `on` is
// deliberately a no-op, because `app.exit` emitting no `will-quit` is the exact
// upstream behaviour the `foreground.ts` fix exists to work around. Faking it any
// other way would test the fake.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import esbuild from "esbuild";

import { settlesWithin, withDeadline } from "../lib/deadline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const LOCK_NAME = "terminal-browser.lock";

/** How long a child of this suite gets before it is a hang rather than a run. */
const CHILD_MS = 30_000;

// The real directory name, from the built store rather than a plausible-looking
// constant: `claimProfile` numbers its profiles off this, and a test that invented
// its own name would still pass if the port and the store stopped agreeing on it.
// `paths.js` is imported directly because the package index opens the database, and
// this file wants a string, not a store.
const { APP_DIR_NAME } = await import(pathToFileURL(path.join(REPO, "store/dist/paths.js")).href);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-profile-accept-"));
const strays = [];
after(() => {
  for (const pid of strays) forceKill(pid);
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** `taskkill /F`: the exit that runs no destructor, so the lock outlives the holder. */
function forceKill(pid) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/PID", String(pid)], { timeout: 15_000, stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Already gone, which is the state every caller wanted.
  }
}

/**
 * `claimProfile` and the foreground exit routes, bundled together against one
 * Electron stub.
 *
 * One bundle rather than two, because the two files talk to each other *through*
 * `app`: `profile.ts` decides `userData` with `setPath` and `foreground.ts` reads it
 * back with `getPath`. Bundling them separately would give each its own stub and its
 * own `userData`, and every release would silently look at the wrong directory —
 * passing for the wrong reason, which is worse here than failing.
 */
async function buildPort() {
  const entry = path.join(scratch, "entry.mjs");
  const out = path.join(scratch, "port.mjs");
  const src = (file) => JSON.stringify(path.join(REPO, "browser/src", file));
  fs.writeFileSync(
    entry,
    [
      `import { app } from "electron";`,
      `export { claimProfile } from ${src("profile.ts")};`,
      `export { releaseProfileLock, runForeground } from ${src("foreground.ts")};`,
      // How the child reports what `claimProfile` chose: the function returns
      // nothing and says it by moving `userData`, so this asks the same way
      // `foreground.ts` does.
      `export const chosen = () => app.getPath("userData");`,
    ].join("\n"),
  );

  const stubs = {
    electron: [
      "let userData = null;",
      "export const app = {",
      "  getPath(name) {",
      '    if (name !== "userData") throw new Error("unexpected getPath " + name);',
      '    if (userData === null) throw new Error("no userData path yet");',
      "    return userData;",
      "  },",
      "  setPath(name, value) { userData = value; },",
      // Not an oversight. Electron specifies that `app.exit` terminates without
      // emitting `will-quit`, so the handler `claimProfile` registers there never
      // runs — which is the leak `releaseProfileLock` was added to close. A stub
      // that fired it would hide the defect and pass this suite on the old code.
      "  on() {},",
      "  exit(code) { process.exit(code); },",
      "};",
    ].join("\n"),
    store: `export const APP_DIR_NAME = ${JSON.stringify(APP_DIR_NAME)};`,
    session: "export const createSession = (ctx) => globalThis.__session(ctx);",
  };
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    plugins: [
      {
        name: "stub-electron-store-and-session",
        setup(build) {
          build.onResolve({ filter: /^(electron|pixel-store|\.\/session\/session)$/ }, (arg) => ({
            path:
              arg.path === "electron"
                ? "electron"
                : arg.path === "pixel-store"
                  ? "store"
                  : "session",
            namespace: "stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, (arg) => ({
            loader: "js",
            contents: stubs[arg.path],
          }));
        },
      },
    ],
    logLevel: "silent",
  });
  return out;
}

const PORT = await buildPort();

/**
 * The child: one browser's worth of profile handling, in a process of its own.
 *
 * `hold` claims and stays up, which is the live first browser. `close` and `signal`
 * claim and then leave through the two real exit routes in `foreground.ts` —
 * `onClose` and a signal handler. The signal is *emitted in the child* rather than
 * sent to it, because on Windows delivering one from outside terminates the target
 * outright: the handler would never run and the test would report a leak that the
 * fix does prevent.
 *
 * `crash` is the route none of the nine `app.exit` sites can cover: it registers the
 * `exit` handler `main.tsx` registers, and then throws from a timer, which is the
 * uncaught-exception path Node terminates on by itself. The two lines it mirrors are
 * held to `main.tsx` by `tools/browser/foreground.test.mjs`, because a child that
 * arranged its own handler and then asserted the handler ran would be a test of this
 * file. What it establishes here is the half that is not obvious from reading either:
 * that Node really emits `exit` after an uncaught throw, and that `releaseProfileLock`
 * is a legal thing to do inside one.
 *
 * `probe` names a pid to run the real `process.kill(pid, 0)` against before
 * claiming, and prints what came back. That line is what keeps "the live holder was
 * skipped" from being a claim about a probe nobody watched.
 */
const CHILD = `
  import { claimProfile, chosen, releaseProfileLock, runForeground } from ${JSON.stringify(pathToFileURL(PORT).href)};

  // With \`node -e\`, argv[1] is the first argument: there is no script path to hold
  // the usual slot.
  const route = process.argv[1];
  const probe = Number(process.argv[2] ?? 0);
  if (probe) {
    try {
      process.kill(probe, 0);
      console.log("probe ok");
    } catch (error) {
      console.log("probe " + (error.code ?? "no-code"));
    }
  }

  claimProfile();
  console.log("chose " + chosen());

  if (route === "hold") {
    console.log("ready");
    setInterval(() => {}, 1000);
  } else if (route === "crash") {
    process.on("exit", releaseProfileLock);
    setTimeout(() => {
      throw new Error("an exit nobody wrote");
    }, 10);
  } else {
    globalThis.__session = (ctx) => {
      globalThis.__ctx = ctx;
      return { ready: Promise.resolve(), close: () => {}, nudgeResize: () => {} };
    };
    await runForeground(null, []);
    if (route === "signal") process.emit("SIGINT");
    else globalThis.__ctx.onClose(0);
  }
`;

/** A fresh `appData` root, so the numbered profiles start empty. */
function freshAppData(t) {
  const dir = fs.mkdtempSync(path.join(scratch, "appdata-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function profileDir(appData, index) {
  return path.join(appData, index === 0 ? APP_DIR_NAME : `${APP_DIR_NAME}-${index + 1}`);
}

function lockOf(appData, index) {
  return path.join(profileDir(appData, index), LOCK_NAME);
}

/** Spawns the child against `appData`, with `strays` and `t.after` owning its death. */
function spawnChild(t, appData, route, probe = 0) {
  const args = ["--input-type=module", "-e", CHILD, "--", route, String(probe)];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, TERMINAL_BROWSER_APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  strays.push(child.pid);
  t.after(() => forceKill(child.pid));

  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  return { child, read: () => out, readErr: () => err };
}

/** Runs the child to completion and reports its exit code and output. */
async function runChild(t, appData, route, probe = 0) {
  const { child, read, readErr } = spawnChild(t, appData, route, probe);
  const code = await withDeadline(
    new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    }),
    `the ${route} child to exit`,
    CHILD_MS,
  );
  return { code, out: read(), err: readErr() };
}

/** Starts a child that claims a profile and stays up, once it has said so. */
async function holdProfile(t, appData, probe = 0) {
  const { child, read, readErr } = spawnChild(t, appData, "hold", probe);
  await withDeadline(
    new Promise((resolve, reject) => {
      child.stdout.on("data", () => {
        if (read().includes("ready")) resolve();
      });
      child.once("exit", (code) =>
        reject(new Error(`the holder exited ${code} before claiming: ${read()}${readErr()}`)),
      );
      child.once("error", reject);
    }),
    "the holder to claim a profile",
    CHILD_MS,
  );
  return { pid: child.pid, out: read() };
}

/** The directory the child said it took. */
function choseDir(out) {
  const line = out.split(/\r?\n/).find((it) => it.startsWith("chose "));
  assert.ok(line, `the child never reported a profile: ${JSON.stringify(out)}`);
  return line.slice("chose ".length).trim();
}

/** What the child's real probe of a real pid returned. */
function probeAnswer(out) {
  const line = out.split(/\r?\n/).find((it) => it.startsWith("probe "));
  assert.ok(line, `the child never reported a probe: ${JSON.stringify(out)}`);
  return line.slice("probe ".length).trim();
}

/**
 * Whether Windows still lists `pid`, asked without `process.kill`.
 *
 * Deliberately not the same question `alive()` answers. This suite waits on a child's
 * death before asserting what a probe of it returns, and using the rule under test to
 * decide when to test the rule would make the wait agree with the answer by
 * construction. `tasklist` knows nothing about signals or integrity levels.
 */
function stillRunning(pid) {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  }
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
      timeout: 15_000,
      encoding: "utf8",
    });
    return out.includes(String(pid));
  } catch {
    return false;
  }
}

describe("a second browser launched against a live first one", () => {
  it("takes its own profile and leaves the first's lock naming the first", async (t) => {
    const appData = freshAppData(t);
    const first = await holdProfile(t, appData);
    const firstDir = profileDir(appData, 0);
    assert.equal(choseDir(first.out), firstDir, "the first browser skipped a free profile");
    assert.equal(fs.readFileSync(lockOf(appData, 0), "utf8"), String(first.pid));

    // A real second process probing a real running one. Nothing is stubbed here:
    // this is `alive()` answering about a pid Windows currently owns.
    const second = await holdProfile(t, appData, first.pid);

    // Peers, so the probe succeeds rather than being refused — see the header. Both
    // answers mean alive; `ESRCH` for a running process would mean the criterion had
    // stopped being about anything, so it is named rather than left to the outcome.
    assert.ok(
      ["ok", "EPERM"].includes(probeAnswer(second.out)),
      `a live holder probed as ${probeAnswer(second.out)}; only ok and EPERM mean alive`,
    );

    assert.equal(
      choseDir(second.out),
      profileDir(appData, 1),
      "the second browser took the live first one's userData directory",
    );
    assert.equal(
      fs.readFileSync(lockOf(appData, 0), "utf8"),
      String(first.pid),
      "the first browser's lock was overwritten while it was still running",
    );
    assert.equal(fs.readFileSync(lockOf(appData, 1), "utf8"), String(second.pid));
  });
});

describe("a normal foreground quit leaves no lock behind", () => {
  // Asserted after the process is genuinely gone, not against a recorded `app.exit`:
  // `exit` in the stub is `process.exit`, so anything scheduled to release *after*
  // it never runs — which is the failure mode the fix's ordering exists to avoid.
  for (const [route, code] of [
    ["close", 0],
    ["signal", 130],
  ]) {
    it(`removes the lock on the ${route} route`, async (t) => {
      const appData = freshAppData(t);
      const quit = await runChild(t, appData, route);
      assert.equal(quit.code, code, `the ${route} route exited ${quit.code}: ${quit.err}`);

      const dir = choseDir(quit.out);
      assert.equal(dir, profileDir(appData, 0));
      assert.equal(
        fs.existsSync(path.join(dir, LOCK_NAME)),
        false,
        `${LOCK_NAME} outlived a normal foreground quit; the next launch will skip this profile`,
      );
    });
  }

  // What is deliberately *not* asserted here: that the next launch reuses the freed
  // profile. It does — but it also does without the fix, because a leaked lock names
  // a pid that has just died, and `alive()` correctly reclaims it. The leak only
  // costs the user anything once Windows hands that pid to something else, and no
  // test can force a recycle. Such a test would pass on the defect while reading like
  // it covered it, which is worse than the gap it appears to close. The lock's
  // absence above is the part that actually discriminates, and it is the criterion
  // the plan asked for.
});

describe("an exit nobody wrote still gives the lock back", () => {
  it("releases on an uncaught throw, which no app.exit site sees", async (t) => {
    // The nine explicit releases are placed at `app.exit` calls, and the source scan
    // in `tools/browser/foreground.test.mjs` keeps them there. An uncaught throw from
    // a callback reaches none of them: Node prints the stack and ends the process.
    //
    // This used to cost nothing, because upstream's `alive()` reclaimed any lock whose
    // probe failed. Divergence 13 traded that away on purpose, so the residual leak is
    // now the one the recovery cannot reach — a stranded lock whose pid Windows later
    // reissues to a higher-integrity process reads as alive on every launch for as long
    // as that process lives, and the user is logged out for as long as that lasts.
    const appData = freshAppData(t);
    const crashed = await runChild(t, appData, "crash");
    assert.equal(crashed.code, 1, `the crash route exited ${crashed.code}, not on the throw`);
    assert.match(crashed.err, /an exit nobody wrote/, "the child did not die of its own throw");

    const dir = choseDir(crashed.out);
    assert.equal(dir, profileDir(appData, 0));
    assert.equal(
      fs.existsSync(path.join(dir, LOCK_NAME)),
      false,
      `${LOCK_NAME} outlived an uncaught throw. Nothing reclaims it once the pid is ` +
        `reissued to a process that probes EPERM, so this profile is stranded.`,
    );
  });
});

describe("a stale lock naming a dead pid is still reclaimed", () => {
  it("recovers the profile of a browser killed without a destructor", async (t) => {
    // The fix must not make recovery from a real crash worse: `EPERM` meaning alive
    // is only safe if `ESRCH` still means gone. This is the crash, reproduced —
    // `taskkill /F` runs no cleanup, so the lock is left behind naming a pid that
    // no longer exists.
    const appData = freshAppData(t);
    const crashed = await holdProfile(t, appData);
    assert.equal(choseDir(crashed.out), profileDir(appData, 0));

    forceKill(crashed.pid);
    await settlesWithin(() => !stillRunning(crashed.pid), "the crashed holder to die", CHILD_MS);
    assert.equal(
      fs.existsSync(lockOf(appData, 0)),
      true,
      "the forced kill cleaned up after itself; this test is no longer about a stale lock",
    );

    const next = await holdProfile(t, appData, crashed.pid);
    assert.equal(
      probeAnswer(next.out),
      "ESRCH",
      "a dead pid did not probe as ESRCH; the reclaim below proves nothing about the fix",
    );
    assert.equal(
      choseDir(next.out),
      profileDir(appData, 0),
      "a stale lock was treated as live, so a crash now costs the user their profile",
    );
    assert.equal(fs.readFileSync(lockOf(appData, 0), "utf8"), String(next.pid));
  });
});
