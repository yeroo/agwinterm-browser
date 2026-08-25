// Guards the two halves of Task 9 that live in `browser/`: what offscreen mode
// Electron is asked for on Windows, and what happens to each painted frame once
// it arrives.
//
// Finding, recorded in the plan: `offscreen.ts` needed no Windows branch. The
// existing non-darwin branch already returns `useSharedTexture: false` and, since
// `SHM_FRAMES` is gated on `platform === "linux"`, `useSharedMemory: false` —
// which is the shape the plan asked for, plus a fork-only key explicitly turned
// off. `initOffscreenMode` already reports `bitmap` without throwing off darwin.
// These tests pin that down so the "no branch needed" claim stays checkable.
//
// The modules are bundled rather than transpiled one at a time: `paint.ts` pulls
// in `./types`, and `offscreen.ts` imports `appLog` from `pixel-react`, whose
// build is a native-addon dependency this test has no reason to need.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, beforeEach, describe, it } from "node:test";

import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-offscreen-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** Replaces the workspace imports with a recording stub. */
const stubWorkspace = {
  name: "stub-workspace",
  setup(build) {
    build.onResolve({ filter: /^(pixel-react|electron)$/ }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents:
        "export function appLog(...entry) { (globalThis.__appLog ??= []).push(entry); }\n",
      loader: "js",
    }));
  },
};

async function bundle(relative) {
  const out = path.join(scratch, `${path.basename(relative, ".ts")}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(REPO, relative)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    plugins: [stubWorkspace],
    logLevel: "silent",
  });
  return out;
}

const offscreenBundle = await bundle("browser/src/page/offscreen.ts");
const paint = await import(pathToFileURL(await bundle("browser/src/page/paint.ts")).href);

const realPlatform = process.platform;
const setPlatform = (value) =>
  Object.defineProperty(process, "platform", { value, configurable: true });
after(() => setPlatform(realPlatform));

/**
 * Imports `offscreen.ts` as if it had started on `platform`.
 *
 * The module reads `process.platform` at import time (`SHM_FRAMES`), so each
 * platform needs its own module instance — hence the cache-busting query.
 */
let generation = 0;
async function offscreenAs(platform, env = {}) {
  setPlatform(platform);
  const before = { ...process.env };
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return await import(`${pathToFileURL(offscreenBundle).href}?p=${platform}&n=${generation++}`);
  } finally {
    for (const key of Object.keys(env)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

describe("offscreenPreferences per platform", () => {
  it("asks Windows for a plain bitmap surface — no shared texture, no shared memory", async () => {
    const { offscreenPreferences } = await offscreenAs("win32");
    assert.deepEqual(offscreenPreferences(1.5), {
      useSharedTexture: false,
      useSharedMemory: false,
      deviceScaleFactor: 1.5,
    });
  });

  it("never asks Windows for shared memory, whatever TERMINAL_BROWSER_SHM says", async () => {
    // The shm frame path needs the patched Electron this port refuses to build.
    for (const value of ["1", "0", ""]) {
      const { offscreenPreferences } = await offscreenAs("win32", {
        TERMINAL_BROWSER_SHM: value,
      });
      assert.equal(offscreenPreferences(1).useSharedMemory, false);
    }
  });

  it("carries the device scale factor through unchanged", async () => {
    const { offscreenPreferences } = await offscreenAs("win32");
    for (const scale of [1, 1.25, 2, 3]) {
      assert.equal(offscreenPreferences(scale).deviceScaleFactor, scale);
    }
  });

  it("leaves darwin on shared textures and linux on shared memory", async () => {
    const mac = await offscreenAs("darwin");
    assert.deepEqual(mac.offscreenPreferences(2), {
      useSharedTexture: true,
      sharedTexturePixelFormat: "argb",
      deviceScaleFactor: 2,
    });
    const linux = await offscreenAs("linux");
    assert.equal(linux.offscreenPreferences(1).useSharedMemory, true);
    const linuxOff = await offscreenAs("linux", { TERMINAL_BROWSER_SHM: "0" });
    assert.equal(linuxOff.offscreenPreferences(1).useSharedMemory, false);
  });
});

describe("initOffscreenMode", () => {
  beforeEach(() => {
    globalThis.__appLog = [];
  });

  it("reports bitmap on Windows and does not throw", async () => {
    const { initOffscreenMode } = await offscreenAs("win32");
    initOffscreenMode(false);
    assert.deepEqual(globalThis.__appLog.at(-1), ["info", "texture", "offscreen mode: bitmap"]);
  });

  it("does not throw on Windows even when Electron claims shared textures", async () => {
    const { initOffscreenMode } = await offscreenAs("win32");
    initOffscreenMode(true);
    assert.deepEqual(globalThis.__appLog.at(-1), ["info", "texture", "offscreen mode: bitmap"]);
  });

  it("still rejects a stock Electron on darwin, where the fork is required", async () => {
    const { initOffscreenMode } = await offscreenAs("darwin");
    assert.throws(() => initOffscreenMode(false), /wrong electron build/);
  });
});

/** A `NativeImage` stand-in: the two methods the paint path calls. */
function fakeImage(width, height, fill = 0) {
  return {
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.alloc(Math.max(0, width * height * 4), fill),
  };
}

function fakeSurface() {
  const frames = [];
  return { frames, present: (frame) => frames.push(frame) };
}

const rect = (x, y, width, height) => ({ x, y, width, height });

describe("presentPaint on the Windows path", () => {
  it("falls through to the bitmap presenter when there is no texture and no shm frame", () => {
    const surface = fakeSurface();
    const ok = paint.presentPaint(
      surface,
      undefined,
      undefined,
      fakeImage(4, 3),
      rect(0, 0, 4, 3),
      true,
    );
    assert.equal(ok, true);
    assert.equal(surface.frames.length, 1);
    const [frame] = surface.frames;
    assert.equal(frame.width, 4);
    assert.equal(frame.height, 3);
    assert.equal(frame.bgra.length, 4 * 3 * 4);
    assert.equal(frame.damage, undefined, "a whole-surface frame carries no damage rect");
    assert.ok(!("ioSurface" in frame), "no shared texture on this path");
    assert.ok(!("shm" in frame), "no shared memory on this path");
  });

  it("passes a partial damage rect through when the surface is not whole", () => {
    const surface = fakeSurface();
    paint.presentPaint(surface, undefined, undefined, fakeImage(8, 8), rect(1, 2, 3, 4), false);
    assert.deepEqual(surface.frames[0].damage, rect(1, 2, 3, 4));
  });

  it("drops an empty damage rect rather than presenting a zero-area update", () => {
    const surface = fakeSurface();
    paint.presentPaint(surface, undefined, undefined, fakeImage(8, 8), rect(1, 2, 0, 0), false);
    assert.equal(surface.frames[0].damage, undefined);
  });

  it("rejects a zero-area image without presenting anything", () => {
    for (const size of [
      [0, 0],
      [0, 5],
      [5, 0],
    ]) {
      const surface = fakeSurface();
      const ok = paint.presentPaint(
        surface,
        undefined,
        undefined,
        fakeImage(size[0], size[1]),
        rect(0, 0, 1, 1),
        true,
      );
      assert.equal(ok, false, `${size.join("x")} should not present`);
      assert.deepEqual(surface.frames, []);
    }
  });

  it("shows a shm frame is never invented on this path", () => {
    // `shmFrameOf` reads a property the stock Electron event does not carry.
    assert.equal(paint.shmFrameOf({}), undefined);
    assert.equal(paint.shmFrameOf({ softwareFrame: null }), undefined);
  });
});

describe("BitmapPresenter throttling", () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("collapses a burst of paints into one present", async () => {
    const surface = fakeSurface();
    const presenter = new paint.BitmapPresenter(surface);
    for (let i = 0; i < 5; i++) {
      assert.equal(presenter.push(fakeImage(4, 4, i), rect(0, 0, 4, 4), false), true);
    }
    assert.equal(surface.frames.length, 0, "nothing is presented synchronously");
    await tick();
    assert.equal(surface.frames.length, 1, "the burst drained as a single frame");
    assert.equal(surface.frames[0].bgra[0], 4, "the newest pixels won");
  });

  it("presents again on the next burst, so throttling is not dropping", async () => {
    const surface = fakeSurface();
    const presenter = new paint.BitmapPresenter(surface);
    presenter.push(fakeImage(2, 2, 1), rect(0, 0, 2, 2), true);
    await tick();
    presenter.push(fakeImage(2, 2, 2), rect(0, 0, 2, 2), true);
    await tick();
    assert.equal(surface.frames.length, 2);
    assert.equal(surface.frames[1].bgra[0], 2);
  });

  it("unions the damage of the frames it collapsed", async () => {
    const surface = fakeSurface();
    const presenter = new paint.BitmapPresenter(surface);
    presenter.push(fakeImage(64, 64), rect(0, 0, 10, 10), false);
    presenter.push(fakeImage(64, 64), rect(20, 30, 10, 10), false);
    await tick();
    assert.equal(surface.frames.length, 1);
    assert.deepEqual(surface.frames[0].damage, rect(0, 0, 30, 40));
  });

  it("repaints the whole surface when a collapsed frame changed size", async () => {
    const surface = fakeSurface();
    const presenter = new paint.BitmapPresenter(surface);
    presenter.push(fakeImage(16, 16), rect(0, 0, 4, 4), false);
    presenter.push(fakeImage(32, 32), rect(0, 0, 4, 4), false);
    await tick();
    assert.equal(surface.frames.length, 1);
    assert.equal(surface.frames[0].width, 32);
    assert.equal(
      surface.frames[0].damage,
      undefined,
      "a stale frame of another size cannot be described by a damage rect",
    );
  });

  it("rejects a zero-area image and schedules nothing", async () => {
    const surface = fakeSurface();
    const presenter = new paint.BitmapPresenter(surface);
    assert.equal(presenter.push(fakeImage(0, 12), rect(0, 0, 1, 1), true), false);
    await tick();
    assert.deepEqual(surface.frames, []);
  });
});

describe("what the controller routes to on Windows", () => {
  const source = fs.readFileSync(
    path.join(REPO, "browser", "src", "page", "controller.ts"),
    "utf8",
  );

  it("sends a frame with neither texture nor shm frame to the throttled presenter", () => {
    // Finding: with no texture and no shm frame — which is every frame on
    // Windows — the controller never reaches `presentPaint` at all. The
    // throttled `BitmapPresenter` is the Windows path; `presentPaint`'s bitmap
    // branch is the fallback behind it.
    assert.match(source, /event\.texture \|\| shmFrame\s*\?\s*presentPaint\(/);
    assert.match(source, /:\s*this\.bitmaps\.push\(image, dirtyRect, this\.wholeSurfaceNext\)/);
  });
});
