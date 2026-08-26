// The guard, over every tree the vendoring commit brought in.
//
// This file used to scope itself to `engine/crates/pixel-core/src` and the 46 paths
// in `pixel-core-files.json`. That was one of three vendored trees. `pixel-node/src`,
// `pixel-react` and the two `Cargo.toml` files had no baseline check at all, so an
// edit there — or a re-vendor that dropped one — passed the whole suite in silence,
// while `UPSTREAM.md` told a re-vendorer that each divergence "is asserted by a test
// in `tools/vendor-check/`".
//
// The scope now comes from `universe.mjs`, which asks git what `45b5e43` introduced,
// and the reasons come from `dispositions.mjs`, which says of every diverged path
// whether it is the port's subject matter, an incidental divergence with an
// `UPSTREAM.md` number, or a project file declared out. Three properties survive the
// move and are worth naming, because losing any of them would make this a wider
// check and a worse one:
//
//   - the failure still names the file and says why it was expected to differ. A
//     digest over 235 paths would be less code and a worse signal.
//   - `pixel-core-files.json` still asserts what `pixel-core/src` contains. It just
//     no longer decides what gets checked — that was the defect.
//   - `45b5e43` is still asserted to be the vendoring commit. Every path in the scope
//     is derived from it, so a wrong commit is a wrong universe.
//
// And one property is new: a *deleted* vendored file fails. A missing file has no
// diff to inspect, which is why nothing caught it before.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  INCIDENTAL,
  describeDisposition,
  dispositionCount,
  dispositionOf,
  dispositionedPaths,
  guardVerdict,
} from "./dispositions.mjs";
import {
  BASELINE,
  EXCLUSIONS,
  GIT_TIMEOUT_MS,
  REPO,
  surveyVendored,
  vendoredUniverse,
} from "./universe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SURVEY = surveyVendored();

const PIXEL_CORE_SRC = "engine/crates/pixel-core/src";

/**
 * The inventory, kept as the assertion it always was.
 *
 * It answers "what is in `pixel-core/src`", which is a real question and the one
 * `inventory.test.mjs` screens the inputs of. It is no longer consulted about what
 * this file checks.
 */
const EXPECTED_FILES = JSON.parse(
  fs.readFileSync(path.join(HERE, "pixel-core-files.json"), "utf8"),
);

/** The three `pixel-core` modules the port replaces. Everything else is the forty-three. */
const REPLACEABLE = ["ghostty.rs", "herdr.rs", "terminal.rs"];

/**
 * The six paths the old scoping could not see, and which this rewrite exists for.
 *
 * Named individually rather than counted, because "six divergences outside
 * `pixel-core`" is the finding and a count would survive any one of them being
 * dropped again.
 */
const PREVIOUSLY_UNGUARDED = [
  "engine/crates/pixel-node/src/capture.rs",
  "engine/crates/pixel-node/src/lib.rs",
  "engine/crates/pixel-node/src/surface.rs",
  "engine/packages/pixel-react/scripts/build-native.mjs",
  "engine/Cargo.toml",
  "engine/crates/pixel-core/Cargo.toml",
];

/** Vendored, in scope, and undiverged — so a simulated edit to one is a fresh finding. */
const UNDIVERGED = {
  pixelNode: "engine/crates/pixel-node/src/shm.rs",
  pixelReact: "engine/packages/pixel-react/src/surface.ts",
};

describe("the vendored trees", () => {
  it("has a baseline commit to diff against", () => {
    // Load-bearing twice over now: it is the diff's left-hand side *and* the thing
    // the scope itself is derived from. A wrong commit is a wrong universe, silently.
    const subject = execFileSync("git", ["log", "-1", "--format=%s", BASELINE], {
      cwd: REPO,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    assert.match(subject, /vendor upstream/i, `${BASELINE} is not the vendoring commit`);
  });

  it("differs from the baseline only where a disposition says why", () => {
    const verdict = guardVerdict(SURVEY);
    assert.ok(verdict.ok, verdict.message);
    assert.equal(
      verdict.expected.length,
      SURVEY.changed.length,
      "a diverged path has no named reason in the roster",
    );
  });

  it("loses no vendored file to a deletion", () => {
    assert.deepEqual(
      SURVEY.deleted,
      [],
      "a path the vendoring commit introduced is gone from the working tree",
    );
  });

  it("names a reason for every diverged path, not just a count", () => {
    // The property the old check had over 46 paths and that the derived scope must
    // keep over 235: the output is a roster of files with reasons, and each reason
    // is long enough to disagree with.
    for (const line of guardVerdict(SURVEY).expected) {
      assert.match(line, /^\S+ — (subject matter|incidental divergence|not vendored)/);
      assert.ok(line.length > 80, `a roster line is a label, not a reason: ${line}`);
    }
  });
});

describe("the trees the `SRC`-scoped guard could not see", () => {
  it("covers the three `pixel-node` files, the `pixel-react` script and both manifests", () => {
    const scope = new Set(vendoredUniverse());
    const changed = new Set(SURVEY.changed);
    for (const file of PREVIOUSLY_UNGUARDED) {
      assert.ok(scope.has(file), `${file} is not in the derived scope`);
      assert.ok(changed.has(file), `${file} differs from ${BASELINE} and the guard missed it`);
      assert.equal(dispositionCount(file), 1, `${file} is not dispositioned exactly once`);
    }
  });

  it("calls all six incidental rather than subject matter", () => {
    // They are edits to vendored code for a reason that is not the port's subject —
    // a `read_exact_at` shim, an `allow`, a `.dll` name, two feature lists. That is
    // precisely what a re-vendorer has to re-apply by hand, and precisely what
    // `UPSTREAM.md`'s numbered list is for.
    for (const file of PREVIOUSLY_UNGUARDED) {
      assert.equal(
        dispositionOf(file).kind,
        "incidental",
        `${file} is not an incidental divergence`,
      );
    }
  });

  it("covers whole trees, not the files that happened to change", () => {
    // The point of deriving the scope: the twelve `pixel-node` sources and the
    // twenty-three `pixel-react` paths are all in, including the nine and the
    // twenty-two that are identical to upstream today. A guard that only watched the
    // files already known to differ would be a changelog.
    const scope = vendoredUniverse();
    const under = (prefix) => scope.filter((file) => file.startsWith(prefix));
    assert.equal(under("engine/crates/pixel-node/src/").length, 12);
    assert.equal(under("engine/packages/pixel-react/").length, 23);
    for (const file of Object.values(UNDIVERGED)) {
      assert.ok(scope.includes(file), `${file} is not in the derived scope`);
      assert.ok(
        !SURVEY.changed.includes(file),
        `${file} now differs; pick another undiverged path`,
      );
    }
  });
});

describe("the forty-three, still checked as such", () => {
  it("is what is left after the three replaceable modules", () => {
    assert.equal(EXPECTED_FILES.length, 46);
    for (const module of REPLACEABLE) {
      assert.ok(EXPECTED_FILES.includes(module), `${module} is not in the inventory`);
    }
    assert.equal(EXPECTED_FILES.length - REPLACEABLE.length, 43);
  });

  it("is inside the derived scope, every one of it", () => {
    // The inventory no longer decides what is checked, so this is the assertion that
    // keeps it honest: a derived universe covering *less* than the list it superseded
    // would be a regression wearing the clothes of an improvement.
    const scope = new Set(vendoredUniverse());
    for (const file of EXPECTED_FILES) {
      assert.ok(scope.has(`${PIXEL_CORE_SRC}/${file}`), `${file} is listed but out of scope`);
    }
  });

  it("leaves forty of the forty-three untouched", () => {
    const keep = EXPECTED_FILES.filter((file) => !REPLACEABLE.includes(file));
    const changed = keep.filter((file) => SURVEY.changed.includes(`${PIXEL_CORE_SRC}/${file}`));
    assert.deepEqual(changed.sort(), ["clipboard_image.rs", "engine/mod.rs", "lib.rs"]);
    assert.equal(keep.length - changed.length, 40, "the untouched count moved");
  });

  it("changed ghostty.rs and herdr.rs not at all — they are gated, not edited", () => {
    // "Drop one" is a `#[cfg(unix)]` in `lib.rs`, deliberately: the modules still
    // compile and still run their tests on unix, and a future host could revive
    // either without a diff to review.
    for (const file of ["ghostty.rs", "herdr.rs"]) {
      assert.ok(!SURVEY.changed.includes(`${PIXEL_CORE_SRC}/${file}`));
      assert.ok(!SURVEY.deleted.includes(`${PIXEL_CORE_SRC}/${file}`));
    }
  });

  it("keeps `engine/mod.rs`'s divergence to test code", () => {
    // The one file in the forty-three whose diff is not load-bearing. Pinned by
    // shape rather than by trust: production lines here would be a real finding.
    const diff = execFileSync(
      "git",
      ["diff", "-U0", BASELINE, "--", `${PIXEL_CORE_SRC}/engine/mod.rs`],
      { cwd: REPO, encoding: "utf8", timeout: GIT_TIMEOUT_MS },
    );
    const removed = diff
      .split("\n")
      .filter((line) => line.startsWith("-") && !line.startsWith("---"));
    assert.deepEqual(removed, [], "an existing line changed, not just an addition");
    assert.match(diff, /\+\s*#\[test\]/, "the addition is not a test");
  });
});

describe("the numbered divergences", () => {
  it("names a path UPSTREAM.md really mentions", () => {
    // The test says which files; the document says why, and is what a re-vendor
    // reads. Neither is useful if they drift apart. The unnumbered incidentals are
    // Task 4's to write up — `UNRECORDED_BUDGET` in `dispositions.mjs` pins how many
    // are still owed, so they cannot hide behind this `continue`.
    const upstream = fs.readFileSync(path.join(REPO, "docs", "design", "UPSTREAM.md"), "utf8");
    for (const [file, entry] of Object.entries(INCIDENTAL)) {
      if (entry.divergence === null) continue;
      assert.ok(
        upstream.includes(file),
        `UPSTREAM.md does not mention ${file}, which it numbers as divergence ${entry.divergence}`,
      );
    }
  });
});

describe("a simulated re-vendor going wrong", () => {
  // Driven through `guardVerdict` on a fabricated survey rather than by editing the
  // tree. The three failures below are exactly the ones the old scoping could not
  // produce, and reproducing them for real would mean a test writing to
  // `pixel-node/src` while the rest of the suite reads it.
  const SURFACE = "engine/crates/pixel-node/src/surface.rs";
  const clean = { changed: dispositionedPaths(), deleted: [] };

  it("passes on a survey that matches the table", () => {
    const verdict = guardVerdict(clean);
    assert.ok(verdict.ok, verdict.message);
  });

  it("fails an undeclared edit to `pixel-node/src/surface.rs`", () => {
    // The file the old guard was blind to, asked as it stood before anyone declared
    // it: the row is withheld, so the survey's edit arrives with nothing said about
    // it. Withholding the row is what makes this the real question — `surface.rs` is
    // dispositioned today precisely because this check now demands it.
    const withoutSurface = (file) => (file === SURFACE ? 0 : dispositionCount(file));
    const verdict = guardVerdict(clean, withoutSurface);
    assert.ok(!verdict.ok, "an undeclared edit under `pixel-node/src` passed");
    assert.match(verdict.message, /surface\.rs/, "the failure does not name the file");
    assert.match(verdict.message, /subject matter/);
    assert.match(verdict.message, /incidental divergence/);
    assert.match(verdict.message, /no fourth answer/);
    assert.ok(
      !verdict.expected.some((line) => line.startsWith(SURFACE)),
      "an undeclared path was listed as expected",
    );
  });

  it("fails an undeclared edit to a `pixel-node` file nothing has ever touched", () => {
    const verdict = guardVerdict({ changed: [...dispositionedPaths(), UNDIVERGED.pixelNode] });
    assert.ok(!verdict.ok);
    assert.match(verdict.message, /shm\.rs/);
    assert.match(
      verdict.message,
      /dispositions\.mjs/,
      "the failure does not say where to write it",
    );
  });

  it("fails an undeclared edit under `pixel-react`", () => {
    // A whole package with no baseline check at all until now: 23 vendored paths, of
    // which exactly one was known to differ and none was watched.
    const verdict = guardVerdict({ changed: [...dispositionedPaths(), UNDIVERGED.pixelReact] });
    assert.ok(!verdict.ok, "an edit under `pixel-react` passed");
    assert.match(verdict.message, /pixel-react\/src\/surface\.ts/);
    assert.match(verdict.message, /UPSTREAM\.md/);
  });

  it("fails a deletion, and says the file is gone rather than that it changed", () => {
    const changed = dispositionedPaths().filter((file) => file !== SURFACE);
    const verdict = guardVerdict({ changed, deleted: [SURFACE] });
    assert.ok(!verdict.ok, "a deleted vendored file passed");
    assert.match(verdict.message, /is not in the working tree/);
    assert.match(verdict.message, new RegExp(`git checkout ${BASELINE}`));
    assert.doesNotMatch(
      verdict.message,
      /no longer differs/,
      "a deleted file was also reported as a stale entry",
    );
  });

  it("fails a deletion of a file that never differed", () => {
    // The re-vendor this is really about: upstream drops a module, nobody edited it,
    // so there is no disposition to go stale and no diff to inspect. Scope alone has
    // to notice.
    const verdict = guardVerdict({
      changed: dispositionedPaths(),
      deleted: [UNDIVERGED.pixelReact],
    });
    assert.ok(!verdict.ok, "a dropped vendored file with no edits passed");
    assert.match(verdict.message, /pixel-react\/src\/surface\.ts was vendored by/);
  });

  it("fails an untracked file sitting in a vendored tree", () => {
    // The hole the derived scope could not close by itself, and the last of the four
    // ways a re-vendor goes wrong. `changed` and `deleted` are both questions about a
    // path `45b5e43` introduced; a new upstream module is not one, so it was invisible
    // to every check in this directory until the survey started asking git what it
    // does not track.
    const intruder = "engine/crates/pixel-node/src/backends/win32.rs";
    const verdict = guardVerdict({ changed: dispositionedPaths(), untracked: [intruder] });
    assert.ok(!verdict.ok, "an untracked file in a vendored tree passed");
    assert.match(verdict.message, /backends\/win32\.rs/, "the failure does not name the file");
    assert.match(verdict.message, /git does not track it/);
    assert.match(verdict.message, /\.gitignore/, "the failure does not offer the other answer");
    assert.ok(
      !verdict.expected.some((line) => line.startsWith(intruder)),
      "an untracked path was listed as expected",
    );
  });

  it("does not confuse an untracked file with a stale or deleted one", () => {
    // Three findings that all mean "a path and the tree disagree", reported under
    // three names. Collapsing any pair reads as one problem and sends the reader to
    // the wrong fix.
    const verdict = guardVerdict({
      changed: dispositionedPaths(),
      untracked: ["engine/packages/pixel-react/src/intruder.ts"],
    });
    assert.doesNotMatch(verdict.message, /no longer differs/);
    assert.doesNotMatch(verdict.message, /is not in the working tree/);
  });

  it("fails a path that two disposition tables both claim", () => {
    // The failure with no symptom, and the one the guard used to pass. `unclassified`
    // only ever tested `count === 0` and the roster filter only kept `count === 1`, so
    // a path in both SUBJECT and INCIDENTAL was reported by nothing *and* dropped out
    // of `expected` — the guard's whole product quietly one line short. The tables
    // disagree about substance too: one says a plan task owns the edit, the other says
    // a re-vendorer re-applies it by hand.
    const doubled = (file) => (file === SURFACE ? 2 : dispositionCount(file));
    const verdict = guardVerdict({ changed: dispositionedPaths() }, doubled);
    assert.ok(!verdict.ok, "a path claimed by two tables passed the guard");
    assert.match(verdict.message, /surface\.rs is claimed by more than one disposition table/);
    assert.match(verdict.message, /Delete the rows that are wrong/);
    assert.ok(
      !verdict.expected.some((line) => line.startsWith(SURFACE)),
      "a conflicted path is still described as though one table owned it",
    );
    assert.doesNotMatch(
      verdict.message,
      /has no disposition/,
      "a doubly-claimed path was also reported as unclassified",
    );
  });

  it("fails an entry whose file no longer differs", () => {
    const changed = dispositionedPaths().filter((file) => file !== SURFACE);
    const verdict = guardVerdict({ changed, deleted: [] });
    assert.ok(!verdict.ok, "a stale disposition passed");
    assert.match(verdict.message, /no longer differs/);
    assert.match(verdict.message, /re-key it at the new path/);
  });
});

describe("the named-reason roster", () => {
  it("says what a subject-matter path is and which task owns it", () => {
    const line = describeDisposition("engine/crates/pixel-core/src/terminal.rs");
    assert.match(line, /^engine\/crates\/pixel-core\/src\/terminal\.rs — subject matter/);
    assert.match(line, /20260821-windows-port/);
  });

  it("says which UPSTREAM.md divergence an incidental path is", () => {
    const line = describeDisposition("engine/crates/pixel-node/src/lib.rs");
    assert.match(line, /incidental divergence, divergence 5 in UPSTREAM\.md/);
  });

  it("says so when an incidental path has no number yet", () => {
    // Fabricated, because no real path is in this state any more: Task 4 of the
    // vendor-check-gap plan numbered the last six and `UNRECORDED_BUDGET` is 0. The
    // branch stays and is tested because the next undocumented divergence is precisely
    // when this line gets read, and the one thing it must not do is describe an
    // unnumbered edit as though a re-vendorer could look it up.
    const line = describeDisposition("engine/crates/pixel-node/src/somewhere-new.rs", {
      kind: "incidental",
      divergence: null,
      reason: "an incidental edit nobody has written up yet",
    });
    assert.match(line, /not yet numbered in UPSTREAM\.md/);
  });

  it("says an excluded path is not vendored, and gives the declared reason", () => {
    // The fourth roster shape, and the only one nothing exercised. `EXCLUSIONS` paths
    // are out of the universe by construction so a real survey never carries one, but
    // `dispositionOf` still answers `"excluded"` for them and this is what it prints.
    const line = describeDisposition("package.json");
    assert.match(line, /^package\.json — not vendored: /);
    assert.ok(line.includes(EXCLUSIONS["package.json"]), "the declared reason is not in the line");
  });

  it("refuses an unrecognised kind rather than calling it not vendored", () => {
    // "not vendored" used to be the fall-through, which made it the answer for
    // anything unrecognised — the most reassuring sentence this function has, printed
    // by default. A fourth kind is a change to the function, not to its default.
    assert.throws(
      () => describeDisposition("engine/x.rs", { kind: "provisional", reason: "who knows" }),
      /none of subject, incidental or excluded/,
    );
  });

  it("refuses a verdict that is not one, rather than printing a plausible lie", () => {
    // How this was found: `guardVerdict` built its roster with
    // `.map(describeDisposition)`, `map` handed the index to the injectable second
    // argument, and every line came out "— not vendored: undefined". It parsed, it
    // read like prose, and it was wrong about all 44 paths.
    assert.throws(() => describeDisposition("engine/x.rs", 1), /hands it the array index/);
    assert.throws(() => describeDisposition("engine/x.rs", null), /Pass a dispositionOf/);
  });

  it("names a divergence number for every incidental path the table holds", () => {
    // The other half, against the real table: what the roster prints for a diverged
    // vendored file is now always something a re-vendorer can act on.
    for (const file of Object.keys(INCIDENTAL)) {
      assert.match(
        describeDisposition(file),
        /incidental divergence, divergence \d+ in UPSTREAM\.md/,
        `${file}'s roster line does not point at a numbered entry`,
      );
    }
  });
});
