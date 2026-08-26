# Review scope (handed over by ralphex)

This round was opened automatically by ralphex's external review phase for the
task it just implemented. Everything below is ralphex's own review prompt,
verbatim — it carries the goal, the exact diff command for this iteration, and
the paths to the plan and the progress log.

Review the diff it names. The plan file states what the task was supposed to do;
a change that works but does not match the plan is a finding worth reporting.

---

You are reviewing code changes for: implementation of plan at C:\Users\boris\source\winterm-browser\docs\plans\20260826-deferred-browser-defects.md

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

Check the progress log at C:\Users\boris\source\winterm-browser\.ralphex\progress\progress-20260826-deferred-browser-defects-codex.txt for previous review iterations and findings history before reporting issues.

## Important

- Focus on real problems, not style preferences
- Check if issues are already mitigated in the code
- Only report issues you can verify by reading the actual code
- Be specific about file paths and line numbers

---
PREVIOUS REVIEW CONTEXT:
Claude (previous reviewer) responded to your findings:

I'll evaluate each finding against the code.Now applying the fixes.Now the `settlesWithin` test and the temp-directory leak.Now the plan drift on `instances.ts`.As expected — the staleness guard. Rebuilding.All 550 node tests pass, 125 suites, 0 skipped. Not committing, per instructions.

Evaluation of each finding:

Fixed — valid

1. foreground.ts:62-64 "Safe twice" names an interleaving the closing guard prevents. Confirmed. onClose sets closing = true first (foreground.ts:118) and stop returns on if (closing) return (:84), so a signal during an onClose teardown schedules nothing. The reverse ordering does put both in flight, but onClose's setImmediate runs release then app.exit before stop's 200ms timer, and Session.shutdown is re-entrancy-guarded (session.tsx:508), so still one release. The genuinely reachable double call is main.tsx's process.on("exit", releaseProfileLock) alongside the explicit calls. Rewrote the bullet to name that route and why the two coexist, and rewrote the matching test title and comment in tools/browser/foreground.test.mjs.

2. tools/lib/deadline.mjs:103 docstring claims three suites had grown their own copy. Confirmed false. git grep "async function settles" main -- tools/ returns exactly one hit, pane-clear.test.mjs:137; the other two callers are files this change creates. Dropped the clause — "every wait in this tree says what it was waiting for and is bounded" already carries the argument.

3. settlesWithin had no test in the suite that tests every other export. Confirmed. Added three cases to tools/lib/deadline.test.mjs: rejects at the deadline with the named subject, returns as soon as the predicate flips, and does not poll again once settled. The first is the one that catches a moved-or-dropped deadline check; without it, five waits across three suites degrade to a 2-minute --test-timeout that names the file, not the wait.

4. .ralphex/config header said five keys, file sets six. Confirmed. Changed to "Every key below" so the sentence cannot go stale on the next addition, which is how "two" survived the previous two additions.

5. Plan drift on store/src/instances.ts. Confirmed — the diff moved it from code === "EPERM" to code !== "ESRCH" and added the int32 guard, and the plan's Development Approach requires updating on scope change. Added a "Scope correction" note to the Context section explaining why the model itself needed the fix (its rule answered the third case the way Task 1 rejects), refreshed the stale :26-28 citation to :30-36, and added the Task 1 checklist item.

6. tools/browser/profile.test.mjs leaked a directory into the real %TEMP% every run. Confirmed — nothing in that suite redirects TEMP/TMP, and claimProfile's fallback mkdtemps into os.tmpdir(). Added t.after cleanup, registered before the assertions so a failing one still cleans up, guarded to only remove a path outside scratch. Verified by running the suite and counting %TEMP%\terminal-browser-* before and after: unchanged. (75 empty directories from earlier runs are still there; those are outside the repo so I left them rather than mass-deleting from %TEMP% — say the word and I'll clear them.)

Also updated the counts that these tests pin: 547 → 550 and 124 → 125 suites in docs/design/06-acceptance.md:215, "the rest" 157 → 160 (column re-verified to sum to 550), the re-count sentence, and README.md:31.

Not fixed — explanation

7. profile.ts:21 non-atomic fallback (marked immaterial). The atomicity defect is upstream's and pre-existing. The new interleaving is real but strictly smaller than what it replaced: an owner removing its lock between a claimant's failed wx and its readFileSync gives ENOENT, the outer catch continues, and the claimant takes the next numbered directory — one cookie-less profile, self-correcting on the next launch, in a window of microseconds that also requires a concurrent launch and a concurrent exit. The leak it replaced was permanent. Fixing it means restructuring claimProfile, which the plan explicitly costs out: profile.ts is vendored and byte-identical to 45b5e43 apart from divergence 13, and every edit to it widens a divergence that the re-vendoring checklist singles out as the one to re-apply by hand.

8. profile.ts:66-74 stranded lock after a hard kill is now permanent and silent (marked immaterial, confidence 70). This is the plan's decided tradeoff, recorded in Technical Details:255-260 and in UPSTREAM.md divergence 13, and the asymmetry argument is stated there. Three of the four stranding routes are closed by Task 2 plus main.tsx's exit handler. The remaining one — taskkill /F, power loss, job-object teardown — heals only if the pid probes ESRCH, which is the accepted cost of not letting a second browser take a live elevated browser's userData. The suggested extra warning on a skipped profile is a runtime behaviour change to vendored code beyond the plan's scope, at the cost of another divergence line. Worth raising as a follow-up, not worth widening divergence 13 for inside this plan.

9. instances.ts warning asymmetry (marked immaterial). Kept the edit — dropping it would leave the tree holding two different liveness verdicts about one pid, which is what UPSTREAM.md divergence 13 says it exists to prevent. The over-claim in the comment was real, so I corrected it: instances.ts now says it reaches the same verdict from the same code, and states why it does not also warn — profile.ts probes once per launch and the answer decides which profile the user gets, while this probes once per row on every ls, where a repeated per-row warning stops being read. UPSTREAM.md divergence 13's wording is already scoped to profile.ts and needed no change.

Re-evaluate considering Claude's arguments. If Claude's fixes are correct, acknowledge them.
If Claude's arguments are invalid, explain why the issues still exist.