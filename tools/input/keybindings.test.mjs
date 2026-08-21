// Task 11's other half: which physical modifier means "Cmd" on this host.
//
// Upstream has two answers and neither is right for Windows. `defaultKeys`
// branches darwin/not-darwin and gives the not-darwin side Ctrl, which is
// correct; but `cmdHeld` branches on whether the *host* can deliver Super, and
// substitutes **Alt** when it cannot. agwinterm cannot — it implements no kitty
// keyboard protocol, so `mods.super` is never set — and Alt is a modifier
// Windows pages use in their own right. Left alone, the accelerators would have
// been alt+t, alt+l, alt+r on a platform where every one of them is Ctrl.
//
// `keybindings.ts` imports nothing but types, so it bundles on its own; the
// platform is fixed at bundle time so all three branches are reachable from one
// machine.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-keys-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

async function loadKeybindings(platform) {
  const out = path.join(scratch, `keybindings-${platform}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(REPO, "browser/src/session/keybindings.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    define: { "process.platform": JSON.stringify(platform) },
    logLevel: "silent",
  });
  return import(pathToFileURL(out).href);
}

const [win32, darwin, linux] = await Promise.all(
  ["win32", "darwin", "linux"].map(loadKeybindings),
);

/** An `EngineKeyEvent` with only the named modifiers held. */
function press(key, ...held) {
  return {
    key,
    kind: "press",
    text: "",
    mods: {
      shift: held.includes("shift"),
      alt: held.includes("alt"),
      ctrl: held.includes("ctrl"),
      super: held.includes("super"),
    },
  };
}

// agwinterm reports no kitty keyboard, so this is the value Windows always runs
// with. It is passed explicitly so the tests do not depend on where it is set.
const NO_SUPER = true;

describe("Windows: Ctrl is the accelerator", () => {
  it("names Ctrl as the stand-in for Cmd", () => {
    assert.equal(win32.cmdModifier, "ctrl");
  });

  it("accepts Ctrl and does not accept Alt or Super", () => {
    assert.equal(win32.cmdHeld(press("t", "ctrl"), NO_SUPER), true);
    // Alt is upstream's substitute for a host with no Super. Here it must stay a
    // page modifier: alt+t is not "new tab" on Windows.
    assert.equal(win32.cmdHeld(press("t", "alt"), NO_SUPER), false);
    // Super never arrives at all, but if a host ever delivered it, it is the
    // Windows key and not an accelerator.
    assert.equal(win32.cmdHeld(press("t", "super"), NO_SUPER), false);
  });

  it("treats Ctrl as the navigation accelerator too", () => {
    assert.equal(win32.accelHeld(press("l", "ctrl"), NO_SUPER), true);
    assert.equal(win32.accelHeld(press("l", "alt"), NO_SUPER), false);
  });

  it("copies on Ctrl, and leaves the terminal's Ctrl+Shift alone", () => {
    assert.equal(win32.clipboardHeld(press("c", "ctrl"), NO_SUPER), true);
    assert.equal(win32.clipboardHeld(press("c", "ctrl", "shift"), NO_SUPER), false);
    assert.equal(win32.clipboardHeld(press("c", "ctrl", "alt"), NO_SUPER), false);
    assert.equal(win32.clipboardHeld(press("c", "alt"), NO_SUPER), false);
  });

  it("binds a Mac's `cmd+` chord to something a Windows user can press", () => {
    const bindings = win32.parseKeyBindings("cmd+p");
    assert.deepEqual(bindings, [
      { super: false, ctrl: true, alt: false, shift: false, key: "p" },
    ]);
    assert.equal(win32.matchesBinding(press("p", "ctrl"), bindings), true);
    assert.equal(win32.matchesBinding(press("p", "super"), bindings), false);
    assert.equal(win32.bindingLabel(bindings), "ctrl+p");
  });

  it("maps a literal `super+` chord the same way, for the same reason", () => {
    assert.deepEqual(win32.parseKeyBindings("super+shift+f"), [
      { super: false, ctrl: true, alt: false, shift: true, key: "f" },
    ]);
  });

  it("ships Ctrl defaults, and a Ctrl+Shift record key", () => {
    assert.deepEqual(win32.defaultKeys, {
      palette: "ctrl+k alt+k",
      find: "ctrl+shift+f",
      devtools: "ctrl+shift+i",
      console: "ctrl+alt+j",
    });
    assert.equal(win32.recordKeyLabel, "ctrl+shift+r");
    assert.equal(win32.isRecordKey(press("r", "ctrl", "shift")), true);
    assert.equal(win32.isRecordKey(press("r", "ctrl")), false);
  });
});

describe("macOS is untouched", () => {
  it("keeps Cmd as Cmd", () => {
    assert.equal(darwin.cmdModifier, "super");
    assert.equal(darwin.cmdHeld(press("t", "super"), false), true);
    assert.equal(darwin.cmdHeld(press("t", "ctrl"), false), false);
    assert.equal(darwin.clipboardHeld(press("c", "super"), false), true);
    assert.equal(darwin.clipboardHeld(press("c", "ctrl"), false), false);
    assert.deepEqual(darwin.parseKeyBindings("cmd+p"), [
      { super: true, ctrl: false, alt: false, shift: false, key: "p" },
    ]);
    assert.equal(darwin.bindingLabel(darwin.parseKeyBindings("cmd+p")), "cmd+p");
  });
});

describe("Linux is untouched", () => {
  it("still lets Alt stand in for Super, and still accepts a bare Ctrl", () => {
    assert.equal(linux.cmdModifier, "super");
    assert.equal(linux.cmdHeld(press("t", "alt"), NO_SUPER), true);
    assert.equal(linux.cmdHeld(press("t", "alt"), false), false);
    assert.equal(linux.cmdHeld(press("t", "super"), false), true);
    // `accelHeld` is where Linux's bare Ctrl lives; `cmdHeld` alone rejects it.
    assert.equal(linux.cmdHeld(press("l", "ctrl"), false), false);
    assert.equal(linux.accelHeld(press("l", "ctrl"), false), true);
    assert.equal(linux.clipboardHeld(press("c", "ctrl"), false), true);
    assert.equal(linux.clipboardHeld(press("c", "ctrl", "shift"), false), false);
  });
});
