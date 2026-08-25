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

I'll examine each finding against the actual code.All three findings check out against the code. Let me verify the exact numbers, then fix.Confirmed: an unvalidated entry can Unicode-fold to the ASCII pipe while `eq_ignore_ascii_case` cannot match it (17 bytes vs 15). Applying the three fixes.Now verifying — tests, lint, and the doc counts the change touches.Now the full suites, plus the Rust lint scope check.The failure is the build-staleness guard tripping on my `pane.ts` edit, not a test defect. Rebuilding.365 / 88 — matching the doc's recorded counts, so no count edit is needed. Now Rust.All findings evaluated. Three fixed, one dismissed with reasoning.

Fixed

1. Fold-equivalence comment overstates its scope (cli/src/pane.ts:178-180, agwinterm.rs:335-336) — valid, fixed.

Confirmed against the code. pipeAllowed folds two operands but only one is validated: pipe passes PIPE_NAME at pane.ts:223 and unsupported.ts:171 (valid_pipe_name at agwinterm.rs:202), while list entries come straight from TERMINAL_BROWSER_ALLOW_PIPE and are only split/trimmed/emptied. I reproduced the divergence under node — "AGWINTERM-KIOSK" with U+212A KELVIN SIGN folds equal to "agwinterm-kiosk" in JS but is 17 bytes against 15, so eq_ignore_ascii_case cannot match it. The comment's claim that the two folds "agree on every input that gets this far" is true of the pipe and false of the entry. Both the pane.ts and agwinterm.rs comments now scope the guarantee to the pipe, name the entry as unvalidated, give the concrete homoglyph case, and record that the asymmetry is one-directional — the engine never admits what the CLI refuses, so the frame path still fails closed.

2. "forty lines away" in the acceptance doc (docs/design/06-acceptance.md:357) — valid, fixed.

pipeAllowed is at cli/src/pane.ts:182 and sameMark at :561 — 379 lines, opposite ends of the module. Replaced with "at the other end of the same module", which is what is actually true and carries the same point without a number that fails on inspection.

3. Test comment claims an assertion pins "*" when it contains none (tools/cli/pane-clear.test.mjs:207) — valid, fixed.

The assertion below it passes ("agwinterm-dev", "agwinterm-prod") — no wildcard on either side. Took the second remedy the review offered rather than the first: relabelled line 207 to match the Rust twin at agwinterm.rs:1714 ("Folding a name is not folding anything else: a different name is still one"), and added the missing wildcard assertion beneath it — pipeAllowed("*", "Agwinterm-Dev") === true — so the escape hatch is now genuinely pinned in this suite next to the fold it survives, rather than only at line 192 and in unsupported.test.mjs. The new assert sits inside the existing it(), so the suite is still 74 tests and no doc count moves.

Dismissed

4. Stale sweeping deletes live directories based only on frame activity (frame_file.rs:393) — not actionable as reported.

This is an accepted, documented trade-off, not an oversight. The sweep_stale doc comment states the design decision and its exact cost in the code: "By age, not by liveness: asking whether a pid is still alive is both racy (pids are reused) and more Win32 than this needs. The trade is that age only tracks painting — a directory gains a file every frame, so a browser drawing anything at all stays fresh, but an idle one goes quiet and can pass STALE_AFTER while still holding its pane." It then names the mitigation the finding itself identifies as partial (write_frame recreates on NotFound and calls remark). The residual force-kill window the finding describes is real and is precisely what that paragraph already discloses.

The proposed remedy — a renewable lease or heartbeat — means a timer or background thread in a crate whose stated design avoids exactly that, to close a window requiring an idle browser, a second publisher starting, and a forced kill before the next repaint. The review's own synthesis classified this as pre-existing and noted the change under review only corrects the comments describing it. I am not fixing it under a comment-correction round, since it is a deliberate architecture choice with its cost written down rather than a defect; changing it is a design decision for its own plan entry.

Also noted: the immaterial adversarial finding at pane.ts:190 is the same divergence as finding 1. I did not change the guard's behaviour. The verify pass's reasoning holds — the asymmetry only ever makes the engine refuse what the CLI allowed, so no wrong pane is ever drawn into, and hand-mirroring an ASCII fold into two TypeScript copies buys nothing observable. The maintainer-facing half is what the comment fix now covers.

Verification (all green)

- node --test "tools/*/*.test.mjs": 365 passed, 88 suites, 0 failed — matching the counts §6 records.
- cargo nextest run --workspace: 452 passed, 1 skipped, 0 failed.
- tsc -p cli/tsconfig.json: clean; corepack pnpm -r build rebuilt dist (the acceptance suite's staleness guard tripped on the pane.ts edit until I did, which is that guard working as intended).
- fmt-scope.py: 298 complaints, 0 on port lines. clippy-scope.py: 12 warnings, 0 on port lines.

Not committed — leaving the working tree for the next review iteration.

Re-evaluate considering Claude's arguments. If Claude's fixes are correct, acknowledge them.
If Claude's arguments are invalid, explain why the issues still exist.