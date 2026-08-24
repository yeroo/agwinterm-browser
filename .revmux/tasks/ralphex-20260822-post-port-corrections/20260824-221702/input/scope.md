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

I'll examine each finding against the actual code.Now let me make the fixes. Starting with the `asciiLower` doc scope claim and `sameMark`:Now the test fixtures — replacing the raw U+212A with escapes and adding marker-fold coverage:Now the acceptance doc's split code span:Now the trim-set divergence between JS and Rust (pre-existing finding 2):Now the same helper in `unsupported.ts`:Now the Rust side of the trim parity:Now the pane.ts and Rust test assertions:Now a final full verification pass:`cargo fmt --all` reformatted unrelated files across the workspace — reverting those:All green. Here is the evaluation.

Valid — fixed

1. `asciiLower` doc claims the allow-list is "the one place a non-ASCII operand can reach" (cli/src/pane.ts:170)
Confirmed. `sameMark` folded with Unicode `toLowerCase`, and its `mark.pipe` operand comes from `frameMark`, which reads `PANE_FILE` off disk and applies no `PIPE_NAME` check — so it is exactly as unconstrained as an allow-list entry. Rather than just narrowing the comment, I closed the divergence: `sameMark` now folds with `asciiLower`, its doc says why (`FrameDir::mark_pane` only ever writes a `valid_pipe_name`, so a non-ASCII marker is one something else planted, and folding it would adopt another tool's directory as ours to delete), and `asciiLower`'s doc now names both operands. Added assertions to the existing marker test in tools/cli/pane-clear.test.mjs covering both halves (`Agwinterm` marker vs `agwinterm` pane matches; a U+212A marker does not).

2. Line-wrapped code span splits `AGWINTERM-KIOSK` (docs/design/06-acceptance.md:366)
Confirmed byte-for-byte — a closing backtick after `AGWINTERM-` and an opening one before `KIOSK`. Reflowed so the identifier sits in one span.

3. Raw U+212A in the two .mjs fixtures (tools/cli/pane-clear.test.mjs:217, tools/cli/unsupported.test.mjs:263)
Confirmed. Both now spell it `"AGWINTERM-\u{212a}IOSK"`, matching agwinterm.rs:1729, and the all-ASCII control line carries a one-line comment marking it as the contrast.

Valid pre-existing — fixed

4. JavaScript and Rust trim different code points (cli/src/pane.ts:207)
Confirmed and real. ECMAScript's WhiteSpace includes U+FEFF and Rust's `char::is_whitespace` does not; Rust's includes U+0085 NEL and JS's does not. The divergence was not confined to the allow-list — the same `trim` gates `AGWINTERM_PIPE` and `AGWINTERM_SESSION_ID` through `nonempty` on both sides, where a BOM-padded pipe name passed `PIPE_NAME` in the CLI and failed `valid_pipe_name` in the engine. Fixed at the shared helper in each language rather than at the one call site: `PADDING`/`trimmed` in both TypeScript copies, `fn trimmed` in agwinterm.rs. Both sides now trim `White_Space ∪ {U+FEFF}`, which is provably the same set (JS ∪ {NEL} == Rust ∪ {ZWNBSP}). Covered by assertions in the existing fold tests on all three readers plus a `HOST_CASES` row; no `it()` or `#[test]` count moved.

Invalid — not fixed

5. A starting publisher can delete a live idle publisher's directory (engine/crates/pixel-core/src/frame_file.rs:385)
The failure sequence is accurate, but this is a documented, deliberate trade, not an oversight — and the finding concedes as much ("leave as-is ... may be the intended resolution"). The `STALE_AFTER` doc at frame_file.rs:96-113 names the window, names its consequence, gives the reason liveness-based sweeping was rejected (pid reuse strands real wrecks unboundedly, which is the commoner and unbounded failure), and closes with "An hour is chosen to make the window rare rather than to make it impossible." The suggested fix — touching the directory's mtime on the frame-budget tick — changes publisher behaviour to buy a rare case at the cost of the mechanism the doc explicitly weighed and rejected. That is a design decision for the plan to reopen, not a review correction.

Also noted, not fixed: `just lint` (`cargo clippy --workspace --all-targets -- -D warnings`) currently fails on 14 pre-existing sites in upstream files this branch never touched — pixel-core canvas.rs, tree/mod.rs, selection/doc.rs, throttle.rs, and pixel-node capture.rs/record.rs/lib.rs. None are in agwinterm.rs or frame_file.rs, and none were introduced here. Sweeping them is a separate change; say the word and I will. Likewise `cargo fmt --all --check` has pre-existing drift across ~40 upstream files — the two files I touched are fmt-clean.

Verification: 365 node tests across 18 suites pass (counts unchanged, matching the docs), 395 pixel-core Rust tests pass, `tsc --noEmit` clean, cli/dist rebuilt so the acceptance suite runs against current source. Nothing committed.

Re-evaluate considering Claude's arguments. If Claude's fixes are correct, acknowledge them.
If Claude's arguments are invalid, explain why the issues still exist.