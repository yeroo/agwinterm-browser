# Review scope (handed over by ralphex)

This round was opened automatically by ralphex's external review phase for the
task it just implemented. Everything below is ralphex's own review prompt,
verbatim — it carries the goal, the exact diff command for this iteration, and
the paths to the plan and the progress log.

Review the diff it names. The plan file states what the task was supposed to do;
a change that works but does not match the plan is a finding worth reporting.

---

You are reviewing code changes for: implementation of plan at C:\Users\boris\source\winterm-browser\docs\plans\20260826-vendor-check-gap.md

## Get the Diff

Run this command to see the changes:
git diff

## Review Focus

Analyze the code for:

1. Bugs and logic errors - incorrect behavior, edge cases, null/nil handling
2. Security issues - injection, XSS, secrets exposure, improper validation
3. Race conditions - concurrent access, shared state, missing synchronization
4. Error handling - silent failures, ignored errors, missing fallbacks
5. Test coverage - missing tests, inadequate edge case coverage
6. Code quality - unnecessary complexity, poor naming, unclear logic

## Output Format

Report issues as a structured list:

- file:line - description of issue
- file:line - description of issue

If no issues found, output: NO ISSUES FOUND

## Previous Review History

Check the progress log at C:\Users\boris\source\winterm-browser\.ralphex\progress\progress-20260826-vendor-check-gap.txt for previous review iterations and findings history before reporting issues.

## Important

- Focus on real problems, not style preferences
- Check if issues are already mitigated in the code
- Only report issues you can verify by reading the actual code
- Be specific about file paths and line numbers

---
PREVIOUS REVIEW CONTEXT:
Claude (previous reviewer) responded to your findings:

I'll work through each finding against the actual code.Now the plan's stale Task 5 references:Now add the tests for the manifest inputs and fix the misleading comment:Now the diff-vs-inventory hazard — the docstring correction and a loud guard:Now make the `aboveExcluded` clause reachable and testable:Now update the tests: remove the `classify` block, fix the stale comments, and add real coverage for the new branches.Now edit the test file:Now the `vendoredDirectories` test comments and the real coverage for the excluded-ancestor rule:Now the second mis-attributed comment (the `assets` test's closing assertions):Now the stale Task 4 comment in `unchanged.test.mjs`:Now the plan's third bullet for Task 5:All findings evaluated. Twelve were valid and are fixed; one is dismissed. Full suite: 509 passed, 0 failed, 0 skipped; fmt-scope 0 on port lines; clippy-scope 0 on port lines.

FIXED

1. UPSTREAM.md:368 named a narrower staleness root than the code
Confirmed. Step 5 said "newer than engine/crates/pixel-node/src" while SOURCE_REL is engine/crates and requireBuilt prints that path. Rewritten to name engine/crates plus the two manifests, with the pixel-node-depends-on-pixel-core reason.

2. 07-as-built.md:610 "four files of this change"
Confirmed — git diff main...HEAD --diff-filter=A returns five. Changed to "five".

3. git show --name-only is a diff, not an inventory
Confirmed and load-bearing. 45b5e43 has parent 0b526fe (54 paths), so the query returns 239 where git ls-tree returns 291. The 52 omitted are all this repo's own harness, which is why it is right today by coincidence rather than by construction. I did not switch to ls-tree — that would pull .revmux/ and README.md into the universe and demand a divergence reason for the review harness this port runs under. Instead the coincidence is now declared and enforced: PRE_BASELINE (six prefixes, a reason each) plus assertUniverseIsTheWholeSnapshot, called from vendoredUniverse(), which holds the diff to the snapshot and fails naming the paths that fell out. On a BASELINE move to a re-vendor commit, every upstream file unchanged across it now trips a loud failure telling the reader to re-derive rather than re-baseline. Four tests, including the throw and the list's own staleness. Recorded in the plan's Technical Details, 07-as-built.md and UPSTREAM.md's closing note.

4. Artifact freshness ignored engine/Cargo.toml and engine/Cargo.lock
Confirmed. The manifest carries [workspace.dependencies] (windows-sys and its features), [workspace.lints] and the opt-level = 2 overrides; neither file is under engine/crates. requireBuilt takes an optional alsoRelative list, stats each uncaught for the same reason the source root is, and reports which input is newer so the message does not send the reader to the wrong tree. native-build.test.mjs passes ["engine/Cargo.toml", "engine/Cargo.lock"]; SOURCE_REL stays engine/crates so the walk still avoids engine/target. Three new tests: manifest-only staleness, that the message names the actual newer input, and that a missing named input refuses.

5. classify was exported, headlined and tested with no production caller
Confirmed by repo-wide grep. dispositionOf answers the same question over all three categories and is the live path. Deleted classify, its module-header bullet and its describe block; the header now points at dispositionOf. The inherited-property coverage already exists in dispositions.test.mjs:293-299.

6 and 9. The aboveExcluded clause was inert, and two tests credited it falsely
Confirmed by running the derivation both ways: 48 directories either way, empty difference. aboveExcluded is {docs, docs/design, docs/plans} and PROJECT_ROOTS removes all three. I kept the rule rather than deleting it — it is the only thing covering an exclusion declared outside a project root, where the alternative is that the declaration itself makes the directory a tree — but made it reachable: vendoredDirectories now takes injectable paths and exclusions, and a new test drives an engine/generated case the clause actually decides, plus its converse. Verified load-bearing by stubbing the clause to true: the new test fails. The two mis-credited test comments now say PROJECT_ROOTS is what keeps docs and docs/plans out.

7. "all seven tests below" in a suite of twelve
Confirmed. Replaced with "every test below", and a line saying why a count does not belong in a comment about the cost of a silent skip.

8. native-build.test.mjs:229 described the placement the file rejects
Confirmed against lines 99-105. Reworded to "requireBuilt inside each test".

10. unchanged.test.mjs comment said Task 4 still owed divergences
Confirmed: UNRECORDED_BUDGET is 0 and every INCIDENTAL row is numbered. Rewritten to say the budget is spent, why the continue is kept, and that upstream-doc.test.mjs does the parsed-numbering check.

11. Plan Task 5 named pixel-node/src and quoted an unproducible message
Confirmed. Both corrected, and a third "found while doing it" bullet records the manifest gap and why widening SOURCE_REL to engine is not the fix.

12. Acceptance table ordering (reported immaterial)
Fixed anyway — the node column is descending again, and re-counted for the new tests: universe 34 to 36, native-build 14 to 17, total 504 to 509. Updated in 06-acceptance.md, README.md and the plan.

DISMISSED

13. "Divergence scope is repaired by hand but not mechanically checked" (dispositions.mjs:549-555)
The refusal to content-check port-applied divergences is deliberate and argued in place: dispositions.test.mjs:206-210 states that "does it differ from the baseline" and "is the described edit present" are different questions, and conflating them is what let divergences 1-3 go unchecked. The proposed numstat pinning would invert the failure this directory is about — every legitimate edit to a subject-matter file would move the counts and fail the guard, which is precisely the "a guard that fails on ordinary work teaches people to stop reading it" pressure PROJECT_ROOTS and the docs/plans exclusion both exist to relieve. The finding's own verifier notes no doc claims scope is checked. Closing it would need a design decision about what a scope check costs, not a repair to this change.

Not committed — leaving the working tree for the next review round.

Re-evaluate considering Claude's arguments. If Claude's fixes are correct, acknowledge them.
If Claude's arguments are invalid, explain why the issues still exist.