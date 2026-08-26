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

I'll start by reading the review context and the three sites.All three findings check out. Making the fixes.Now the docs that pin the compared-input list and the counts.All three findings were valid. I traced each, confirmed it against the code, and fixed it. Full suite after the changes: 510 passed, 112 suites, 0 skipped, 8.9s.

Finding 1 — ALSO_REL omits build inputs (native-build.test.mjs:55). Valid, confirmed.
- Verified: pixel-node/src/lib.rs:273-275 include_bytes! both fonts; engine/rust-toolchain.toml is tracked and pins channel 1.93.1; build-native.mjs runs cargo with cwd = engine/packages/pixel-react, so rustup walks up to engine/ for that pin. None of the three is under engine/crates, Cargo.toml or Cargo.lock, so a font update or a channel bump left requireBuilt passing against the old binary.
- Fixed: ALSO_REL now also carries engine/rust-toolchain.toml, both engine/assets/fonts/*.ttf, and engine/packages/pixel-react/scripts/build-native.mjs (it decides which cargo profile is copied and under what name). The comment above it now enumerates each with its reason, and says why engine/deny.toml and engine/justfile are deliberately out — a cargo-deny policy and a task runner, neither read by the build.
- Went past "at minimum": added a test, "compares against every asset the crates compile into the artifact", that walks engine/crates for include_bytes!/include_str! literals, resolves each to a repo-relative path, and fails if one is covered by neither SOURCE_REL nor ALSO_REL. That closes the rot the finding is really about — the derived set is the two fonts plus two self-referential .rs files, so without the fonts in ALSO_REL it fails. The fixture already wrote every ALSO_REL entry generically; I only changed its placeholder content from "[workspace]" to the entry's own path, since not every entry is a manifest now.
- Also generalized requireBuilt's docstring in tools/lib/built.mjs, which named only the manifest and lockfile as the class of extra inputs.

Finding 2 — PRE_BASELINE docstring credits a guarantee assertUniverseIsTheWholeSnapshot does not implement (universe.mjs:179-180). Valid, confirmed.
- Verified: the function has one loop, tree → diff-or-prefix. It cannot see a prefix covering nothing, and a broader prefix only makes it more permissive. The rot check lives in universe.test.mjs:227-240 and only requires a prefix to cover at least one carried-over path; nothing checks absorption.
- Fixed by rewording rather than moving the check into production: the injected cases at universe.test.mjs:215-225 pass PRE_BASELINE against two-path trees, so a non-emptiness check inside the function would have to be paid for by rewriting those tests around a synthetic carried list, which trades a true sentence for weaker tests. The docstring now attributes each half where it lives, names the test by its own title, says outright that absorption is caught by nothing, and tells the maintainer to keep each key as narrow as its reason.
- While rewriting it I also corrected the adjacent sentence "a key with no slash covers the whole tree beneath it" — underPrefix walks every ancestor, so depth of the key is irrelevant; docs/design/00-port-brief.md names one file and .ralphex names a tree, by what is under them, not by their shape.

Finding 3 — the excluded-ancestor test's comment names the wrong directory (universe.test.mjs:313-331). Valid, confirmed by tracing and by mutation.
- Verified: only a vendored file populates above, so engine/generated is never a candidate and line 328 holds with the clause deleted. The directory the clause removes is engine — in above via lib.rs, not in holdsVendored, in aboveExcluded via manifest.json.
- Fixed: comment now names engine and explains why engine/generated cannot be the case being decided. Added a direct assertion that engine is not in derived, so the load-bearing behaviour is asserted at its own name rather than only via the ancestor walk in the next line. Mutation-checked: replacing !aboveExcluded.has(dir) with true fails this test (and the neighbouring real-data suite); restoring it passes.

Docs updated for the widened comparison set and the new test: UPSTREAM.md re-vendor step 5, 06-acceptance.md (native-build.test.mjs 17 → 18, node total 509 → 510, and the "stale is measured against" paragraph), README.md's 509 → 510, and the plan's "a source root is not the whole set of build inputs" note now records the three further inputs and the derived check.

Not committed.

Re-evaluate considering Claude's arguments. If Claude's fixes are correct, acknowledge them.
If Claude's arguments are invalid, explain why the issues still exist.