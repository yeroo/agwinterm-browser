// Pins the napi artifact's name, and that the built module actually loads.
//
// `pixel-node` is `crate-type = ["cdylib"]`, so cargo names its output per platform:
// `libpixel_node.dylib`, `libpixel_node.so`, and on Windows `pixel_node.dll` — no
// `lib` prefix and a different extension. Upstream's build helper branched only on
// darwin, so on Windows it looked for `libpixel_node.so`, and `copyFileSync` failed
// with ENOENT — a message that reads as "the engine was never built" rather than
// "the file is not called that here". That is a stall, not a bug report, which is
// why the name is pinned rather than left to the next person to rediscover.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { build, libraryName } from "../../engine/packages/pixel-react/scripts/build-native.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PIXEL_REACT = path.join(REPO, "engine", "packages", "pixel-react");
const ARTIFACT = path.join(PIXEL_REACT, "native", "pixel.node");

describe("the cdylib's name", () => {
  it("is what cargo produces on each platform", () => {
    assert.equal(libraryName("darwin"), "libpixel_node.dylib");
    assert.equal(libraryName("win32"), "pixel_node.dll");
    assert.equal(libraryName("linux"), "libpixel_node.so");
  });

  it("treats an unknown platform as unix rather than as Windows", () => {
    // Guessing `.so` for freebsd is right; guessing it for a second Windows-like
    // target would be wrong, and there is no such target to guess at.
    assert.equal(libraryName("freebsd"), "libpixel_node.so");
  });

  it("still describes a cdylib, which is what makes the name platform-shaped", () => {
    const manifest = fs.readFileSync(
      path.join(REPO, "engine", "crates", "pixel-node", "Cargo.toml"),
      "utf8",
    );
    assert.match(manifest, /crate-type\s*=\s*\[\s*"cdylib"\s*\]/);
  });
});

describe("the build helper", () => {
  const source = fs.readFileSync(
    path.join(PIXEL_REACT, "scripts", "build-native.mjs"),
    "utf8",
  );

  it("does not run cargo merely because something imported it", () => {
    // This file imports it. If the guard goes, importing this test spawns a build.
    assert.equal(typeof build, "function", "build is not exported, so it cannot be guarded");
    assert.match(source, /process\.argv\[1\][\s\S]*import\.meta\.filename/);
  });

  it("says which file it wanted when the artifact is not where it looked", () => {
    assert.match(source, /does not exist/);
    assert.ok(
      source.includes("existsSync"),
      "the copy is unguarded again, so a naming mistake surfaces as a bare ENOENT",
    );
  });

  it("runs cargo without a shell", () => {
    assert.ok(!/\bexecSync\b|\bsh -c\b|\bbash\b/.test(source));
    assert.match(source, /execFileSync\("cargo"/);
  });
});

describe("the built napi module", () => {
  const built = fs.existsSync(ARTIFACT);
  const skip = built ? false : "engine/packages/pixel-react/native/pixel.node is not built";

  it("is this platform's artifact, not a stale one from another", { skip }, () => {
    // `pixel.node` is a copy, so a wrong `libraryName` that still found *some*
    // file would be caught here rather than at `require` time. Mach-O has four
    // magics depending on arch and fatness, so darwin is covered by loading alone.
    const magic = { win32: "MZ", linux: "\x7fELF" }[process.platform];
    if (magic === undefined) return;
    const head = Buffer.alloc(magic.length);
    const fd = fs.openSync(ARTIFACT, "r");
    fs.readSync(fd, head, 0, magic.length, 0);
    fs.closeSync(fd);
    assert.equal(
      head.toString("latin1"),
      magic,
      `pixel.node does not begin with ${JSON.stringify(magic)}`,
    );
  });

  it("loads, and exports every symbol pixel-react binds to", { skip }, () => {
    const binding = createRequire(import.meta.url)(ARTIFACT);
    for (const name of [
      "PixelEngine",
      "captureFilmstrip",
      "diff",
      "encodeRecording",
      "highlight",
      "highlightCaptures",
      "parseMarkdown",
    ]) {
      assert.equal(typeof binding[name], "function", `binding.${name} is missing`);
    }
  });

  it("runs the C-backed halves — tree-sitter and pulldown-cmark", { skip }, () => {
    // The seven tree-sitter grammars and openh264 compile C/C++ through build
    // scripts, so "the module loads" and "MSVC produced working objects" are
    // different claims. This is the second one.
    const binding = createRequire(import.meta.url)(ARTIFACT);
    assert.ok(binding.highlight("fn main() {}", "rust").length > 0);
    assert.ok(binding.highlightCaptures().length > 0);
    assert.equal(binding.parseMarkdown("# hi\n\ntext").length, 2);
    assert.equal(binding.diff("a\nb\n", "a\nc\n").length, 3);
  });
});
