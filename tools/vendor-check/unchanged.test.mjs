// "Split one module, port one, drop one, keep forty-three" — checked rather than
// asserted.
//
// The plan's whole shape rests on the last clause. Keeping forty-three files
// untouched is what makes the browser chrome free, what makes re-vendoring cheap,
// and what `inventory.test.mjs` screens the *inputs* of. This file checks the
// output: every one of `pixel-core`'s 46 vendored source files, diffed against the
// commit that vendored them, with a named reason for each one that differs.
//
// The list of expected diffs is deliberately exhaustive and deliberately small. A
// new entry is not a test failure to be silenced — it is a file the port promised
// not to touch, and adding it here means writing down why, in
// `docs/design/UPSTREAM.md`, where a re-vendor will find it.
//
// Task 4 predicted this list would grow, and it did: `clipboard_image.rs` uses no
// unix API (so the inventory screen cleared it) and still assumed unix *paths*.
// "No unix API" is not "portable", and this is the check that can see the
// difference.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

/**
 * The commit that vendored upstream, before a line of the port was written.
 *
 * A tag would be nicer, but `docs/design/UPSTREAM.md` explains why there is no
 * upstream revision to name either: the reference checkout carries no VCS metadata.
 * This tree's own first commit is the only fixed point there is.
 */
const BASELINE = "45b5e43";

const EXPECTED_FILES = JSON.parse(
  fs.readFileSync(path.join(HERE, "pixel-core-files.json"), "utf8"),
);

const SRC = "engine/crates/pixel-core/src";

/** The three modules the port replaces. Everything else is the forty-three. */
const REPLACEABLE = ["ghostty.rs", "herdr.rs", "terminal.rs"];

/**
 * Keep-unchanged files that nonetheless differ, and why.
 *
 * Each reason is a claim someone can check, not a label. `lib.rs` was expected from
 * the start (it is where modules are declared, so gating any of them lands here);
 * the other two were found by running the vendored tests on Windows.
 */
const EXPECTED_DIFFS = {
  "lib.rs":
    "module declarations only: the port's six new modules, the `#[cfg]` gates on " +
    "ghostty/herdr, and the `TerminalBackend` re-export. Tasks 3-7.",
  "clipboard_image.rs":
    "divergence 4 in UPSTREAM.md: three POSIX path assumptions widened behind " +
    "`cfg!(windows)`. Found by its own vendored tests failing, not by reading it.",
  "engine/mod.rs":
    "divergence 6 in UPSTREAM.md: one added `#[test]`. No production line changed.",
};

function changedSince(file) {
  const result = execFileSync(
    "git",
    ["diff", "--numstat", BASELINE, "HEAD", "--", `${SRC}/${file}`],
    { cwd: REPO, encoding: "utf8" },
  ).trim();
  if (!result) return null;
  const [added, removed] = result.split(/\s+/, 2).map(Number);
  return { added, removed };
}

describe("the forty-three", () => {
  it("is what is left after the three replaceable modules", () => {
    assert.equal(EXPECTED_FILES.length, 46);
    for (const module of REPLACEABLE) {
      assert.ok(EXPECTED_FILES.includes(module), `${module} is not in the inventory`);
    }
    assert.equal(EXPECTED_FILES.length - REPLACEABLE.length, 43);
  });

  it("has a baseline commit to diff against", () => {
    const subject = execFileSync("git", ["log", "-1", "--format=%s", BASELINE], {
      cwd: REPO,
      encoding: "utf8",
    }).trim();
    assert.match(subject, /vendor upstream/i, `${BASELINE} is not the vendoring commit`);
  });

  it("differs from the vendored baseline in exactly the files with a written reason", () => {
    const keep = EXPECTED_FILES.filter((file) => !REPLACEABLE.includes(file));
    const changed = keep.filter((file) => changedSince(file) !== null);
    assert.deepEqual(
      changed.sort(),
      Object.keys(EXPECTED_DIFFS).sort(),
      "a keep-unchanged file changed without a reason recorded here (or a recorded " +
        "one is no longer changed)",
    );
    assert.equal(keep.length - changed.length, 40, "the untouched count moved");
  });

  it("changed ghostty.rs and herdr.rs not at all — they are gated, not edited", () => {
    // "Drop one" is a `#[cfg(unix)]` in `lib.rs`, deliberately: the modules still
    // compile and still run their tests on unix, and a future host could revive
    // either without a diff to review.
    assert.equal(changedSince("ghostty.rs"), null);
    assert.equal(changedSince("herdr.rs"), null);
  });

  it("keeps `engine/mod.rs`'s divergence to test code", () => {
    // The one file in the forty-three whose diff is not load-bearing. Pinned by
    // shape rather than by trust: production lines here would be a real finding.
    const diff = execFileSync(
      "git",
      ["diff", "-U0", BASELINE, "HEAD", "--", `${SRC}/engine/mod.rs`],
      { cwd: REPO, encoding: "utf8" },
    );
    const removed = diff
      .split("\n")
      .filter((line) => line.startsWith("-") && !line.startsWith("---"));
    assert.deepEqual(removed, [], "an existing line changed, not just an addition");
    assert.match(diff, /\+\s*#\[test\]/, "the addition is not a test");
  });

  it("records every keep-unchanged divergence in UPSTREAM.md", () => {
    // The test says which files; the document says why, and is what a re-vendor
    // reads. Neither is useful if they drift apart.
    const upstream = fs.readFileSync(path.join(REPO, "docs", "design", "UPSTREAM.md"), "utf8");
    for (const file of Object.keys(EXPECTED_DIFFS)) {
      if (file === "lib.rs") continue; // named as excluded there: replacing it is the port
      assert.ok(
        upstream.includes(`${SRC}/${file}`),
        `UPSTREAM.md does not mention ${file}, which differs from the baseline`,
      );
    }
  });
});
