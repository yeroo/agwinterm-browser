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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  BASELINE,
  EXCLUSIONS,
  PROJECT_ROOTS,
  assertExclusionsAreReal,
  assertProjectRootsAreReal,
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
const REPO = path.resolve(HERE, "..", "..");

/** `git show`'s NUL-terminated path list, for asking the same question two ways. */
function gitPaths(args) {
  const out = execFileSync("git", args, { cwd: REPO, encoding: "utf8", timeout: 30_000 });
  return out.split("\u0000").filter((field) => field !== "");
}

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

  it("leaves out what a vendoring commit deletes rather than adds", () => {
    // `--name-only` lists a commit's removals beside its additions, so without
    // `--diff-filter=d` a path the baseline *deleted* would enter the scope, survey as
    // `deleted`, and be reported with a `git checkout` restoring a file that was meant
    // to go. `45b5e43` deletes nothing, so the live call cannot show the difference —
    // the query is checked instead, against a commit in this repo that does delete.
    const source = fs.readFileSync(path.join(HERE, "universe.mjs"), "utf8");
    assert.match(source, /"--diff-filter=d"/, "the scope query no longer drops deletions");
    const deleting = "0e71f05";
    const withDeletes = gitPaths(["show", "--name-only", "--format=", "-z", deleting]);
    const without = gitPaths([
      "show",
      "--name-only",
      "--format=",
      "-z",
      "--diff-filter=d",
      deleting,
    ]);
    assert.ok(
      withDeletes.length > without.length,
      `${deleting} was chosen because it deletes paths; if it no longer does, this ` +
        `test is checking that two identical lists are identical`,
    );
    for (const file of without) {
      assert.ok(withDeletes.includes(file), "the filter dropped a path it should keep");
    }
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

  it("refuses an exclusion for a path the commit never carried, and names it", () => {
    // The only branch `assertExclusionsAreReal` has. Asserting `doesNotThrow` above
    // holds just as well for a function whose condition can never be true, so the
    // failure path is driven directly rather than left as an untested claim. The
    // arguments are injected because the alternative is adding a fake row to the real
    // `EXCLUSIONS` while the rest of the run reads it.
    assert.throws(
      () => assertExclusionsAreReal({ "engine/crates/pixel-core/src/ghost.rs": "why" }, ["LICENSE"]),
      (error) => {
        assert.match(error.message, /ghost\.rs/);
        assert.match(error.message, /exempts a future file of that name/);
        return true;
      },
    );
    assert.doesNotThrow(() => assertExclusionsAreReal({ LICENSE: "why" }, ["LICENSE"]));
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
  // Lazy, and called from inside each test, for the reason `native-build.test.mjs`
  // spells out: `vendoredDirectories` reaches `assertExclusionsAreReal`, which throws
  // on a stale exclusion, and a throw from a `describe` callback prints `not ok` while
  // counting as neither pass nor fail -- `node --test` still exits 0 (v22.19.0). At
  // describe-time a stale exclusion would delete all seven tests below and leave the
  // run green, which is the precise condition `assertExclusionsAreReal` exists to
  // shout about. Inside a test, a throw is a failure the exit code knows about.
  const dirs = () => vendoredDirectories();

  it("derives the directories from the commit and leaves the root out", () => {
    // Every path in the repo descends from `.`, so a root that qualified would make
    // `inVendoredTree` true of everything and the untracked check a repo-wide nag.
    assert.ok(dirs().has("engine/crates/pixel-node/src"));
    assert.ok(dirs().has("engine/packages/pixel-react/src"));
    assert.ok(!dirs().has("."), "the repo root is a vendored directory by the same rule");
    assert.ok(!dirs().has(""), "an empty directory name reached the set");
  });

  it("does not make a tree out of a directory only an excluded path put there", () => {
    // `docs/plans` holds exactly one baseline path — `20260821-windows-port.md`,
    // declared out because changing is what a plan does — so the directory is this
    // repo's own and not a vendored tree. Derived from the raw commit it qualified
    // anyway, and every plan document was an untracked-file failure for as long as it
    // took to write. A guard whose answer to ordinary work is "stop" gets silenced.
    assert.ok(!dirs().has("docs/plans"), "an excluded path still makes its directory a tree");
    assert.ok(!inVendoredTree("docs/plans/20260826-vendor-check-gap.md", dirs()));
  });

  it("leaves this repo's own scaffolding out, though the commit carried it", () => {
    // The same pressure as `docs/plans`, eight times the size, and the exclusion rule
    // cannot reach it: `tools/vendor-check/digest.py` and
    // `docs/design/01-baseline-errors.md` are in the universe on purpose and must stay
    // byte-identical, so they qualify their directories on the first rule while no
    // upstream file has ever landed in either. `UPSTREAM.md`'s "What was copied" lists
    // `engine/`, `browser/`, `cli/`, `store/`, `terminals/`, `assets/` and four root
    // files — `tools/` and `docs/` are not in it.
    assert.ok(!dirs().has("tools"), "tools/ is a tree upstream code arrives in");
    assert.ok(!dirs().has("tools/vendor-check"), "the guard's own directory is a vendored tree");
    assert.ok(!dirs().has("tools/conpty-probe"));
    assert.ok(!dirs().has("docs/design"), "docs/design is a tree upstream code arrives in");
    assert.ok(!inVendoredTree("tools/vendor-check/universe.mjs", dirs()));
    assert.ok(!inVendoredTree("tools/milestone/anything.mjs", dirs()));
    assert.ok(!inVendoredTree("docs/design/08-whatever.md", dirs()));
    // And the roots buy no exemption from the diff: those paths are still in scope.
    const universe = new Set(vendoredUniverse());
    assert.ok(universe.has("tools/vendor-check/digest.py"), "a project root left the universe");
    assert.ok(universe.has("docs/design/01-baseline-errors.md"));
  });

  it("names only roots the vendoring commit actually filled", () => {
    // The staleness hazard `assertExclusionsAreReal` covers, one level up: a root
    // naming no real directory reads as a decision while doing nothing, and the day
    // upstream code lands under that name it is outside the untracked check already.
    assert.deepEqual(Object.keys(PROJECT_ROOTS).sort(), ["docs", "tools"]);
    assert.throws(
      () => assertProjectRootsAreReal({ ghost: "why" }, ["tools/x.py"]),
      (error) => {
        assert.match(error.message, /ghost/);
        assert.match(error.message, /before anyone reads it/);
        return true;
      },
    );
    assert.doesNotThrow(() => assertProjectRootsAreReal({ tools: "why" }, ["tools/x.py"]));
    // And the subtraction reaches no further than it is meant to: every tree
    // `UPSTREAM.md` says upstream filled is still one.
    for (const root of ["engine", "browser", "cli", "store", "terminals", "assets"]) {
      assert.ok(dirs().has(root), `${root} stopped being a vendored tree`);
    }
  });

  it("counts a tree whose vendored paths all sit a level down", () => {
    // The second rule, and the hole the first one alone left: `assets/` holds nothing
    // directly — its only baseline paths are under `assets/fonts` — so taking the
    // immediate parent made `assets/fonts/new.ttf` inside a vendored tree and
    // `assets/new.ttf` outside one, while `UPSTREAM.md` names `assets/` among the
    // guarded trees. Everything the commit put beneath it is vendored, so it is a tree.
    assert.ok(dirs().has("assets"), "a top-level vendored tree is not a directory");
    assert.ok(inVendoredTree("assets/new.ttf", dirs()));
    // And the rule stops where a declared-out path is: `docs` holds no vendored file
    // directly and two exclusions live under it, so counting it would drag
    // `docs/plans` back in through the ancestor walk.
    assert.ok(!dirs().has("docs"), "a directory holding two exclusions became a tree");
    assert.ok(!inVendoredTree("docs/README.md", dirs()));
  });

  it("places a file by its own directory", () => {
    assert.ok(inVendoredTree("engine/crates/pixel-node/src/shm.rs", dirs()));
    assert.ok(inVendoredTree("engine/packages/pixel-react/src/surface.ts", dirs()));
  });

  it("places a file in a subdirectory no vendored path lives in", () => {
    // The reason the walk goes up the ancestors instead of testing the immediate
    // directory: a re-vendor that adds `backends/` under `pixel-node/src` puts files
    // in a directory that shares no vendored path, and it is plainly still inside the
    // tree.
    assert.ok(inVendoredTree("engine/crates/pixel-node/src/backends/win32.rs", dirs()));
  });

  it("leaves alone what is not in a vendored tree at all", () => {
    assert.ok(!inVendoredTree("scratch/notes.md", dirs()));
    assert.ok(!inVendoredTree("notes.md", dirs()), "a root-level file counted as vendored");
  });

  it("agrees with the survey", () => {
    assert.deepEqual(untrackedInVendoredTrees(), surveyVendored().untracked);
  });

  it("reports an untracked file that is in a vendored tree, and only that one", () => {
    // The positive case, which nothing else here has. On a clean tree the live call
    // answers `[]`, and `[]` is also what a body of `return []` answers — so both
    // assertions above hold for a function that does nothing at all. The file list is
    // injected rather than written to disk: creating a real file under `pixel-node/src`
    // would make `unchanged.test.mjs` fail in the process running beside this one.
    assert.deepEqual(
      untrackedInVendoredTrees(
        [
          "scratch/notes.md",
          "engine/crates/pixel-node/src/backends/win32.rs",
          "notes.md",
          "engine/packages/pixel-react/src/surface.ts",
          "docs/plans/20260826-vendor-check-gap.md",
        ],
        dirs(),
      ),
      [
        "engine/crates/pixel-node/src/backends/win32.rs",
        "engine/packages/pixel-react/src/surface.ts",
      ],
    );
  });

  it("sorts what it reports, so a failure list reads the same on every platform", () => {
    assert.deepEqual(
      untrackedInVendoredTrees(
        ["engine/crates/pixel-node/src/z.rs", "engine/crates/pixel-node/src/a.rs"],
        dirs(),
      ),
      ["engine/crates/pixel-node/src/a.rs", "engine/crates/pixel-node/src/z.rs"],
    );
  });

  it("asks git for files that are neither tracked nor ignored", () => {
    // The half the injectable list cannot cover. `--others` without
    // `--exclude-standard` would report every build artifact under `engine/target`,
    // which is how this check becomes a nag and then gets deleted.
    const source = fs.readFileSync(path.join(HERE, "universe.mjs"), "utf8");
    assert.match(source, /"ls-files", "--others", "--exclude-standard", "-z"/);
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
