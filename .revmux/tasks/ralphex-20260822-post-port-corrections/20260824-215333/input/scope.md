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

I'll analyze each finding against the actual code.Now I'll apply the ASCII-fold fix to both TypeScript copies.Now the Rust doc comment, which documented the divergence that no longer exists:Now the `unsupported.ts` table case and the Rust twin test:Now finding 3 — the `Pick` narrowing:Now the residual sweep window from finding 1 — documenting the gap the recovery path genuinely does not cover:Now build and run the full suites:All green. Here is what I found and did.

Finding 1 — "Age-based sweeping removes ownership evidence from live idle publishers" (frame_file.rs:393) — partially valid, addressed by documentation rather than redesign.

- The mechanism is real and the window the reviewer names is genuinely uncovered: write_frame's recreate and FrameDir::remark both run on the next frame, so an idle publisher swept out and then force-killed before any repaint leaves no directory and no marker, and pane-clear reports nothing owned.
- It is not, however, an oversight. sweep_stale documents the trade explicitly ("By age, not by liveness"), and the alternative the finding proposes is the one the code already rejects with a reason: a pid is reused, so a liveness test would strand real wrecks for as long as some unrelated process holds the number — an unbounded failure in the common case, traded against a bounded one in a rare case. A lease/heartbeat means new machinery (a timer thread refreshing mtime) that the corrections plan does not call for.
- I did check the cheap alternative — holding an open handle inside the directory so remove_dir_all fails for a live publisher. It does not work: modern Rust's remove_dir_all uses POSIX-semantics delete on Win10+, which unlinks despite open handles, so the sweep would still succeed.
- What was actually wrong was the comment: it cited write_frame and remark as the recovery without saying they run on the next frame and therefore miss this window. STALE_AFTER now names the window, names its consequence, and says why sweeping on liveness is the worse trade.

Finding 2 — "Unicode lowercasing admits allow-list entries the Rust guard rejects" (pane.ts:199) — valid, fixed.

- Confirmed the divergence: the TS copies folded with toLowerCase (Unicode) while allows_pipe uses eq_ignore_ascii_case. Only the pipe operand is ASCII-gated by PIPE_NAME; a list entry is whatever the variable held.
- Documenting the asymmetry did not satisfy the contract the same comment asserts ("allows_pipe in agwinterm.rs, character for character"). The reviewer is right that the previous round papered over it.
- Both TS copies now fold ASCII-only — an asciiLower helper in pane.ts, an inline copy in unsupported.ts, which imports nothing by design. The three long doc comments no longer document an asymmetry; they document why the fold is ASCII.
- Pinned on all three sides: a pane-clear.test.mjs pair, a HOST_CASES row (which drives both CLI readers), and a Rust assertion, all using AGWINTERM-\u{212a}IOSK against agwinterm-kiosk.

Finding 3 — "Pick does not reject pane on a pre-typed options value" (pane.ts:725) — valid, fixed.

- Confirmed: the Pick only rejected pane through the excess-property check on a fresh literal. A caller holding an already-typed OwnedFramesOptions passed it by structural assignability with pane intact and got exactly the silent no-op the comment claims is now a type error.
- Added pane?: never to the accepted shape, with a comment explaining why leaving the property off was not enough. Purely type-level; tsc is clean and no call site changed.

Verification: 365/365 node tests pass, 395/395 Rust tests pass, tsc --noEmit clean, cargo fmt clean on both touched Rust files, no new clippy warnings in them. Test counts the docs cite are unchanged (74 / 30 / 48 / 365) because every addition landed inside an existing test or table; 06-acceptance.md and 07-as-built.md both record the ASCII fold, the acceptance doc as a correction within the seventh round rather than an eighth, since no count moved.

Not committed.

Re-evaluate considering Claude's arguments. If Claude's fixes are correct, acknowledge them.
If Claude's arguments are invalid, explain why the issues still exist.