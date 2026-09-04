# Review: ralphex-20260903-adopt-image-frameshm / 20260904-115622-3611031-23690-1

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260903-adopt-image-frameshm\20260904-115622-3611031-23690-1\input\scope.md`

## Major

### The shared-memory route never refreshes its directory and can never remark, so sweep_stale can reclaim a live publisher's only evidence

`engine/crates/pixel-core/src/frame_file.rs:880-883`

The staleness design rests on an invariant the fast path breaks, and the recovery it names is unreachable from that route.

The invariant is stated twice. `STALE_AFTER`'s doc says "A publisher that is *painting* refreshes its directory's timestamp for free: every frame creates a file inside it", and `sweep_stale`'s doc repeats it as "a directory gains a file every frame, so a browser drawing anything at all stays fresh". On the mapping route no file is ever created: `publish_shm` copies pixels into the mapping and writes only the marker, once, on the first accepted frame, under an `if !self.placed` guard. The directory's mtime is therefore frozen at the first accepted frame for the whole session, however hard the browser paints. The frame budget file cannot keep it fresh either, since it is opt-in and names a path of the user's choosing outside the directory.

The recovery is unreachable. `FrameDir::remark` has exactly one call site, the not-found arm of `write_frame`, which only the file route executes. Its own doc names precisely this failure: a publisher whose directory was reclaimed "would go on publishing frames nothing could ever attribute, and its wreck would be unrecoverable". `STALE_AFTER`'s doc makes the same promise about `write_frame` recreating a swept directory. Both mitigations live on the file route.

Failure case: a host with the fast-path verb, transport `auto`, a pane painting continuously for longer than `MARKED_STALE_AFTER` (seven days). The directory holds only the marker, timestamped at day zero. Any second browser launched anywhere on the machine runs `sweep_stale` over the shared temp root, sees the marked directory past its limit, and `remove_dir_all`s it out from under the live publisher. The publisher never notices and will not re-mark, because the accepted arm is guarded by `!self.placed`. The browser is then force-killed, so `Terminal::drop` never sends the clear. Nothing is left on disk, `allOwnedFrames` finds no directory, and `pane-clear` reports nothing owned against a pane that is still fully painted — the exact state this change was written to make recoverable.

The file route survives the same sweep because its next frame recreates the directory and re-marks it, so this is a degradation the change introduces rather than one it inherits. The plan file records no decision about `sweep_stale`, so it is not a deferred item either.

Fix: Give the fast path the recovery the file path has: in the accepted arm of `publish_shm`, when `self.placed` is already true, recreate the directory if it is missing and call `self.dir.remark()` before returning. Recreating it also refreshes the mtime, which stops the sweep reaching it. Whichever route is chosen, correct the invariant at `frame_file.rs:115-121`, `:401-410` and `:430-434` so it no longer claims every frame creates a file, or scope the promised recovery to the file route.

_confidence: 99 | sources: bugs+impl, arch+quality, docs+tests | lenses: bugs, impl, architecture, quality, comments, docs | verdict: unverified_

## Minor

### Three comments still name the removed written.is_empty() clear guard

`engine/crates/pixel-core/src/frame_file.rs:1202`

The branch moved `FramePublisher::clear`'s ownership test from `written.is_empty()` onto the new `placed` flag (frame_file.rs:748), and this round carried the rename through the CLI module comment, the marker constant's doc, `frame_file.rs:143`, `:184`, `:728`, the test comment at `:1833`, `pane-clear.test.mjs` and the as-built design note. Three sites in `frame_file.rs` were missed and still name a guard that no longer exists:

- `:986`, in `publish_encoded` — "both of them the 'clear a placement some other process owns' this publisher declines to do when `written` is empty"
- `:1202`, in `write_all_new` — "That is the very thing `FramePublisher::clear`'s `written.is_empty()` guard exists to refuse."
- `:2118`, in `a_frame_the_host_refused_names_no_pane` — "Same rule as `clear`'s `written.is_empty()`"

`written` is still a live field, now only the retention list that `reap` trims, so these read as a real guard rather than an obvious relic and point a maintainer at the wrong thing. On the fast path `written` is permanently empty while a placement exists, so following any of the three leads to the opposite conclusion from the code. The `:1202` one is worse than a stale name: it is the explanation of why a failed write must leave no marker behind, which is load-bearing reasoning for the ownership rule this change just moved.

The lines predate the working-tree diff and still exist on `main` with the same text, but the branch is what made them false by changing the guard, and this diff is the sweep that converted every other `written` mention. Prose only, so nothing runs wrong.

Fix: Replace all three with `placed`, matching the wording already used at `frame_file.rs:728` and on the marker constant.

_confidence: 99 | sources: bugs+impl, arch+quality, docs+tests | lenses: impl, architecture, comments, docs | verdict: unverified_

### check_transmitted's doc still calls the untransmitted warning once-per-publisher after this change made it per-route

`engine/crates/pixel-core/src/frame_file.rs:1066`

This diff replaced the single `warned_untransmitted` boolean with the `Warned` struct so each route latches its own complaint, and updated the inline comment at `:1102` to say "Per route rather than per publisher". Two comments describing the same latch were not updated and now contradict it:

- `:1066`, in `check_transmitted`'s own doc, immediately above the code that changed: "it does not spend the once-per-publisher warning below."
- `:2979`, in the test comment for the cache-hit case: "rather than spending the once-per-publisher stale-frame warning."

The same change states the rule twice in the same function and gets it right once. Both stale sites sit next to lines this diff edited, `:1102` for the first and the `.any()` assertion at `:2995` for the second, so this is an incomplete pass rather than an inherited defect. The claim matters because the whole point of the change is that the mapping route's complaint must not spend the file route's; a doc still saying the latch is per publisher describes the bug that was just fixed. Prose only, so nothing runs wrong.

Fix: Say "once-per-route" in both comments and point at `Warned`.

_confidence: 99 | sources: arch+quality, docs+tests | lenses: architecture, comments, docs | verdict: unverified_

### New producer-doc sentence cites the third rule for a guarantee the second rule carries

`engine/crates/pixel-core/src/frame_shm.rs:1504`

The reworded first bullet now ends "A second producer in the same process starts its own count at 1 — that is safe only because the third rule gives it names of its own."

The third bullet is "**A name is this process's alone, not its pid's**" (line 1514), which is about `process_start` separating this process from an earlier holder of the same pid. It says nothing about two producers within one process. What actually makes a second producer safe is the second bullet at line 1510: "The suffixes are the only thing that tells two producers of one process apart — the pid is the process's — so each producer owns a range of them ([`producer::RANGE`]) and none is ever offered by two."

A reader who follows the pointer lands on process-level uniqueness, finds nothing about a second producer, and is left believing the restarted sequence is unexplained. The sentence is new in this diff, and the miscount matches the previous review round's suggested fix text, which named the third bullet in error.

Fix: Say "the second rule", or refer to `producer::RANGE` by name rather than by bullet position.

_confidence: 90 | sources: docs+tests | lenses: docs, comments | verdict: unverified_

### A pid the teardown force-killed itself stays queued for a second, redundant tree kill

`tools/acceptance/frameshm.test.mjs:396-397`

The new teardown prunes `strays` on the fulfilled branch only:

```js
await settlesWithin(() => !alive(pid), "the browser to leave with its session", EXIT_MS).then(
  () => strays.splice(strays.indexOf(pid), 1),
  () => forceKill(pid),
);
```

That closes the success branch and leaves open the failure branch the queue exists for. The comment above gives the reason for pruning: "taken back off the queue once the browser is confirmed gone, because `forceKill` inspects nothing and the pid of a dead process is one Windows hands out again — to the next case's Electron, say." The reason applies just as well after the rejection branch runs, because `forceKill` there kills the process: the pid is then equally dead and equally reusable, but it stays in `strays` for the rest of the run.

Failure case: a case whose browser misses `EXIT_MS`, is force-killed at its own teardown, and whose pid Windows reissues to a later case's Electron. The file-level hook at line 250 maps every remaining entry through `forceKill`, which issues `taskkill /F /T` unconditionally and inspects nothing, taking that unrelated process and its tree down mid-run. The window is the remainder of the suite, longer than the window the pruning closes.

The retained entry also buys nothing: `forceKill` catches everything and never throws, so the second attempt cannot report a failure and the `assert.deepEqual(failures, [])` at `:251` cannot fail on it. Test-only code, so the blast radius is a developer machine, but it is a tree kill against a pid this suite does not own.

Fix: Prune on both branches — force-kill, then splice, optionally rechecking `alive(pid)` first and retaining only a kill that did not stick — or push the pid only from the rejection handler so the queue holds exactly the pids no teardown ever confirmed dead.

_confidence: 99 | sources: arch+quality, docs+tests, adversarial | lenses: quality, tests, comments, adversarial | verdict: unverified_

### The suite's stray-kill assertion can never fail

`tools/acceptance/frameshm.test.mjs:250-251`

The file-level hook reads:

```js
const failures = await teardown(...strays.map((pid) => () => forceKill(pid)));
assert.deepEqual(failures, [], "a browser of this suite would not die");
```

`teardown` (tools/lib/deadline.mjs:135) collects only what its steps throw, and `forceKill` (line 255) wraps `execFileSync` in a `try`/`catch` that swallows everything, with the comment "Already gone, which is the state the caller wanted." So `failures` is `[]` on every run, including a run where `taskkill` fails on every stray and a live Electron browser is left behind for the whole session. The assertion's stated claim, that a browser of this suite would not die, is the one thing it cannot detect.

The sibling suite tools/acceptance/profile-lock.test.mjs:68 does the same cleanup as a bare loop with no assertion, so this is the file's own addition rather than the project's convention. It arrived with the file in e8725ad on this branch; this round's diff does not touch these two lines.

Fix: Either drop the assertion, matching the sibling suite, or give `forceKill` a `strict` mode that rethrows so `teardown` has something to collect.

_confidence: 95 | sources: docs+tests | lenses: tests | verdict: unverified_

### New CLI comment claims frames-without-marker is a shape no route produces, and both routes still produce it

`cli/src/pane.ts:640-643`

The rewritten ownership comment ends "Frames with no marker beside them are the one shape neither route produces today — an engine predating the marker — and are adopted by the pid question alone, below." Today's engine produces that shape in at least two ways.

First, the marker write is best-effort. `FrameDir::mark_pane` (frame_file.rs:384) writes with `let _ = fs::write(...)` and its own doc says so: "Best-effort: a marker that could not be written costs `pane-clear` a recovery it would otherwise make, which is not worth failing a frame over." Any antivirus lock, full disk or unwritable temp directory produces the shape.

Second, the file route has a live window. In `publish_encoded` the PNG is written at `:965` and the marker only at `:1004`, after the host's reply. A browser force-killed inside that window on its first frame leaves the frame file with no marker, and the `remove_file` cleanups on the refusal and error arms are all best-effort too. `write_all_new`'s own comment at `:1196-1202` states this as a live hazard rather than a historical one.

The substantive half is what a failed marker now does on the fast path. `publish_shm` calls `mark_pane` and sets `placed = true` regardless of whether the write landed, and writes no frame file, so a failed marker leaves an entirely empty directory. `allOwnedFrames`'s guard `if (frames === 0 && !marked) continue;` then skips it under both the exit path's pid question and the verb's pane question. On the file route the frame files remain and the pid question still adopts the unattributed wreck, so the exit path recovery survives; the fast path has no second line of evidence. Failure case: fast path active, first frame accepted, the marker's `fs::write` fails, browser later force-killed — the pane stays painted and neither recovery path finds anything.

As written the comment also makes the pid-question branch below look like dead code kept for compatibility.

Fix: Reword the claim to name the live producers: a best-effort marker write that failed, or a browser killed between its first frame's write and the host's reply. Separately, consider whether `publish_shm` should treat a marker it could not write as a placement it cannot prove, since on that route the marker is the only evidence there is.

_confidence: 95 | sources: arch+quality, docs+tests | lenses: architecture, quality, comments, docs | verdict: unverified_

### Plan constraint still declares pane-clear ownership untouched, and no as-built note records the move

`docs/plans/20260903-adopt-image-frameshm.md:113-116`

The Constraints section states "**The file path is not touched except where the two share a seam.** `encode_png`, `write_frame`, the retention list and `pane-clear` ownership are untouched". This round changes `pane-clear` ownership on both sides: `allOwnedFrames` in cli/src/pane.ts now accepts a directory holding only the `pane` marker, and the engine's `clear` guard has moved from `written.is_empty()` to `placed` (frame_file.rs:748).

The plan carries fourteen `➕ as built` notes for smaller deviations, including one for `Producer::close` at line 352, but nothing records this one. A reader reconstructing the task from the plan concludes the CLI's ownership rule was never touched, which is the single most consequential behaviour change in the branch and the one the previous review round raised as major.

Fix: Reword the constraint to exempt ownership, and add a `➕ as built` note recording that the guard moved to `placed` and that `allOwnedFrames` now reads the marker rather than a frame count.

_confidence: 90 | sources: docs+tests | lenses: docs | verdict: unverified_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 1809165 | 2 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 2482603 | 5 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 3912953 | 10 | ok |
| adversarial | codex | gpt-5.6-sol | high | 104368 | 1 | ok |
