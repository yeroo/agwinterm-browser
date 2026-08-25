# Review scope (handed over by ralphex)

This round was opened automatically by ralphex's external review phase for the
task it just implemented. Everything below is ralphex's own review prompt,
verbatim — it carries the goal, the exact diff command for this iteration, and
the paths to the plan and the progress log.

Review the diff it names. The plan file states what the task was supposed to do;
a change that works but does not match the plan is a finding worth reporting.

---

You are reviewing code changes for: implementation of plan at C:\Users\boris\source\winterm-browser\docs\plans\20260822-post-port-corrections.md

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

Check the progress log at C:\Users\boris\source\winterm-browser\.ralphex\progress\progress-20260822-post-port-corrections-review.txt for previous review iterations and findings history before reporting issues.

## Important

- Focus on real problems, not style preferences
- Check if issues are already mitigated in the code
- Only report issues you can verify by reading the actual code
- Be specific about file paths and line numbers

---
PREVIOUS REVIEW CONTEXT:
Claude (previous reviewer) responded to your findings:

I'll analyze each finding against the actual code.All findings verified against the code. Now fixing.Now the tests that pin all three readers together.Adding a case row to each of the three test suites.Now finding 2 — the tautological `expired` test.Now finding 3 — the two contradictory `frame_file.rs` comments.Now finding 4 — the collapsing backslash fixture.Now the immaterial-but-real contract mismatch on `clearOwnedPaneFrame`.The suite guards against a stale build — I edited `cli/src`. Rebuilding.All green: 365 node tests / 88 suites, 395 + 57 Rust. Now the scoped lint checks.All five actionable findings are fixed and verified. Not committing — leaving the tree for the next review pass.

Findings I fixed

1. Pipe allow-list compared case-sensitively (cli/src/pane.ts:181, cli/src/unsupported.ts:183, agwinterm.rs allows_pipe) — valid. Confirmed the contradiction: sameMark at pane.ts:552 folds case on the same identifier with a comment saying the object manager resolves pipe names case-insensitively, while all three guard copies used exact equality. Both readers restrict a pipe name to ASCII (PIPE_NAME, valid_pipe_name), so toLowerCase and eq_ignore_ascii_case agree on everything that reaches the comparison. Fixed in all three copies, with `*` still matched as a literal before the fold. Added pinning tests in each of the three suites: a new it() in tools/cli/pane-clear.test.mjs, a HOST_CASES row in tools/cli/unsupported.test.mjs, and case pairs plus a negative in a_dev_build_publishes_into_the_instance_it_was_told_to_use.

2. expired test asserted a phrasing no call site emits, with an assertion that cannot fail (agwinterm.rs) — valid, both halves. Grep confirms the only two call sites are "writing a request" (line 496) and "waiting for a reply" (line 546); "reading a reply" existed only in the test. And since expired interpolates its argument, said.contains(what) held for any input. Replaced the invented phrasing with the real one and swapped the contains for assert_eq against the whole sentence, so the wording around the argument is pinned too. Corrected the "both phrasings" comment to describe what the test actually does.

3. Two comments claimed a live publisher can never be swept (frame_file.rs STALE_AFTER and sweep_stale) — valid. sweep_stale selects purely on mtime age with no liveness check, and this change's own remark comment calls an idle swept publisher "a real case". Rewrote both to say the timestamp only tracks painting, not liveness, and to cross-reference write_frame and remark as what makes that survivable.

4. Test fixture backslash collapsed (tools/cli/pane-clear.test.mjs) — valid. "T:\wreck" is "T:wreck", and the pattern's \w is the word-character class, so it passed by coincidence between two mistakes — while the same commit added the opposite rule at tools/launcher/launch.test.mjs:253-257. Fixed both sides and adopted launch.test.mjs's includes("\\") guard.

5. clearOwnedPaneFrame advertised a pane option it discards (marked immaterial) — the contract mismatch is real even though no caller hits it, and the fix is one line. Narrowed the parameter to Pick<OwnedFramesOptions, "root" | "env" | "pid"> & { timeoutMs?: number } so passing pane is a type error. No caller or test passes it; tsc is clean.

Finding I did not act on

Age-based sweeping deletes ownership evidence from live idle publishers (frame_file.rs, filed as pre-existing) — the described window is real, but liveness-based sweeping is a design choice the code states and rejects for stated reasons: a pid check is racy because Windows recycles pids, and it is more Win32 than the module needs. The mitigation is already built and deliberate — write_frame recreates a swept directory and remark puts the pane marker back — so the exposure is only a browser force-killed after a sweep and before its next frame. Adding a heartbeat or lock file would replace a documented trade-off with a new failure mode (a stale lock that never gets swept) and is a redesign beyond this correction round. What was genuinely wrong here was that two comments denied the trade-off existed, and that is fixed in finding 3.

Verification

- node --test "tools/*/*.test.mjs": 365 passed, 88 suites, 0 failed
- cargo test --workspace: 395 + 57 passed, 0 failed
- cli tsc --noEmit: clean
- tools/vendor-check/clippy-scope.py: 12 warnings, 0 on port lines
- tools/vendor-check/fmt-scope.py: 298 complaints, 0 on port lines

One note: tools/acceptance/pane-clear.test.mjs failed on the first run because it guards against a stale cli/dist — I had edited cli/src. Rebuilt with corepack pnpm -r build; the guard did its job. Docs updated to match the new counts: 06-acceptance.md §6 (364 → 365 node tests, pane-clear.test.mjs 73 → 74, plus a seventh-round paragraph) and 07-as-built.md's guard section now states the case-insensitive rule.

Re-evaluate considering Claude's arguments. If Claude's fixes are correct, acknowledge them.
If Claude's arguments are invalid, explain why the issues still exist.