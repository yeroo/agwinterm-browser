// Guards the process-model decision recorded in `docs/design/03-process-model.md`
// at the level the JavaScript side of it can be checked without a built engine.
//
// `browser/` cannot be typechecked yet — `pixel-react` has no build until the
// native addon lands in Task 8 — so these tests compile the one import-free module
// with the repo's own esbuild and exercise it directly, then assert the wiring
// around it by reading the entry point.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-entry-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** Transpiles one dependency-free TypeScript module and imports it. */
async function loadModule(relative) {
  const source = fs.readFileSync(path.join(REPO, relative), "utf8");
  const { code } = await esbuild.transform(source, { loader: "ts", format: "esm" });
  const out = path.join(scratch, `${path.basename(relative, ".ts")}.mjs`);
  fs.writeFileSync(out, code);
  return import(pathToFileURL(out).href);
}

const entry = await loadModule("browser/src/entry.ts");
const readSource = (...parts) => fs.readFileSync(path.join(REPO, ...parts), "utf8");

describe("entry mode selection", () => {
  it("runs a daemon only when the CLI asks for one", () => {
    assert.equal(entry.entryMode(["--daemon"]), "daemon");
    assert.equal(entry.entryMode(["--daemon", "https://example.com"]), "daemon");
  });

  it("runs in the foreground by default, which is the Windows shape", () => {
    assert.equal(entry.entryMode([]), "foreground");
    assert.equal(entry.entryMode(["https://example.com"]), "foreground");
    assert.equal(entry.entryMode(["--no-toolbar", "--split-dir", "right"]), "foreground");
  });

  it("matches the flag exactly, so an argument that merely contains it is not one", () => {
    // A pane opening https://daemon.example must not become the daemon.
    assert.equal(entry.entryMode(["https://daemon.example"]), "foreground");
    assert.equal(entry.entryMode(["--daemonize"]), "foreground");
    assert.equal(entry.entryMode(["--parent-tty=/dev/ttys00--daemon"]), "foreground");
  });

  it("keeps every argument except the mode flag for the session", () => {
    assert.deepEqual(entry.sessionArgv(["--daemon", "--no-toolbar", "u"]), ["--no-toolbar", "u"]);
    assert.deepEqual(entry.sessionArgv(["--no-toolbar"]), ["--no-toolbar"]);
    assert.deepEqual(entry.sessionArgv([]), []);
  });
});

describe("browser entry point wiring", () => {
  const main = readSource("browser", "src", "main.tsx");

  it("chooses between the two shapes instead of always starting a daemon", () => {
    assert.match(main, /entryMode\(argv\)\s*===\s*"daemon"/);
    assert.match(main, /runForeground\(/);
    assert.ok(
      !/^\s*await runDaemon\(cdpPort\);\s*$/m.test(main),
      "runDaemon is still called unconditionally; the foreground shape is unreachable",
    );
  });

  it("passes the session the arguments with the mode flag stripped", () => {
    assert.match(main, /runForeground\(cdpPort,\s*sessionArgv\(argv\)\)/);
  });
});

describe("the foreground session", () => {
  const foreground = readSource("browser", "src", "foreground.ts");

  it("creates its session without a tty path", () => {
    // The absence is the decision: `tty` names another process's terminal, which
    // is the thing Windows cannot express. `createRoot` already has a no-tty
    // branch, and the Windows backend goes behind it.
    assert.match(foreground, /createSession\(\{/);
    assert.ok(
      !/\btty\s*:/.test(foreground),
      "the foreground session sets a tty; on Windows there is no path to set it to",
    );
  });

  it("reuses the daemon's session factory rather than a parallel one", () => {
    assert.match(foreground, /import \{ createSession \} from "\.\/session\/session"/);
  });

  it("still stops the process when the session closes", () => {
    assert.match(foreground, /onClose:/);
    assert.match(foreground, /app\.exit\(code\)/);
  });
});

describe("the Electron binary the decision was measured against", () => {
  it("is a GUI-subsystem image, which is why it needs an explicit console attach", () => {
    // `tools/console-inherit-probe` stands in for Electron with a
    // `/SUBSYSTEM:WINDOWS` Rust binary. That substitution is only valid while the
    // real thing has the same subsystem, so pin it: an Electron build that shipped
    // a console-subsystem launcher would silently invalidate the measurement.
    const exe = path.join(REPO, "browser", "node_modules", "electron", "dist", "electron.exe");
    assert.ok(fs.existsSync(exe), `missing ${exe} — run pnpm install`);
    assert.equal(peSubsystem(exe), 2, "electron.exe is no longer IMAGE_SUBSYSTEM_WINDOWS_GUI");
  });
});

/** Reads the PE optional header's Subsystem field. 2 = GUI, 3 = console. */
function peSubsystem(file) {
  const handle = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(0x400);
    fs.readSync(handle, head, 0, head.length, 0);
    const pe = head.readUInt32LE(0x3c);
    assert.equal(head.toString("ascii", pe, pe + 4), "PE\0\0", "not a PE image");
    // COFF header is 20 bytes; Subsystem sits at offset 68 of the optional header
    // in both PE32 and PE32+.
    return head.readUInt16LE(pe + 24 + 68);
  } finally {
    fs.closeSync(handle);
  }
}
