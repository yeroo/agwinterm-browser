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

import {
  DIVERGENCES,
  INCIDENTAL,
  ROSTER_HEADING,
  deletedMessage,
  divergenceEvidenceHolds,
  readRepoFile,
  staleMessage,
  unclassifiedMessage,
  untrackedMessage,
} from "./dispositions.mjs";
import { BASELINE, surveyVendored, vendoredUniverse, vendoringCommitPaths } from "./universe.mjs";

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
  // Lazy, and called from inside each test, for the reason `native-build.test.mjs`
  // spells out: `numberedEntries` reaches `divergenceSection`, which *asserts* the
  // heading is there, and a throw from a `describe` callback prints `not ok` while
  // counting as neither pass nor fail -- `node --test` still exits 0 (v22.19.0). At
  // describe-time a renamed heading would silently drop every test in this suite and
  // leave the run green, which is the same silent pass the branch exists to remove.
  // Inside a test, a throw is a failure the runner's exit code knows about.
  const entries = () => numberedEntries();

  it("numbers its entries 1..N with no gaps and no repeats", () => {
    const list = entries();
    const numbers = list.map((entry) => entry.number);
    // Before the comparison, because `deepEqual([], [])` passes: a change to the
    // `N. **\`path\`` convention would make `numberedEntries` parse nothing and leave
    // this test green on a list it could no longer read at all.
    assert.ok(list.length > 0, `${DOC}'s numbered entries no longer parse`);
    assert.deepEqual(
      numbers,
      numbers.map((_, index) => index + 1),
      `${DOC} numbers its divergences ${numbers.join(", ")}. INCIDENTAL cites these by ` +
        `number, so a gap or a repeat is a broken reference, not a typo.`,
    );
  });

  it("has exactly the entries DIVERGENCES claims, at the same numbers", () => {
    assert.deepEqual(
      entries(),
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
    for (const { number, path: file } of entries()) {
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
    for (const { number, path: file } of entries()) {
      // Named rather than dereferenced twice, because the drift this file exists to
      // catch — a numbered entry in the document with no row in the table — would
      // otherwise land here as `Cannot read properties of undefined`, in a suite whose
      // whole product is a failure that names the path and the fix.
      const entry = DIVERGENCES[number];
      assert.ok(
        entry,
        `${DOC} numbers divergence ${number} (${file}) and DIVERGENCES in ` +
          `tools/vendor-check/dispositions.mjs has no such entry. Add the row or drop ` +
          `the entry — a number the table cannot resolve is a reference to nothing.`,
      );
      if (entry.appliedIn === "port") {
        assert.ok(
          SURVEY.changed.includes(file),
          `divergence ${number} says ${file} was edited, and it does not differ from ` +
            `the baseline. Either the edit was reverted — delete the entry — or it was ` +
            `never made, in which case the entry has been describing nothing.`,
        );
      } else {
        assert.ok(
          divergenceEvidenceHolds(number),
          `divergence ${number} claims ${entry.what} of ${file}, and the ` +
            `file does not show it`,
        );
      }
    }
  });

  it("gives every incidental divergence in the table a numbered entry", () => {
    const documented = new Set(entries().map((entry) => entry.path));
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
    const documented = new Set(entries().map((entry) => entry.path));
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
  // Lazy for the reason the divergence-list suite above gives.
  const section = () => divergenceSection();

  it("no longer claims the list makes the untouched files checkable", () => {
    // The exact sentence that stood here until 2026-08-26. It was false: the guard
    // covered `pixel-core/src` and the list covered six of the twelve edits outside
    // the port's subject matter. Pinned by its own words so it cannot be restored by
    // someone copying an old revision forward.
    assert.ok(
      !section().includes('the claim "the other\n43 files are untouched" stays checkable'),
      `${DOC} has the retired exhaustiveness claim back. What is checked is derived ` +
        `from the vendoring commit, not from this list — say that instead.`,
    );
    assert.ok(
      !/Each is asserted by a test in `tools\/vendor-check\/`/.test(section()),
      `${DOC} claims every divergence is asserted by a test. That was true of two of ` +
        `six when it was written; if it is true now, say what makes it true.`,
    );
  });

  it("says where the scope comes from, so the list is not read as the boundary", () => {
    // Prose, so held to the facts a reader needs and not to wording: the baseline
    // commit, that git decides the scope, and the three vendored trees.
    const text = section();
    assert.match(text, /45b5e43/, "the preamble does not name the vendoring commit");
    assert.match(text, /git show --name-only/, "the preamble does not say git decides the scope");
    for (const tree of ["pixel-core", "pixel-node", "pixel-react"]) {
      assert.match(text, new RegExp(tree), `the preamble does not name ${tree} as guarded`);
    }
  });

  it("says a deleted vendored file fails, which is the failure a diff cannot see", () => {
    assert.match(section(), /\*deleted\* fails/);
  });
});

/**
 * The checklist section: everything from its heading to the end of the file.
 *
 * It is the part of this document that is *used* rather than read — someone works down
 * it with upstream freshly copied over the tree — so the things it can get wrong are
 * operational, not editorial. It can quote a failure the suite cannot produce, name a
 * script that does not exist, or state a count that has moved. All three read as a
 * correct checklist right up until someone follows it.
 */
function checklistSection(text = readRepoFile(DOC).replace(/\r\n/g, "\n")) {
  const start = text.indexOf("## Re-vendoring checklist");
  assert.notEqual(start, -1, `${DOC} has no re-vendoring checklist`);
  return text.slice(start);
}

/** `*…quoted failure text*`, as the checklist's failure table writes it. */
function quotedFailures(section = checklistSection()) {
  return [...section.matchAll(/\*…([^*]+)\*/g)].map((match) => match[1].trim());
}

describe("the re-vendoring checklist", () => {
  // Lazy for the reason the divergence-list suite above gives: `checklistSection`
  // asserts its heading exists, and at describe-time that throw would take all three
  // tests below out of the run without failing it.
  const section = () => checklistSection();

  it("quotes failure text the guard can really produce", () => {
    // The table tells a re-vendorer to match what the suite printed against a row. A
    // quote that no message builder produces sends them looking for a row that will
    // never appear — and it fails silently, because the checklist is only read while
    // something is already broken. Every quote is held to the real message text.
    const real = [
      deletedMessage("PATH"),
      unclassifiedMessage("PATH"),
      untrackedMessage("PATH"),
      staleMessage("PATH"),
    ]
      .join("\n")
      .replace(/\s+/g, " ");

    const quotes = quotedFailures(section());
    assert.ok(quotes.length >= 4, "the failure table has lost its quoted messages");
    for (const quote of quotes) {
      const needle = quote.replace(/`/g, "").replace(/\s+/g, " ").trim();
      // `includes("")` is true, so a row whose emphasis markers ended up empty would
      // pass this loop while quoting nothing. Length first, match second.
      assert.ok(needle.length > 15, `the checklist has a quoted row with no message in it`);
      assert.ok(
        real.includes(needle),
        `the checklist quotes "…${quote}" and nothing in dispositions.mjs says it. A ` +
          `row nobody can match is worse than no row: it is read while something is ` +
          `already wrong.`,
      );
    }
  });

  it("quotes the roster heading the guard really prints over the re-apply list", () => {
    // The other half of "match what the suite printed against a row": this row does not
    // quote a failure, it tells the reader that the whole re-apply list is in the same
    // output and names the line it sits under. It said so while `expected` was returned
    // in a field and printed nowhere, so the row was true of the code's intent and
    // false of its output. Held to the exported heading, not to a paraphrase.
    const quoted = section().match(/roster printed under "([^"]+)"/);
    assert.ok(quoted, `the checklist no longer says where the re-apply list is printed`);
    assert.ok(
      ROSTER_HEADING.includes(quoted[1]),
      `the checklist sends a re-vendorer to "${quoted[1]}" and the guard prints ` +
        `"${ROSTER_HEADING}". A row nobody can match is worse than no row.`,
    );
  });

  it("names scripts that exist, in the packages that define them", () => {
    // Step 5 exists because `native-build.test.mjs` stopped skipping: a re-vendor makes
    // every source file newer than the last build, so an unbuilt artifact now fails.
    // A checklist that names the wrong command there hands the reader a failure with no
    // way out of it.
    for (const [manifest, script] of [
      ["package.json", "test"],
      ["engine/packages/pixel-react/package.json", "build:native"],
    ]) {
      assert.ok(
        section().includes(script),
        `the checklist does not tell a re-vendorer to run ${script}`,
      );
      assert.ok(
        JSON.parse(readRepoFile(manifest)).scripts?.[script],
        `the checklist names \`${script}\` and ${manifest} does not define it`,
      );
    }
  });

  it("names the files a re-vendorer has to edit, and they are there", () => {
    for (const file of [
      "tools/vendor-check/dispositions.mjs",
      "tools/vendor-check/universe.mjs",
    ]) {
      assert.ok(section().includes(file), `the checklist does not name ${file}`);
      assert.doesNotThrow(
        () => readRepoFile(file),
        `the checklist sends a re-vendorer to ${file}, which is not there`,
      );
    }
  });
});

describe("what the docs claim the guard covers", () => {
  // Two documents state the size of the vendored universe in prose — the preamble here
  // and the Tests section of the README. Both are the kind of number that is right when
  // written and wrong after the next vendoring commit, and a stale one overstates
  // coverage in exactly the direction this plan existed to correct.
  // Lazy for the reason the divergence-list suite above gives -- doubly so here,
  // because `vendoredUniverse` calls `assertExclusionsAreReal`, and a stale exclusion
  // is exactly the condition that check exists to shout about. At describe-time it
  // would silence both tests below instead of failing the run.
  const counts = () => ({
    commit: vendoringCommitPaths().length,
    universe: vendoredUniverse().length,
  });

  it("states the path count the vendoring commit really has", () => {
    // Anchored on the sentence each document actually makes the claim in, the way the
    // `remaining (\d+)` check below is. A bare /(\d+) paths/ swept the whole file, so
    // any future correct sentence — "the 12 paths under `pixel-node/src`" — would fail
    // a vendoring-commit assertion, and a test that fails on unrelated true prose is
    // one that gets edited rather than obeyed.
    const commit = counts().commit;
    for (const [doc, claim] of [
      [DOC, /introduced (\d+) paths/],
      ["README.md", /the (\d+) paths `45b5e43`/],
    ]) {
      const text = readRepoFile(doc).replace(/\r\n/g, "\n");
      const match = text.match(claim);
      assert.ok(match, `${doc} no longer says how many paths ${BASELINE} put in scope`);
      assert.equal(
        Number(match[1]),
        commit,
        `${doc} says ${match[1]} paths where ${BASELINE} introduced ${commit}. ` +
          `A count written once and never re-derived is how a coverage claim goes ` +
          `stale without anyone editing it.`,
      );
    }
  });

  it("states the guarded count left after the declared exclusions", () => {
    const universe = counts().universe;
    const text = readRepoFile(DOC).replace(/\r\n/g, "\n");
    const match = text.match(/remaining (\d+)/);
    assert.ok(match, `${DOC} no longer says how many paths are left after EXCLUSIONS`);
    assert.equal(
      Number(match[1]),
      universe,
      `${DOC} says ${match[1]} guarded paths and vendoredUniverse() has ${universe}`,
    );
  });
});
