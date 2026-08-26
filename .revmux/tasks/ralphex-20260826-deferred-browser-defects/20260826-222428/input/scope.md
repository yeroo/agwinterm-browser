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

I'll start by reading the reported locations.Findings verified against the code. Now applying fixes.Now the stale `instances.ts` citations — replacing line numbers with the function name so they cannot drift again.Now the test-suite header citation:Now the `settlesWithin` deadline defect and the test that doesn't pin its stated property:Deadline suite passes. Now the full suite, to get the true count for the acceptance table:Now the full suite plus lint/typecheck:All five findings plus the pre-existing one were valid and are fixed. All 551 node tests pass; browser and store typecheck clean.

What I changed:

1. foreground.ts "Safe twice" bullet (browser/src/foreground.ts:62) — the finding is correct and the claim was backwards for the common path. Traced it: stop() sets closing itself, then calls session.close(code) → Session.shutdown(code) (session/session.tsx:72), which ends with this.ctx.onClose(code) synchronously at session.tsx:529. onClose is not gated on closing, so it schedules setImmediate(app.exit) from inside stop, and stop then schedules its own 200 ms timer. Both callbacks are live on every signal exit; the closing guard prevents nothing there. Rewrote the bullet to state the real mechanism — the first app.exit ending the process is what makes it one release, and closing covers the reverse ordering (a signal after the session closed itself). Also dropped the over-broad "an uncaught throw reaches no explicit call" (main.tsx:83 is an explicit call on the IIFE's catch) in favour of main.tsx's own qualifier: a throw from a callback the IIFE is no longer awaiting.

2 and 3. The instances.ts citations. Confirmed the comment is now at :30-39 with the rule at :40, so both :26-28 and the replacement :30-36 are wrong — the replacement was invalidated by the same diff that introduced it. Rather than re-pin a range that will drift again on the next comment edit, all four references now name alive() in store/src/instances.ts: plan lines 35, 47, 96 and the profile.test.mjs header. The Scope-correction note says explicitly why it cites by name.

4. profile.test.mjs:14 header — same fix, plus the accuracy point the reviewer raised: the comment stated the rule first, but the code answered code === "EPERM" until this task; the header now says so instead of "already states the rule".

5. deadline.test.mjs "does not poll again once it has settled" — the finding holds. calls === 1 passes under either ordering, so moving the predicate after the await leaves the test green while it sleeps ten seconds. Added the elapsed assertion (Date.now() - started < 1000, margin is 9 s so not flaky).

6. Pre-existing: settlesWithin overran its own deadline. An uncapped every meant late rejection and, worse, late acceptance — ms=50/every=100 accepted a predicate that only became true at 75 ms. The loop now checks the predicate once before any sleep, caps each sleep to the remaining time, and throws when nothing is left, so the last poll lands on the deadline. Added a test pinning it (every=10_000 against ms=50 rejects in under a second) and recorded the reasoning in the function's doc comment.

Test-count bookkeeping: the two new deadline cases move the node total 550 → 551, so I updated the acceptance table row, the "the rest" column (160 → 161), the sum sentence, the per-suite breakdown (lib/deadline +3 → +4, "nine cases" → "ten"), the wall clock, and the README figure the docs-check suite holds to it.

Not changed: docs/design/01-baseline-errors.md:110 cites store/src/instances.ts:39 for upstream's fs.rmSync(row.socket). That doc records the pre-port baseline, so its line numbers refer to the baseline file deliberately, not to the current tree.

Nothing committed — stopping here for the next review pass.

Re-evaluate considering Claude's arguments. If Claude's fixes are correct, acknowledge them.
If Claude's arguments are invalid, explain why the issues still exist.