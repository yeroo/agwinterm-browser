// What happens to the profile lock when a foreground browser exits.
//
// `claimProfile` (`browser/src/profile.ts`) writes `terminal-browser.lock` into the
// numbered `userData` directory it took, and removes it from Electron's `will-quit`.
// That is correct upstream and unreachable here: Electron specifies that `app.exit`
// terminates immediately *without* emitting `will-quit`, and `app.exit` is how a
// foreground browser ordinarily ends — on a signal (`foreground.ts`'s `stop`) and
// when the session closes itself (`onClose`). So every normal quit left the lock
// behind, the next launch read a pid that was either recycled or unprobeable, skipped
// to the next numbered directory, and handed the user a profile with none of their
// cookies in it. The user-visible symptom is being logged out, which names nothing.
//
// The fix stays in `foreground.ts` rather than the vendored `profile.ts`, so it costs
// no new divergence — see `docs/design/UPSTREAM.md`. What this file pins is the whole
// of that decision: that both exit routes release, that release happens *before*
// `app.exit` rather than in a handler that will never run, and the three ways a
// cleanup on an exit path can be worse than the leak it replaces — taking someone
// else's lock, throwing when nothing is owned, and throwing on a second call.
//
// `foreground.ts` imports `electron` and the session factory, so it is bundled here
// with both stubbed, the way `tools/browser/profile.test.mjs` bundles `profile.ts`.
// `./entry` is import-free and is bundled for real.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const LOCK_NAME = "terminal-browser.lock";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-foreground-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/**
 * `browser/src/foreground.ts`, bundled with `electron` and the session factory
 * stubbed.
 *
 * Both stubs forward to a global at call time rather than closing over a recorder,
 * so one bundle serves every test and each test installs its own.
 */
async function loadForeground() {
  const out = path.join(scratch, "foreground.mjs");
  const stubs = {
    electron: [
      "export const app = {",
      "  getPath: (...a) => globalThis.__fgApp.getPath(...a),",
      "  exit: (...a) => globalThis.__fgApp.exit(...a),",
      "};",
    ].join("\n"),
    session: "export const createSession = (ctx) => globalThis.__fgSession(ctx);",
  };
  await esbuild.build({
    entryPoints: [path.join(REPO, "browser/src/foreground.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    plugins: [
      {
        name: "stub-electron-and-session",
        setup(build) {
          build.onResolve({ filter: /^(electron|\.\/session\/session)$/ }, (arg) => ({
            path: arg.path === "electron" ? "electron" : "session",
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
  return import(pathToFileURL(out).href);
}

const { releaseProfileLock, runForeground } = await loadForeground();

/** A fresh `userData` directory per test, standing in for the one `claimProfile` took. */
let userData;
let lock;
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(scratch, "userdata-"));
  lock = path.join(userData, LOCK_NAME);
});

/** Writes `pid` into the profile's lock, the way `claimProfile` does. */
function heldBy(pid) {
  fs.writeFileSync(lock, String(pid));
}

/**
 * Runs `body` with `app.getPath("userData")` answering `dir`, and reports every
 * `app.exit` it saw — each with whether the lock still existed at that moment,
 * because "released eventually" and "released before the process goes" are not the
 * same claim and only the second one is worth anything on an exit path.
 */
async function withApp(dir, body) {
  const exits = [];
  globalThis.__fgApp = {
    getPath: (name) => {
      assert.equal(name, "userData");
      if (dir === null) throw new Error("no userData path yet");
      return dir;
    },
    exit: (code) => exits.push({ code, lockStillThere: fs.existsSync(lock) }),
  };
  try {
    return { exits, value: await body(exits) };
  } finally {
    delete globalThis.__fgApp;
  }
}

/**
 * Starts `runForeground` and hands back the session context it built, plus the
 * signal handlers it registered.
 *
 * `process.on` is intercepted rather than left alone for two reasons: the four
 * handlers would otherwise accumulate on the real process across tests, and
 * capturing them is the only way to drive the signal exit route without sending a
 * signal to the test runner itself.
 */
async function startForeground() {
  let ctx = null;
  const signals = new Map();
  const realOn = process.on;
  process.on = (event, handler) => {
    if (typeof event === "string" && event.startsWith("SIG")) {
      signals.set(event, handler);
      return process;
    }
    return realOn.call(process, event, handler);
  };
  globalThis.__fgSession = (given) => {
    ctx = given;
    return { ready: Promise.resolve(), close: () => {}, nudgeResize: () => {} };
  };
  try {
    await runForeground(null, []);
  } finally {
    process.on = realOn;
    delete globalThis.__fgSession;
  }
  assert.ok(ctx, "runForeground never built a session");
  return { ctx, signals };
}

/** Polls `predicate` until it holds, or fails after `budget` ms. */
async function until(predicate, budget, what) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out after ${budget}ms waiting for ${what}`);
}

describe("a normal foreground exit leaves no lock behind", () => {
  it("releases when the session closes itself", async () => {
    heldBy(process.pid);
    await withApp(userData, async (exits) => {
      const { ctx } = await startForeground();
      ctx.onClose(0);
      await until(() => exits.length === 1, 1000, "app.exit after onClose");
      assert.equal(exits[0].code, 0);
      assert.equal(
        exits[0].lockStillThere,
        false,
        "the lock outlived the process again; releasing after app.exit is releasing never",
      );
    });
    assert.equal(fs.existsSync(lock), false);
  });

  it("releases on the signal route too, not only the session one", async () => {
    // `foreground.ts` has two `app.exit` sites and they are reached by different
    // paths. Covering one and calling the leak fixed is how it comes back.
    heldBy(process.pid);
    await withApp(userData, async (exits) => {
      const { signals } = await startForeground();
      const sigint = signals.get("SIGINT");
      assert.ok(sigint, "no SIGINT handler was registered");
      sigint();
      await until(() => exits.length === 1, 2000, "app.exit after SIGINT");
      assert.equal(exits[0].code, 130);
      assert.equal(exits[0].lockStillThere, false, "the signal route still leaks the lock");
    });
  });

  it("releases on every signal the foreground shape survives", async () => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
      userData = fs.mkdtempSync(path.join(scratch, "userdata-"));
      lock = path.join(userData, LOCK_NAME);
      heldBy(process.pid);
      await withApp(userData, async (exits) => {
        const { signals } = await startForeground();
        signals.get(signal)();
        await until(() => exits.length === 1, 2000, `app.exit after ${signal}`);
        assert.equal(exits[0].lockStillThere, false, `${signal} left the lock behind`);
      });
    }
  });
});

describe("a lock this process does not own is not ours to remove", () => {
  it("leaves a live sibling's lock exactly where it was", async () => {
    // The same ownership rule `FramePublisher::clear` and `pane-clear` follow.
    // Unlinking here would invite a third browser onto that profile, which is the
    // failure this whole plan exists to prevent — arriving from the other side.
    heldBy(4242);
    await withApp(userData, async () => releaseProfileLock());
    assert.equal(fs.readFileSync(lock, "utf8"), "4242", "someone else's lock was removed");
  });

  it("does not mistake a pid that merely starts with ours for ours", async () => {
    heldBy(`${process.pid}7`);
    await withApp(userData, async () => releaseProfileLock());
    assert.equal(fs.existsSync(lock), true);
  });

  it("leaves a lock whose contents are not a pid at all", async () => {
    fs.writeFileSync(lock, "not a pid");
    await withApp(userData, async () => releaseProfileLock());
    assert.equal(fs.existsSync(lock), true, "a garbled lock was treated as ours");
  });
});

describe("the release path cannot itself break an exit", () => {
  it("is safe called twice, because both exit routes can be in flight at once", async () => {
    // A signal arriving during an `onClose` teardown reaches here twice. A recovery
    // path that throws on its second call is worse than the leak it replaced.
    heldBy(process.pid);
    await withApp(userData, async () => {
      releaseProfileLock();
      releaseProfileLock();
      releaseProfileLock();
    });
    assert.equal(fs.existsSync(lock), false);
  });

  it("is safe when no lock is owned, which is the mkdtemp fallback profile", async () => {
    // `claimProfile` gives up after 32 numbered directories and hands out a temp
    // directory with no lock in it. That process still exits through here.
    await withApp(userData, async () => releaseProfileLock());
    assert.equal(fs.existsSync(lock), false);
  });

  it("is safe when the profile directory is gone", async () => {
    fs.rmSync(userData, { recursive: true, force: true });
    await withApp(userData, async () => releaseProfileLock());
  });

  it("is safe before Electron has a userData path to give", async () => {
    await withApp(null, async () => releaseProfileLock());
  });

  it("still exits when release cannot do its job", async () => {
    // Whatever goes wrong in here, the process still has to go. Reporting the
    // failure by not exiting would strand the pane.
    fs.rmSync(userData, { recursive: true, force: true });
    await withApp(userData, async (exits) => {
      const { ctx } = await startForeground();
      ctx.onClose(3);
      await until(() => exits.length === 1, 1000, "app.exit despite a failed release");
      assert.equal(exits[0].code, 3);
    });
  });
});

describe("the wiring, read from the source", () => {
  const foreground = fs.readFileSync(path.join(REPO, "browser/src/foreground.ts"), "utf8");

  it("releases before every app.exit, including any added later", () => {
    const sites = [...foreground.matchAll(/app\.exit\(/g)];
    assert.equal(sites.length, 2, "the number of exit sites changed; check each one releases");
    for (const site of sites) {
      const before = foreground.slice(0, site.index);
      assert.match(
        before.slice(-200),
        /releaseProfileLock\(\);\s*$/,
        "an app.exit is reached without releasing the profile lock first",
      );
    }
  });

  it("spells the lock the same way the vendored claimProfile does", () => {
    // The name is duplicated rather than imported, because exporting it from
    // `profile.ts` would buy a second divergence from upstream for a string. The
    // cost of duplicating is that it can drift, so it is pinned instead.
    const profile = fs.readFileSync(path.join(REPO, "browser/src/profile.ts"), "utf8");
    assert.ok(
      profile.includes(`"${LOCK_NAME}"`),
      `claimProfile no longer writes ${LOCK_NAME}; foreground.ts is releasing the wrong file`,
    );
    assert.ok(foreground.includes(`"${LOCK_NAME}"`));
  });

  it("does not reach into the vendored profile module to do it", () => {
    assert.ok(
      !/from "\.\/profile"/.test(foreground),
      "foreground.ts imports profile.ts; the fix was supposed to cost no new divergence",
    );
  });
});
