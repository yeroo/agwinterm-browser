// Task 13's refusals: every command Windows cannot honour has to say so, name the
// obstacle, and be reachable on the path the user actually takes.
//
// Two layers, because a refusal has two failure modes. `cli/src/unsupported.ts` is
// import-free and is transpiled and driven directly — that covers the wording and
// the per-platform behaviour. But a correct message in a function nobody calls is
// the exact bug this task exists to prevent, so the second layer asserts the call
// sites by reading them: which module imports which refusal, and where in the flow
// it is checked. The ordering claims ("before the direction is validated", "before
// the version lookup") are the ones that would otherwise regress silently.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-unsupported-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

async function loadModule(relative) {
  const source = fs.readFileSync(path.join(REPO, relative), "utf8");
  const { code } = await esbuild.transform(source, { loader: "ts", format: "esm" });
  const out = path.join(scratch, `${path.basename(relative, ".ts")}.mjs`);
  fs.writeFileSync(out, code);
  return import(pathToFileURL(out).href);
}

const readSource = (...parts) => fs.readFileSync(path.join(REPO, ...parts), "utf8");

const {
  sandboxSetupNote,
  splitUnsupported,
  sshUnsupported,
  upgradeUnsupported,
  windowsHostRefusal,
} = await loadModule("cli/src/unsupported.ts");

const OTHERS = ["linux", "darwin", "freebsd"];

describe("--ssh", () => {
  it("is refused on Windows, naming ControlMaster as the obstacle", () => {
    const reason = sshUnsupported("win32");
    assert.match(reason, /--ssh is not supported on Windows/);
    assert.match(reason, /ControlMaster/);
    // The advice has to be actionable, not just an apology.
    assert.match(reason, /remote host/);
  });

  it("is untouched everywhere else", () => {
    for (const platform of OTHERS) assert.equal(sshUnsupported(platform), null);
  });

  it("is checked while validating the target, before anything is spawned", () => {
    const source = readSource("cli", "src", "ssh.ts");
    assert.match(source, /import \{ sshUnsupported \} from "\.\/unsupported"/);
    const at = source.indexOf("export function validateSshTarget");
    const check = source.indexOf("sshUnsupported(process.platform)", at);
    const parse = source.indexOf("parseSshWords", at);
    assert.ok(check > at, "validateSshTarget does not consult sshUnsupported");
    assert.ok(check < parse, "the target is parsed before the platform is checked");
  });
});

describe("upgrade", () => {
  it("is refused on Windows, naming the shell installer as the obstacle", () => {
    const reason = upgradeUnsupported("win32");
    assert.match(reason, /upgrade is not supported on Windows/);
    assert.match(reason, /curl \| bash/);
    assert.match(reason, /re-running the build/);
  });

  it("is untouched everywhere else", () => {
    for (const platform of OTHERS) assert.equal(upgradeUnsupported(platform), null);
  });

  it("is checked before the version lookup, so the message is the real obstacle", () => {
    const source = readSource("cli", "src", "upgrade.ts");
    const at = source.indexOf("export async function upgradeCommand");
    const check = source.indexOf("upgradeUnsupported(process.platform)", at);
    const version = source.indexOf("installedVersion()", at);
    assert.ok(check > at, "upgradeCommand does not consult upgradeUnsupported");
    assert.ok(
      check < version,
      "the dist root is read first, so a Windows user gets 'could not perform upgrade'",
    );
  });
});

describe("--split", () => {
  it("is refused on Windows, naming the missing host verb", () => {
    const reason = splitUnsupported("win32");
    assert.match(reason, /--split is not supported on Windows/);
    assert.match(reason, /session\.split takes an operation but not a command/);
  });

  it("is untouched everywhere else", () => {
    for (const platform of OTHERS) assert.equal(splitUnsupported(platform), null);
  });

  it("is refused before the direction is validated", () => {
    // Otherwise `--split sideways` on Windows reports a typo rather than the
    // fact that no direction would have worked.
    const source = readSource("cli", "src", "main.ts");
    const at = source.indexOf("function takeSplitFlag");
    const check = source.indexOf("splitUnsupported(process.platform)", at);
    const validate = source.indexOf("isDirection(raw)", at);
    assert.ok(check > at, "takeSplitFlag does not consult splitUnsupported");
    assert.ok(check < validate, "the direction is validated before the platform is checked");
  });
});

describe("the sandbox step of `setup`", () => {
  it("says nothing on Linux, where there is something to do", () => {
    assert.equal(sandboxSetupNote("linux"), null);
  });

  it("explains on Windows that Chromium sandboxes itself", () => {
    const note = sandboxSetupNote("win32");
    assert.match(note, /nothing to set up on Windows/);
    assert.match(note, /Chromium sandboxes its own processes/);
    // The reason AppArmor exists at all, so the absence reads as a decision.
    assert.match(note, /unprivileged user namespaces/);
  });

  it("names whichever other platform it is on rather than guessing", () => {
    assert.match(sandboxSetupNote("darwin"), /nothing to set up on darwin/);
  });

  it("is what apparmorSetup prints instead of returning 0 in silence", () => {
    const source = readSource("cli", "src", "sandbox.ts");
    assert.match(source, /import \{ sandboxSetupNote \} from "\.\/unsupported"/);
    const at = source.indexOf("export function apparmorSetup");
    assert.ok(source.indexOf("sandboxSetupNote(process.platform)", at) > at);
    assert.ok(
      !/if \(process\.platform !== "linux"\) return 0;/.test(source),
      "the silent early return is still there",
    );
  });
});

describe("the host refusal", () => {
  const pane = { AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "s1" };

  it("accepts an agwinterm pane", () => {
    assert.equal(windowsHostRefusal("win32", pane), null);
    // the older variable, which some hosts set instead
    assert.equal(
      windowsHostRefusal("win32", { AGWINTERM_ENABLED: "1", AGWINTERM_PANE_ID: "s1" }),
      null,
    );
  });

  it("refuses anywhere else on Windows, and says why the usual probe is not used", () => {
    for (const env of [{}, { AGWINTERM_ENABLED: "1" }, { AGWINTERM_SESSION_ID: "s1" }]) {
      const reason = windowsHostRefusal("win32", env);
      assert.match(reason, /agwinterm pane/);
      assert.match(reason, /ConPTY strips the graphics escapes/);
    }
  });

  it("does not apply off Windows, where the graphics probe answers the question", () => {
    for (const platform of OTHERS) assert.equal(windowsHostRefusal(platform, {}), null);
  });

  it("is what `open` checks, in place of the Kitty probe", () => {
    const source = readSource("cli", "src", "main.ts");
    assert.match(source, /windowsHostRefusal\(process\.platform, process\.env\)/);
    const at = source.indexOf("async function requireGraphics");
    const check = source.indexOf("windowsHostRefusal(", at);
    const probe = source.indexOf('check.graphics !== "unsupported"', at);
    assert.ok(check > at && check < probe, "the Kitty verdict is consulted first");
  });
});

describe("shutdown", () => {
  it("returns before daemonPid can name a browser as the daemon", () => {
    // The bug this guards is not a wrong message: `daemonPid()` returns the first
    // live instance pid, and in the foreground shape that is a browser someone is
    // using, which `kill` would then stop.
    const source = readSource("cli", "src", "main.ts");
    const at = source.indexOf("async function shutdownDaemon");
    const guard = source.indexOf("if (WINDOWS)", at);
    const pid = source.indexOf("await daemonPid()", at);
    assert.ok(guard > at, "shutdownDaemon has no Windows branch");
    assert.ok(guard < pid, "daemonPid runs before the Windows branch");
    assert.match(source.slice(guard, pid), /no daemon on Windows/);
  });
});
