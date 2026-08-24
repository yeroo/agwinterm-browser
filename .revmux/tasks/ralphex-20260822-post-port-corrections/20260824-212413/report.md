# Review: ralphex-20260822-post-port-corrections / 20260824-212413

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260822-post-port-corrections\20260824-212413\input\scope.md`

## Minor

### The KELVIN SIGN example in both new fold comments names a string with no `K` in it

`cli/src/pane.ts:184`

Both new comments illustrate the CLI/engine fold divergence with the same example: "An entry that is not ASCII but Unicode-folds to it — `AGWINTERM-DEV` with a U+212A KELVIN SIGN — matches here and not in `allows_pipe`, which needs equal bytes" (cli/src/pane.ts:183-185), and the twin on `allows_pipe` at engine/crates/pixel-core/src/agwinterm.rs:341-342, "so `AGWINTERM-DEV` with a U+212A KELVIN SIGN passes the CLI and stops here".

`AGWINTERM-DEV` contains no `K` — its characters are A G W I N T E R M - D E V. U+212A KELVIN SIGN lowercases to `k` and can only stand in for a `K`/`k`, so "`AGWINTERM-DEV` with a U+212A KELVIN SIGN" names no string at all. Reviewers report scanning U+0080–U+2FFFF under node and finding no non-ASCII code point whose `toLowerCase()` equals any single letter of `agwinterm-dev` (U+0130 İ folds to `i` plus a combining dot, two code points, so it does not match either) — so there is no substitute homoglyph for this name. The plain-ASCII string the comment names is 13 bytes and `eq_ignore_ascii_case` matches it against `agwinterm-dev` perfectly, i.e. a case where the engine *does* accept, the reverse of the claim it is attached to.

The example is the load-bearing half of the paragraph: the abstract claim ("a list entry is whatever the variable held") is unfalsifiable on its own, and the concrete case is what a later maintainer would use to check whether the divergence is still real before touching either fold.

The surrounding reasoning is reported as sound and independently verified: with `pipe` ASCII by `PIPE_NAME` (pane.ts:231) / `valid_pipe_name` (agwinterm.rs:202), Rust's `eq_ignore_ascii_case` matching implies JS's `toLowerCase` matching, so the asymmetry is genuinely one-directional and the frame path still fails closed. Only the worked example is wrong. Introduced by this change — the prior round's report used `agwinterm-kiosk` / `AGWINTERM-KIOSK`, a valid instance; the substitution to the README's running instance name `agwinterm-dev` is what broke the illustration. Prose only, so nothing executes differently.

Fix: Restore a name that actually contains a `k`, in both copies — e.g. `AGWINTERM-KIOSK` with a U+212A KELVIN SIGN in place of the `K`, against a pipe of `agwinterm-kiosk` (17 bytes against the pipe's 15, so `eq_ignore_ascii_case` cannot match). Or drop the specific code point and say "a non-ASCII entry that Unicode-folds to the ASCII name". Fix cli/src/pane.ts:184 and engine/crates/pixel-core/src/agwinterm.rs:341 together; leaving one is the same contradiction in a second place.

_confidence: 99 | sources: bugs+impl, arch+quality, docs+tests | lenses: impl, bugs, quality, comments, docs | verdict: confirmed_

### README still claims 364 node tests after this change moved the count to 365

`README.md:31`

The diff updates `docs/design/06-acceptance.md:213` from "**364 passed**" to "**365 passed**" and the module table at :277 / :287 from 73 to 74 for `pane-clear.test.mjs`, because the new `it("compares the pipe the way the object manager resolves it")` adds one test. `README.md:31` still reads "452 Rust tests and 364 node tests pass on Windows" and was not touched.

Reviewers report confirming the acceptance doc is now internally consistent and the README is the one that drifted: `grep -c '^\s*it('` gives 74 for `tools/cli/pane-clear.test.mjs` and 30 for `tools/cli/unsupported.test.mjs` (the new `HOST_CASES` row runs inside the two existing loop-driven tests at :275 and :281, so it adds no test), `grep -c '#\[test\]'` gives 48 for `agwinterm.rs` (the new fold cases were added inside the existing `#[test]` fn), and the node column sums 74+37+32+30+28+23+18+123 = 365.

This is not two independent numbers that happen to be close: `git log -S"364 node tests"` shows commit fba801d moved README from "447 Rust tests and 355 node tests" to "452 Rust tests and 364 node tests" in the same commit that moved the acceptance table — the front-page count is maintained in lockstep with §6, and this round broke that lockstep by updating only one side.

Failure case: a reader lands on the README's Status section, sees 364, opens the linked acceptance doc, sees 365 in two places, and cannot tell which document describes the current tree — in a section whose whole claim is that these numbers are measured rather than asserted. `tools/docs-check/docs.test.mjs` reads `README.md` for the recovery verb and the allow-pipe wording but pins no test count, so nothing caught it. Introduced by this change: before the diff both documents said 364. Human-facing prose, so nothing executes differently.

Fix: Update README.md:31 to "452 Rust tests and 365 node tests", matching docs/design/06-acceptance.md:213.

_confidence: 99 | sources: bugs+impl, docs+tests | lenses: impl, docs | verdict: confirmed_

### "The five rounds below" now sits above six round paragraphs

`docs/design/06-acceptance.md:292-293`

docs/design/06-acceptance.md:292-293 ends the test-table paragraph with "The five rounds below carry them the rest of the way." That sentence is unchanged by this diff, but the diff adds a sixth round paragraph beneath it — "A seventh round moved one..." at line 355.

Before the change the count was right: the paragraphs below were second (295), third (304), fourth (313), fifth (322) and sixth (340) — five. After it there are six, and the sentence was not updated.

Failure case: a reader uses "five" as the checklist for how many rounds the narrative accounts for, reads the seventh-round paragraph, and cannot tell whether the sentence is stale or whether one of the six paragraphs describes something other than a round — in a section whose whole claim is that the counts in it are kept current. Introduced by this change; the same edit that added the paragraph and moved 364 → 365 and 73 → 74 missed this one. Prose, so nothing executes differently.

Fix: Change "The five rounds below" to "The six rounds below" at docs/design/06-acceptance.md:292.

_confidence: 95 | sources: docs+tests | lenses: docs | verdict: confirmed_

## Immaterial

### Unicode-aware CLI folding diverges from the engine's ASCII-only allow-list comparison

`cli/src/pane.ts:198`

With `AGWINTERM_PIPE=agwinterm-kiosk` and an allow-list entry `AGWINTERM-KIOSK` containing U+212A KELVIN SIGN, JavaScript lowercases the entry to `agwinterm-kiosk`, so both CLI guards permit it. Rust's `eq_ignore_ascii_case` compares bytes and rejects the same entry. In a debug build the CLI therefore launches a browser that the engine subsequently refuses; in a release build, where the engine guard is disabled, the CLI permits launch and clear against a pipe that its supposed engine-equivalent parser would not admit. The new comment documents this divergence but does not resolve the broken three-reader contract. This is introduced by the changed `toLowerCase` comparison; the prior exact comparison rejected the malformed entry.

Fix: Use an explicitly ASCII-only comparison in both TypeScript copies, or reject every non-wildcard allow-list entry that fails `PIPE_NAME` before comparing it.

_confidence: 92 | sources: adversarial | lenses: adversarial | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 2404240 | 2 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 2276335 | 1 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 1988487 | 3 | ok |
| adversarial | codex | gpt-5.6-sol | high | 92064 | 1 | ok |
