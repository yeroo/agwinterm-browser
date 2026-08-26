# Review: ralphex-20260826-deferred-browser-defects / 20260826-214759

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260826-deferred-browser-defects\20260826-214759\input\scope.md`

## Minor

### The "Safe twice" comment (and its test) names the one interleaving the `closing` guard prevents

`browser/src/foreground.ts:62-64`

The doc comment's third bullet justifies idempotency with "Both exit routes can be in flight at once (a signal during an `onClose` teardown)". That ordering cannot reach `releaseProfileLock` twice: `onClose` sets `closing = true` as its first statement (foreground.ts:118) and `stop` returns on `if (closing) return` (foreground.ts:84), so a signal arriving during an `onClose` teardown schedules nothing. `tools/browser/foreground.test.mjs:253-255` repeats the same justification ("A signal arriving during an `onClose` teardown reaches here twice"), so the test that pins this comment carries the error too.

The reverse ordering does put both routes in flight — `stop` calls `session.close(code)` (foreground.ts:87), which is `session.shutdown(code)` and invokes `ctx.onClose` synchronously at session.tsx:529, inside `stop`'s 200ms window, and `onClose` is not gated on `closing`. But that alone still yields one release in production: `onClose`'s `setImmediate` runs `releaseProfileLock` then `app.exit`, which terminates before the 200ms timer fires. `shutdown` is also re-entrancy-guarded (`if (this.shuttingDown) return`, session.tsx:508), so the session cannot emit `onClose` twice.

The reachable second call is the one this change added elsewhere: `main.tsx` registers `process.on("exit", releaseProfileLock)` alongside the explicit calls, and its own comment says the explicit calls stay because `app.exit` is not specified to run Node's exit handlers — so on any exit where they do run, release runs twice. The `.catch` handler in `main.tsx` is the plainest case: `releaseProfileLock()` then `app.exit(1)` then the `exit` handler. The property is genuinely required; only the example given for it cannot occur.

Fix: Replace the parenthetical with a route that actually reaches release twice — the explicit call before an `app.exit` followed by `main.tsx`'s `process.on("exit", releaseProfileLock)`, which is why the explicit calls and the handler coexist. Fix the same sentence in `tools/browser/foreground.test.mjs:253-255`, since that test is what holds the comment to the code.

_confidence: 85 | sources: arch+quality | lenses: quality | verdict: refined_

### Docstring justifies the extraction with a duplication that did not exist

`tools/lib/deadline.mjs:103`

The docstring closes with "three suites had each grown their own copy of this loop" as the reason `settlesWithin` belongs in this module. On `main` exactly one copy existed: `tools/acceptance/pane-clear.test.mjs:137`'s `settles`, which this change deletes. `git grep "async function settles" main -- tools/` returns that one line and nothing else.

The other two suites that now call it — `tools/browser/foreground.test.mjs` and `tools/acceptance/profile-lock.test.mjs` — are files this same change creates, so they never grew a copy of anything. The stated history is of a de-duplication that did not happen; the real reason is that one existing copy plus two new callers made it worth hoisting, which is a good enough reason on its own.

This file's comments are the project's record of why its waits are shaped as they are — the header two functions up dates the incident that motivated the module — so a fabricated precedent in one is worth correcting rather than leaving for the next reader to try to verify.

Fix: "…and one suite had grown its own copy, with two more about to," or simply drop the clause — "every wait in this tree says what it was waiting for and is bounded" already carries the argument.

_confidence: 90 | sources: docs+tests | lenses: comments, docs | verdict: confirmed_

### New `settlesWithin` export is the only bound on five waits and has no test in the suite that tests every other export

`tools/lib/deadline.mjs:105-112`

`tools/lib/deadline.test.mjs` imports and exercises every other export of this module — `withDeadline`, `listen`, `closeServer`, `onceWithin`, `teardown` — and its header states the rule: "'fails instead of hanging' is only a claim if something actually stalls," written after `tools/cli/registry.test.mjs` hung on 2026-08-21 and left three node processes alive for eighteen hours. This change adds a fifth export and does not touch that file (`git diff main...HEAD -- tools/lib/` shows `deadline.mjs` only).

`settlesWithin` is now the sole bound on five waits: `tools/browser/foreground.test.mjs:196`, `:221`, `:288`, `tools/acceptance/profile-lock.test.mjs:442` and `tools/acceptance/pane-clear.test.mjs:295`. None of those callers has any other timeout.

Named defect: move or drop the `if (Date.now() >= until) throw` at line 109 — say, past the `await` so a never-settling predicate re-enters the loop before the check, or delete the throw in a refactor — and `foreground.test.mjs:196` ("releases when the session closes itself") spins instead of failing. The run does not wedge: `package.json` pins `node --test --test-timeout=120000`, and `deadline.test.mjs:210-223` exists precisely to keep that backstop in place. The loss is the one the module header at `deadline.mjs:20-23` names as the reason these helpers exist at all — the backstop reports "this test file ran out of time" after two minutes, not "timed out waiting for app.exit after onClose". The identical regression in `withDeadline` is caught in a millisecond by `deadline.test.mjs:47`. The test belongs beside that one.

Fix: Add a case to `tools/lib/deadline.test.mjs` beside "a wait that never completes": call `settlesWithin(() => false, "a thing", 50, 5)` and assert it rejects with a message containing "a thing", plus one asserting it resolves as soon as the predicate flips.

_confidence: 85 | sources: docs+tests | lenses: tests | verdict: refined_

### Header says "the five keys below" but the file now sets six

`.ralphex/config:5-9`

This change rewrote the header from "Only the two lines below are this project's own decision" to "The five keys below are this project's own decision and each says why" in the same commit that added two keys. The file now sets six: `external_review_tool` (:14), `custom_review_script` (:21), `max_external_iterations` (:32), `review_patience` (:38), `max_iterations` (:46), `idle_timeout` (:51).

The count is the whole load the sentence carries — it is what tells a reader whether they have found every key this project pins and shadows out of the global config. Getting it wrong is how the previous "two" survived the addition of `max_external_iterations` and `review_patience`; the rewrite reintroduced the same drift one key later. Five matches the number of comment blocks, not the number of keys, which is probably where it came from.

Fix: "The six keys below", or drop the number and say "every key below is this project's own decision and each says why" so the sentence cannot go stale on the next addition.

_confidence: 95 | sources: docs+tests | lenses: docs, comments | verdict: confirmed_

### Plan still presents `store/src/instances.ts` as the untouched correct model, but the change rewrote its `alive()` rule

`docs/plans/20260826-deferred-browser-defects.md:35-41`

The plan's Context section is headed "The correct model already exists in this repo" and says `store/src/instances.ts:26-28` "gets it right"; Task 1 (:87-88) is written as bringing `profile.ts` up to it — "matching `store/src/instances.ts:26-28`". A reader takes from that: one file changed, the other was already right.

The diff changed `store/src/instances.ts` too. Its probe was `return code === "EPERM"` and is now `return code !== "ESRCH"` (:36), and it gained a new `Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff` guard (:25) that upstream and the pre-change file did not have. That is a behaviour change to a second file — an unrecognised probe code now reads as alive where it used to read as dead — in a plan whose Development Approach says "Update this plan when scope changes." The quoted lines `:26-28` no longer contain the comment quoted; it now sits at `:30-36`.

The change is recorded — `docs/design/UPSTREAM.md` divergence 13 explains it, and `tools/cli/store.test.mjs:317` pins it — so this is the plan file alone being left describing a world the code no longer has. It matters because the plan is what this project reviews the change against, and the profile names "a change that works but does not match the plan it was built from" as reportable.

Fix: Add a line to the Context section (or a Task 1 checklist item) recording that `instances.ts` was brought from `code === "EPERM"` to `code !== "ESRCH"` and given the same int32 guard, so the two files answer the third case alike — which is what `UPSTREAM.md` divergence 13 already claims of it — and refresh the `:26-28` citation.

_confidence: 85 | sources: docs+tests | lenses: docs | verdict: confirmed_

### The 32-profiles-taken test leaks a directory into the real %TEMP% on every run

`tools/browser/profile.test.mjs:296-301`

`claimProfile`'s fallback is `fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-"))` (profile.ts:32), and `os.tmpdir()` here is the machine's real temp directory — the bundle stubs only `electron` and `pixel-store`, and nothing in this suite redirects `TEMP`/`TMP` the way `tools/acceptance/pane-clear.test.mjs`'s `paneEnv` does. The test at line 281 drives that branch deliberately (32 locks, every probe throwing `EPERM`) and then asserts the directory exists (line 296), but the only cleanup in the file is `after(() => fs.rmSync(scratch, ...))` at line 44, and `scratch` is a different root.

So each `node --test "tools/*/*.test.mjs"` leaves one more empty `%TEMP%\terminal-browser-XXXXXX` directory behind, permanently. Every other suite in this tree cleans up after itself — `pane-clear.test.mjs` goes as far as asserting no child of the suite survived — and this is new test code introducing the one kind of state that outlives the run.

Fix: `t.after(() => fs.rmSync(chosen, { recursive: true, force: true }))` on the directory the assertion at :296 already captured. (Setting `process.env.TEMP`/`TMP` around the `claimWith` call also works — `os.tmpdir()` reads them at call time — but the one-line `t.after` stays at the site.)

_confidence: 90 | sources: bugs+impl | lenses: bugs | verdict: refined_

## Immaterial

### Failed exclusive claims fall back to a non-atomic read/write

`browser/src/profile.ts:21`

After `writeFileSync(..., { flag: "wx" })` fails, the fallback assumes the lock remains stable. If a crash left a stale lock and two browsers launch concurrently, both can read the dead PID, both pass `alive(holder)`, and both overwrite the lock here before selecting the same `userData`; one then encounters Chromium's profile-lock conflict instead of receiving its own profile. That atomicity defect is itself pre-existing. What the change adds is another interleaving: the new normal-exit cleanup lets an owner remove its lock between a claimant's failed `wx` and its `readFileSync`, so `ENOENT` reaches the outer catch and the claimant skips a now-free primary profile. The acceptance tests exercise these operations sequentially, so neither race is covered.

Fix: After determining a lock is stale, remove it and retry acquisition using `wx`; likewise retry the same profile when the lock disappears before it can be read. Never claim a profile through an unconditional overwrite.

_confidence: 90 | sources: adversarial | lenses: adversarial | verdict: immaterial_

### After a hard kill, a stranded lock is now permanent and silent — the only self-healing path was removed

`browser/src/profile.ts:66-74`

`alive()` now answers `true` for every probe failure except `ESRCH`, and the `EPERM` branch is deliberately silent (`if (code !== "EPERM")` guards the only `console.warn`). Task 2 closes three of the four routes that can strand a lock (the two `app.exit` routes, the six daemon ones, and — via `main.tsx`'s `process.on("exit")` — the uncaught-throw route). It cannot close the fourth: a `taskkill /F`, a power loss, or a job-object teardown leaves `terminal-browser.lock` behind with no handler run at all. This repo produces that state routinely — `pane-clear` exists because of it, and `tools/acceptance/pane-clear.test.mjs` and `profile-lock.test.mjs` both manufacture it with `taskkill /F`.

Before this change that residual leak healed itself: upstream's blanket `catch { return false }` meant the next launch reclaimed the directory whatever the probe said. Now it only heals while the stranded pid probes `ESRCH`.

Concrete failure: the machine loses power with a browser holding `%APPDATA%\terminal-browser`, whose lock names pid 6820. After reboot Windows hands 6820 to a service running as SYSTEM. Every later launch reads the lock, probes 6820, gets `EPERM`, calls it alive (profile.ts:72), `continue`s at profile.ts:20, and opens `terminal-browser-2` — with none of the user's cookies. That is exactly the "user appears logged out" symptom this plan names as the whole defect, arriving from the other side, and it now lasts as long as that SYSTEM process does rather than one launch. Nothing is printed on the way past, so there is no thread to pull and no documented recovery beyond deleting the lock by hand.

The plan does record the tradeoff in Technical Details, and the asymmetry argument behind it is defensible in general — but the argument it rests on ("refusing a profile that was in fact free costs one numbered directory") understates the cost, because a numbered directory the user did not expect *is* the logged-out symptom. It also sits against the plan's own Task 4 requirement that "the fix must not make recovery from a real crash worse", which the acceptance test only checks for the non-recycled pid — the case that never regressed.

Pre-existing only in part: the recycled-pid-probes-ok case is upstream's and unchanged. The `EPERM`/unknown-code case is introduced here.

Fix: Apply the plan's own "a guess nobody can see is what the warning removes" rule to the skip rather than only to the unrecognised code: when `claimProfile` lands on a numbered directory other than the one it started at, print which lock it skipped and which pid it believed, e.g. `terminal-browser: profile 1 is held by pid 6820 (EPERM — alive); using profile 2`. That turns a silent permanent logout into one the user can diagnose and clear, and costs one line. A stronger option, if it is worth the divergence, is to make the lock self-identifying — write the process start time alongside the pid and treat a mismatch as stale — so a reissued pid stops reading as the original holder at all.

_confidence: 70 | sources: bugs+impl | lenses: bugs, impl | verdict: immaterial_

### instances.ts was changed, silently, in a file the plan cited as already correct

`store/src/instances.ts:36-38`

The plan's Context section holds `store/src/instances.ts:26-28` up as "The correct model already exists in this repo" and Task 1 asks only that `browser/src/profile.ts` be brought to match it. The change instead edits both: `instances.ts` moves from `code === "EPERM"` to `code !== "ESRCH"`, which flips the verdict for every unrecognised code from dead to alive.

That is work the goal never asked for, and it lands without the one property the plan made a constraint for exactly this decision — "an unexpected code should be loud rather than silently treated either way." `profile.ts:67` honours it with a `console.warn`; `instances.ts` has no equivalent, so an odd probe failure here is silently read as alive with nothing on the record. `docs/design/UPSTREAM.md` divergence 13 and the comment at instances.ts:34 both claim the two files "read the same code the same way", which is true of the verdict and not of the reporting.

Runtime impact is contained rather than absent. `stillThere` (instances.ts:100) turns `!alive(pid)` into `absent` and deletes the row; with the new rule an odd code instead falls through to `endpointStatus`, which on Windows resolves the row anyway because every endpoint is a pipe (`isPipeEndpoint`, endpoint.ts:34). The cost is one wasted `ENDPOINT_PROBE_MS` budget on `ls`. On a non-pipe endpoint, instances.ts:101 returns `alive` outright and the phantom row survives indefinitely.

(Corroborated in substance by the plan-drift finding on the same edit at docs/plans/20260826-deferred-browser-defects.md:35.)

Fix: Either drop the `instances.ts` edit — the plan asked for `profile.ts` to match it, not the reverse — or, if the two really are meant to agree, give it the same warning `profile.ts:67` emits so the third case is loud in both, and correct the "reads the same code the same way" claim in UPSTREAM.md divergence 13 and the comment at instances.ts:34.

_confidence: 75 | sources: bugs+impl | lenses: impl | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 2714822 | 3 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 1841624 | 2 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 3552148 | 4 | ok |
| adversarial | codex | gpt-5.6-sol | high | 146900 | 1 | ok |
