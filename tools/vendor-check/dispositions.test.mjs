// The disposition table, checked against the survey it is answerable for.
//
// Two failures are possible here and they are opposite. The table can cover less
// than the tree does — a vendored file changed and nobody said why — which is the
// hole this whole plan exists to close. Or it can cover more: an entry for a path
// that no longer differs, which reads as a considered decision about a live edit
// while describing nothing. The second is the quieter one, and it is how a table
// starts lying: a stale row keeps its authority long after its subject is gone.
//
// So both directions are asserted, and the counts are pinned rather than derived
// from the table itself. `44 changed, 44 dispositioned, 35 subject, 9 incidental`
// moving is a real event and should be read, not re-baselined.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DIVERGENCES,
  INCIDENTAL,
  SUBJECT,
  UNRECORDED_BUDGET,
  auditDispositions,
  dispositionCount,
  dispositionOf,
  dispositionedPaths,
  divergenceEvidenceHolds,
  unclassifiedMessage,
} from "./dispositions.mjs";
import { EXCLUSIONS, surveyVendored } from "./universe.mjs";

const SURVEY = surveyVendored();

describe("the disposition table", () => {
  it("gives every changed vendored path exactly one disposition", () => {
    const { unclassified } = auditDispositions(SURVEY);
    assert.deepEqual(
      unclassified,
      [],
      `${unclassified.length} vendored path(s) differ with nothing said about them:\n` +
        unclassified.map(unclassifiedMessage).join("\n\n"),
    );
    for (const file of SURVEY.changed) {
      assert.equal(dispositionCount(file), 1, `${file} is claimed by more than one table`);
    }
  });

  it("holds no entry for a path that no longer differs", () => {
    const { stale } = auditDispositions(SURVEY);
    assert.deepEqual(
      stale,
      [],
      "a disposition describes an edit that is not in the tree: either the file was " +
        "reverted (delete the entry) or it moved (re-key it at the new path)",
    );
  });

  it("covers the 44 divergences with 35 subject-matter and 9 incidental entries", () => {
    assert.equal(SURVEY.changed.length, 44, `${SURVEY.changed.length} vendored paths differ, not 44`);
    assert.equal(Object.keys(SUBJECT).length, 35);
    assert.equal(Object.keys(INCIDENTAL).length, 9);
    assert.equal(dispositionedPaths().length, 44);
    assert.deepEqual(dispositionedPaths(), [...SURVEY.changed].sort());
  });

  it("keeps the three tables disjoint", () => {
    // Two dispositions for one path is not a redundancy, it is a disagreement: one
    // says a task owns the edit, the other says a re-vendorer must re-apply it.
    for (const file of dispositionedPaths()) {
      assert.equal(dispositionCount(file), 1, `${file} appears in more than one table`);
    }
    for (const file of Object.keys(EXCLUSIONS)) {
      assert.equal(dispositionCount(file), 1, `${file} is excluded and also dispositioned`);
    }
  });
});

describe("a subject-matter entry", () => {
  it("names the plan task that owns it", () => {
    for (const [file, entry] of Object.entries(SUBJECT)) {
      assert.match(
        entry.task,
        /^2026\d{4}-[a-z-]+ Tasks? [\d-]+( and \d+)?$/,
        `${file}'s owner is not a plan task`,
      );
    }
  });

  it("says what the edit does, at a length someone can disagree with", () => {
    for (const [file, entry] of Object.entries(SUBJECT)) {
      assert.ok(entry.reason.length > 40, `${file}'s reason is a label, not an argument`);
    }
  });

  it("is not in the divergence list, because the port's own work is not a divergence", () => {
    // `UPSTREAM.md` is explicit that its numbered list is for edits that are *not*
    // the port's subject matter. A subject-matter file appearing there would tell a
    // re-vendorer to re-apply the port by hand.
    const recorded = new Set(Object.values(DIVERGENCES).map((entry) => entry.path));
    for (const file of Object.keys(SUBJECT)) {
      assert.ok(!recorded.has(file), `${file} is subject matter and also a numbered divergence`);
    }
  });
});

describe("an incidental entry", () => {
  it("carries an UPSTREAM.md number — the budget for entries with none is 0", () => {
    // Was 6 while `UPSTREAM.md` was behind this table. Task 4 of the vendor-check-gap
    // plan wrote those six up as divergences 7-12, so the budget is spent: an
    // incidental edit with no number is a re-vendor instruction nobody wrote down.
    assert.equal(UNRECORDED_BUDGET, 0, "the unrecorded budget does not go back up");
    const unrecorded = Object.entries(INCIDENTAL)
      .filter(([, entry]) => entry.divergence === null)
      .map(([file]) => file);
    assert.equal(
      unrecorded.length,
      UNRECORDED_BUDGET,
      `${unrecorded.length} incidental divergences have no UPSTREAM.md entry, not ` +
        `${UNRECORDED_BUDGET}: ${unrecorded.join(", ")}. Number it in ` +
        `docs/design/UPSTREAM.md and cite the number here — that list is what a ` +
        `re-vendor re-applies by hand, and an entry missing from it is an edit that ` +
        `comes back only if somebody happens to remember it.`,
    );
  });

  it("is matched one-for-one by a port-applied divergence in UPSTREAM.md", () => {
    // Both directions, because they fail differently. An incidental path with no
    // numbered entry is an edit a re-vendorer never re-applies. A numbered entry with
    // no incidental path is a re-vendor instruction for an edit that is not there —
    // and if it is `appliedIn: "port"` it should have shown up in the survey, so its
    // absence means the edit was reverted or the file moved.
    const portApplied = Object.entries(DIVERGENCES)
      .filter(([, entry]) => entry.appliedIn === "port")
      .map(([, entry]) => entry.path)
      .sort();
    assert.deepEqual(
      portApplied,
      Object.keys(INCIDENTAL).sort(),
      "the numbered divergences the port applied and the incidental table must be the " +
        "same set of paths",
    );
  });

  it("agrees with the divergence it cites", () => {
    for (const [file, entry] of Object.entries(INCIDENTAL)) {
      if (entry.divergence === null) continue;
      const recorded = DIVERGENCES[entry.divergence];
      assert.ok(recorded, `${file} cites divergence ${entry.divergence}, which does not exist`);
      assert.equal(
        recorded.path,
        file,
        `${file} cites divergence ${entry.divergence}, which is about ${recorded.path}`,
      );
    }
  });

  it("says what the edit does", () => {
    for (const [file, entry] of Object.entries(INCIDENTAL)) {
      assert.ok(entry.reason.length > 40, `${file}'s reason is a label, not an argument`);
    }
  });
});

describe("the twelve divergences UPSTREAM.md numbers", () => {
  it("is twelve, numbered 1 through 12 with no gaps", () => {
    // Six until Task 4 of the vendor-check-gap plan. The numbers are the addressing
    // scheme `INCIDENTAL` cites and a re-vendorer works down, so a gap or a renumber
    // is a broken reference rather than a cosmetic change.
    assert.deepEqual(
      Object.keys(DIVERGENCES),
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"],
    );
  });

  it("gives every entry a path, a shape and a way of being checked", () => {
    // `SUBJECT` and `INCIDENTAL` have per-entry shape tests above and this table had
    // none, which matters because `appliedIn` is a two-value enum that decides which
    // check runs. A typo — `appliedIn: "vendoring"` — falls into the *port* branch and
    // dies inside `divergenceEvidenceHolds` saying the edit "is applied by the port",
    // the opposite of the truth; a `vendoring-commit` entry with no `evidence` dies
    // reading `.test` of undefined. Both are the entry being wrong, reported as
    // something else.
    for (const [number, entry] of Object.entries(DIVERGENCES)) {
      assert.equal(typeof entry.path, "string", `divergence ${number} has no path`);
      assert.ok(entry.path.length > 0, `divergence ${number}'s path is empty`);
      assert.ok(
        ["port", "vendoring-commit"].includes(entry.appliedIn),
        `divergence ${number} is appliedIn ${JSON.stringify(entry.appliedIn)}, which is ` +
          `neither "port" nor "vendoring-commit" — those are the only two ways an edit ` +
          `gets checked here`,
      );
      assert.ok(
        typeof entry.what === "string" && entry.what.length > 10,
        `divergence ${number} does not say what the edit is, and that string is what ` +
          `every failure message about it quotes`,
      );
      if (entry.appliedIn === "vendoring-commit") {
        assert.ok(
          entry.evidence instanceof RegExp,
          `divergence ${number} is in the baseline, so content is the only thing that ` +
            `can check it, and it carries no evidence pattern`,
        );
      }
    }
  });

  it("describes an edit that is really in the tree", () => {
    // The two halves of "real" are different questions, and conflating them is what
    // let three of these go unchecked. A divergence the *port* applied shows up as a
    // diff against the baseline. A divergence the *vendoring commit* applied cannot
    // — it is the baseline — so the only honest check there is the content itself.
    for (const [number, entry] of Object.entries(DIVERGENCES)) {
      if (entry.appliedIn === "port") {
        assert.ok(
          SURVEY.changed.includes(entry.path),
          `divergence ${number} says ${entry.path} differs from the baseline, and it does not`,
        );
      } else {
        assert.ok(
          divergenceEvidenceHolds(Number(number)),
          `divergence ${number} (${entry.path}) claims ${entry.what}, and the file does not show it`,
        );
      }
    }
  });

  it("keeps the vendoring-commit divergences out of the survey, where they cannot appear", () => {
    // Not a tautology worth skipping: if one of these ever *does* differ from the
    // baseline it means somebody edited it after vendoring, and the entry stops
    // describing the whole of what is there — which is exactly the failure
    // divergence 5 turned out to have.
    for (const entry of Object.values(DIVERGENCES)) {
      if (entry.appliedIn !== "vendoring-commit") continue;
      assert.ok(
        !SURVEY.changed.includes(entry.path),
        `${entry.path} was edited after the vendoring commit, so its divergence entry ` +
          `no longer covers everything in it`,
      );
    }
  });

  it("refuses to content-check a divergence the port applied", () => {
    assert.throws(() => divergenceEvidenceHolds(4), /checked by diffing/);
    assert.throws(() => divergenceEvidenceHolds(13), /there is no divergence 13/);
  });

  it("fails the content check when the edit is gone", () => {
    // The re-vendor this is for: upstream's `browser/package.json` comes back with
    // its own `postinstall`, nothing differs from the baseline because the baseline
    // moved too, and every diff-based check stays green.
    const upstreamAgain = () => '{\n  "scripts": {\n    "postinstall": "bash ../scripts/fetch-electron.sh"\n  }\n}\n';
    assert.equal(divergenceEvidenceHolds(1, upstreamAgain), false);
    assert.equal(divergenceEvidenceHolds(2, () => "packages:\n  - browser\n"), false);
    assert.equal(divergenceEvidenceHolds(3, () => '{ "name": "x" }'), false);
  });
});

describe("dispositionOf", () => {
  it("reports a subject-matter path with its owning task", () => {
    const verdict = dispositionOf("engine/crates/pixel-core/src/terminal.rs");
    assert.equal(verdict.kind, "subject");
    assert.match(verdict.task, /20260821-windows-port/);
  });

  it("reports an incidental path with its divergence number", () => {
    const verdict = dispositionOf("engine/crates/pixel-node/src/lib.rs");
    assert.equal(verdict.kind, "incidental");
    assert.equal(verdict.divergence, 5);
  });

  it("reports an excluded path as excluded, with the reason universe.mjs declares", () => {
    const verdict = dispositionOf("package.json");
    assert.equal(verdict.kind, "excluded");
    assert.equal(verdict.reason, EXCLUSIONS["package.json"]);
  });

  it("fails on an undispositioned path, naming it and the three choices", () => {
    assert.throws(
      () => dispositionOf("engine/crates/pixel-node/src/somewhere-new.rs"),
      (error) => {
        assert.match(error.message, /somewhere-new\.rs/, "the message does not name the path");
        assert.match(error.message, /subject matter/);
        assert.match(error.message, /incidental divergence/);
        assert.match(error.message, /not vendored/);
        assert.match(error.message, /dispositions\.mjs/, "the message does not say where to write it");
        assert.match(error.message, /UPSTREAM\.md/);
        assert.match(error.message, /universe\.mjs/);
        assert.match(error.message, /no fourth answer/);
        return true;
      },
    );
  });

  it("does not treat inherited object properties as dispositions", () => {
    // The tables are looked up with `hasOwn`, not `in`. Without that, `constructor`
    // and `toString` are dispositioned paths with an undefined owning task.
    assert.throws(() => dispositionOf("constructor"), /no disposition/);
    assert.throws(() => dispositionOf("toString"), /no disposition/);
    assert.equal(dispositionCount("valueOf"), 0);
  });
});

describe("auditing a survey", () => {
  // Driven directly rather than through git: the interesting cases are a file that
  // moved and a file that was reverted, and neither is something a test should do to
  // the working tree while the rest of the suite is reading it.
  const KNOWN = "engine/crates/pixel-node/src/surface.rs";
  const MOVED = "engine/crates/pixel-node/src/surfaces/surface.rs";

  it("says nothing when the survey matches the table", () => {
    const audit = auditDispositions({ changed: dispositionedPaths(), deleted: [] });
    assert.deepEqual(audit.unclassified, []);
    assert.deepEqual(audit.stale, []);
  });

  it("reports a changed path with no entry", () => {
    const audit = auditDispositions({ changed: [...dispositionedPaths(), "engine/new.rs"] });
    assert.deepEqual(audit.unclassified, ["engine/new.rs"]);
    assert.deepEqual(audit.stale, []);
  });

  it("reports an entry whose path no longer differs", () => {
    const changed = dispositionedPaths().filter((file) => file !== KNOWN);
    const audit = auditDispositions({ changed, deleted: [] });
    assert.deepEqual(audit.stale, [KNOWN]);
    assert.deepEqual(audit.unclassified, []);
  });

  it("reports both halves when a vendored file moves", () => {
    // The reason the table is keyed by path. The old path stops differing and its
    // entry goes stale; the new path arrives with nothing said about it. A coarser
    // key — a directory, a glob — would swallow the move and report neither.
    const changed = dispositionedPaths().map((file) => (file === KNOWN ? MOVED : file));
    const audit = auditDispositions({ changed, deleted: [KNOWN] });
    assert.deepEqual(audit.unclassified, [MOVED]);
    assert.deepEqual(audit.deleted, [KNOWN]);
    assert.deepEqual(audit.stale, [], "a deleted path is reported once, as deleted");
  });

  it("does not double-report a deleted file as a stale entry", () => {
    const changed = dispositionedPaths().filter((file) => file !== KNOWN);
    const audit = auditDispositions({ changed, deleted: [KNOWN] });
    assert.deepEqual(audit.stale, []);
    assert.deepEqual(audit.deleted, [KNOWN]);
  });

  it("reports a path two tables both claim, and does not call it unclassified", () => {
    // The third way the table can be wrong, and the one that used to be invisible:
    // `unclassified` tested `count === 0` only, so two rows for one path produced no
    // finding at all. Zero and two are different failures — nothing was said, versus
    // two things were said that contradict each other — so they get separate buckets.
    const doubled = (file) => (file === KNOWN ? 2 : dispositionCount(file));
    const audit = auditDispositions({ changed: dispositionedPaths() }, doubled);
    assert.deepEqual(audit.conflicted, [KNOWN]);
    assert.deepEqual(audit.unclassified, []);
    assert.deepEqual(audit.stale, []);
  });

  it("treats a missing `deleted` as none, not as undefined", () => {
    assert.deepEqual(auditDispositions({ changed: dispositionedPaths() }).deleted, []);
  });

  it("reports nothing conflicted on the real table", () => {
    assert.deepEqual(auditDispositions(SURVEY).conflicted, []);
  });
});
