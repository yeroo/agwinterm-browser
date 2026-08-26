// `docs/design/UPSTREAM.md`, checked against the tree it describes.
//
// The divergence list is a re-vendor instruction sheet: someone copies upstream over
// this tree and works down it, re-applying edits by hand. That makes it the one
// document here whose *wrongness is silent* — a missing entry, a stale entry or an
// entry whose scope understates the diff all read exactly like a correct one, and the
// failure arrives weeks later as behaviour nobody can account for.
//
// It had all three problems. Divergence 5 described `pixel-node/src/lib.rs` as "one
// line" against a 237-insertion diff, so following the checklist restored the constant
// and dropped the `SurfaceSink` trait. Six other incidental divergences had no entry
// at all. And the preamble claimed each divergence "is asserted by a test in
// `tools/vendor-check/`" when the guard was scoped to one of three vendored trees.
//
// So the document is parsed and held to the table rather than trusted. Three things
// are checked, and the third is the one that was missing:
//
//   - the numbering is contiguous, because `INCIDENTAL` cites it by number
//   - every numbered entry names the path `DIVERGENCES` says it does
//   - every numbered entry describes an edit that is really there — a diff against the
//     baseline for the ones the port applied, matching content for the three the
//     vendoring commit applied, which have no diff to show
//
// What is deliberately *not* checked is the prose. A test that pinned wording would
// fail on every improvement and teach people to edit the test. The one exception is
// the retired exhaustiveness claim, pinned by its exact old sentence: that specific
// sentence was false, and it should not come back by being copied forward.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DIVERGENCES, INCIDENTAL, divergenceEvidenceHolds, readRepoFile } from "./dispositions.mjs";
import { BASELINE, surveyVendored, vendoringCommitPaths } from "./universe.mjs";

const DOC = "docs/design/UPSTREAM.md";
const SURVEY = surveyVendored();

/**
 * The divergence section only: the numbered list stops at the next `##` heading.
 *
 * Line endings are normalised first. `core.autocrlf` is on in this repo, so the file
 * arrives CRLF in a Windows working tree and LF in a POSIX one — a check that read
 * either literally would be vacuously green on the other platform, which is the
 * quietest way for a documentation test to stop testing anything.
 */
function divergenceSection(text = readRepoFile(DOC).replace(/\r\n/g, "\n")) {
  const start = text.indexOf("## Intentional divergences from upstream");
  assert.notEqual(start, -1, `${DOC} has no divergence section`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? text.length : end);
}

/**
 * The numbered entries, as `{ number, path }`.
 *
 * An entry's first backticked token is its subject by convention — every entry is
 * written `N. **\`path\` — what changed**` — and that convention is what makes the
 * document machine-checkable at all. An entry that breaks it parses as a different
 * path and fails the next assertion, which is the right outcome: a divergence whose
 * subject cannot be read is one nobody can re-apply.
 */
function numberedEntries(section = divergenceSection()) {
  return [...section.matchAll(/^(\d+)\. \*\*`([^`]+)`/gm)].map((match) => ({
    number: Number(match[1]),
    path: match[2],
  }));
}

describe("the UPSTREAM.md divergence list", () => {
  const entries = numberedEntries();

  it("numbers its entries 1..N with no gaps and no repeats", () => {
    const numbers = entries.map((entry) => entry.number);
    assert.deepEqual(
      numbers,
      numbers.map((_, index) => index + 1),
      `${DOC} numbers its divergences ${numbers.join(", ")}. INCIDENTAL cites these by ` +
        `number, so a gap or a repeat is a broken reference, not a typo.`,
    );
  });

  it("has exactly the entries DIVERGENCES claims, at the same numbers", () => {
    assert.deepEqual(
      entries,
      Object.entries(DIVERGENCES).map(([number, entry]) => ({
        number: Number(number),
        path: entry.path,
      })),
      `${DOC} and DIVERGENCES in tools/vendor-check/dispositions.mjs disagree about ` +
        `what is numbered what. The document is what a re-vendorer reads; the table is ` +
        `what the suite checks. They are only worth anything together.`,
    );
  });

  it("names a path the vendoring commit really introduced", () => {
    // Against the commit's whole path set rather than against `vendoredUniverse()`,
    // which drops the four declared exclusions. Divergence 3 is about the root
    // `package.json` — an excluded path, because this repo owns that file — and it is
    // still a real divergence a re-vendorer re-applies. Exclusion decides whether a
    // path needs a *diff* explained, not whether it can carry an instruction.
    const vendored = new Set(vendoringCommitPaths());
    for (const { number, path: file } of entries) {
      assert.ok(
        vendored.has(file),
        `divergence ${number} is about ${file}, which ${BASELINE} never introduced. ` +
          `Either the path is misspelled or the file was never vendored, and in both ` +
          `cases the entry tells a re-vendorer to edit something that is not there.`,
      );
    }
  });

  it("describes an edit that is really in the tree", () => {
    // The two halves of "really there" are different questions. An edit the *port*
    // applied shows up as a diff against the baseline. An edit the *vendoring commit*
    // applied cannot — it is the baseline — so the only honest check is the content.
    for (const { number, path: file } of entries) {
      if (DIVERGENCES[number].appliedIn === "port") {
        assert.ok(
          SURVEY.changed.includes(file),
          `divergence ${number} says ${file} was edited, and it does not differ from ` +
            `the baseline. Either the edit was reverted — delete the entry — or it was ` +
            `never made, in which case the entry has been describing nothing.`,
        );
      } else {
        assert.ok(
          divergenceEvidenceHolds(number),
          `divergence ${number} claims ${DIVERGENCES[number].what} of ${file}, and the ` +
            `file does not show it`,
        );
      }
    }
  });

  it("gives every incidental divergence in the table a numbered entry", () => {
    const documented = new Set(entries.map((entry) => entry.path));
    const missing = Object.keys(INCIDENTAL).filter((file) => !documented.has(file));
    assert.deepEqual(
      missing,
      [],
      `${missing.length} incidental divergence(s) are in dispositions.mjs and not in ` +
        `${DOC}: ${missing.join(", ")}. The table makes the suite pass; the document ` +
        `is what makes the edit survive a re-vendor.`,
    );
  });

  it("covers pixel-node, pixel-react and the manifests — the trees that had no guard", () => {
    // The specific gap this document was wrong about. Not a restatement of the entry
    // list: these five paths are why the plan exists, and an entry for each is the
    // deliverable. `Cargo.lock` is left out on purpose — it is cargo's output, and
    // pinning it here would make a lockfile refresh look like a lost divergence.
    const documented = new Set(entries.map((entry) => entry.path));
    for (const file of [
      "engine/crates/pixel-node/src/capture.rs",
      "engine/crates/pixel-node/src/surface.rs",
      "engine/packages/pixel-react/scripts/build-native.mjs",
      "engine/Cargo.toml",
      "engine/crates/pixel-core/Cargo.toml",
    ]) {
      assert.ok(documented.has(file), `${file} is an unguarded-tree edit with no entry`);
    }
  });
});

describe("the divergence-list preamble", () => {
  const section = divergenceSection();

  it("no longer claims the list makes the untouched files checkable", () => {
    // The exact sentence that stood here until 2026-08-26. It was false: the guard
    // covered `pixel-core/src` and the list covered six of the twelve edits outside
    // the port's subject matter. Pinned by its own words so it cannot be restored by
    // someone copying an old revision forward.
    assert.ok(
      !section.includes('the claim "the other\n43 files are untouched" stays checkable'),
      `${DOC} has the retired exhaustiveness claim back. What is checked is derived ` +
        `from the vendoring commit, not from this list — say that instead.`,
    );
    assert.ok(
      !/Each is asserted by a test in `tools\/vendor-check\/`/.test(section),
      `${DOC} claims every divergence is asserted by a test. That was true of two of ` +
        `six when it was written; if it is true now, say what makes it true.`,
    );
  });

  it("says where the scope comes from, so the list is not read as the boundary", () => {
    // Prose, so held to the facts a reader needs and not to wording: the baseline
    // commit, that git decides the scope, and the three vendored trees.
    assert.match(section, /45b5e43/, "the preamble does not name the vendoring commit");
    assert.match(section, /git show --name-only/, "the preamble does not say git decides the scope");
    for (const tree of ["pixel-core", "pixel-node", "pixel-react"]) {
      assert.match(section, new RegExp(tree), `the preamble does not name ${tree} as guarded`);
    }
  });

  it("says a deleted vendored file fails, which is the failure a diff cannot see", () => {
    assert.match(section, /\*deleted\* fails/);
  });
});
