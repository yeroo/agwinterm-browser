# Review: ralphex-20260826-vendor-check-gap / 20260826-124913

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260826-vendor-check-gap\20260826-124913\input\scope.md`

## Minor

### Re-vendoring checklist names a narrower staleness source root than the code compares against

`docs/design/UPSTREAM.md:368-369`

`native-build.test.mjs:45` sets `SOURCE_REL = "engine/crates"`, deliberately widened from one crate to both — the comment at lines 37-44 argues it correctly, since `pixel-node` depends on `pixel-core` and so `pixel-core/src` is compiled into the artifact.

`docs/design/UPSTREAM.md:368` still tells a re-vendorer to build "so `native/pixel.node` is newer than `engine/crates/pixel-node/src`". The message `requireBuilt` actually prints is `...pixel.node is older than engine/crates — ...` (`tools/lib/built.mjs:66`, pinned by `native-build.test.mjs:198`).

Concrete case: a re-vendorer edits only `engine/crates/pixel-core/src`, checks the invariant the checklist states — `pixel.node` is newer than `pixel-node/src`, which it is — and still gets `pixel.node is older than engine/crates` from `requireBuilt`. The failure names a path the checklist never mentions, in the one document that is read only while something is already broken. The `upstream-doc.test.mjs` checklist tests do not cover this: they check the quoted failure strings and the script names, not the source root.

Fix: Change `engine/crates/pixel-node/src` to `engine/crates` at `UPSTREAM.md:368`, so it matches `SOURCE_REL` and the text of the staleness message, and say why both crates count (pixel-node links pixel-core).

_confidence: 99 | sources: bugs+impl, docs+tests | lenses: impl, docs | verdict: confirmed_

### "the four files of this change" — the change adds five

`docs/design/07-as-built.md:610`

The paragraph justifying `PROJECT_ROOTS` says "Every tool and design note written since, 66 of them including the four files of this change, was an untracked-file failure until it was staged."

The 66 checks out: `git ls-files tools docs` returns 79 and `45b5e43` introduced 13 under those roots, so 66 is the remainder — and that remainder includes the files this change added. `git diff main...HEAD --diff-filter=A` returns five added files, all under `tools/vendor-check/`: `dispositions.mjs`, `dispositions.test.mjs`, `universe.mjs`, `universe.test.mjs`, `upstream-doc.test.mjs`. Four was right while Task 4 was in flight; `upstream-doc.test.mjs` landed in that task and the sentence was written in Task 7.

No behaviour depends on it, and nothing pins it. Note that the neighbouring 239 at line 590 is not pinned either: `upstream-doc.test.mjs:339-388` asserts against `DOC` (`docs/design/UPSTREAM.md`, line 45) and `README.md`, where the sentences "introduced 239 paths" and "the remaining 235" live — `07-as-built.md` is not read by that suite, and 235 does not appear in it at all.

Fix: Change "four" to "five".

_confidence: 99 | sources: arch+quality | lenses: quality | verdict: refined_

### `git show --name-only` yields a diff, not an inventory, so a moved BASELINE shrinks the universe

`tools/vendor-check/universe.mjs:188-189`

Confirmed, and the mechanism is sharper than the finding states. `45b5e43` is **not** a root commit — `git rev-list --parents -n 1` gives parent `0b526fe` — so `vendoringCommitPaths()` is already returning a *diff* rather than a tree today: `git show --name-only --diff-filter=d 45b5e43` yields 239 paths where `git ls-tree -r --name-only 45b5e43` yields 291. The 52 it omits are all this repo's own (`.ralphex/`, `.revmux/`, `README.md`, `docs/design/00-port-brief.md`, `tools/ralphex-revmux.*`), which is why nothing is wrong today.

The forward-looking claim holds. A re-vendor committed as a new "vendor upstream" commit — which `UPSTREAM.md:392-396` names as the supported path and `dispositions.mjs:668` instructs — diffs tree-to-tree, so any upstream file byte-identical across the re-vendor never appears in `--name-only`. It leaves `vendoredUniverse()`, `partitionDivergences` filters its edits and deletions out at `universe.mjs:387`, and the guard passes on a lost vendored file. The module's own `--diff-filter=d` comment (`universe.mjs:174-183`) reasons carefully about a moving BASELINE for *deleted* paths and misses the *unchanged* ones — and `universe.test.mjs:3-5` names this exact hazard: "a query that quietly answers something narrower than it claims".

Two corrections to the finding's weight. First, a baseline move is not silent at the moment it happens: `universe.test.mjs:59` pins the count at 239, `assertExclusionsAreReal` throws for `.gitignore`/`package.json`/`docs/plans/...` if the new commit does not touch them, and `upstream-doc.test.mjs:366-370` pins the count in the document. All three force the maintainer to look. None of them says the universe *shrank* — the natural response is to re-baseline the numbers and delete the stale exclusions — so they are speed bumps, not a guard. Second, the fix is not one line: swapping to `git ls-tree` pulls `.ralphex/`, `.revmux/` and `README.md` into the universe, and `README.md` is itself changed by this diff, so it needs new `PROJECT_ROOTS`/`EXCLUSIONS` entries alongside.

Fix: Derive the snapshot's full path set with `git ls-tree -r --name-only BASELINE`, adding `.ralphex` and `.revmux` to `PROJECT_ROOTS` and dispositioning `README.md` and `docs/design/00-port-brief.md`; or, if that is too wide, record the hazard in the `--diff-filter=d` comment and in the `UPSTREAM.md` closing note so a re-vendorer knows the universe is a diff and must be re-derived, not just re-counted.

_confidence: 88 | sources: adversarial | lenses: adversarial | verdict: refined_

### Artifact freshness ignores the workspace manifest and lockfile it is built from

`tools/vendor-check/native-build.test.mjs:45`

Confirmed. `SOURCE_REL = "engine/crates"` (`native-build.test.mjs:45`) and `requireBuilt` walks only that root (`tools/lib/built.mjs:59-69`), so `engine/Cargo.toml` and `engine/Cargo.lock` are outside the mtime comparison. Both feed the build: the workspace manifest carries `[workspace.dependencies]` (including `windows-sys` and its features), `[workspace.lints]`, and the `opt-level = 2` profile overrides for `pixel-core`/`pixel-node`. Edit either after a build without touching anything under `engine/crates`, and all three tests in "the built napi module" load and pass against the previous binary — the silent stale pass Task 5 closed.

Both files are live divergences this port actively edits (`dispositions.mjs:332`, `:344`; divergences 10 and 12 in `DIVERGENCES`), so this is not a theoretical input.

Two notes on weight and on the fix. The trigger is narrower than the finding implies: most dependency work touches crate sources too, so the manifest-only case is `cargo update`, a feature-flag or lint change, or a profile edit — real but not the common path. And the fix must be an explicit file list, not a wider root: setting `SOURCE_REL` to `engine` would make `newestUnder` walk `engine/target`, whose mtimes are always newest, and every run would report stale. Adding an optional extra-paths argument to `requireBuilt` leaves the other five call sites (`tools/cli/*`, `tools/acceptance/pane-clear.test.mjs`) untouched.

Fix: Give `requireBuilt` an optional list of extra files to include in the newest-mtime comparison and pass `["engine/Cargo.toml", "engine/Cargo.lock"]` from `native-build.test.mjs`; keep `SOURCE_REL` as `engine/crates` so the walk still avoids `engine/target`.

_confidence: 88 | sources: adversarial | lenses: adversarial | verdict: refined_

### `classify` is exported, headlined in the module doc and tested, but no production path calls it

`tools/vendor-check/universe.mjs:239-252`

Confirmed for `classify`. A repo-wide grep returns only `universe.mjs:26` (the module header bullet), `universe.mjs:239` (the definition) and `universe.test.mjs:27,171-200` (the import and its own `describe` block). Neither `surveyVendored`, `vendoredUniverse`, `vendoredDirectories`, `guardVerdict` nor `auditDispositions` calls it.

The overlap with `dispositionOf` is real: `dispositions.mjs:448-455` answers excluded-vs-not over the same `EXCLUSIONS` table and additionally covers `SUBJECT` and `INCIDENTAL`, throwing `unclassifiedMessage` for anything in none of the three. That is the live path, and it is what actually delivers Task 1's "make an unknown path fail rather than default into any category". So `classify` is a second, narrower answer to a neighbouring question, and a later reader who wires it in gets a verdict that knows nothing about `SUBJECT` or `INCIDENTAL` — a genuine hazard in a module whose stated design (`universe.mjs:23`) is one answer per question and no defaults. The `.includes()` linear scan over 239 paths is incidental.

The `untrackedFiles` half of the finding is wrong and I have dropped it. `untrackedFiles` is not dead: it is the default argument of `untrackedInVendoredTrees` (`universe.mjs:360`), which `surveyVendored` calls unconditionally at `universe.mjs:423`. It runs on every guard invocation. Its export is arguably unnecessary, but that is a separate and much weaker point than the one made about `classify`.

Fix: Either delete `classify`, its `describe` block at `universe.test.mjs:171-202` and the bullet at `universe.mjs:26` — the inherited-property and empty-string cases are already covered for the live path by `dispositions.test.mjs:293-299` — or call it from `partitionDivergences`/`surveyVendored` so the scope decision goes through the one function that refuses to guess.

_confidence: 95 | sources: bugs+impl, arch+quality | lenses: impl, architecture, quality | verdict: refined_

### The `aboveExcluded` clause in `vendoredDirectories` cannot change the result

`tools/vendor-check/universe.mjs:315`

`vendoredDirectories` filters with `!underProjectRoot(dir, roots) && (holdsVendored.has(dir) || !aboveExcluded.has(dir))`. The second half is unreachable: `aboveExcluded` is populated only from ancestors of `EXCLUSIONS` paths, and the four exclusions are `.gitignore`, `package.json` (both repo-root, so the `cut <= 0` break contributes no ancestor), `docs/design/UPSTREAM.md` and `docs/plans/20260821-windows-port.md`. That makes `aboveExcluded` exactly `{docs, docs/design, docs/plans}` — and every one of those is already removed by `underProjectRoot`, since `docs` is a `PROJECT_ROOTS` key.

The derivation was run both ways against the real commit: 48 directories with the clause, 48 without, empty difference, and `vendoredDirectories().size === 48`. So the clause is a fallback that cannot trigger.

It also means two tests are not testing what their comments say. `universe.test.mjs:255-263` ("does not make a tree out of a directory only an excluded path put there") and `universe.test.mjs:315-319` ("the rule stops where a declared-out path is") both pass with the clause deleted — they are exercising `PROJECT_ROOTS`, not the exclusion rule they name. `PROJECT_ROOTS` was added in Task 6 and subsumed the `docs/plans` case the earlier rule was written for; the earlier rule was never retired.

Fix: Either drop the `!aboveExcluded.has(dir)` half and the `aboveExcluded` bookkeeping in the loop, and re-point the two test comments at `PROJECT_ROOTS`; or keep it and add a case that actually reaches it — an injectable `exclusions`/`roots` pair where a declared-out path sits under a directory that is not beneath a project root.

_confidence: 95 | sources: arch+quality | lenses: quality | verdict: confirmed_

### Comment says a describe-time throw would drop "seven tests"; the suite has twelve

`tools/vendor-check/universe.test.mjs:241-242`

The lazy-`dirs()` comment justifies itself with "At describe-time a stale exclusion would delete all seven tests below and leave the run green." The `describe("vendored trees, as directories rather than paths")` block contains twelve `it(...)` cases (lines 246, 255, 265, 286, 307, 322, 327, 335, 340, 344, 368, 378). The count understates the blast radius of exactly the failure the comment exists to argue about, in a file whose sibling comments (lines 5-8) make a point of pinning counts so that "any of those moving is a real event and should be read, not re-baselined."

Fix: Say "every test below" rather than a count, so the sentence cannot go stale the next time a case is added.

_confidence: 90 | sources: docs+tests | lenses: comments | verdict: confirmed_

### Comment describes the describe-level placement the file deliberately rejects

`tools/vendor-check/native-build.test.mjs:229-230`

Lines 99-105 of the same file state the design and the reason for it: "Called from inside each test rather than once here, which reads worse and is the only version that works: a throw from a `describe` callback is printed as `not ok 3` but counted as neither pass nor fail, and `node --test` still exits 0 (v22.19.0)." The plan records the same thing as the finding of Task 5 (`20260826-vendor-check-gap.md:234-239`): "Anything that moves it back up a level re-introduces the bug this task was closing."

Line 229 then opens with "`requireBuilt` at the top of a describe is only loud while nothing downstream re-introduces the option it replaced" — naming the placement the file exists to avoid. A reader who takes line 229 at face value and hoists `artifact()` out of the tests to the `describe` body restores the silent-pass this test was written to prevent, and this very test would still pass while they did it.

Fix: Reword line 229 to "`requireBuilt` inside each test is only loud while nothing downstream re-introduces the option it replaced."

_confidence: 85 | sources: docs+tests | lenses: comments | verdict: confirmed_

### Test for the excluded-ancestor rule passes without that rule existing

`tools/vendor-check/universe.test.mjs:255-263`

The test "does not make a tree out of a directory only an excluded path put there" claims to cover the `aboveExcluded` half of `vendoredDirectories`' filter (`universe.mjs:305` and `universe.mjs:315`). Neither assertion reaches it.

`vendoredDirectories` only builds candidates from *vendored* files (`universe.mjs:302-304`), and no vendored path lives under `docs/plans` — the one baseline path there is the excluded `20260821-windows-port.md` — so `docs/plans` never enters `above` and can never be in the returned set regardless of the filter. `assert.ok(!dirs().has("docs/plans"))` and `inVendoredTree("docs/plans/...")` therefore hold for a function with the whole `aboveExcluded` mechanism deleted. The same is true of `assert.ok(!dirs().has("docs"))` at line 318: `docs` is removed by `underProjectRoot` before the `aboveExcluded` clause is consulted.

With the four exclusions as declared, the clause is in fact unreachable: ancestors-of-excluded is `{docs/design, docs, docs/plans}`, and every one of those is either absent from `above` or already dropped by `PROJECT_ROOTS`. So a regression that inverted `!aboveExcluded.has(dir)` would be caught by nothing in the suite.

Fix: Either drive `vendoredDirectories` with an injected roots/exclusions pair that puts the excluded-ancestor case outside `tools`/`docs` so the clause is really exercised, or drop the clause and the comment defending it and let `PROJECT_ROOTS` carry the case on its own.

_confidence: 85 | sources: docs+tests | lenses: tests, comments | verdict: confirmed_

### Comment still describes Task 4 as owing six unnumbered divergences

`tools/vendor-check/unchanged.test.mjs:234-236`

The comment on "names a path UPSTREAM.md really mentions" reads: "The unnumbered incidentals are Task 4's to write up — `UNRECORDED_BUDGET` in `dispositions.mjs` pins how many are still owed, so they cannot hide behind this `continue`."

Task 4 completed inside this same change: `dispositions.mjs:362` sets `UNRECORDED_BUDGET = 0`, every `INCIDENTAL` row carries a number (4-12), and `dispositions.test.mjs:106` asserts the budget "does not go back up". Nothing is owed and no entry can reach the `continue` at line 239. A reader arriving at this file is told there is outstanding documentation debt that was paid two tasks earlier, and that the weak `upstream.includes(file)` check here is provisional when `upstream-doc.test.mjs` now does the strong version against the parsed numbering.

Fix: Rewrite the comment to say the budget is spent and the `continue` is kept only so a future `divergence: null` row does not crash this loop; point at `upstream-doc.test.mjs` for the parsing check.

_confidence: 85 | sources: docs+tests | lenses: comments | verdict: confirmed_

### Plan Task 5 still names `pixel-node/src` as the staleness root, and quotes a message the code cannot produce

`docs/plans/20260826-vendor-check-gap.md:218-231`

`native-build.test.mjs:45` sets `SOURCE_REL = "engine/crates"`, widened in commit `a655670` ("fix: address code review findings") so that an edit to `pixel-core/src` — which is compiled into the artifact — also marks `pixel.node` stale. The plan was not updated with it, and it is the plan's own rule that it should have been (`docs/plans/20260826-vendor-check-gap.md:91`, "Update this plan when scope changes").

Two places now describe a world the code does not have:

- line 218, the checklist item: "route the artifact check through `requireBuilt` against `engine/crates/pixel-node/src`" — ticked, but that is not what shipped.
- lines 229-231, the recorded evidence: "`touch`ing `pixel-node/src/lib.rs` exits 1 with *\"...is older than engine/crates/pixel-node/src — this suite would pass against the previous build\"*". `requireBuilt` interpolates `sourceRelative` verbatim (`tools/lib/built.mjs:66`), so the message today reads "is older than engine/crates". A reader matching that quote against a real failure will not find it — the same class of defect `upstream-doc.test.mjs:260-288` was written to prevent for `UPSTREAM.md`'s failure table.

Fix: Update line 218 to `engine/crates` with the one-line reason already in `native-build.test.mjs:38-44` (pixel-node depends on pixel-core, so pixel-core/src is compiled into the artifact), and correct the quoted message at line 230.

_confidence: 95 | sources: arch+quality | lenses: architecture | verdict: confirmed_

## Immaterial

### New suite rows spliced into the coverage table without re-sorting, so the size ranking is no longer descending

`docs/design/06-acceptance.md:281-283`

The right-hand column of the table at lines 276-290 is a descending ranking of node suites by `test()` count, closing with `the rest | 120`. The four new `vendor-check/` rows were inserted at the row positions that happened to be free rather than at their rank, so the column now reads 88, 37, 33, **31, 34, 33**, 30, 28, 23, 18, 15, 14.

`cli/unsupported.test.mjs` (31) is listed above `vendor-check/universe.test.mjs` (34) and `vendor-check/unchanged.test.mjs` (33). A reader scanning for the largest suites gets the wrong two.

The counts themselves are right — the column sums to 88+37+33+31+34+33+30+28+23+18+15+14+120 = 504, matching the run recorded at line 214, and `it(` in each of the four new files re-counts as universe 34, unchanged 33, dispositions 30, upstream-doc 15, native-build 14. Only the ordering is wrong.

Fix: Re-sort the node column descending: 88, 37, 34, 33, 33, 31, 30, 28, 23, 18, 15, 14, then `the rest`.

_confidence: 90 | sources: bugs+impl | lenses: impl | verdict: immaterial_

### The failure mode the plan was written about — a divergence whose recorded scope understates the diff — is repaired by hand but not mechanically checked

`tools/vendor-check/dispositions.mjs:549-555`

The plan's headline defect is divergence 5: `UPSTREAM.md` described `pixel-node/src/lib.rs` as "one line — `WATCH_RESIZE = cfg!(windows)`" against a 237-insertion diff that also carried the `SurfaceSink` trait, so a re-vendorer following the checklist would restore the constant and lose the trait (plan lines 59-68). Task 4 rewrote that prose. What the change does not add is anything that would catch the next one.

For the nine `appliedIn: "port"` divergences, the only assertion is existence: `dispositions.test.mjs:213` and `upstream-doc.test.mjs:151` both check `SURVEY.changed.includes(entry.path)` — "does this path differ from the baseline at all". The content-matching machinery that could check scope does exist (`divergenceEvidenceHolds`, with `entry.evidence` regexes), but lines 549-554 explicitly *refuse* to run it for port-applied entries, and `dispositions.test.mjs:242` pins that refusal.

Concrete recurrence: someone adds 200 lines to `engine/crates/pixel-node/src/surface.rs` — a new backend seam, say — while divergence 8 still reads "three `#[cfg_attr(windows, allow(irrefutable_let_patterns))]`". `surface.rs` is already in `INCIDENTAL`, so `dispositionCount` is 1, `unclassified` is empty, `stale` is empty, and the guard prints the roster line quoting the old three-attribute reason. Every test in the suite stays green, and the next re-vendorer re-applies three attributes and drops the seam — byte for byte the divergence-5 failure, one file over.

Task 2's checklist item "verify the six existing divergences still describe real edits" was satisfied by a human pass; the mechanism left behind verifies only that the edits exist. This is a limitation rather than a broken promise — no doc claims scope is checked — but it is the cause behind the symptom the plan set out to fix.

Fix: Let `evidence` be optional on `appliedIn: "port"` entries too, and have `divergenceEvidenceHolds` run it instead of throwing for them; assert it in the existing `describes an edit that is really in the tree` loops. Cheaper alternative: give each `INCIDENTAL` entry the expected `git diff --numstat` insert/delete counts and fail when they move, which is exactly the signal (237 vs "one line") that would have caught divergence 5.

_confidence: 80 | sources: bugs+impl | lenses: impl | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 3363140 | 4 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 2185790 | 4 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 2319556 | 6 | ok |
| adversarial | codex | gpt-5.6-sol | high | 120454 | 2 | ok |
