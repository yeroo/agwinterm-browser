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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

import esbuild from "esbuild";

import { requireBuilt } from "../lib/built.mjs";

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
  ALLOW_PIPE_VAR: unsupportedAllowPipeVar,
  sandboxSetupNote,
  splitUnsupported,
  sshUnsupported,
  upgradeUnsupported,
  windowsHostRefusal,
} = await loadModule("cli/src/unsupported.ts");

// The other reader of the same rule. `pane.ts` cannot import `unsupported.ts`
// (both are kept workspace-import-free for different reasons), so the agreement is
// asserted rather than assumed.
const { ALLOW_PIPE_VAR: paneAllowPipeVar, paneClearRequest } =
  await loadModule("cli/src/pane.ts");

// The other place a refusal has to appear: what a user reads *before* running the
// command, rather than the sentence they meet when they do.
const help = await loadModule("cli/src/help.ts");

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

  // Run against the shipped CLI, because what is being checked is the *dispatch*
  // — whether `takeSshFlags` reaches `validateSshTarget` at all — and every
  // in-process spelling of that would be asserting on the source rather than on
  // the behaviour. `open` refuses on the flag before it looks at a terminal, so
  // nothing is dialled and no browser is spawned.
  it("refuses an empty --ssh rather than reading it as absent", () => {
    const cli = requireBuilt(REPO, "cli/dist/main.js", "cli/src", "corepack pnpm -r build");
    requireBuilt(REPO, "store/dist/index.js", "store/src", "corepack pnpm -r build");
    // `--ssh=` is how an unset shell variable spells itself (`--ssh="$SSH_HOST"`),
    // and it survives `rejectUnknownFlags`. Read as absent it skipped
    // `validateSshTarget` — the only site that raises `sshUnsupported` — so on
    // Windows the refusal never printed, and off it `sshSetup` returned early and
    // every request the user asked to be tunnelled went out from this machine.
    // Both spellings: the joined form the shell leaves behind, and the separate
    // one `takeFlag` handles.
    for (const flags of [["--ssh="], ["--ssh", ""]]) {
      const spelling = JSON.stringify(flags);
      const run = spawnSync(process.execPath, [cli, "open", ...flags, "https://example.invalid"], {
        env: { ...process.env, CODEX_SANDBOX: "" },
        encoding: "utf8",
        timeout: 30_000,
      });
      const said = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      assert.equal(run.status, 1, `an empty ${spelling} was accepted:\n${said}`);
      assert.match(
        said,
        process.platform === "win32" ? /--ssh is not supported on Windows/ : /invalid --ssh/,
        `${spelling} was not validated`,
      );
    }
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

  // One table, three readers. `agwinterm.rs`'s `hosted` is the rule the engine
  // draws by, `cli/src/pane.ts` repeats it (it must stay import-free), and this
  // refusal is the CLI's copy. They disagreed: this one required exactly `"1"` and
  // accepted `"active"`, so `AGWINTERM_ENABLED=true` refused a pane the engine
  // would have drawn into, and `AGWINTERM_SESSION_ID=active` launched a browser
  // that then refused every frame -- a browser that starts and shows nothing.
  const HOST_CASES = [
    [{ AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "s1" }, true, "the ordinary case"],
    [{ AGWINTERM_ENABLED: "true", AGWINTERM_SESSION_ID: "s1" }, true, "any truthy spelling"],
    [{ AGWINTERM_ENABLED: " 1 ", AGWINTERM_SESSION_ID: "s1" }, true, "padded by a shell"],
    [{ AGWINTERM_ENABLED: "1", AGWINTERM_PANE_ID: "s1" }, true, "the older variable"],
    [{ AGWINTERM_ENABLED: "0", AGWINTERM_SESSION_ID: "s1" }, false, "explicitly off"],
    [{ AGWINTERM_ENABLED: "", AGWINTERM_SESSION_ID: "s1" }, false, "empty is not set"],
    [{ AGWINTERM_SESSION_ID: "s1" }, false, "a session id with no host flag"],
    [{ AGWINTERM_ENABLED: "1" }, false, "a host flag with no pane to address"],
    [{ AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "  " }, false, "a blank session id"],
    [
      { AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "active" },
      false,
      "`active` names whichever pane is in front, which is not a pane",
    ],
    [{}, false, "no agwinterm at all"],

    // The axis the eleven rows above could not see. `AGWINTERM_PIPE` decides which
    // agwinterm the frame and the clear both go to, and until the corrections plan's
    // Task 2 the three readers disagreed about it completely: the engine allowed
    // `[A-Za-z0-9._-]`, `paneClearRequest` rejected only `[\\/]`, and
    // `inAgwintermPane` did not look. A pane spelling the pipe `agwinterm 2` passed
    // both CLI readers, launched a browser, and the engine then refused every frame.
    [{ AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "s1", AGWINTERM_PIPE: "agwinterm-dev" }, true, "a named instance"],
    [{ AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "s1", AGWINTERM_PIPE: "agwinterm.boris" }, true, "a dot in the name"],
    [{ AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "s1", AGWINTERM_PIPE: " agwinterm-dev " }, true, "padded by a shell"],
    [{ AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "s1", AGWINTERM_PIPE: "" }, true, "empty is unset, which is the fallback"],
    [{ AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "s1", AGWINTERM_PIPE: "agwinterm 2" }, false, "a space is not in the engine's set"],
    [{ AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "s1", AGWINTERM_PIPE: "agwinterm/evil" }, false, "a separator names something else"],
    [{ AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "s1", AGWINTERM_PIPE: "..\\..\\Users\\me\\.ssh\\config" }, false, "`\\\\.\\` is normalised, so `..` leaves the pipe namespace"],
    [{ AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "s1", AGWINTERM_PIPE: "agwintérm" }, false, "non-ASCII is outside the set too"],

    // And the development guard on the same axis.
    [
      { AGWINTERM_ENABLED: "1", AGWINTERM_SESSION_ID: "s1", TERMINAL_BROWSER_ALLOW_PIPE: "agwinterm-dev" },
      false,
      "the fallback to the real instance is what the guard exists to refuse",
    ],
    [
      {
        AGWINTERM_ENABLED: "1",
        AGWINTERM_SESSION_ID: "s1",
        AGWINTERM_PIPE: "agwinterm",
        TERMINAL_BROWSER_ALLOW_PIPE: "agwinterm-dev",
      },
      false,
      "and naming it explicitly does not make it allowed",
    ],
    [
      {
        AGWINTERM_ENABLED: "1",
        AGWINTERM_SESSION_ID: "s1",
        AGWINTERM_PIPE: "agwinterm-dev",
        TERMINAL_BROWSER_ALLOW_PIPE: "agwinterm-dev",
      },
      true,
      "the instance the developer named",
    ],
    [
      {
        AGWINTERM_ENABLED: "1",
        AGWINTERM_SESSION_ID: "s1",
        AGWINTERM_PIPE: "agwinterm-dev",
        TERMINAL_BROWSER_ALLOW_PIPE: "other, agwinterm-dev",
      },
      true,
      "a list, padded",
    ],
    [
      {
        AGWINTERM_ENABLED: "1",
        AGWINTERM_SESSION_ID: "s1",
        AGWINTERM_PIPE: "Agwinterm-Dev",
        TERMINAL_BROWSER_ALLOW_PIPE: "agwinterm-dev",
      },
      true,
      "the object manager resolves the pipe case-insensitively, so the guard does too",
    ],
    [
      {
        AGWINTERM_ENABLED: "1",
        AGWINTERM_SESSION_ID: "s1",
        AGWINTERM_PIPE: "agwinterm-kiosk",
        // `AGWINTERM-KIOSK` with its first `K` as U+212A KELVIN SIGN. `toLowerCase`
        // folds it onto the pipe and the engine's `eq_ignore_ascii_case` cannot, so
        // an entry the CLI admitted here would be refused a frame at a time later.
        TERMINAL_BROWSER_ALLOW_PIPE: "AGWINTERM-\u{212a}IOSK",
      },
      false,
      "the fold is ASCII-only, the way `allows_pipe` is",
    ],
    [
      {
        AGWINTERM_ENABLED: "1",
        AGWINTERM_SESSION_ID: "s1",
        AGWINTERM_PIPE: "agwinterm-dev",
        // Padding is what `str::trim` calls padding, not what `String.trim` does:
        // an editor that prefixes a byte-order mark (U+FEFF) writes an entry
        // ECMAScript trims and Unicode `White_Space` does not, and U+0085 NEL is
        // the pair of that. A reader trimming its own set admits a launch the
        // engine refuses, or refuses one it would have allowed.
        TERMINAL_BROWSER_ALLOW_PIPE: "other,\u{feff}agwinterm-dev,\u{85}other-2",
      },
      true,
      "the trim is `str::trim` plus U+FEFF, in every reader",
    ],
    [
      {
        AGWINTERM_ENABLED: "1",
        AGWINTERM_SESSION_ID: "s1",
        // The same union trim, on the variable that carries the *address* rather
        // than the list. U+0085 NEL is `White_Space` and `String.trim` leaves it on,
        // so a reader using its own trim asks `valid_pipe_name` about a name with a
        // NEL in it and refuses a pane the engine addresses happily.
        AGWINTERM_PIPE: "\u{85}agwinterm-dev\u{feff}",
        TERMINAL_BROWSER_ALLOW_PIPE: "agwinterm-dev",
      },
      true,
      "the pipe variable is trimmed the same way the list entries are",
    ],
    [
      {
        AGWINTERM_ENABLED: "1",
        AGWINTERM_SESSION_ID: "s1",
        TERMINAL_BROWSER_ALLOW_PIPE: "*",
      },
      true,
      "`*` is the escape hatch",
    ],
    [
      {
        AGWINTERM_ENABLED: "1",
        AGWINTERM_SESSION_ID: "s1",
        TERMINAL_BROWSER_ALLOW_PIPE: "  ",
      },
      true,
      "a blank list is an unset variable, not a list that allows nothing",
    ],
  ];

  it("uses the engine's rule for what counts as a pane", () => {
    for (const [env, accepted, why] of HOST_CASES) {
      assert.equal(windowsHostRefusal("win32", env) === null, accepted, why);
    }
  });

  it("agrees with the pane-clear addressing, which repeats rather than imports it", () => {
    for (const [env, accepted, why] of HOST_CASES) {
      assert.equal(paneClearRequest(env) !== null, accepted, `pane.ts: ${why}`);
    }
  });

  it("spells the guard's variable and character set the way the engine does", () => {
    // The third reader is in Rust and cannot be driven from here, so the two things
    // that would silently split the rule are read out of it instead.
    const engine = readSource("engine", "crates", "pixel-core", "src", "agwinterm.rs");
    const declared = /ALLOW_PIPE_VAR: &str = "([A-Z_]+)"/.exec(engine);
    assert.ok(declared, "agwinterm.rs no longer declares the allow-pipe variable");
    // Compared as values, not searched for as text: a source-text match is satisfied
    // by the name turning up in a comment, and what has to agree with the engine is
    // the constant each reader actually consults. Importing them is also the only
    // thing that makes the two exports a surface rather than a claim.
    assert.equal(paneAllowPipeVar, declared[1], "pane.ts reads a different variable");
    assert.equal(
      unsupportedAllowPipeVar,
      declared[1],
      "unsupported.ts reads a different variable",
    );
    // `[A-Za-z0-9._-]` on the Rust side is spelled as a byte test, so the two are
    // compared by behaviour above and by intent here.
    assert.match(engine, /is_ascii_alphanumeric\(\) \|\| matches!\(byte, b'\.' \| b'_' \| b'-'\)/);
    for (const relative of ["cli/src/pane.ts", "cli/src/unsupported.ts"]) {
      assert.ok(
        readSource(...relative.split("/")).includes("/^[A-Za-z0-9._-]+$/"),
        `${relative} does not use the engine's pipe-name set`,
      );
    }
  });

  it("gates the engine's half on the build, so a release browser is unaffected", () => {
    // The CLI cannot tell its own build kind and so honours the variable whenever it
    // is set; the engine can, and must, because a value inherited from a shell
    // profile would otherwise stop a shipped browser drawing anything at all.
    const engine = readSource("engine", "crates", "pixel-core", "src", "agwinterm.rs");
    const at = engine.indexOf("let allow = nonempty(env, ALLOW_PIPE_VAR)");
    assert.ok(at > 0, "from_env no longer reads the allow list");
    const call = engine.slice(at, engine.indexOf(");", engine.indexOf("pipe_refusal(", at)));
    assert.match(call, /cfg!\(debug_assertions\)/, "the guard is armed in release builds");
  });

  it("names the variable when the development guard is what refused", () => {
    // The whole point of the guard is that the browser does not start; a refusal
    // that did not name the way out would be a browser that fails for no visible
    // reason. This is the environment the 18-hour incident ran in: a checkout
    // build, launched from a pane of the real instance, with AGWINTERM_PIPE unset.
    const reason = windowsHostRefusal("win32", {
      AGWINTERM_ENABLED: "1",
      AGWINTERM_SESSION_ID: "s1",
      TERMINAL_BROWSER_ALLOW_PIPE: "agwinterm-dev",
    });
    assert.match(reason, /TERMINAL_BROWSER_ALLOW_PIPE/);
    assert.match(reason, /AGWINTERM_PIPE is unset/, "the fallback is the case that wrecked a pane");
    assert.match(reason, /"agwinterm"/, "the instance it would have drawn into");
    assert.ok(
      !reason.includes("Run this from inside an agwinterm pane"),
      "this shell *is* a pane; telling the user to find one is a lie",
    );
  });

  it("names the variable when the pipe is not a pipe name", () => {
    const reason = windowsHostRefusal("win32", {
      AGWINTERM_ENABLED: "1",
      AGWINTERM_SESSION_ID: "s1",
      AGWINTERM_PIPE: "agwinterm 2",
    });
    assert.match(reason, /AGWINTERM_PIPE="agwinterm 2"/);
    assert.match(reason, /letters, digits/);
  });

  it("leaves the guard out of it when there is no pane to guard", () => {
    // Otherwise a TERMINAL_BROWSER_ALLOW_PIPE left in the environment would turn
    // "you are not in a pane" into a message about an instance that is not involved.
    const reason = windowsHostRefusal("win32", { TERMINAL_BROWSER_ALLOW_PIPE: "agwinterm-dev" });
    assert.match(reason, /Run this from inside an agwinterm pane/);
    assert.ok(!reason.includes("TERMINAL_BROWSER_ALLOW_PIPE"));
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

// The help text is the other place a refusal has to appear. `unsupported.ts` owns
// the wording a user meets when they run a refused command; `help.ts` is what they
// read *before* running it, and it was inherited unchanged — still advertising
// --split, --ssh, upgrade and shutdown as though they worked here. A user who reads
// the help and then hits a refusal has been sent the long way round for an answer
// that could have been on the page.
describe("the help text on Windows", () => {
  const REFUSED_FLAGS = ["--split", "--ssh", "--ssh-bundle", "--ssh-bundle-dir"];

  it("marks the commands that refuse, in the list they are listed in", () => {
    const root = help.rootHelp("win32");
    for (const command of ["upgrade", "shutdown"]) {
      const line = root.split("\n").find((entry) => entry.trim().startsWith(command));
      assert.ok(line, `${command} left the command list`);
      assert.match(line, /not supported on Windows/, `${command} is listed as though it works`);
    }
  });

  it("still gives a refused command a page, because 'why' is the question", () => {
    for (const command of ["upgrade", "shutdown"]) {
      const page = help.commandHelp(command, "win32");
      assert.match(page, /Not supported on Windows/, `${command} has no explanation`);
    }
  });

  it("says of every flag it advertises for `open` that Windows refuses it", () => {
    const page = help.commandHelp("open", "win32");
    const note = page.slice(page.indexOf("On Windows:"));
    assert.ok(note, "`open` has no Windows note");
    for (const flag of REFUSED_FLAGS) {
      assert.ok(note.includes(flag), `the Windows note does not mention ${flag}`);
    }
  });

  it("says `ls` is always every browser, which is what scopeHere does here", () => {
    const page = help.commandHelp("ls", "win32");
    assert.match(page.slice(page.indexOf("On Windows:")), /--all is the only behaviour/);
  });

  it("leaves every other platform's help exactly as upstream wrote it", () => {
    for (const platform of OTHERS) {
      assert.ok(!help.rootHelp(platform).includes("not supported on Windows"));
      for (const topic of help.helpTopics()) {
        assert.ok(
          !help.commandHelp(topic, platform).includes("On Windows:"),
          `${topic} leaks a Windows note on ${platform}`,
        );
        assert.ok(!help.commandHelp(topic, platform).includes("Not supported on Windows"));
      }
    }
  });
});
