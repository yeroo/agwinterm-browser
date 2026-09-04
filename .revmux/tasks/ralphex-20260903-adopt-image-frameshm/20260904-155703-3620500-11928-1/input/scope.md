# Review scope (handed over by ralphex)

This round was opened automatically by ralphex's external review phase for the
task it just implemented. Everything below is ralphex's own review prompt,
verbatim — it carries the goal, the exact diff command for this iteration, and
the paths to the plan and the progress log.

Review the diff it names. The plan file states what the task was supposed to do;
a change that works but does not match the plan is a finding worth reporting.

---

You are reviewing code changes for: implementation of plan at C:\Users\boris\source\winterm-browser\docs\plans\20260903-adopt-image-frameshm.md

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

Check the progress log at C:\Users\boris\source\winterm-browser\.ralphex\progress\progress-20260903-adopt-image-frameshm-codex.txt for previous review iterations and findings history before reporting issues.

## Important

- Focus on real problems, not style preferences
- Check if issues are already mitigated in the code
- Only report issues you can verify by reading the actual code
- Be specific about file paths and line numbers

---
PREVIOUS REVIEW CONTEXT:
Claude (previous reviewer) responded to your findings:

I'll evaluate each of the 12 findings against the code and the plan, then fix what holds up.Reads are done. Starting the edits now, beginning with the Rust producer side: the major fix in frame_file.rs, then the stale comments in both Rust files.Working through the remaining Rust edits in frame_file.rs and frame_shm.rs. They are independent of each other, so I'm issuing them together.The Rust suite passes. Now verifying the new tests actually ran, checking rustfmt and clippy, and running the affected Node suites.The one thing I'm waiting on is the background rebuild plus acceptance run. Nothing else is independent of it, so I'll check its interim output.The acceptance suite passes against the installed host: the fallback case ran and the two capable-host cases skipped. Last step is the full Node suite as CI runs it.All twelve findings held up against the code, the host's contract and the agwinterm checkout, and all twelve are fixed. Nothing is committed, since the review loop may run again.

Verdicts, in the review's order.

Major: the shared-memory route never refreshed its frame directory. Valid. On that route the only write is the first frame's marker, so the directory's mtime froze and another browser's sweep could reclaim it after a week, with no path to recreate it. Fixed in frame_file.rs: every accepted image.frameshm frame now runs a keep_fresh check on the directory before the marker step. A missing directory is recreated and re-marked, matching what write_frame does for the file route. A directory that has gone ten minutes without a write gets its marker rewritten through a stage-and-rename, because a directory entry changing is what moves an NTFS directory's timestamp, so a painting publisher stays ahead of the sweep on both routes. The doc comments on the stale thresholds, sweep_stale and remark, plus the as-built doc, now describe both routes. Two new tests pin both halves: a swept directory comes back with its marker over the mapping route, and a quiet marked directory has its timestamp moved and its marker intact.

Minor, all valid and fixed:
- Three comments naming the old written.is_empty() clear guard now say placed.
- Both once-per-publisher comments now say once per route and point at Warned.
- The producer rule cross-reference now cites the second rule and names producer::RANGE.
- The release claim was wrong: in the agwinterm checkout, v0.17.10 contains 8230d0e and its ControlServer.cs carries the verb. Every site now says "from v0.17.10" or "before v0.17.10", including the runtime warning, the module docs, README, the four design docs, and the acceptance test's skip reasons. The plan file was left as a dated record.
- The PAGE doc now says what the rounding buys: slots a whole number of pages apart, not page-aligned starts.
- The frame:0/0 comment, the Source::Mapping message and the two test comments now state that the contract rejects an unopenable mapping with ok:false, and that this arm is defensive handling. The logon-session advice is gone and the test with the impossible scenario in its name was renamed.
- The per-case teardown now dequeues the pid after forceKill confirms it dead, and leaves it queued only when the kill could not be confirmed.
- forceKill now waits for the pid to be gone and throws otherwise, so the file-level assertion can actually fail.
- exchange in both the acceptance test and the measurement driver now owns its deadline and destroys the socket on expiry, and the redundant withDeadline wrappers around it are gone.
- The pane.ts comment now attributes frames-without-marker to a browser killed between the PNG write and the host's reply.
- The docs-check comment now claims only the substring presence it tests.

Immaterial finding, also fixed since it was a one-line contract check: Layout::for_frame now rejects a frame above the host's 256 MiB per-request copy limit before any mapping is created, with a test.

Verification:
- cargo nextest for pixel-core: 471 passed before the Node changes, and the five new or touched Rust tests pass by name. The unix-target cargo check is clean apart from its two pre-existing warnings.
- fmt-scope.py and clippy-scope.py: 0 port-line complaints. The 297 rustfmt and 12 clippy complaints are all on vendored lines, which the CI workflow explicitly excludes from the gate and warns against reformatting, so I left those files alone.
- Full node suite: 575 tests, 573 pass, 2 skipped (the capable-host acceptance cases, since the installed agwinterm predates v0.17.10), 0 fail. The first full run had a single flake in tools/browser/foreground.test.mjs, a file I did not touch; it passed alone and on the second full run. The acceptance suite also passed on its own after rebuilding the CLI dist and the native module, which its stale-build guard required.

Re-evaluate considering Claude's arguments. If Claude's fixes are correct, acknowledge them.
If Claude's arguments are invalid, explain why the issues still exist.