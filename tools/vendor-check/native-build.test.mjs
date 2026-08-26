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

// The arguments the artifact check is made of, named once so the tests below
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
// The build inputs that decide what goes into the artifact without living under
// `SOURCE_REL`, each named because a source root is not the whole set of inputs:
//
//   - the workspace manifest carries `[workspace.dependencies]` — including
//     `windows-sys` and its feature list — `[workspace.lints]` and the `opt-level = 2`
//     overrides for both crates; the lockfile carries the versions those resolve to;
//   - `rust-toolchain.toml` picks the compiler. `build-native.mjs` runs cargo with
//     `cwd` inside `engine/packages/pixel-react`, so rustup walks up to `engine/` and
//     reads the channel pinned there — bump it and the next build is a different
//     rustc against an unmoved `engine/crates`;
//   - both fonts are `include_bytes!`d into the cdylib by `pixel-node/src/lib.rs`, so
//     their bytes *are* part of the artifact. The check below derives that list from
//     the sources rather than trusting this one to have kept up;
//   - `build-native.mjs` itself decides which cargo profile is copied and under what
//     name, so an edit there is an edit to what `pixel.node` is.
//
// Touch any of them without touching a `.rs` file — a `cargo update`, a feature flag, a
// profile change, a channel bump, a re-hinted font — and the three tests below would
// load and pass against the previous binary, which is the silent stale pass the rest of
// this file exists to close. Named here rather than reached by widening `SOURCE_REL` to
// `engine`, which would walk `engine/target` and report stale on every run.
// `engine/deny.toml` and `engine/justfile` are deliberately out: a cargo-deny policy
// and a task runner, neither of which the build reads.
const ALSO_REL = [
  "engine/Cargo.toml",
  "engine/Cargo.lock",
  "engine/rust-toolchain.toml",
  "engine/assets/fonts/InterVariable.ttf",
  "engine/assets/fonts/JetBrainsMono-Regular.ttf",
  "engine/packages/pixel-react/scripts/build-native.mjs",
];
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
  const artifact = () => requireBuilt(REPO, ARTIFACT_REL, SOURCE_REL, BUILD, ALSO_REL);

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
 * A repo-shaped scratch tree carrying every path the artifact check compares, with
 * the artifact written only when asked. mtimes are set rather than inferred from
 * write order: staleness is a claim about a strict inequality, and two writes a
 * millisecond apart are not a reliable way to state one.
 *
 * `built` names which input is newer than the artifact: `"stale"` the crate sources,
 * `"stale-manifest"` `engine/Cargo.toml` alone — the case a comparison against the
 * source tree by itself cannot see — and `"fresh"` none of them.
 */
function fixture(tag, built) {
  const root = fs.mkdtempSync(path.join(scratch, `${tag}-`));
  const source = path.join(root, SOURCE_REL);
  fs.mkdirSync(source, { recursive: true });
  for (const relative of ALSO_REL) {
    const also = path.join(root, relative);
    fs.mkdirSync(path.dirname(also), { recursive: true });
    fs.writeFileSync(also, relative);
  }
  fs.writeFileSync(path.join(source, "lib.rs"), "fn main() {}\n");
  const artifact = path.join(root, ARTIFACT_REL);
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  if (built === "missing") return root;
  fs.writeFileSync(artifact, "MZ");
  const now = Date.now() / 1000;
  const before = now - 60;
  // Everything is older than the artifact except the one input `built` names, so each
  // fixture states a single strict inequality and the test that reads it cannot pass
  // for the wrong reason.
  const artifactAt = built === "fresh" ? now : before;
  fs.utimesSync(artifact, artifactAt, artifactAt);
  const sourceAt = built === "stale" ? now : before;
  fs.utimesSync(path.join(source, "lib.rs"), sourceAt, sourceAt);
  for (const relative of ALSO_REL) {
    const at = built === "stale-manifest" && relative === "engine/Cargo.toml" ? now : before;
    fs.utimesSync(path.join(root, relative), at, at);
  }
  return root;
}

const check = (root) => () => requireBuilt(root, ARTIFACT_REL, SOURCE_REL, BUILD, ALSO_REL);

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

  it("fails on a pixel.node older than the workspace manifest alone", () => {
    // The half `SOURCE_REL` cannot reach. `engine/Cargo.toml` decides the dependency
    // versions, the `windows-sys` feature set and the opt-levels the artifact is
    // compiled with, and none of it lives under `engine/crates` — so a `cargo update`
    // or a feature-flag edit left every test above passing against the old binary
    // while nothing under the source root had moved.
    assert.throws(check(fixture("manifest", "stale-manifest")), (error) => {
      assert.match(error.message, /pixel\.node is older than engine\/Cargo\.toml/);
      assert.ok(error.message.includes(BUILD), error.message);
      return true;
    });
  });

  it("names the input that is actually newer, not just the source root", () => {
    // A message that always said `engine/crates` would send the reader to look at the
    // one tree the edit was not in. The two staleness tests above assert two different
    // paths out of the same check, which is the whole reason it reports which.
    assert.throws(check(fixture("which", "stale")), /older than engine\/crates —/);
  });

  it("refuses a named build input that is not there", () => {
    // Same reasoning as the source root below: `engine/Cargo.lock` renamed or removed
    // must not quietly drop out of the comparison, because that is precisely the run
    // where the artifact is most likely stale.
    const root = fixture("nolock", "fresh");
    fs.rmSync(path.join(root, "engine", "Cargo.lock"));
    assert.throws(check(root), (error) => {
      assert.ok(
        error.message.includes("Cargo.lock"),
        `the message does not name the missing build input: ${error.message}`,
      );
      return true;
    });
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

  it("compares against every asset the crates compile into the artifact", () => {
    // `ALSO_REL` is hand-written, and the hazard it exists to close is exactly the
    // input nobody remembered to add: an `include_bytes!` puts a file's bytes *into*
    // `pixel.node` from outside `SOURCE_REL`, and a check that never stats it reports
    // fresh against a binary built from the old bytes. So the list of embedded assets
    // is read out of the sources rather than restated here, and this fails the day one
    // is added without `ALSO_REL` moving. `include_str!` counts for the same reason.
    const embedded = new Set();
    const unresolved = [];
    const walk = (at) => {
      for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".rs")) {
          const source = fs.readFileSync(full, "utf8");
          // Every invocation is found first, then only the plain-string form is read
          // for its path. A raw string or a `concat!`-built path is a real embed this
          // cannot resolve, and skipping it quietly is the same stale pass in miniature
          // -- so it is collected and failed on below rather than dropped.
          for (const site of source.matchAll(/include_(?:bytes|str)!\(\s*(.)/g)) {
            const line = source.slice(0, site.index).split("\n").length;
            const where = `${path.relative(REPO, full).split(path.sep).join("/")}:${line}`;
            if (site[1] !== '"') {
              unresolved.push(where);
              continue;
            }
            const rel = /^"([^"]+)"/.exec(source.slice(site.index + site[0].length - 1))?.[1];
            if (rel === undefined) {
              unresolved.push(where);
              continue;
            }
            const absolute = path.resolve(path.dirname(full), rel);
            embedded.add(path.relative(REPO, absolute).split(path.sep).join("/"));
          }
        }
      }
    };
    walk(path.join(REPO, SOURCE_REL));
    assert.deepEqual(
      unresolved,
      [],
      `these includes embed a file this test cannot resolve, so ALSO_REL is unchecked for them: ${unresolved.join(", ")}`,
    );
    assert.ok(embedded.size > 0, "no embedded assets found at all, so this proves nothing");
    for (const rel of embedded) {
      assert.ok(
        rel.startsWith(`${SOURCE_REL}/`) || ALSO_REL.includes(rel),
        `${rel} is compiled into pixel.node and neither SOURCE_REL nor ALSO_REL covers it`,
      );
    }
  });

  it("no longer lets any test here run conditionally", () => {
    // `requireBuilt` inside each test is only loud while nothing downstream
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
