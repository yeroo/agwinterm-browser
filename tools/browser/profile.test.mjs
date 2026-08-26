// Which errors from a liveness probe mean the profile's owner is gone.
//
// `claimProfile` (`browser/src/profile.ts`) walks 32 numbered `userData` directories
// and takes the first whose `terminal-browser.lock` is free or stale. "Stale" is
// decided by `alive(pid)`, and upstream decided it with a bare
// `try { process.kill(pid, 0); return true } catch { return false }` — every failure
// is a death.
//
// On Windows that is wrong in the one case that costs something. `process.kill(pid, 0)`
// sends no signal; it asks whether the process *can* be signalled, and Windows answers
// `EPERM` for a process at a higher integrity level. An elevated browser probed by an
// ordinary one is exactly that, and calling it dead puts two browsers on one Chromium
// `userData` directory — whose symptom is a profile-lock failure or a concurrent-profile
// conflict, not anything naming this function. `alive()` in `store/src/instances.ts`
// states the rule this file pins: `ESRCH` is the only "gone". Its comment said so
// first; its code answered `code === "EPERM"` until this task brought both files to
// the stated rule, so the two now agree. Cited by name, not by line: the same
// reference has gone stale twice already on comment edits.
//
// The third case is the one with no obviously right answer, so it is pinned too. An
// unrecognised code is treated as alive *and warned about*: refusing a free profile
// costs one numbered directory, taking a live one costs the user their session, so the
// defaults are not symmetric — but a guess nobody can see is what the warning removes.
// The two known codes stay silent, or the warning stops meaning anything.
//
// `profile.ts` imports `electron` and `pixel-store`, so it is bundled here with both
// stubbed, the way `url.test.mjs` bundles `url.ts` with `process.platform` fixed. The
// probe itself is the global `process.kill`, which the bundle reaches through the same
// global this file swaps.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

/** What the stubbed `APP_DIR_NAME` is, so the directory names are predictable. */
const APP_DIR = "terminal-browser-test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-profile-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/**
 * `browser/src/profile.ts`, bundled with `electron` and `pixel-store` stubbed.
 *
 * The `app` stub forwards to `globalThis.__profileApp` at call time rather than
 * closing over a recorder, so one bundle serves every test and each test installs its
 * own. `claimProfile` only reaches `getPath` when `TERMINAL_BROWSER_APPDATA` is unset,
 * which it never is below.
 */
async function loadProfile() {
  const out = path.join(scratch, "profile.mjs");
  const electronStub = [
    "export const app = {",
    "  getPath: (...a) => globalThis.__profileApp.getPath(...a),",
    "  setPath: (...a) => globalThis.__profileApp.setPath(...a),",
    "  on: (...a) => globalThis.__profileApp.on(...a),",
    "};",
  ].join("\n");
  await esbuild.build({
    entryPoints: [path.join(REPO, "browser/src/profile.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    plugins: [
      {
        name: "stub-electron-and-store",
        setup(build) {
          build.onResolve({ filter: /^(electron|pixel-store)$/ }, (arg) => ({
            path: arg.path,
            namespace: "stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, (arg) => ({
            loader: "js",
            contents:
              arg.path === "electron"
                ? electronStub
                : `export const APP_DIR_NAME = ${JSON.stringify(APP_DIR)};`,
          }));
        },
      },
    ],
    logLevel: "silent",
  });
  return import(pathToFileURL(out).href);
}

const { claimProfile } = await loadProfile();

/** A fresh `appData` root per test, so the numbered directories start empty. */
let appData;
beforeEach(() => {
  appData = fs.mkdtempSync(path.join(scratch, "appdata-"));
});

function profileDir(index) {
  return path.join(appData, index === 0 ? APP_DIR : `${APP_DIR}-${index + 1}`);
}

function lockPath(index) {
  return path.join(profileDir(index), "terminal-browser.lock");
}

/** Writes `pid` into the nth profile's lock, creating the directory. */
function existingLock(index, pid) {
  fs.mkdirSync(profileDir(index), { recursive: true });
  fs.writeFileSync(lockPath(index), String(pid));
}

/**
 * Runs `claimProfile` with `process.kill` answering `probe`, and reports what it
 * chose, what it registered on `will-quit`, and anything it warned about.
 *
 * `probe` is called with the pid; throwing is how it says the probe failed. Only the
 * signal-0 probe is redirected — a real `process.kill` with a real signal would be a
 * test that kills something, and there is no reading of this suite that wants one.
 */
function claimWith(probe) {
  const warnings = [];
  const events = new Map();
  let chosen = null;

  const realKill = process.kill;
  const realWarn = console.warn;
  const savedAppData = process.env.TERMINAL_BROWSER_APPDATA;
  process.env.TERMINAL_BROWSER_APPDATA = appData;
  process.kill = (pid, signal) => {
    if (signal !== 0) return realKill.call(process, pid, signal);
    return probe(pid);
  };
  console.warn = (...args) => warnings.push(args.join(" "));
  globalThis.__profileApp = {
    getPath: (name) => assert.fail(`claimProfile asked electron for ${name}`),
    setPath: (name, value) => {
      assert.equal(name, "userData");
      chosen = value;
    },
    on: (event, handler) => events.set(event, handler),
  };

  try {
    claimProfile();
  } finally {
    process.kill = realKill;
    console.warn = realWarn;
    delete globalThis.__profileApp;
    if (savedAppData === undefined) delete process.env.TERMINAL_BROWSER_APPDATA;
    else process.env.TERMINAL_BROWSER_APPDATA = savedAppData;
  }
  return { chosen, warnings, events };
}

/** A `process.kill` failure carrying a code, the way libuv reports one. */
function errno(code) {
  const error = new Error(`kill ${code}`);
  error.code = code;
  return error;
}

describe("alive(): which probe failures mean the lock holder is gone", () => {
  it("treats EPERM as alive, so a second browser does not take a live profile", () => {
    existingLock(0, 4242);
    const { chosen, warnings } = claimWith(() => {
      throw errno("EPERM");
    });

    assert.equal(chosen, profileDir(1), "EPERM was read as a dead owner");
    // The live browser's lock is untouched, still naming it rather than us.
    assert.equal(fs.readFileSync(lockPath(0), "utf8"), "4242");
    assert.equal(fs.readFileSync(lockPath(1), "utf8"), String(process.pid));
    assert.deepEqual(warnings, [], "EPERM is a known answer and must not warn");
  });

  it("treats ESRCH as dead, so a crashed browser's profile is still reclaimed", () => {
    existingLock(0, 4242);
    const { chosen, warnings } = claimWith(() => {
      throw errno("ESRCH");
    });

    assert.equal(chosen, profileDir(0), "a stale lock naming a dead pid was not reclaimed");
    assert.equal(fs.readFileSync(lockPath(0), "utf8"), String(process.pid));
    assert.deepEqual(warnings, [], "ESRCH is a known answer and must not warn");
  });

  it("treats a probe that succeeds as alive", () => {
    existingLock(0, 4242);
    const { chosen } = claimWith(() => undefined);
    assert.equal(chosen, profileDir(1));
  });

  it("takes the first profile when no lock is held at all", () => {
    const { chosen } = claimWith(() => assert.fail("nothing to probe"));
    assert.equal(chosen, profileDir(0));
    assert.equal(fs.readFileSync(lockPath(0), "utf8"), String(process.pid));
  });

  it("skips as many live profiles as there are", () => {
    for (const index of [0, 1, 2]) existingLock(index, 4242 + index);
    const { chosen } = claimWith(() => {
      throw errno("EPERM");
    });
    assert.equal(chosen, profileDir(3));
  });

  it("registers the will-quit unlock against the profile it took", () => {
    existingLock(0, 4242);
    const { events } = claimWith(() => {
      throw errno("EPERM");
    });
    const willQuit = events.get("will-quit");
    assert.ok(willQuit, "claimProfile registered no will-quit handler");
    willQuit();
    assert.equal(fs.existsSync(lockPath(1)), false, "will-quit left our own lock behind");
    assert.equal(fs.existsSync(lockPath(0)), true, "will-quit removed someone else's lock");
  });
});

describe("an unrecognised probe failure is loud, not silently either answer", () => {
  it("keeps the profile and says why", () => {
    existingLock(0, 4242);
    const { chosen, warnings } = claimWith(() => {
      throw errno("EINVAL");
    });

    assert.equal(chosen, profileDir(1), "an unknown code fell through to 'dead'");
    assert.equal(fs.readFileSync(lockPath(0), "utf8"), "4242");
    assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
    // The pid and the code, because a warning naming neither is one nobody can act on —
    // and the rule, because the reader's next question is what would have differed.
    assert.match(warnings[0], /4242/);
    assert.match(warnings[0], /EINVAL/);
    assert.match(warnings[0], /ESRCH/);
  });

  it("warns even when the error carries no code at all", () => {
    existingLock(0, 4242);
    const { chosen, warnings } = claimWith(() => {
      throw new Error("something else entirely");
    });

    assert.equal(chosen, profileDir(1));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no code/);
  });

  it("warns once per probe, not once for the whole walk", () => {
    for (const index of [0, 1]) existingLock(index, 4242 + index);
    const { chosen, warnings } = claimWith(() => {
      throw errno("EINVAL");
    });
    assert.equal(chosen, profileDir(2));
    assert.equal(warnings.length, 2);
  });

  it("does not let 'treat it as alive' become permanent for a value no pid can take", () => {
    // The cost of the default above is bounded only if it can be undone. A lock whose
    // contents are outside int32 is answered by `process.kill` with a `TypeError` and
    // no errno, so under "unknown means alive" that directory would be warned about
    // and skipped on *every* launch, forever — worse than upstream's blanket `false`,
    // which self-healed on the next start. The shape is checked before the probe.
    existingLock(0, 99999999999);
    const { chosen, warnings } = claimWith(() => assert.fail("a non-pid was probed"));

    assert.equal(chosen, profileDir(0), "a lock holding no possible pid was never reclaimed");
    assert.equal(fs.readFileSync(lockPath(0), "utf8"), String(process.pid));
    assert.deepEqual(warnings, [], "a value that is not a pid is not an unrecognised probe answer");
  });

  it("reclaims rather than skips a lock naming a negative pid", () => {
    existingLock(0, -1);
    const { chosen } = claimWith(() => assert.fail("a non-pid was probed"));
    assert.equal(chosen, profileDir(0));
  });
});

describe("when every numbered profile is taken", () => {
  it("falls back to a throwaway directory rather than sharing a live one", (t) => {
    // The end of the walk, and the change above made strictly more inputs reach it:
    // EPERM and every unrecognised code now skip where they used to reclaim. The
    // fallback profile has none of the user's cookies in it, which is the branch's own
    // headline symptom — so what it does here is pinned rather than left to be found.
    for (let index = 0; index < 32; index++) existingLock(index, 4242 + index);
    const { chosen, events } = claimWith(() => {
      throw errno("EPERM");
    });
    // The one thing in this suite that lands outside `scratch`: the fallback is
    // `mkdtempSync(os.tmpdir(), ...)` inside `profile.ts`, so it goes to the real
    // `%TEMP%` and nothing in the bundle's stubs can redirect it. Registered before
    // the assertions so a failing one still cleans up — otherwise every run of this
    // file leaves another empty `terminal-browser-XXXXXX` behind for good.
    t.after(() => {
      if (chosen && !chosen.startsWith(scratch)) fs.rmSync(chosen, { recursive: true, force: true });
    });

    assert.ok(chosen, "claimProfile set no userData path at all");
    for (let index = 0; index < 32; index++) {
      assert.notEqual(chosen, profileDir(index), `profile ${index} was taken from its live owner`);
      assert.equal(fs.readFileSync(lockPath(index), "utf8"), String(4242 + index));
    }
    assert.ok(fs.existsSync(chosen), "the fallback directory was not created");
    assert.match(path.basename(chosen), /^terminal-browser-/);
    // No lock in it, which is what `releaseProfileLock` has to be safe against.
    assert.equal(fs.existsSync(path.join(chosen, "terminal-browser.lock")), false);
    assert.equal(events.has("will-quit"), false, "a lockless fallback registered an unlock");
  });
});
