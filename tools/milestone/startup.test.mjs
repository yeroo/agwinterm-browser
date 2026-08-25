// Guards Task 10's startup failure modes, and the bring-up path the milestone was
// driven through.
//
// The milestone itself is not a test — a page being legibly on screen is a
// screenshot, and it is in the plan's Post-Completion. What is testable is the
// three ways starting up goes wrong, and the two of them that live in JavaScript:
//
//   - **Electron fails to launch.** Two halves. The guard has to diagnose the
//     right artifact (Task 9 covers the messages; what is new here is that the
//     guard is checked against the *real* installed tree, so a resolution that
//     drifted would fail here rather than at a milestone). And a spawn that fails
//     anyway has to say so instead of being swallowed by an unref'd child.
//   - **The launcher picks the shape Task 2 chose.** `entryMode` is what routes
//     a pane to `runForeground`, and it is selected by the *absence* of a flag —
//     the failure mode is silent, so it is pinned.
//
// The other two — no agwinterm, and a pane with no room in it — are decided in
// `pixel-core`, where the console and the pipe are, and are tested there
// (`terminal_windows.rs`). What this file checks about them is that the frame
// budget the milestone measured is still wired to the variable the design doc
// names, since a budget file that quietly stopped being written would look
// exactly like a fast path.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-startup-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

async function loadModule(relative) {
  const source = fs.readFileSync(path.join(REPO, relative), "utf8");
  const { code } = await esbuild.transform(source, { loader: "ts", format: "esm" });
  const out = path.join(scratch, `${path.basename(relative, ".ts")}.mjs`);
  fs.writeFileSync(out, code);
  return import(pathToFileURL(out).href);
}

const launch = await loadModule("cli/src/launch.ts");
const entry = await loadModule("browser/src/entry.ts");
const mainSource = fs.readFileSync(path.join(REPO, "cli", "src", "main.ts"), "utf8");
const runner = fs.readFileSync(path.join(HERE, "run-milestone.cmd"), "utf8");
const frameFile = fs.readFileSync(
  path.join(REPO, "engine", "crates", "pixel-core", "src", "frame_file.rs"),
  "utf8",
);
const budgetDoc = fs.readFileSync(
  path.join(REPO, "docs", "design", "02-frame-budget.md"),
  "utf8",
);

const BROWSER_DIR = path.join(REPO, "browser");
const electron = launch.electronBinaryPath({
  platform: "win32",
  browserDir: BROWSER_DIR,
  distRoot: null,
});
const mainScript = path.join(BROWSER_DIR, "dist", "main.js");

describe("Electron fails to launch", () => {
  it("diagnoses each missing artifact as its own kind of problem", () => {
    const only = (present) => (candidate) => candidate === present;
    assert.match(
      launch.missingLaunchArtifact(electron, mainScript, () => false),
      /install the browser's dependencies/,
      "a missing electron.exe is an install problem, not a build one",
    );
    assert.match(
      launch.missingLaunchArtifact(electron, mainScript, only(electron)),
      /build the browser first/,
    );
    assert.equal(launch.missingLaunchArtifact(electron, mainScript, () => true), null);
  });

  it("resolves an electron.exe that is really there", (t) => {
    // The milestone's actual failure mode was never a missing binary — it was a
    // path that named a file Windows does not produce, reported as a build
    // problem. Checking resolution against the installed tree is what makes that
    // impossible to reintroduce silently.
    if (process.platform !== "win32") return t.skip("resolution is per-platform");
    if (!fs.existsSync(electron)) {
      return t.skip("no electron installed here; `pnpm install` in browser/");
    }
    assert.equal(fs.readFileSync(electron).subarray(0, 2).toString("latin1"), "MZ");
  });

  it("reports a spawn failure instead of dropping it", () => {
    // The child is detached and unref'd, so with no listener an ENOENT either
    // throws out of the event loop or is lost — and `daemonSocket` then spends 15
    // seconds blaming the socket for a browser that never started.
    assert.match(mainSource, /child\.on\("error"/);
    assert.match(mainSource, /could not start \$\{plan\.file\}/);
  });
});

describe("the shape a pane starts in", () => {
  it("is foreground unless the CLI asks for a daemon", () => {
    assert.equal(entry.entryMode([]), "foreground");
    assert.equal(entry.entryMode(["https://example.com"]), "foreground");
    assert.equal(entry.entryMode(["--daemon"]), "daemon");
  });

  it("is not selected by a URL that merely contains the word", () => {
    assert.equal(entry.entryMode(["https://example.com/daemon"]), "foreground");
    assert.equal(entry.entryMode(["--partition=daemon"]), "foreground");
  });

  it("the milestone launcher therefore gets a foreground browser", () => {
    assert.ok(!runner.includes("--daemon"), "the bring-up launcher must not start a daemon");
    assert.match(runner, /electron\.exe/, "it has to name the Windows artifact");
    assert.match(runner, /dist\main\.js|dist\\main\.js|MAIN=/, "it has to run the built main");
  });

  it("the launcher passes the frame-budget and cell-metrics variables through", () => {
    // Both are how the milestone was measured; a launcher that dropped them would
    // make the numbers in the design doc unreproducible.
    assert.match(runner, /TERMINAL_BROWSER_FRAME_BUDGET/);
    assert.match(runner, /TERMINAL_BROWSER_CELL_PX/);
  });

  it("aims the debug engine at the dev instance rather than the pane it was started in", () => {
    // This script launches the engine straight into whatever pane runs it, with no
    // CLI in the way and no check of which agwinterm that pane belongs to. Started
    // in a pane of the real instance it publishes there, and an exit that runs no
    // destructor leaves the frame on it. The engine's guard reads this variable; the
    // runner is where the dev workflow's answer to it lives.
    assert.match(runner, /if not defined TERMINAL_BROWSER_ALLOW_PIPE/);
    assert.match(runner, /TERMINAL_BROWSER_ALLOW_PIPE=agwinterm-dev/);
    const engine = fs.readFileSync(
      path.join(REPO, "engine", "crates", "pixel-core", "src", "agwinterm.rs"),
      "utf8",
    );
    assert.match(engine, /ALLOW_PIPE_VAR: &str = "TERMINAL_BROWSER_ALLOW_PIPE"/);
  });
});

describe("the frame budget stays measurable", () => {
  it("is wired to the variable the design doc names", () => {
    const declared = /BUDGET_ENV: &str = "([A-Z_]+)"/.exec(frameFile);
    assert.ok(declared, "frame_file.rs no longer declares a budget variable");
    assert.ok(
      budgetDoc.includes(declared[1]),
      `the doc does not mention ${declared[1]}, so re-measuring it is guesswork`,
    );
    assert.equal(declared[1], "TERMINAL_BROWSER_FRAME_BUDGET");
  });

  it("records the stage the round trip does not include", () => {
    // `publish_ms` stops when `image.frame` is answered; agwinterm decodes the PNG
    // afterwards on another thread. A reader who misses that under-counts the
    // frame by the largest single stage at the largest size measured.
    assert.match(frameFile, /decode is async and is not in here|is not in here/);
    assert.match(budgetDoc, /async on its own thread/);
  });

  it("names the host-side measurements it was taken with", () => {
    for (const script of [
      "measure-host-decode.ps1",
      "measure-frame-verb.ps1",
      "measure-pipe.ps1",
      "run-milestone.cmd",
    ]) {
      assert.ok(fs.existsSync(path.join(HERE, script)), `${script} went missing`);
      assert.ok(budgetDoc.includes(script), `the doc does not say ${script} exists`);
    }
  });
});
