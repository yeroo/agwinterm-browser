# Review: ralphex-20260903-adopt-image-frameshm / 20260904-112916-3607907-27453-1

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260903-adopt-image-frameshm\20260904-112916-3607907-27453-1\input\scope.md`

## Major

### A browser that only ever used the shared-memory path leaves a placement no recovery path can clear

`cli/src/pane.ts:890`

`allOwnedFrames` counts files matching `FRAME_FILE` (`/^frame-\d{8,}\.png$/`) in each frame directory and skips the directory outright when the count is zero (`if (frames === 0) continue;`). On the fast path no PNG is ever written: `FramePublisher::publish` returns as soon as `publish_shm` succeeds, so `publish_encoded` and `write_frame` never run, and the only thing left in the directory is the `pane` marker from `mark_pane` (`engine/crates/pixel-core/src/frame_file.rs:875-878`), which does not match that regex.

Failure case: agwinterm built from `main` at or past `8230d0e`, transport `auto`, so every frame goes over the mapping. The browser is force-killed, crashes, or has its console closed, so `Terminal::drop` never sends `image.clear` and the placement stays on the pane. The CLI's exit-path recovery `clearOwnedPaneFrame(process.env, { pid: child.pid })` (`cli/src/main.ts:544`) walks `allOwnedFrames`, hits `frames === 0`, and returns an empty wreck list, so it sends nothing. The user then runs `terminal-browser pane-clear`, which consults the same function and reports "nothing of ours to clear". The pane keeps a full-page image over a live shell with no command that can remove it.

This is exactly the state `PANE_FILE` and the two out-of-band clears exist to recover, and it is reachable only because of this change. The engine side of the same problem was noticed and handled: `FramePublisher::clear`'s guard was moved from `written.is_empty()` onto a new `placed` flag precisely because "a frame that went over shared memory wrote nothing and is a placement all the same" (`frame_file.rs:723-724`). The CLI's copy of the ownership test was not moved with it. `frame_file.rs:3031` asserts under the name `a_shm_placement_is_owned_exactly_as_a_file_one`, with the comment "`pane-clear` ownership is about placements, not files", but it only checks the engine's own clear, never the CLI's reading of the directory. The module comment above `FRAME_DIR_PREFIX` still states the model as "`written.is_empty()` read from the filesystem instead of from memory", with a three-case table whose third row ("died before drawing") is no longer the only way a directory can be empty, and the inline comment at the guard repeats the same now-false premise. `docs/design/07-as-built.md` ("Taking the picture back") and `README.md`'s recovery section both still promise three clear paths; on the fast path only the first one works.

Fix: Make the marker sufficient evidence on its own, since `FrameDir::mark_pane` is written past the placement guard on both routes (`frame_file.rs:876` for shm, `:999` for file). In `allOwnedFrames`, accept a directory holding `FRAME_PANE_FILE` even when `frames === 0`, so the guard becomes something like `if (frames === 0 && !fs.existsSync(path.join(dir, FRAME_PANE_FILE))) continue;`. `OwnedFrames.frames` can then legitimately be zero, so its doc comment ("Never zero") and any caller reading it as a count need the same adjustment. Extend `tools/cli/pane-clear.test.mjs` with a marker-only directory, and assert in `a_shm_placement_is_owned_exactly_as_a_file_one` that the on-disk shape it produces is one the CLI accepts.

_confidence: 98 | sources: bugs+impl, arch+quality | lenses: bugs, impl, architecture | verdict: confirmed_

## Minor

### Producer module doc announces "three rules" and then lists four

`engine/crates/pixel-core/src/frame_shm.rs:1496-1525`

The `producer` module doc opens with "Owns the mapping, the sequence counter and the incarnation, and keeps the three rules that tie them together in one place:" and then bullets four rules: `seq` is monotonic, a resize is a fresh mapping under a fresh name, a name is this process's alone rather than its pid's, and the old mapping is dropped only after the new one exists. A reader who trusts the count stops looking after the third bullet, which is the one that explains the `<start>` segment in the mapping name — the fourth, about when the old mapping may be dropped, is the one that carries the contract obligation the drop inside `Producer::publish` depends on. This block is the change's own new documentation for the module, so the miscount was introduced here rather than inherited.

Fix: Change "the three rules" to "the four rules", or fold the third and fourth bullets together if only three were intended.

_confidence: 95 | sources: docs+tests | lenses: docs, comments | verdict: confirmed_

### Terminal::draw's doc comment still describes the file path as the only frame route

`engine/crates/pixel-core/src/terminal_windows.rs:1272-1274`

The doc comment on `Terminal::draw` reads "Puts a frame on screen: PNG to a file of its own, then one `image.frame` request pointing the host at it." That is the port's frame entry point, and it is now wrong on any host with the verb: `FramePublisher::publish` tries `image.frameshm` first under `auto` and `shm`, and on a capable host no PNG is ever encoded or written. The field doc at `:1061` ("The file-based frame path, created with the first frame") has the same problem, since the publisher now owns both routes.

A reader following the frame path from its entry point is told the fast path does not exist. Task 10 enumerated the docs to correct and covered `frame_shm.rs`, `frame_file.rs`, `lib.rs`, `agwinterm.rs` and the design docs, but missed this port-written file, which the plan's diff does not touch at all.

Fix: Reword both comments to name the two routes and point at `frame_file`'s module doc for which one is taken, matching the three-case list that doc already carries.

_confidence: 92 | sources: bugs+impl | lenses: impl | verdict: confirmed_

### Doc claims seq is monotonic per process, but it is per producer

`engine/crates/pixel-core/src/frame_shm.rs:1499-1503`

The producer module doc states the first rule as "**`seq` is monotonic for the life of the process.** It is bumped on every successful publish and never restarted", and the crate-level module doc repeats it at line 22 as "a sequence that never restarts while the process lives". `Producer::new` (line 1610) sets `seq: 0` on every producer, so a second producer built in the same process does restart the sequence at 1. The change's own test `two_producers_in_one_process_never_offer_the_same_name` (line 1796) constructs exactly that pair. The code is correct — safety comes from the disjoint suffix ranges `RANGE` hands out, which the same doc's third bullet explains — but the rule as stated is not the one the code keeps, and the rationale attached to it ("the host rejects a `seq` that goes backwards ... so a restarted counter would be a dropped or refused frame") does not survive the process-wide reading. A maintainer who later adds a second producer per process and reads this as a process-wide guarantee would look for a shared counter that does not exist.

Fix: Say "for the life of the producer" in both places, and let the third bullet carry why two producers in one process are still safe.

_confidence: 85 | sources: docs+tests | lenses: docs, comments | verdict: confirmed_

### The once-per-publisher unplaced-frame warning is shared by both routes, so the mapping's diagnosis suppresses the file path's

`engine/crates/pixel-core/src/frame_file.rs:1098-1101`

`warned_untransmitted` is a single latch, but `check_transmitted` is now called from two routes with two different `Source` values that produce two different diagnoses: `Source::Mapping` says the host could not open the mapping and must be in this logon session, `Source::File` says the host could not read the frame directory. The first one to fire consumes the latch for the whole publisher.

Failure case: transport `auto` against a host that has the verb but cannot reach either resource, for instance a pane hosted in another logon session with a redirected `TEMP`. The first frame answers `frame:0/0` over the mapping, `check_transmitted` emits the mapping message and sets the latch, `refused` logs and the frame falls to the file path. `MAX_REFUSALS` is 3, so three of those latch the fast path off. Every frame after that goes over the file and also answers `frame:0/0`, but `check_transmitted` returns at the latch check and the file-specific message naming the unreadable path is never logged.

The change's own test `a_shm_frame_the_host_served_from_its_cache_is_a_placement_and_not_a_stale_one` asserts `!publisher.warned_untransmitted` with the reason "the stale-frame warning is still available to the file route", so keeping the file route's warning reachable after a mapping-route reply is a property this change already treats as worth pinning. It holds for the cache-hit reply, which returns before the latch, and does not hold for the zero-placement reply, which spends it.

Before this change the latch guarded one source, so it could not hide a second diagnosis. The git diff shows the `Source` enum and the second call site are both new here.

Fix: Latch per source rather than per publisher: replace the boolean with two flags, or with a small record of which source has already been complained about, and warn once for each distinct source. The change stays inside `frame_file.rs` and touches the struct, `FramePublisher::new`, `check_transmitted` and the one test that reads the field.

_confidence: 88 | sources: arch+quality | lenses: quality | verdict: refined_

### A browser PID confirmed dead stays queued for the final force-kill

`tools/acceptance/frameshm.test.mjs:385-394`

In `t.after`, the browser PID is pushed to `strays` (line 385) before the wait at line 391 that confirms the browser exited, and nothing removes it once that wait succeeds. The file-level `after` hook (line 250) then runs `forceKill` for every recorded PID, and `forceKill` issues `taskkill /F /T` unconditionally: it inspects nothing and swallows every error, so a PID Windows has since handed to another process is force-killed along with its whole tree. The window is the remainder of the run after a case's teardown, up to `LAUNCH_MS` while the next live-host case runs, and Windows does reuse freed PIDs quickly on a machine that is churning Electron child processes. Note the queued entry is redundant in precisely the case where the browser is dead: when the wait at line 391 fails, that same handler already force-kills the PID itself. The sibling suites `pane-clear.test.mjs` and `profile-lock.test.mjs` queue PIDs the same way, but neither ever establishes that its child exited, so this file is the one that has the information to prune and does not use it.

Fix: Drop the PID from `strays` once the `settlesWithin(() => !alive(pid), ...)` wait resolves, or push it only from that wait's `catch`, so the file-level hook force-kills only PIDs whose browser was never confirmed gone.

_confidence: 75 | sources: adversarial | lenses: adversarial | verdict: refined_

### Plan contradicts itself on the mapping name after a partial fix

`docs/plans/20260903-adopt-image-frameshm.md:197`

Line 184 defines `mapping_name(pid, start, incarnation)`, matching frame_shm.rs:366, but line 197 still writes `mapping_name(1234, 0)` and line 261 still specifies `mapping_name(pid, incarnation)`. Commit ac7c047, which added the process-start component precisely so a reused pid cannot repeat a name the host still holds a sequence for, updated only the definition line and left these two behind.

Both steps are marked `[x]`, so no one will execute them and nothing fails to compile. The cost is a record that contradicts itself on the exact point the previous review round was raised about: line 261 is the producer's own naming step, and a reader taking it at face value concludes the name is pid plus incarnation, which is the reuse hazard ac7c047 exists to remove. Line 197's expected name is stale in the same way, since the test at frame_shm.rs:577 passes a millisecond timestamp.

Fix: Add the `start` argument to both stale invocations and update line 197's expected name to match the three-component form the test uses.

_confidence: 95 | sources: adversarial | lenses: adversarial | verdict: refined_

## Immaterial

### The connection retry replays non-idempotent session creation after ambiguous failures

`tools/acceptance/frameshm.test.mjs:146-148`

`control` retries every `E*` error raised by the whole connect/write/read exchange, not only failures before connection. If the host executes `session.new` and the pipe resets before its reply reaches this client, the retry creates a second session. Only the retry's returned ID is registered for cleanup, leaving the first session and its browser running. The same retry mechanism and failure are duplicated in `tools/milestone/measure-transports.mjs:107-111`; the host implementation generates a fresh session ID for each request, so the replay is not idempotent.

Fix: Retry only errors proven to occur before the request is written; treat post-write failures as ambiguous and fail without replaying `session.new`, or add an idempotency token that lets the host return the original session.

_confidence: 92 | sources: adversarial | lenses: adversarial | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 5001802 | 2 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 5991597 | 2 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 5724394 | 3 | ok |
| adversarial | codex | gpt-5.6-sol | high | 175794 | 3 | ok |
