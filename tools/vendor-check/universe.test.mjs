// The scope, checked against the thing it is derived from.
//
// `universe.mjs` replaces a checked-in list with a query, which removes one failure
// mode (a file nobody remembered to list) and introduces another (a query that
// quietly answers something narrower than it claims). So the numbers are pinned
// here: 239 paths introduced, 4 declared out, 235 in scope, 44 of them diverged and
// none deleted. Any of those moving is a real event and should be read, not
// re-baselined.
//
// The membership assertions name the files the old guard missed on purpose. If the
// derived scope ever stops containing `pixel-node/src/surface.rs`, this plan has
// undone itself and the test says so in those words.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  BASELINE,
  EXCLUSIONS,
  assertExclusionsAreReal,
  classify,
  inVendoredTree,
  partitionDivergences,
  surveyVendored,
  untrackedInVendoredTrees,
  vendoredDirectories,
  vendoredUniverse,
  vendoringCommitPaths,
} from "./universe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The trees the old `SRC`-scoped guard could not see. */
const PREVIOUSLY_UNGUARDED = [
  "engine/crates/pixel-node/src/capture.rs",
  "engine/crates/pixel-node/src/lib.rs",
  "engine/crates/pixel-node/src/surface.rs",
  "engine/packages/pixel-react/scripts/build-native.mjs",
  "engine/Cargo.toml",
  "engine/crates/pixel-core/Cargo.toml",
];

describe("the vendored universe", () => {
  it("is every path the vendoring commit introduced", () => {
    const paths = vendoringCommitPaths();
    assert.equal(paths.length, 239, `${BASELINE} no longer introduces 239 paths`);
    assert.deepEqual(paths, [...paths].sort(), "the universe is not sorted");
    assert.equal(new Set(paths).size, paths.length, "the universe has a duplicate");
  });

  it("contains the trees the old guard could not see", () => {
    const universe = new Set(vendoringCommitPaths());
    for (const file of PREVIOUSLY_UNGUARDED) {
      assert.ok(universe.has(file), `${file} is not in the derived universe`);
    }
  });

  it("contains all 46 files the old `pixel-core` inventory listed", () => {
    // The inventory is not what decides scope any more, but everything it named had
    // better still be inside the scope that replaced it — a derived universe that
    // covers *less* than the list it supersedes would be a regression wearing the
    // clothes of an improvement.
    const inventory = JSON.parse(
      fs.readFileSync(path.join(HERE, "pixel-core-files.json"), "utf8"),
    );
    assert.equal(inventory.length, 46);
    const universe = new Set(vendoringCommitPaths());
    for (const file of inventory) {
      const full = `engine/crates/pixel-core/src/${file}`;
      assert.ok(universe.has(full), `${full} is not in the derived universe`);
    }
  });

  it("is the commit's paths minus the declared exclusions", () => {
    const scope = vendoredUniverse();
    assert.equal(scope.length, vendoringCommitPaths().length - Object.keys(EXCLUSIONS).length);
    assert.equal(scope.length, 235);
    for (const excluded of Object.keys(EXCLUSIONS)) {
      assert.ok(!scope.includes(excluded), `${excluded} is excluded but still in scope`);
    }
  });
});

describe("the exclusion list", () => {
  it("declares a reason for every entry", () => {
    for (const [file, reason] of Object.entries(EXCLUSIONS)) {
      assert.equal(typeof reason, "string", `${file} has no reason`);
      assert.ok(
        reason.length > 40,
        `${file}'s reason is a label, not an argument someone can disagree with`,
      );
    }
  });

  it("names only paths the vendoring commit really introduced", () => {
    assert.doesNotThrow(assertExclusionsAreReal);
    const universe = new Set(vendoringCommitPaths());
    for (const file of Object.keys(EXCLUSIONS)) {
      assert.ok(universe.has(file), `${file} is excluded but was never vendored`);
    }
  });

  it("covers exactly the four project files the commit carried and the port edits", () => {
    assert.deepEqual(Object.keys(EXCLUSIONS).sort(), [
      ".gitignore",
      "docs/design/UPSTREAM.md",
      "docs/plans/20260821-windows-port.md",
      "package.json",
    ]);
  });
});

describe("classify", () => {
  it("reports an excluded path as excluded, with its reason", () => {
    const verdict = classify("package.json");
    assert.equal(verdict.category, "excluded");
    assert.equal(verdict.reason, EXCLUSIONS["package.json"]);
  });

  it("reports a vendored path as vendored", () => {
    for (const file of PREVIOUSLY_UNGUARDED) {
      assert.equal(classify(file).category, "vendored", `${file} did not classify as vendored`);
    }
  });

  it("fails on an undeclared path rather than defaulting into a category", () => {
    // This very file, which the vendoring commit obviously did not carry. The point
    // is that there is no third answer and no silent one: an unrecognised path is a
    // question the module refuses, not a path it waves through.
    assert.throws(
      () => classify("tools/vendor-check/universe.mjs"),
      /is not a path .* introduced/,
    );
    assert.throws(() => classify("engine/crates/pixel-core/src/nonexistent.rs"), /will not guess/);
    assert.throws(() => classify(""), /will not guess/);
  });

  it("does not treat inherited object properties as declarations", () => {
    // `EXCLUSIONS` is looked up with `hasOwn`, not `in`. Without that, `constructor`
    // and `toString` are excluded project files.
    assert.throws(() => classify("constructor"), /will not guess/);
    assert.throws(() => classify("toString"), /will not guess/);
  });
});

describe("the survey against the baseline", () => {
  it("finds the 44 in-scope divergences and no deletions", () => {
    const { changed, deleted } = surveyVendored();
    assert.deepEqual(deleted, [], "a vendored file is missing from the working tree");
    assert.equal(changed.length, 44, `${changed.length} vendored paths differ, not 44`);
  });

  it("sees the divergences the old guard was blind to", () => {
    const changed = new Set(surveyVendored().changed);
    for (const file of PREVIOUSLY_UNGUARDED) {
      assert.ok(changed.has(file), `${file} differs from ${BASELINE} but the survey missed it`);
    }
  });

  it("reports nothing outside the vendored universe", () => {
    const scope = new Set(vendoredUniverse());
    const { changed, deleted } = surveyVendored();
    for (const file of [...changed, ...deleted]) {
      assert.ok(scope.has(file), `${file} was surveyed but is not in the vendored universe`);
    }
  });

  it("carries an untracked list, which is the one finding scope cannot supply", () => {
    // `changed` and `deleted` are both questions about a path the commit introduced.
    // This one is only ever about a path it did not, so it is the single field of the
    // survey that the universe cannot be used to check.
    const { untracked } = surveyVendored();
    assert.ok(Array.isArray(untracked));
    assert.deepEqual(untracked, [], `untracked files sit in a vendored tree: ${untracked}`);
  });
});

describe("vendored trees, as directories rather than paths", () => {
  const DIRS = vendoredDirectories();

  it("derives the directories from the commit and leaves the root out", () => {
    // Every path in the repo descends from `.`, so a root that qualified would make
    // `inVendoredTree` true of everything and the untracked check a repo-wide nag.
    assert.ok(DIRS.has("engine/crates/pixel-node/src"));
    assert.ok(DIRS.has("engine/packages/pixel-react/src"));
    assert.ok(!DIRS.has("."), "the repo root is a vendored directory by the same rule");
    assert.ok(!DIRS.has(""), "an empty directory name reached the set");
  });

  it("places a file by its own directory", () => {
    assert.ok(inVendoredTree("engine/crates/pixel-node/src/shm.rs", DIRS));
    assert.ok(inVendoredTree("engine/packages/pixel-react/src/surface.ts", DIRS));
  });

  it("places a file in a subdirectory no vendored path lives in", () => {
    // The reason the walk goes up the ancestors instead of testing the immediate
    // directory: a re-vendor that adds `backends/` under `pixel-node/src` puts files
    // in a directory that shares no vendored path, and it is plainly still inside the
    // tree.
    assert.ok(inVendoredTree("engine/crates/pixel-node/src/backends/win32.rs", DIRS));
  });

  it("leaves alone what is not in a vendored tree at all", () => {
    assert.ok(!inVendoredTree("scratch/notes.md", DIRS));
    assert.ok(!inVendoredTree("notes.md", DIRS), "a root-level file counted as vendored");
  });

  it("agrees with the survey", () => {
    assert.deepEqual(untrackedInVendoredTrees(), surveyVendored().untracked);
  });
});

describe("partitioning edits from deletions", () => {
  // The survey's decision half, driven directly. A test that really deleted a
  // vendored file would be racing every other suite in the run, and the interesting
  // part is the judgement, not the `rm`.
  const SCOPE = ["a.rs", "b.rs", "c.rs"];
  const allPresent = () => true;

  it("reports a `D` from git as a deletion, not an edit", () => {
    const { changed, deleted } = partitionDivergences(
      SCOPE,
      [
        ["M", "a.rs"],
        ["D", "b.rs"],
      ],
      (file) => file !== "b.rs",
    );
    assert.deepEqual(changed, ["a.rs"]);
    assert.deepEqual(deleted, ["b.rs"]);
  });

  it("reports a path missing from disk even if git said nothing about it", () => {
    // A re-vendor that drops a file is the failure this directory exists to catch,
    // and until now nothing detected it: a file that is gone has no diff to inspect.
    const { changed, deleted } = partitionDivergences(SCOPE, [], (file) => file !== "c.rs");
    assert.deepEqual(deleted, ["c.rs"]);
    assert.deepEqual(changed, []);
  });

  it("prefers deleted over changed when git says both", () => {
    // `--no-renames` turns a move into D-then-A at two paths; a stale `M` alongside
    // a vanished file must not downgrade the report to "edited".
    const { changed, deleted } = partitionDivergences(
      SCOPE,
      [["M", "b.rs"]],
      (file) => file !== "b.rs",
    );
    assert.deepEqual(deleted, ["b.rs"]);
    assert.deepEqual(changed, []);
  });

  it("ignores statuses for paths outside the scope", () => {
    const { changed, deleted } = partitionDivergences(
      SCOPE,
      [
        ["M", "somewhere/else.ts"],
        ["D", "also/not/ours.ts"],
      ],
      allPresent,
    );
    assert.deepEqual(changed, []);
    assert.deepEqual(deleted, []);
  });

  it("says nothing when nothing diverged", () => {
    assert.deepEqual(partitionDivergences(SCOPE, [], allPresent), { changed: [], deleted: [] });
  });
});
