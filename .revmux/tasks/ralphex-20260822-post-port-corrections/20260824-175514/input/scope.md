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

Check the progress log at C:\Users\boris\source\winterm-browser\.ralphex\progress\progress-20260822-post-port-corrections.txt for previous review iterations and findings history before reporting issues.

## Important

- Focus on real problems, not style preferences
- Check if issues are already mitigated in the code
- Only report issues you can verify by reading the actual code
- Be specific about file paths and line numbers

---
PREVIOUS REVIEW CONTEXT:
Claude (previous reviewer) responded to your findings:

I'll work through each finding against the actual code.Now I'll apply the fixes. Starting with `cli/src/pane.ts`:All eight minor findings plus the immaterial one were checked against the code. Seven were real and are fixed; two needed a different resolution than the one proposed. Nothing is committed.

Fixed

- pane.ts module header asserted the two claims the change corrected elsewhere (finding 1). Confirmed: lines 15-17 still said "outlives the browser by construction, whatever killed it" and "sending image.clear twice is harmless", both of which 06-acceptance.md:130 flags in bold as the gap, and the second of which the ownership rule exists to deny. Rewrote the header to say the CLI outlives the browser only when the browser is what died, why a taskkill on the CLI runs neither half, and that an extra image.clear takes down whoever's placement is on the pane. Also updated restorePaneConsole's "openInForeground is the only survivor" to name paneClearCommand as the other, and the same stale sentence in tools/cli/pane-clear.test.mjs's header.

- The comment's stated reason for where pane-clear lives (finding 2). Confirmed: main.ts:8-41 are all static top-level imports, fully evaluated before the command === "pane-clear" branch at main.ts:849, so the verb gets no load-time protection from pane.ts importing only builtins. Cut the claim and said so explicitly rather than leaving a runtime guarantee a later reader could rely on.

- A successful clear retired only one marker (finding 3). Real. Split ownedFrames into allOwnedFrames (every accepted directory, newest first) and made clearOwnedPaneFrame retire all of them on a confirmed clear: a pane holds one placement, so an older wreck's picture was replaced before the run and its marker is spent. Added retire(), which falls back to removing the pane marker alone when the directory will not delete — an unattributed wreck is one the broad question already declines to own, so no stale authorization survives. New test: "retires every spent wreck, not only the one it reported".

- frameRoots's env parameter was dead (finding 4). Real, and it split the two halves of clearOwnedPaneFrame across two environments. Threaded it instead of dropping it: OwnedFramesOptions gained env, searchedRoots passes it to frameRoots, and clearOwnedPaneFrame scopes its options with its own env. Two new tests, one on searchedRoots directly and one end-to-end through a wreck under a caller-supplied TMP.

- Zero-placement replies created ownership evidence (finding 7). Real, and inconsistent with the module's own rule. check_transmitted now returns whether the host placed anything; publish_encoded treats frame:0/0 exactly as a refusal — removes the file, does not mark the pane, does not push to written. An unparseable reply still counts as a placement, so a future reply-format change cannot silently un-own frames. Two new tests. This also exposed a pre-existing test-isolation bug: a_frame_the_host_could_not_open_at_all_is_complained_about_too reads a process-wide log with no lock, so any other test emitting that warning breaks it. Renamed TRANSPORT_LOG to SHARED_LOG, widened its contract to "every test that writes a line one of these readers matches", and took it in all three.

- Expired exchanges started fresh one-millisecond reads (finding 8). Real: millis_until returns 1 past the deadline so an in-flight operation can still be collected and cancelled, and read_line went round for another read whenever the previous one returned bytes, leaving MAX_REPLY_BYTES as the only bound. Added expired(deadline, what), checked before starting each new read or write and never before collecting one already begun. New test drives a real named-pipe peer that drips a byte every 2 ms and never a newline; it now fails at the deadline instead of running to 4 MiB. Documented in 07-as-built.md beside the 1040 ms derivation.

- Doc counts (finding 5). Confirmed all three instances. Recounted everything: 450 nextest, 393+57 cargo test, 359 node in 87 suites, 8.1 s. Updated §6's results and coverage tables (pane-clear 69, agwinterm 47, frame_file 39 — the table said 36 while the file had 37 even before this round — the rest 122), README's 447/355, corrected "13 to 64" to "13 to 60" so the round-by-round chain reconciles, and added the fifth-round paragraph. For §4's duplicate count I did not simply refresh the number: a second copy of a count is a second thing to go stale, which is what happened. §4 now enumerates the rules qualitatively and points at §6 as the only place counts live. Same treatment for the plan's Task 7 write-up, which restated a table it does not own; its Task 6 measurement is now dated rather than presented as current.

- Broken cross-doc anchor (finding 6). Confirmed, including that the checker was why it passed. Fixed the link to #terminal_browser_allow_pipe--..., added _ to the class slug() keeps, and added a unit test pinning slug() against github-slugger's actual output — without it the anchor test is only as good as a slugger that can agree with a broken link.

Resolved differently

- ALLOW_PIPE_VAR exported with no consumer (immaterial). The observation is accurate, but deleting the export would have left CLEAR_CMD exported with no importer in the same file, so it would have traded one inconsistency for another. The better outcome was available: the drift tests at unsupported.test.mjs:279 and docs.test.mjs:415 matched the literal string in the source text, which a mere comment mention satisfies. Both CLI copies are now imported and compared as values against agwinterm.rs's declared name. The export has a consumer and the drift test is stricter. Test count unchanged.

Verification

- node --test "tools/*/*.test.mjs": 359 passed, 87 suites, 0 failed
- cargo nextest run --workspace: 450 passed, 1 skipped
- cargo test --workspace: 393 + 57 passed
- tools/vendor-check/fmt-scope.py: 298 complaints, 0 on port lines
- tools/vendor-check/clippy-scope.py: 12 warnings, 0 on port lines

One process note: I ran cargo fmt -p pixel-core at one point, which reformatted 29 vendored files — the silent edit the port's Constraints forbid. It was reverted immediately and the two intentionally-changed files were diffed against HEAD line by line to confirm only my own hunks survived; the scoped fmt script reports the same 298/0 as before.

Re-evaluate considering Claude's arguments. If Claude's fixes are correct, acknowledge them.
If Claude's arguments are invalid, explain why the issues still exist.