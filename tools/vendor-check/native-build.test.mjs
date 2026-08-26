// Pins the napi artifact's name, and that the built module actually loads.
//
// `pixel-node` is `crate-type = ["cdylib"]`, so cargo names its output per platform:
// `libpixel_node.dylib`, `libpixel_node.so`, and on Windows `pixel_node.dll` — no
// `lib` prefix and a different extension. Upstream's build helper branched only on
// darwin, so on Windows it looked for `libpixel_node.so`, and `copyFileSync` failed
// with ENOENT — a message that reads as "the engine was never built" rather than
// "the file is not called that here". That is a stall, not a bug report, which is
// why the name is pinned rather than left to the next person to rediscover.
//
// The three checks against the built module used to degrade to a skip when
// `native/pixel.node` was absent, and said nothing about staleness when it was
// present. Both are the failure `tools/lib/built.mjs` was written for -- "a stale
// `dist/` is worse, because everything passes -- against yesterday's source" -- and
// this file guards the one artifact `tools/vendor-check/` exists to protect, so it
// was the worst possible place to be the outlier. `requireBuilt` now decides, and a
// missing or stale artifact fails naming the command to run.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { build, libraryName } from "../../engine/packages/pixel-react/scripts/build-native.mjs";
import { requireBuilt } from "../lib/built.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PIXEL_REACT = path.join(REPO, "engine", "packages", "pixel-react");

// The three arguments the artifact check is made of, named once so the tests below
// exercise the wiring this suite really uses rather than a plausible copy of it.
const ARTIFACT_REL = "engine/packages/pixel-react/native/pixel.node";
// `pixel.node` is a copy of the cdylib cargo builds from `pixel-node`, so this is the
// source whose mtime decides whether the copy is current. Both crates, not just
// `pixel-node/src`: `pixel-node` depends on `pixel-core`, so `pixel-core/src` is
// compiled *into* the artifact and an edit there leaves it just as stale. Scoping
// this to one crate meant the three tests below could pass against yesterday's build
// of the tree this port actually rewrites. `unchanged.test.mjs` guards that tree's
// *content* against the baseline, which is a different question from build freshness.
// `engine/target` is a sibling of `crates`, so this does not walk the build output.
const SOURCE_REL = "engine/crates";
const BUILD = "corepack pnpm --filter pixel-react build:native";

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
  // Throws rather than skips, and rather than dying at `require` with a
  // module-not-found stack that names neither the cause nor the fix.
  //
  // Called from inside each test rather than once here, which reads worse and is
  // the only version that works: a throw from a `describe` callback is printed as
  // `not ok 3` but counted as neither pass nor fail, and `node --test` still exits
  // 0 (v22.19.0). A guard that leaves the run green is the same silent pass the
  // skip was, one layer down -- so the check has to be inside a test, where a
  // throw is a failure the runner's exit code knows about.
  const artifact = () => requireBuilt(REPO, ARTIFACT_REL, SOURCE_REL, BUILD);

  it("is this platform's artifact, not a stale one from another", () => {
    const ARTIFACT = artifact();
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

  it("loads, and exports every symbol pixel-react binds to", () => {
    const binding = createRequire(import.meta.url)(artifact());
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

  it("runs the C-backed halves — tree-sitter and pulldown-cmark", () => {
    // The seven tree-sitter grammars and openh264 compile C/C++ through build
    // scripts, so "the module loads" and "MSVC produced working objects" are
    // different claims. This is the second one.
    const binding = createRequire(import.meta.url)(artifact());
    assert.ok(binding.highlight("fn main() {}", "rust").length > 0);
    assert.ok(binding.highlightCaptures().length > 0);
    assert.equal(binding.parseMarkdown("# hi\n\ntext").length, 2);
    assert.equal(binding.diff("a\nb\n", "a\nc\n").length, 3);
  });
});

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-native-build-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/**
 * A repo-shaped scratch tree carrying the two paths the artifact check compares,
 * with the artifact written only when asked. mtimes are set rather than inferred
 * from write order: staleness is a claim about a strict inequality, and two writes
 * a millisecond apart are not a reliable way to state one.
 */
function fixture(tag, built) {
  const root = fs.mkdtempSync(path.join(scratch, `${tag}-`));
  const source = path.join(root, SOURCE_REL);
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "lib.rs"), "fn main() {}\n");
  const artifact = path.join(root, ARTIFACT_REL);
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  if (built === "missing") return root;
  fs.writeFileSync(artifact, "MZ");
  const now = Date.now() / 1000;
  const [sourceAt, artifactAt] = built === "stale" ? [now, now - 60] : [now - 60, now];
  fs.utimesSync(path.join(source, "lib.rs"), sourceAt, sourceAt);
  fs.utimesSync(artifact, artifactAt, artifactAt);
  return root;
}

const check = (root) => () => requireBuilt(root, ARTIFACT_REL, SOURCE_REL, BUILD);

describe("the artifact check", () => {
  it("fails on a missing pixel.node, and says what to run", () => {
    // The regression in one line: this used to be a skip, so the suite guarding the
    // napi artifact reported success on a tree where it had never been built.
    assert.throws(check(fixture("missing", "missing")), (error) => {
      assert.match(error.message, /pixel-react\/native\/pixel\.node is missing/);
      assert.ok(
        error.message.includes(BUILD),
        `the message does not name the build command: ${error.message}`,
      );
      return true;
    });
  });

  it("fails on a pixel.node older than the crates it is built from", () => {
    // Staleness was never checked at all. An artifact from before the last edit to
    // `lib.rs` loads, exports every symbol, and answers for code that has gone.
    assert.throws(check(fixture("stale", "stale")), (error) => {
      assert.match(error.message, /pixel\.node is older than engine\/crates/);
      assert.ok(error.message.includes(BUILD), error.message);
      return true;
    });
  });

  it("passes on an artifact newer than its sources", () => {
    // Otherwise the two tests above would hold just as well for a check that
    // throws unconditionally, which would be a different kind of useless.
    const root = fixture("fresh", "fresh");
    assert.equal(check(root)(), path.join(root, ARTIFACT_REL));
  });

  it("compares against a source tree that is really there", () => {
    // `built.mjs` refuses a source root it cannot stat rather than answering 0 and
    // silently passing every staleness check. A renamed `pixel-node/src` is exactly
    // how this check would go quiet again.
    const root = fixture("moved", "fresh");
    fs.rmSync(path.join(root, SOURCE_REL), { recursive: true });
    // Whichever way it refuses -- `statSync` raising ENOENT or the explicit
    // not-a-directory message -- the path it could not resolve has to be in it.
    assert.throws(check(root), (error) => {
      assert.ok(
        error.message.includes(path.normalize(SOURCE_REL)),
        `the message does not name the missing source tree: ${error.message}`,
      );
      return true;
    });
  });

  it("no longer lets any test here run conditionally", () => {
    // `requireBuilt` at the top of a describe is only loud while nothing downstream
    // re-introduces the option it replaced. Both spellings, because the options-object
    // form was only the one that happened to be used here: the dotted form on `it`,
    // `describe` or `t`, and `todo` in either shape, all put a test back to reporting
    // success on a tree where the artifact was never built.
    //
    // The prose above deliberately does not write either pattern out. This test reads
    // its own source, so an example in a comment is a match, and a guard that fails on
    // its own explanation is one nobody keeps.
    const self = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    for (const pattern of [/\{\s*(?:skip|todo)\b/, /\.(?:skip|todo)\(/]) {
      assert.ok(!pattern.test(self), `${pattern} is back in this file — a test can go silent again`);
    }
  });
});
