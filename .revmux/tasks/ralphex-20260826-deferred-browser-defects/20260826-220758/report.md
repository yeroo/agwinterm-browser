# Review: ralphex-20260826-deferred-browser-defects / 20260826-220758

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260826-deferred-browser-defects\20260826-220758\input\scope.md`

## Minor

### The Scope correction's replacement citation `instances.ts:30-36` is stale on arrival

`docs/plans/20260826-deferred-browser-defects.md:47`

The new Scope-correction note says the quoted comment "now sits at `store/src/instances.ts:30-36`", and the Task 1 checklist item added at :96 repeats `:30-36`. That range was right for the file *before* this diff's own edit to `instances.ts`: at HEAD the comment ran 30-35 with the `return` at 36. The same diff appended lines to that comment, so it now runs 30-39 with the `return` at 40.

Following `:30-36` today lands mid-sentence — it stops at "…and this does not, deliberately:" — and excludes the `return (error as NodeJS.ErrnoException).code !== "ESRCH";` line that is the rule the citation exists to point at. (If the intent is only the two sentences block-quoted at plan:37-38, those are at `instances.ts:30-31`, which `:30-36` also does not name.)

:30-36 describes the comment as it stood before this diff extended it — which is exactly how the citation it was written to replace (`:26-28`) went stale in the first place. Prose only, and the surrounding sentence still conveys the right thing, but this note is the one place a reader is told where to look, it was added specifically to fix citation drift, and it was written and invalidated in the same change.

Fix: Cite `store/src/instances.ts:30-40` (comment plus the `return` that states the rule) in both :47 and :96, or drop the line numbers and cite `alive()` in `store/src/instances.ts` by name so the reference cannot go stale on the next comment edit.

_confidence: 95 | sources: bugs+impl, docs+tests | lenses: impl, docs | verdict: confirmed_

### Plan now cites the same comment at two different lines; :35 still says :26-28, and the range it should match is itself wrong

`docs/plans/20260826-deferred-browser-defects.md:35`

Verified. Plan:35 reads "`store/src/instances.ts:26-28` gets it right, and says why:" directly above the block quote, while the Scope-correction note this diff adds at :47 says the same comment "now sits at `store/src/instances.ts:30-36`". `instances.ts:26-28` is today `try {` / `process.kill(pid, 0);` / `return true;` — the probe, not the quoted comment.

Attribution checked in history: `:26-28` was accurate at `ddd456e`, where the comment sat at 26-27 with the return at 28; the non-int32 guard added in `0bfeb27` (HEAD~2, already committed) pushed it down. So the staleness of :35 itself pre-dates the working-tree diff. What this diff introduces is the intra-document contradiction — it refreshed the sibling citation at :96 and added a third at :47 while leaving the one directly above the quote, so one document now names two locations for one comment.

`tools/browser/profile.test.mjs:14` carries the same stale `store/src/instances.ts:26-28`; the diff to that file touches only the `t.after` cleanup around :278-295, so that reference is untouched and pre-existing.

Fix: Do not copy :30-36 to line 35 — that range is itself stale after this diff (see bugs+impl-2). Cite `store/src/instances.ts:30-40` (comment plus the `return` that states the rule) at :35, :47 and :96, or drop line numbers entirely and name `alive()` in `store/src/instances.ts`, which is what stops the next comment edit from breaking all four references again — including `tools/browser/profile.test.mjs:14`.

_confidence: 95 | sources: bugs+impl | lenses: impl | verdict: refined_

### Rewritten "Safe twice" bullet credits the `closing` guard for a property it does not provide

`browser/src/foreground.ts:62-69`

The bullet now reads "**Safe twice.** Not the two exit routes below — `onClose` sets `closing` as its first statement and `stop` returns on it, so at most one of them ever reaches an `app.exit`." That reasoning covers only the onClose-first ordering. The stop-first ordering — every signal exit, i.e. the common one — is inverted: `stop` (foreground.ts:88) passes its own `if (closing) return`, sets `closing = true`, and then calls `session?.close(code)` (:92), which is `session.shutdown(code)` (session.tsx:72) and invokes `this.ctx.onClose(code)` synchronously at session.tsx:529. `onClose` is not gated on `closing`, so it runs inside `stop` and schedules `setImmediate(() => { releaseProfileLock(); app.exit(code) })` (:133-136); control returns to `stop`, which then schedules its own `setTimeout(..., 200)` (:95-98). Both callbacks are in flight on every SIGINT/SIGTERM/SIGBREAK/SIGHUP exit, and the guard did nothing to prevent it — `stop` set the flag itself and never re-reads it.

The conclusion happens to hold, but for a reason the comment does not give: the `setImmediate`'s `app.exit` terminates the process before the 200 ms timer can fire. The property depends on `app.exit` being immediate, not on the `closing` guard. Nothing executes wrongly — but this doc comment is the tree's record of why `releaseProfileLock` must be idempotent, and it now tells the next reader the two scheduled exit callbacks are mutually exclusive by construction when they are not. A reader who trusts it and removes the `app.exit` from the `setImmediate` would conclude the double call is still impossible. The harness cannot contradict it either: `tools/browser/foreground.test.mjs:178` stubs the session with `close: () => {}`, so the signal test never drives `close → shutdown → onClose`.

Secondary, same two lines: "an uncaught throw reaches no explicit call" is over-broad — `main.tsx:83` is an explicit `releaseProfileLock()` on the IIFE's `.catch`. `main.tsx:31-33` states the precise case ("a callback the IIFE below is no longer awaiting"); this restatement drops the qualifier.

(One source also notes, as related and not a finding of its own, that the same ordering means `stop`'s 200 ms "beat" is pre-empted one tick later by `onClose`'s `setImmediate` on every signal exit. Another confirms the test-side half of the previous round's fix at `tools/browser/foreground.test.mjs:253-257` is correct.)

Fix: Drop the "onClose sets `closing` … so at most one of them ever reaches an `app.exit`" clause, or state the real mechanism: on a signal, `stop` reaches `onClose` synchronously through `session.close`, so both an immediate and a 200 ms timer are scheduled and only the first one's `app.exit` surviving makes it a single release; the `closing` guard covers the reverse ordering (a signal arriving after `onClose`). The `main.tsx` sentence that follows — `process.on("exit", releaseProfileLock)` alongside the explicit calls — already carries the bullet's argument on its own.

_confidence: 99 | sources: adversarial, bugs+impl, arch+quality, docs+tests | lenses: adversarial, bugs, impl, quality, comments, docs | verdict: confirmed_

### Suite header still cites the pre-branch `instances.ts:26-28`, which is now the probe

`tools/browser/profile.test.mjs:14-15`

`tools/browser/profile.test.mjs:14-15` reads "`store/src/instances.ts:26-28` already states the rule this file pins: `ESRCH` is the only \"gone\"." The citation is stale. Lines 26-28 of `store/src/instances.ts` are now `try { / process.kill(pid, 0); / return true;` — the probe. The comment stating the rule sits at :30-39 with the `return … !== "ESRCH"` at :40, shifted down by the non-int32 guard this branch added at :22-25.

The second half of the original finding does not hold as written. On `main`, `store/src/instances.ts:26-28` was exactly `// EPERM means … / // for processes at a higher integrity level. ESRCH is the only "gone". / return (error as NodeJS.ErrnoException).code === "EPERM";` (verified with `git show main:store/src/instances.ts`). So the sentence the header quotes *was* already there in prose at precisely those lines, and "states the rule" was true of the comment. What was not true is the code at :28, which answered every unrecognised code "dead" — the opposite of the third case this suite pins — and this branch is what brought the implementation to the stated rule. So "already" is imprecise rather than flatly wrong, and the actionable defect is the line range.

Provenance: the shift dates to commit dbf738f on this branch, not to the unstaged diff (which only extends the comment at :34-39 and moves nothing above :30). It is still this task's own edit that invalidated the reference, and this is the round that went and refreshed the twin citation in the plan — `docs/plans/20260826-deferred-browser-defects.md:47` now records that the comment "now sits at `store/src/instances.ts:30-36`" — so the test header reads as a miss in that sweep. `browser/src/profile.ts:44` carries the unnumbered form and is unaffected.

Fix: Update the range to match what the plan already uses for the same block — `store/src/instances.ts:30-36` — and, if you want the header to be exact, note that the file's code was brought to the rule alongside this change rather than having implemented it before.

_confidence: 85 | sources: docs+tests, arch+quality | lenses: docs, comments, architecture, quality | verdict: refined_

### "does not poll again once it has settled" does not test what its comment claims

`tools/lib/deadline.test.mjs:204-210`

The new case passes `every = 10_000` against `ms = 1000` and asserts only `assert.equal(calls, 1)`. Its comment states the property as "Checked before the first sleep, so a predicate that is already true costs nothing — every caller here polls for something that has usually happened." The assertion holds under either ordering.

`settlesWithin` is `for (;;) { if (predicate()) return; if (deadline) throw; await sleep(every) }` (deadline.mjs:107-111). Move the `predicate()` call to after the `await` — the exact defect the comment names, and the same shape as the regression the sibling case at :184 is written to catch — and this test runs `sleep(10_000)` once, then calls the predicate, which returns true, and `calls` is still 1. The assertion passes; the test just takes ten seconds, ten times its own stated deadline. With `--test-timeout=120000` nothing reports it, so the regression lands green.

It is not vacuous — it does pin that the predicate is not polled twice for an already-true condition — but the property the comment advertises, and the one that costs every caller a poll interval on the common path, is unasserted. It matters because this file's header (:10-11) makes "every test here is itself bounded" the rule and the module header (deadline.mjs:17-23) exists because a wait that turned into a slow pass rather than a named failure took a whole `pnpm test` run down; a case that degrades into a silent 10-second stall is the one shape worth not having here.

(The other two cases added in this block are sound: the deadline case at :191 fails fast with the subject in the message, and the :196 case pins the poll count exactly.)

Fix: Assert the elapsed time as well as the call count — `const started = Date.now()` before the call and `assert.ok(Date.now() - started < 1000, "the predicate was checked after the first sleep")`; with `every` at 10_000 the margin is not flaky. Alternatively reword the comment to claim only what `calls === 1` shows.

_confidence: 90 | sources: docs+tests, arch+quality | lenses: tests, comments, quality | verdict: confirmed_

## Pre-existing

### An uncapped poll interval can cross the deadline and admit late success

`tools/lib/deadline.mjs:108-110`

`settlesWithin` sleeps for the full `every` interval and, after waking, checks the predicate before checking whether `until` has passed. For example, with `ms = 50` and `every = 100`, a predicate that becomes true at 75 ms resolves successfully at roughly 100 ms; an always-false predicate also cannot reject until roughly 100 ms. Thus the exported helper does not reliably reject at its documented deadline, and tests can accept conditions reached outside their promised bound.

The reporting source marks this pre-existing relative to this diff: the loop body at :108-110 is not what the change edited, and the change's new tests do not exercise the accepted input either (the failure case uses `every = 5`, and the `every = 10_000` case starts true).

Fix: After the initial predicate check, cap each sleep to the remaining deadline and check expiration before accepting a predicate on subsequent polls.

_confidence: 90 | sources: adversarial | lenses: adversarial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 1293297 | 3 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 1825237 | 3 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 1587458 | 4 | ok |
| adversarial | codex | gpt-5.6-sol | high | 91182 | 2 | ok |
