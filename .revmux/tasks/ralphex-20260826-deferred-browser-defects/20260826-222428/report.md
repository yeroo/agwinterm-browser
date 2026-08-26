# Review: ralphex-20260826-deferred-browser-defects / 20260826-222428

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260826-deferred-browser-defects\20260826-222428\input\scope.md`

## Minor

### New `settlesWithin` docstring claims an already-true predicate is the common case for its callers; it is false for the three that can be traced

`tools/lib/deadline.mjs:105-106`

The rewritten doc comment justifies the new pre-loop `predicate()` check with a claim about the callers that does not hold:

- `tools/lib/deadline.mjs:105-106` — "The predicate runs before the first sleep, so a condition that already holds costs nothing — which is the common case for every caller here."
- `tools/lib/deadline.test.mjs:205-206` — "Checked before the first sleep, so a predicate that is already true costs nothing — every caller here polls for something that has usually happened."

`settlesWithin` runs `predicate()` synchronously at call time (deadline.mjs:115, before the first `await`). Three of the five callers cannot be true at that instant:

- `tools/browser/foreground.test.mjs:196` — `ctx.onClose(0)` is the real `onClose` from `browser/src/foreground.ts:128`, whose only action is `setImmediate(() => { releaseProfileLock(); app.exit(code) })` (foreground.ts:139-142). `exits` is appended only inside `app.exit` (foreground.test.mjs:147), so `exits.length === 1` is structurally impossible at the first poll — it needs a turn of the loop.
- `tools/browser/foreground.test.mjs:290` — identical `setImmediate` shape.
- `tools/browser/foreground.test.mjs:221` — `handler()` reaches `stop(code)`, and `startForeground`'s session stub makes `close` a no-op (foreground.test.mjs:178), so `onClose` never runs and the only `app.exit` is behind `setTimeout(..., 200)` (foreground.ts:101-104). The predicate cannot be true for ~200 ms.

The remaining two are genuinely uncertain rather than provably false, and the original write-up overstated them: `tools/acceptance/profile-lock.test.mjs:442` calls `forceKill` (profile-lock.test.mjs:73-83), which on Windows is a *synchronous* `execFileSync("taskkill", ["/F", ...])`, so `!stillRunning(pid)` may well already hold on the first poll; `tools/acceptance/pane-clear.test.mjs:295` waits on a job-object teardown that is asynchronous relative to the CLI's `exit` event, so it is more often false. Either way "every caller here" is false, which is the claim the sentence makes.

Nothing executes wrongly — this is prose — but the project's own conventions list "a plan or doc left describing a world the code no longer has" as worth reporting, this module's comments are its record of why its waits are shaped as they are (the file header at deadline.mjs:17-23 dates the motivating incident), and the previous round already removed one fabricated justification from this same docstring ("three suites had each grown their own copy of this loop"). This is a second unverifiable rationale landing in its place.

The pre-check has a real justification the comment does not give: without it, `left <= 0` at deadline.mjs:118 would throw before `predicate()` ever ran for `ms = 0` (or any `ms` shorter than the caller's own setup), so the pre-check is what guarantees at least one poll.

Fix: Replace the "common case for every caller here" clause in deadline.mjs:105-106 with the property that is actually true — the pre-check guarantees at least one poll, so no `ms` is too short to consult the predicate once, and a condition that already holds does not cost an `every`. Make the same edit to the mirrored sentence at tools/lib/deadline.test.mjs:205-206; the rest of that comment (the elapsed-time argument) is sound and should stay.

_confidence: 80 | sources: arch+quality | lenses: quality | verdict: refined_

### The new test's comment describes a ten-second stall the same change's sleep cap makes impossible

`tools/lib/deadline.test.mjs:208-209`

The comment justifying the elapsed assertion reads: "move the check to after the `await` and `calls` is still 1, but this test sleeps ten seconds — a ten-times-its-own-deadline stall that `--test-timeout` is too far away to report."

That was true of the pre-change loop, which slept the full uncapped `every`. It is not true of the loop this same diff writes. With the pre-loop `if (predicate()) return;` (deadline.mjs:115) deleted — the exact mutation the comment names — control enters the loop, computes `left = until - Date.now()` ≈ 1000, and sleeps `Math.min(every, left)` = `Math.min(10_000, 1000)` = **1000 ms**, not 10_000. The cap added at deadline.mjs:119 is what removes the ten-second stall, so the comment describes behaviour the code beneath it no longer has.

The practical consequence is that the guard has no margin. `assert.ok(Date.now() - started < 1000)` is asked to distinguish an elapsed time of ~0 ms (correct) from ~1000 ms (mutated), and the mutated value sits exactly on the threshold: `until = t0 + 1000` with `t0 >= started`, so the wake lands at `>= started + 1000` and the assertion fails — by a millisecond of timer jitter rather than by the nine seconds the previous round's write-up claimed. Compare the sibling case at :219-230, which asserts the same `< 1000` bound against a real 50 ms deadline and so carries a 950 ms margin.

This is prose, so nothing executes wrongly today; the cost is that the next reader is told this test degrades into a loud ten-second stall when it degrades into a boundary-exact pass/fail.

Fix: Make the comment true rather than rewording it: pass `ms = 10_000` alongside `every = 10_000` (`settlesWithin(() => (++calls, true), "something already done", 10_000, 10_000)`). The correct code still returns in ~0 ms, the described mutation then really does sleep ten seconds, and `< 1000` regains a nine-second margin — which is what the comment already claims. Otherwise drop the "ten seconds" / "ten-times-its-own-deadline" clause and say the mutation costs exactly one deadline's worth of sleep.

_confidence: 85 | sources: docs+tests | lenses: comments, tests | verdict: confirmed_

## Pre-existing

### The 200 ms "give the session a beat" comment is contradicted by the bullet this change rewrote

`browser/src/foreground.ts:100-104`

`stop` still carries `// Give the session a beat to tear the surfaces down before the process goes.` above `setTimeout(..., 200)` at :100-104. The "Safe twice" bullet this change rewrites, 35 lines above, now states the opposite mechanism and states it correctly:

> `stop` sets the flag itself and then calls `session.close`, which is `Session.shutdown`, which ends by calling `onClose` *synchronously* — so `onClose` schedules its `setImmediate` from inside `stop`, and `stop` then schedules its own 200 ms timer on top. What makes that a single release is the first `app.exit` ending the process before the second callback runs

I traced both halves. `SessionHandle.close` is `(code = 0) => session.shutdown(code)` (session/session.tsx:72) and `shutdown` ends with `this.ctx.onClose(code)` as its last statement (session/session.tsx:529), reached synchronously. `onClose` (:139-142) schedules `setImmediate(() => { releaseProfileLock(); app.exit(code) })`, which runs in the check phase of the current event-loop turn. The 200 ms timer scheduled afterwards therefore never fires: `app.exit` terminates immediately.

So on the ordinary signal exit — every entry in `FOREGROUND_SIGNALS` with a session that shut down cleanly — the session gets no beat at all; the process goes on the next tick. The timer is still a real fallback for the cases where `onClose` is not reached (`session` still null, or `shutdown` throwing before its last line, which `stop`'s bare `catch {}` at :99 swallows), but that is not what the comment says it is for.

Why the change under review did not introduce it: the reporting source states the change did not introduce the ordering or the comment — `stop` and `onClose` are untouched by this diff, which only rewrites the neighbouring bullet at :62-75. The change is what made the contradiction visible, not what created it.

Fix: Reword :100 to what the timer actually is — the fallback exit for the paths where `onClose` never runs (`session` null, or `Session.shutdown` throwing before it reaches `onClose`) — rather than a beat the session is given, since the bullet at :62-75 already establishes that `onClose`'s `setImmediate` pre-empts it whenever the session shuts down cleanly.

_confidence: 80 | sources: docs+tests | lenses: comments, docs_

### The "give the session a beat" comment describes a 200 ms grace that the diff's own new bullet shows never happens

`browser/src/foreground.ts:100-104`

`stop` schedules `setTimeout(… , 200)` under the comment "Give the session a beat to tear the surfaces down before the process goes" (foreground.ts:100-104). The bullet this change rewrites (foreground.ts:62-68) establishes the opposite: `stop` calls `session.close(code)` → `Session.shutdown` (session/session.tsx:507), which ends with `this.ctx.onClose(code)` **synchronously** at session.tsx:529, and `onClose` (foreground.ts:128-143) schedules `setImmediate(() => { releaseProfileLock(); app.exit(code); })`. `setImmediate` fires in the check phase of the current loop turn, long before a 200 ms timer, so `app.exit` ends the process at ~0 ms and the 200 ms callback never runs. Concretely: send SIGINT to a foreground browser with a live session — the exit code and lock removal come from `onClose`'s `setImmediate`, and the "beat" the comment promises is zero. The timer is only reachable when `session` is still null (a signal in the window between the `process.on` loop at :117 and the `createSession` assignment at :119) or when `session.close` throws into the `catch {}` at :99. Nothing misbehaves at runtime; the cost is a reader trusting a grace period that does not exist.

Why the change under review did not introduce it: the reporting source states this diff touches neither `stop` nor `onClose`. The comment and the ordering both predate the change; the change only makes the contradiction plain by spending fourteen lines explaining the exact ordering that defeats the neighbouring comment while leaving that comment untouched.

Fix: Amend the comment at foreground.ts:100 to say the timer is the fallback for the case where the session never reached `onClose` (null session, or `close` threw), and that on the ordinary signal path `onClose`'s `setImmediate` gets there first — matching what the new bullet at :62-68 already states.

_confidence: 80 | sources: bugs+impl | lenses: bugs, impl_

### The session stub's `close: () => {}` never calls `ctx.onClose`, so the signal tests exercise a route production does not take

`tools/browser/foreground.test.mjs:178`

`startForeground`'s stub returns `{ ready: Promise.resolve(), close: () => {}, nudgeResize: () => {} }` (foreground.test.mjs:178). Production's `close` is `(code = 0) => session.shutdown(code)` (browser/src/session/session.tsx:72), and `shutdown` ends by calling `this.ctx.onClose(code)` synchronously (session.tsx:529) — the coupling this diff's rewritten bullet at browser/src/foreground.ts:62-68 now asserts as the mechanism. Because the stub breaks it, the signal tests at foreground.test.mjs:216-224 reach `app.exit` through `stop`'s 200 ms `setTimeout`, whereas a real signal exit reaches it through `onClose`'s `setImmediate`. The assertions (`exits[0].code`, `lockStillThere === false`) happen to hold on both routes, so nothing fails today — but the signal route's actual production path is unpinned. Concrete regression that escapes: replace `stop`'s `setTimeout(() => { releaseProfileLock(); app.exit(code); }, 200)` with a direct `releaseProfileLock(); app.exit(code);` after `session?.close(code)`. Every test in this file still passes, while in production `app.exit` now runs in the same tick as `Registry.dispose`'s async delete, resurrecting the phantom `instances` row that foreground.ts:130-138 documents as the reason `setImmediate` is there.

Why the change under review did not introduce it: the reporting source states this diff only rewrites the test's title and comment, not the stub. The stub's divergence from production predates the change; the change is what promotes it from a detail to a stated contract.

Fix: Have the stub model the real coupling: `globalThis.__fgSession = (given) => { ctx = given; return { ready: Promise.resolve(), close: (code = 0) => given.onClose(code), nudgeResize: () => {} }; }`, so a signal exit runs `stop` → `close` → `onClose` the way production does.

_confidence: 68 | sources: bugs+impl | lenses: impl, bugs_

## Immaterial

### The final predicate runs before confirming the deadline still holds

`tools/lib/deadline.mjs:120`

The attempted fix caps the sleep to `left`, but after that sleep line 120 accepts the predicate without checking the clock again. If the event loop services the final timer late—for example, at 75 ms for a 50 ms deadline—and the externally observed condition became true during that overrun, `settlesWithin` resolves successfully. The next iteration's `left <= 0` check is never reached. Thus the pre-existing late-success behavior remains despite the new comment claiming that a condition reached at 75 ms is no longer accepted. The added test at `tools/lib/deadline.test.mjs:225` uses an always-false predicate, so it verifies prompt rejection but cannot exercise this half of the contract.

Fix: After each sleep, check `Date.now() >= until` before consulting the predicate, and add a case where the event loop is delayed past the deadline while the predicate becomes true.

_confidence: 95 | sources: adversarial | lenses: adversarial | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 1501835 | 3 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 1985663 | 1 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 1089726 | 2 | ok |
| adversarial | codex | gpt-5.6-sol | high | 70849 | 1 | ok |
