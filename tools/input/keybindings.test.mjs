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

  it("reaches zoom through Alt, which is the only modifier the console can carry", () => {
    // Apart from a..z there is no Ctrl encoding at all: under
    // `ENABLE_VIRTUAL_TERMINAL_INPUT`, Ctrl+`=` arrives as a plain `=`. So the zoom
    // chords could not be pressed, however they were spelled — the one accelerator
    // in the set that is not a letter. Alt+`=` arrives as an Esc-prefixed byte and
    // decodes intact, so zoom (and only zoom) also answers to Alt.
    for (const key of ["=", "+", "-", "_", "0"]) {
      assert.equal(win32.zoomHeld(press(key, "alt"), NO_SUPER), true, key);
      assert.equal(win32.zoomHeld(press(key, "ctrl"), NO_SUPER), true, key);
    }
    // Widening zoom must not widen the accelerator: alt+t is still not "new tab".
    assert.equal(win32.cmdHeld(press("t", "alt"), NO_SUPER), false);
    assert.equal(win32.accelHeld(press("t", "alt"), NO_SUPER), false);
    assert.equal(win32.zoomHeld(press("=", "shift"), NO_SUPER), false);
  });

  it("reaches back and forward through Alt and an arrow", () => {
    // Ctrl+`[` is `0x1b`, which is Escape; Ctrl+`]` is `0x1d`, which decodes as no
    // key; and Alt+`[` / Alt+`]` are the CSI and OSC introducers. `CSI 1;3D` is the
    // one spelling that survives, and it is what a Windows browser binds anyway.
    assert.equal(win32.navigationArrow(press("left", "alt")), "back");
    assert.equal(win32.navigationArrow(press("right", "alt")), "forward");
    assert.equal(win32.navigationArrow(press("left")), null);
    assert.equal(win32.navigationArrow(press("left", "alt", "ctrl")), null);
    assert.equal(win32.navigationArrow(press("left", "alt", "shift")), null);
    assert.equal(win32.navigationArrow(press("up", "alt")), null);
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

describe("the two console-shaped bindings do not leak off Windows", () => {
  it("leaves zoom and the arrows exactly as they were on macOS and Linux", () => {
    for (const platform of [darwin, linux]) {
      assert.equal(platform.navigationArrow(press("left", "alt")), null);
      assert.equal(platform.navigationArrow(press("right", "alt")), null);
      // `zoomHeld` is `cmdHeld` off Windows, which is what the zoom sites used to
      // call directly.
      for (const held of [["super"], ["alt"], ["ctrl"], []]) {
        for (const noSuper of [true, false]) {
          assert.equal(
            platform.zoomHeld(press("=", ...held), noSuper),
            platform.cmdHeld(press("=", ...held), noSuper),
            `${held.join("+") || "none"} noSuper=${noSuper}`,
          );
        }
      }
    }
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
