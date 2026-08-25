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

I'll work through each finding against the actual code.Now implementing the fixes. First, the `%SystemRoot%` guard — a shared drive-qualified helper:Now `taskkillPath` in main.ts:Now the `TASKKILL_TIMEOUT_MS` comment (`finally` → `try`) and the `catch { return }` fallback:The comment is accurate — the engine sets modes in `Terminal::new`, before any frame. Now the tilde expansion:Now extend the Rust test to cover the backslash spelling:Now update the tests that pin the old spellings:Now the pane-clear tests that pin `path.isAbsolute` in each body, plus the two stale comments:Now the test that describes the recovery steps as being in the `finally`, and the §1 sweep threshold doc:Now build and run the tests:Build is clean. Now the Rust tests and the JS suite:All seven findings were actionable and are fixed. Build clean, 391/391 JS tests and 410/410 Rust tests pass. Not committed.

What I did with each:

1. %SystemRoot% admits UNC and drive-relative roots (cli/src/pane.ts, cli/src/main.ts) — valid. Confirmed `path.isAbsolute("\\srv\share")` and `path.isAbsolute("/Windows")` are both true, and the second joins to a drive-relative spawn path. Replaced the duplicated `path.isAbsolute` check with one exported helper `windowsSystemRoot()` in pane.ts, shared by `cookConsoleModes` and `taskkillPath`, testing `/^[A-Za-z]:[\\/]/`. Sharing it also removes the "guard was on one copy only" failure mode the tests were written about. Updated the two tests that pinned the literal `path.isAbsolute` and added one pinning the drive requirement.

2. "Idempotent, so it runs either way" is false (cli/src/main.ts, cli/src/pane.ts) — valid, comments fixed rather than code gated. I checked the gating option and rejected it: `terminal_windows.rs:1159` creates `ModeGuard` inside `Terminal::new`, before any frame is published, and the doc at `terminal_windows.rs:1088-1100` records exactly that asymmetry ("the frame half of the wreck was guarded and the console half was not"). So a browser can set the modes and die before its first frame, and frame ownership is not a valid proxy for "a destructor ran" — gating on it would skip the restore on a real wreck. Both comments now say plainly that the modes half sets cmd's cooked default rather than restoring a saved mode, that it overwrites `ModeGuard`'s exact restore on clean exits, and why running it unconditionally is still the right trade.

3. Failed tree kill treated as confirmed termination (cli/src/main.ts:378) — valid, took the reviewer's refined fix rather than the original. The `catch` now falls back to `child.kill()` and falls through to the existing `Promise.race([dead, 1s])` instead of returning, so a refused or timed-out `taskkill` still gets a second route and the caller still waits. Cleanup stays unconditional, since the job object kills the browser at CLI exit with no destructor.

4. `TASKKILL_TIMEOUT_MS` comment says `finally` (cli/src/main.ts:344) — valid. Now says `try`, notes the `finally` holds only listener removal, and records the consequence the wrong word hid: being in the `try` is why `terminateTree` must never throw. Same wording fixed in the test comment that echoed it.

5. Tilde expansion only recognizes `/` (clipboard_image.rs) — valid. `looks_absolute` admits a leading `~` in either separator but only `~/` was expanded, so `~\Pictures\a.png` was probed as a relative literal against the browser's cwd. Added `strip_home`, Windows-only for the same reason `browser/src/url.ts:25` gives, with `under_home` re-deciding the UNC refusal for both prefixes. Extended the share-smuggling test to loop over both prefixes and added positive `~\` cases; recorded in UPSTREAM.md divergence 4 and the plan.

6. Root-relative LOCALAPPDATA (store/src/paths.ts) — valid, same class as the `/tmp/recordings` bug the port already fixed, and reachable because `launch.ts` spawns the browser with a different cwd than the CLI's. `windowsBase` now requires drive- or UNC-qualified; UNC is kept because a redirected profile resolves identically from every process. Tests extended with `\AppData\Local` and `/AppData/Local`, plus one pinning that a share is still accepted.

7. Stale `setRawMode` test comment (pane-clear.test.mjs) — valid. Rewritten in terms of the current mechanism; the file's own test at line 544 proves `setRawMode` is gone from `pane.ts`.

Also fixed the one filed as immaterial: docs/design/07-as-built.md §1 now names the week-long `MARKED_STALE_AFTER` threshold alongside the hour, since §1 is where a reader first meets the sweep.

Re-evaluate considering Claude's arguments. If Claude's fixes are correct, acknowledge them.
If Claude's arguments are invalid, explain why the issues still exist.