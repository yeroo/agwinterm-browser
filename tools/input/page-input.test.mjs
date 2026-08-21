// Task 11's browser half: what `PageInput` hands Chromium once the engine has
// decoded a pointer or a key.
//
// Two things are being pinned here, and they are not the same thing:
//
//  1. **The coordinate translation.** The engine already delivers surface device
//     pixels — a cell coordinate multiplied by the pane's cell size, at
//     `terminal_windows.rs`'s `mouse_position_px`. `pagePoint` divides by the
//     display's `deviceScaleFactor` to reach the page's own coordinates, and
//     clamps to the page's CSS extent. The clamp is not decoration: the surface
//     is `round(cssExtent * scale)` device pixels, so the last device pixel of a
//     3x display divides back to `cssExtent` — one past the last addressable CSS
//     pixel, which is off the page.
//
//  2. **The synthesized key release.** Only the kitty keyboard protocol reports
//     key releases and agwinterm does not implement it, so every key arrives as a
//     press and nothing arrives to close it. Without this, Chromium holds every
//     key down until the page loses focus and `keyup` never fires.
//
// `input.ts` is bundled rather than transpiled so its `electron` import can be
// replaced, and bundled once per platform so the darwin-only branches can be
// exercised from a Windows machine.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as tick } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, beforeEach, describe, it } from "node:test";

import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-input-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** `electron`'s two module-level imports, recorded rather than performed. */
const stubElectron = {
  name: "stub-electron",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: [
        "export const clipboard = {",
        "  writeText(text) { (globalThis.__clipboard ??= []).push(['text', text]); },",
        "  writeImage(image) { (globalThis.__clipboard ??= []).push(['image', image]); },",
        "};",
        "export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };",
      ].join("\n"),
      loader: "js",
    }));
  },
};

async function loadInput(platform, tag = platform) {
  const out = path.join(scratch, `input-${tag}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(REPO, "browser/src/page/input.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    define: { "process.platform": JSON.stringify(platform) },
    plugins: [stubElectron],
    logLevel: "silent",
  });
  return import(pathToFileURL(out).href);
}

const win32 = await loadInput("win32");

const NO_MODS = { shift: false, alt: false, ctrl: false, super: false };

/** A recording `InputTarget`. `size` is omitted unless a test asks for one. */
function makeTarget({ scale = 1, size = null } = {}) {
  const sent = [];
  const cdp = [];
  const inserted = [];
  const target = {
    contents: () => ({
      sendInputEvent: (event) => sent.push(event),
      insertText: (text) => inserted.push(text),
      paste: () => sent.push({ type: "paste" }),
    }),
    scale: () => scale,
    focus: () => undefined,
    cdp: async (method, params) => {
      cdp.push([method, params]);
      return null;
    },
  };
  if (size) target.size = () => size;
  return { target, sent, cdp, inserted };
}

describe("pagePoint: surface device pixels to page CSS pixels", () => {
  const { pagePoint } = win32;

  it("is the identity on an unscaled display", () => {
    assert.deepEqual(pagePoint(25, 30, 1), { x: 25, y: 30 });
  });

  it("divides by the deviceScaleFactor Chromium was handed", () => {
    // The engine's coordinate is a cell centre in device pixels: cell (3, 2) of a
    // 10x20 cell is (25, 30), which on a 2x display is (13, 15) in the page.
    assert.deepEqual(pagePoint(25, 30, 2), { x: 13, y: 15 });
    assert.deepEqual(pagePoint(0, 0, 2), { x: 0, y: 0 });
  });

  it("clamps the last device pixel back onto the page", () => {
    // A 33 CSS-pixel-wide page on a 3x display is 99 device pixels. Device pixel
    // 98 divides to 32.67, which rounds to 33 — one past the last addressable
    // CSS pixel. Without the clamp that pointer lands outside the page.
    assert.deepEqual(pagePoint(98, 98, 3), { x: 33, y: 33 }, "unclamped");
    assert.deepEqual(pagePoint(98, 98, 3, { width: 33, height: 33 }), { x: 32, y: 32 });
  });

  it("leaves interior positions alone when a size is known", () => {
    assert.deepEqual(pagePoint(30, 30, 3, { width: 33, height: 33 }), { x: 10, y: 10 });
  });

  it("never goes negative, and never divides by a scale that is not one", () => {
    assert.deepEqual(pagePoint(-4, -1, 2), { x: 0, y: 0 });
    assert.deepEqual(pagePoint(25, 30, 0), { x: 25, y: 30 });
    assert.deepEqual(pagePoint(25, 30, Number.NaN), { x: 25, y: 30 });
  });

  it("ignores a size of zero rather than clamping to minus one", () => {
    assert.deepEqual(pagePoint(25, 30, 1, { width: 0, height: 0 }), { x: 25, y: 30 });
  });
});

describe("pointer: a drag, end to end", () => {
  it("presses, moves with the button still down, and releases", () => {
    const { target, sent } = makeTarget({ scale: 1 });
    const input = new win32.PageInput(target);
    const drag = [
      { kind: "down", button: "left", mods: NO_MODS, x: 25, y: 30 },
      { kind: "move", button: "none", mods: NO_MODS, x: 45, y: 30 },
      { kind: "up", button: "left", mods: NO_MODS, x: 45, y: 30 },
    ];
    for (const event of drag) input.pointer(event);

    assert.deepEqual(
      sent.map((event) => [event.type, event.x, event.y, event.button, event.clickCount]),
      [
        ["mouseDown", 25, 30, "left", 1],
        ["mouseMove", 45, 30, undefined, 0],
        ["mouseUp", 45, 30, "left", 1],
      ],
    );
    // The move must carry the held button, or a page sees a hover and never a
    // drag; the release must not, because by then it is no longer held.
    assert.deepEqual(sent[0].modifiers, ["leftbuttondown"]);
    assert.deepEqual(sent[1].modifiers, ["leftbuttondown"]);
    assert.deepEqual(sent[2].modifiers, []);
    assert.equal(sent[1].movementX, 20, "movement is measured from the last send");
    assert.equal(sent[1].movementY, 0);
  });

  it("translates every phase of the drag through the same scale and clamp", () => {
    const { target, sent } = makeTarget({ scale: 2, size: { width: 40, height: 20 } });
    const input = new win32.PageInput(target);
    input.pointer({ kind: "down", button: "left", mods: NO_MODS, x: 25, y: 30 });
    input.pointer({ kind: "move", button: "none", mods: NO_MODS, x: 79, y: 39 });
    input.pointer({ kind: "up", button: "left", mods: NO_MODS, x: 79, y: 39 });

    assert.deepEqual(
      sent.map((event) => [event.x, event.y]),
      [
        [13, 15],
        // 79/2 rounds to 40 and 39/2 to 20, both one past the edge.
        [39, 19],
        [39, 19],
      ],
    );
  });

  it("counts a second click in the same place, and restarts elsewhere", () => {
    const { target, sent } = makeTarget();
    const input = new win32.PageInput(target);
    const at = (x) => ({ kind: "down", button: "left", mods: NO_MODS, x, y: 30 });
    input.pointer(at(25));
    input.pointer(at(25));
    input.pointer(at(300));
    assert.deepEqual(
      sent.map((event) => event.clickCount),
      [1, 2, 1],
    );
  });

  it("maps the four modifiers onto Chromium's names", () => {
    const { target, sent } = makeTarget();
    const input = new win32.PageInput(target);
    input.pointer({
      kind: "move",
      button: "none",
      mods: { shift: true, alt: true, ctrl: true, super: true },
      x: 1,
      y: 1,
    });
    assert.deepEqual(sent[0].modifiers, ["shift", "alt", "ctrl", "meta"]);
  });
});

describe("key: releases on a host that never reports one", () => {
  beforeEach(() => win32.setKeyReleaseReporting(false));
  after(() => win32.setKeyReleaseReporting(false));

  it("defaults to synthesizing, which is the safe value when nothing sets it", async () => {
    const fresh = await loadInput("win32", "fresh");
    assert.equal(fresh.reportsKeyReleases(), false);
  });

  it("closes a press the host will never close", () => {
    const { target, sent } = makeTarget();
    const input = new win32.PageInput(target);
    input.key({ kind: "press", key: "a", text: "a", mods: NO_MODS });
    assert.deepEqual(
      sent.map((event) => [event.type, event.keyCode]),
      [
        ["rawKeyDown", "a"],
        ["char", "a"],
        ["keyUp", "a"],
      ],
    );
  });

  it("carries the press's modifiers into the release, but not its autorepeat", () => {
    const { target, sent } = makeTarget();
    const input = new win32.PageInput(target);
    const mods = { shift: true, alt: false, ctrl: true, super: false };
    input.key({ kind: "repeat", key: "a", text: "a", mods });
    assert.deepEqual(
      sent.map((event) => [event.type, event.modifiers]),
      [
        // No `char`: a ctrl combination is not printable text.
        ["rawKeyDown", ["shift", "ctrl", "isautorepeat"]],
        ["keyUp", ["shift", "ctrl"]],
      ],
    );
  });

  it("still names which side of a paired modifier was pressed", () => {
    const { target, sent } = makeTarget();
    const input = new win32.PageInput(target);
    input.key({ kind: "press", key: "rightshift", text: "", mods: NO_MODS });
    assert.deepEqual(
      sent.map((event) => [event.type, event.keyCode, event.modifiers]),
      [
        ["rawKeyDown", "shift", ["right"]],
        ["keyUp", "shift", ["right"]],
      ],
    );
  });

  it("leaves nothing for a later blur to release", () => {
    const { target, sent } = makeTarget();
    const input = new win32.PageInput(target);
    input.key({ kind: "press", key: "a", text: "a", mods: NO_MODS });
    sent.length = 0;
    input.releaseKeys();
    assert.deepEqual(sent, [], "the key was already closed");
  });

  it("closes enter too, which takes the CDP path on every platform", async () => {
    const { target, cdp } = makeTarget();
    const input = new win32.PageInput(target);
    input.key({ kind: "press", key: "enter", text: "", mods: NO_MODS });
    await tick(0);
    await tick(0);
    assert.deepEqual(
      cdp.map(([method, params]) => [method, params.type]),
      [
        ["Input.dispatchKeyEvent", "rawKeyDown"],
        ["Input.dispatchKeyEvent", "char"],
        ["Input.dispatchKeyEvent", "keyUp"],
      ],
    );
  });
});

describe("key: releases on a host that reports them", () => {
  beforeEach(() => win32.setKeyReleaseReporting(true));
  after(() => win32.setKeyReleaseReporting(false));

  it("waits for the host's release rather than inventing one", () => {
    const { target, sent } = makeTarget();
    const input = new win32.PageInput(target);
    input.key({ kind: "press", key: "a", text: "a", mods: NO_MODS });
    assert.deepEqual(
      sent.map((event) => event.type),
      ["rawKeyDown", "char"],
    );
    input.key({ kind: "release", key: "a", text: "", mods: NO_MODS });
    assert.deepEqual(
      sent.map((event) => event.type),
      ["rawKeyDown", "char", "keyUp"],
    );
  });

  it("sends one keyUp even if a release follows a synthesized one", () => {
    const { target, sent } = makeTarget();
    const input = new win32.PageInput(target);
    win32.setKeyReleaseReporting(false);
    input.key({ kind: "press", key: "a", text: "a", mods: NO_MODS });
    win32.setKeyReleaseReporting(true);
    input.key({ kind: "release", key: "a", text: "", mods: NO_MODS });
    assert.equal(
      sent.filter((event) => event.type === "keyUp").length,
      1,
      "a real release after a synthesized one must not double up",
    );
  });
});

describe("key: text with no key code", () => {
  it("inserts characters the engine could not name", () => {
    const { target, sent, inserted } = makeTarget();
    const input = new win32.PageInput(target);
    input.key({ kind: "press", key: "unknown", text: "é", mods: NO_MODS });
    assert.deepEqual(inserted, ["é"]);
    assert.deepEqual(sent, [], "no key code means no key event to send");
  });
});

describe("the wheel detent is the platform's, not the fork's", () => {
  it("is 120 off macOS and 40 on it", async () => {
    const darwin = await loadInput("darwin");
    const perPlatform = async (module) => {
      const { target, sent } = makeTarget();
      const input = new module.PageInput(target);
      input.wheel({ deltaX: 0, deltaY: 1, precise: false, mods: NO_MODS });
      return sent[0].deltaY;
    };
    assert.equal(await perPlatform(win32), -120);
    assert.equal(await perPlatform(darwin), -40);
  });
});
