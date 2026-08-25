# Post-port corrections

## Overview

The port plan completed on 2026-08-21 — all 15 tasks, 128 checkboxes, a browser on
screen. This plan covers four defects found the morning after, by looking at what the
run actually left behind on the machine rather than at what the plan says it did.

Three are real bugs. The fourth is that **the review never happened**.

### What was observed

An agwinterm pane (`ralphex`, workspace 3, on the **production** instance) was found
holding a stale browser frame with SGR mouse reports streaming into the shell prompt —
`\x1b[<555;39;9M` on every pointer move — roughly 18 hours after the run ended. Three
`node` processes from `pnpm test` were still alive, wedged since 20:55 the previous
evening. The pane was recovered by hand over the control pipe
(`session.write` of `\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?25h`, then
`image.clear`), and the processes killed.

Each of those is a symptom of something the port shipped without.

## Context (from discovery)

| finding | evidence |
|---|---|
| recovery lives only on the CLI's own exit path | `cli/src/main.ts:484-490` calls `clearPaneFrame` then `restorePaneConsole` inside `try/finally`; nothing else calls them (`grep` over `cli/src`, `browser/src`, `engine`) |
| no recovery command exists | `cli/src/help.ts` lists `open`, `ls`, `setup`, `upgrade`, `new-tab`, `shutdown`, `action`. `paneClearRequest`/`restorePaneConsole` are library functions with no verb in front of them |
| nothing guards the target instance | `engine/crates/pixel-core/src/agwinterm.rs:57` reads `AGWINTERM_PIPE` and falls back to `DEFAULT_PIPE = "agwinterm"` — the production instance — with no notion that a dev instance exists outside its tests |
| **and the CLI holds a second copy of that fallback** | `cli/src/pane.ts:58` resolves `nonempty(env, "AGWINTERM_PIPE") ?? DEFAULT_PIPE` with its own copy of the constant, in a module that deliberately imports nothing from the workspace — so it cannot inherit a guard added to the engine. Found by the revmux round, `.revmux/tasks/port-windows-full/01-initial/dropped-findings.md` |
| **and the three pane readers disagree** | `inAgwintermPane` (`cli/src/unsupported.ts:115`) documents itself as "the one rule ... shared by everything that asks" and checks the pipe name not at all; the engine permits only `[A-Za-z0-9._-]` (`agwinterm.rs:190`); `paneClearRequest` rejects only `[\/]` (`pane.ts:99`) |
| the hung test has no timeout | `tools/cli/registry.test.mjs` binds a real named pipe and awaits a connection; `grep` for `timeout\|setTimeout\|AbortSignal\|unref` returns **nothing**. `package.json:5` is `node --test "tools/*/*.test.mjs"` with no `--test-timeout` |
| revmux never ran | the run log ends `'.' is not recognized as an internal or external command` → `error: runner: custom loop: custom execution: custom script exited with error: exit status 1` |

### Why revmux never ran, and what that means

`.ralphex/config` said `custom_review_script = ./tools/ralphex-revmux.cmd`. ralphex
invokes it as `exec.Command(script, promptFile)`; for a `.cmd` that goes through
cmd.exe, which reads a leading `/` as a switch prefix. All four spellings were
exec'd directly to settle it:

| spelling | result |
|---|---|
| `./tools/ralphex-revmux.cmd` | **fails** — `'.' is not recognized…` |
| `tools/ralphex-revmux.cmd` | **fails** — `'tools' is not recognized…` |
| `tools\ralphex-revmux.cmd` | works |
| `.\tools\ralphex-revmux.cmd` | works |

Already fixed in `.ralphex/config`, and the config trimmed to only the keys this
project actually overrides — `ralphex --init` had copied the whole global config down,
silently shadowing it.

**The consequence is the point.** Every one of the 15 tasks was reviewed only by
ralphex's own internal Claude review phase. The harness this project was explicitly
built around — a versioned `.revmux/` standard, a codex peer, adversarial verification —
never saw a line of it. The six `fix: address code review findings` commits came from
the internal reviewer. So the port is *unreviewed by this project's own standard*, and
Task 4 below is not a formality.

## Constraints

- **Recovery must not require the control pipe by hand.** The bar is: a user whose pane
  is wrecked runs one command. What was done by hand above is the thing being automated.
- **Do not weaken `restorePaneConsole`'s two-half design.** Escape sequences and console
  modes are restored by different mechanisms for a documented reason; a command that
  only sends the escapes fixes half the problem.
- The dev-instance guard must not make ordinary use annoying. Refusing to run against a
  non-dev instance by default would break the shipped product; the guard is for
  development.
- Regular testing (code first, then tests), same as the port plan.

## Development Approach

- Complete each task fully before the next.
- **CRITICAL: every task MUST include new/updated tests**, as separate checklist items.
- **CRITICAL: all tests pass before the next task starts.**
- `cargo clippy -- -D warnings`, `cargo fmt --check` and `node --test` are part of that.
- Update this plan when scope changes.

## Implementation Steps

### Task 1: A recovery command for a wrecked pane

- [x] add a `pane-clear` (or `doctor`) verb to the CLI that calls `clearPaneFrame` and
      `restorePaneConsole` against the current pane and exits
- [x] register it in `cli/src/help.ts` alongside the other verbs, with body text saying
      what it fixes: a frame left painted over the shell, and a console left with mouse
      reporting on, the cursor hidden, or the alternate buffer active
- [x] make it work when the engine is **not** running — that is its whole purpose; it
      must not require an instance in the registry
- [x] make it succeed loudly when there was nothing to fix, so a user cannot tell
      "it worked" from "it did nothing" only by the pane looking the same
- [x] **do not clear a placement this browser did not make.** `openInForeground`
      (`cli/src/main.ts:484`) sends `image.clear` on every exit path with no test for
      whether anything was ever drawn. The engine deliberately does the opposite:
      `FramePublisher::clear` (`engine/crates/pixel-core/src/frame_file.rs:485`) returns
      early when nothing was published, because "asking anyway would clear a placement
      some *other* process owns". The recovery verb is the case where that matters most —
      it runs when things are already broken — so it needs the engine's rule, not the
      CLI's. Note this cuts against "succeed loudly when there was nothing to fix":
      resolve it as *report* that nothing was owned, rather than clear anyway
- [x] fix `openInForeground`'s unconditional clear at the same time, since the verb and
      the exit path are the two halves of one mechanism
- [x] write tests for the verb dispatching to both halves
- [x] write tests for it running with no browser alive and no instance registered
- [x] write tests for it reporting cleanly when `AGWINTERM_PIPE` is unset
- [x] run tests — must pass before Task 2

### Task 2: Do not paint into the user's live terminal during development

The engine reads `AGWINTERM_PIPE` and falls back to `"agwinterm"`, so a browser
launched from any pane publishes into whatever instance that pane belongs to. During
development that is the machine's real terminal, which is how a stale frame and live
mouse reporting ended up in a working pane for 18 hours.

- [x] determine which run actually did it. `docs/design/06-acceptance.md` states the
      live checks ran against a Debug instance on `--app-id agwinterm-dev` and that
      "none of this touched" the real one. The observed pane contradicts that for *some*
      run. Correct whichever document is wrong — do not leave both standing
- [x] add an opt-in env guard (e.g. `TERMINAL_BROWSER_ALLOW_PIPE`) consulted only when
      a development/debug build is detected, so a dev build refuses to publish into an
      instance it was not told to use, and names the variable in the error
- [x] **route `cli/src/pane.ts` through the same guard.** Its no-workspace-imports
      constraint means the rule has to be duplicated there the way the addressing rules
      already are — a guard on the engine alone leaves the CLI publishing into
      production, which is the case that actually wrecked a pane
- [x] give `inAgwintermPane` the engine's pipe-name check and tighten `paneClearRequest`'s
      `[\/]` test to the same character set, so the "one rule" comment becomes true
- [x] leave release behaviour unchanged — a shipped browser publishes where the pane says
- [x] document the dev workflow in one place: build Debug agwinterm, `--app-id
      agwinterm-dev`, verify with `agwintermctl --pipe agwinterm-dev tree`, then run
- [x] write tests for the guard refusing an unlisted pipe under a dev build
- [x] write tests for release builds being unaffected
- [x] write tests for the CLI's own fallback refusing the same way
- [x] add `AGWINTERM_PIPE` rows to `HOST_CASES` so all three readers are pinned on that
      axis and cannot drift apart again
- [x] run tests — must pass before Task 3

### Task 3: A hung test must not wedge the suite

`tools/cli/registry.test.mjs` waits on a real named-pipe connection with no timeout of
any kind. It hung for 18 hours and took `pnpm test` with it.

- [x] add `--test-timeout` to the `test` script in `package.json` so no run can hang
      indefinitely regardless of which test is at fault
- [x] give every socket/pipe wait in `tools/cli/*.test.mjs` its own bounded timeout that
      fails with a message naming what it was waiting for
- [x] audit the other `tools/*/*.test.mjs` for unbounded waits and bound them too
- [x] ensure servers and pipes are torn down in `after` hooks even when a test fails
- [x] write a test that a wait which never completes fails on the timeout rather than hanging
- [x] verify `pnpm test` completes from a clean checkout, and record the wall-clock time
- [x] run tests — must pass before Task 4

Done 2026-08-24. `tools/lib/deadline.mjs` holds the rule the four `tools/cli/` suites now
share — `withDeadline`, `listen`, `closeServer`, `onceWithin`, `teardown` — and
`tools/lib/deadline.test.mjs` drives it against real pipes and real never-settling
promises. `--test-timeout=120000` is the backstop for waits no suite knows about.

Three things the work turned up:

- **The hang was probably the teardown, not the wait.** `registry.test.mjs`'s mute-host
  test called `server.close(resolve)` after destroying its connections, and `close` does
  not complete until every accepted connection is fully gone. `closeServer` calls
  `closeAllConnections()` first. `server.listen(endpoint, resolve)` in the same test was
  the other candidate: `listen`'s callback is never invoked on a bind failure — that goes
  to the `error` event — so a name a previous run left held would have hung there too.
  Both are bounded now; the helpers subscribe to `error` as well as to success.
- **`--test-timeout` only fires when something keeps the event loop alive.** With no live
  handle, node's own "promise resolution is still pending but the event loop has already
  resolved" check ends the test first, in milliseconds. Measured both ways: a bare
  `new Promise(() => {})` is cancelled by the event-loop check; the same promise with a
  `setInterval` alive beside it — which is the shape of a test holding a pipe — fails with
  `failureType: 'testTimeoutFailure'` at exactly the deadline. The flag is the one that
  covers the case that actually wedged.
- **`execFileSync` cannot be raced against a promise**, so the three `git` calls in
  `unchanged.test.mjs` take `timeout: 30_000` instead.

Wall clock when Task 3 measured it: `pnpm test` 4s, 333 tests in 17 files. `06-acceptance.md` §6 carries the current count; it has moved every review round since. A checkout with no
`store/dist` fails in 2s — three suites report `requireBuilt`'s build command — rather
than hanging, which is the behaviour `tools/lib/built.mjs` documents.

### Task 4: Run the review that never ran — **done 2026-08-24**

- [x] confirm the bridge works end to end before relying on it: `RALPHEX_REVMUX_DRY_RUN=1`
      through the exact configured path, then one real round
- [x] run revmux over the **whole port**, not just this plan's diff — base it against the
      first commit of the vendored tree so the 15 tasks are in scope
- [x] use `comprehensive`; the port spans Rust, TypeScript and a C# host contract, and the
      roster's spread matters more here than depth on one file
- [x] triage the findings into: fix now, fold into a later plan, or record as accepted
      with a reason. Do not silently drop any
- [x] commit the report under `.revmux/tasks/` the way the plan-review round was
- [x] for each finding fixed, add the test that would have caught it
- [x] run tests — must pass before Task 5

Round: `.revmux/tasks/port-windows-full/01-initial/`, base `45b5e43`, profile
`comprehensive`, no confidence floor. 19 findings raised, 12 in `report.md`.

Two things worth carrying forward:

- **The dry run had to use a backslashed Windows absolute path** as the argument, because
  that is what `exec.Command` produces. A forward-slash probe proves nothing about the
  real invocation. It passed; the round was created and the scope written through verbatim.
- **Synthesis dropped seven findings** by applying the scope's "do not re-report the four
  known defects" instruction to findings *adjacent* to that set rather than restatements
  of it — which is exactly what the scope asked for. `stages/` is gitignored, so they are
  extracted to `dropped-findings.md`; three of them are the amendments to Tasks 1, 2 and 5
  above and below. When scoping a future round, say "a second code path with the same
  defect is a new finding, not a duplicate" in the *synthesis* terms, not only the finders'.

### Task 5: A control-pipe exchange must not wait forever

The revmux round's only **major**. `engine/crates/pixel-core/src/agwinterm.rs:277` writes
a frame request and then calls `read_line` with no deadline of any kind. If agwinterm
accepts the connection but its handler stalls — while reading a redirected TEMP path, say
— the engine thread blocks permanently. Rendering stops, and shutdown hangs too, because
`PixelEngine::stop` joins that thread. The TypeScript control clients all have deadlines;
the one frame-critical client does not.

This is the same defect class as Task 3's unbounded test wait, in shipped engine code
rather than in a test, which is why it is its own task rather than a bullet there.

- [x] bound every request/response exchange with timed or overlapped pipe I/O
- [x] on expiry, discard the connection and return an error rather than retrying on a
      pipe whose state is now unknown
- [x] choose the timeout against the frame budget in `docs/design/02-frame-budget.md`, and
      say in a comment why that number and not a rounder one
- [x] check whether `host_absent` latching already covers the recovery path, or whether a
      timed-out exchange needs to latch it too
- [x] write a test with a server that accepts and never answers, asserting the exchange
      fails on the deadline instead of blocking
- [x] write a test that `PixelEngine::stop` completes while such a server is stalling
- [x] run tests — must pass before Task 6

Done 2026-08-24. `Connection` is no longer a `BufReader<File>`. The handle is opened
`FILE_FLAG_OVERLAPPED` and every read and write is collected with
`GetOverlappedResultEx` against one `EXCHANGE_DEADLINE` for the whole exchange, so the
write and the reply share a budget rather than each getting their own.

**The number is 1040 ms** — one hundred times the 10.4 ms round trip
`docs/design/02-frame-budget.md` measures for a 2.48 Mpx frame, which is the slowest of
the three it records. A hundredfold because the measurement is a median on an idle
machine and the tail this must not clip is a loaded one; no more than that because the
wait is charged to the render thread and, through `PixelEngine::stop`'s join, to
shutdown. The odd number carries its derivation: a round 1 s would read as a guess and
would not move if the round trip were re-measured.

Four things the work turned up:

- **`host_absent` neither covers this nor should.** It answers "is there a pane to draw
  into", which is a question about `SessionEnv` settled before a byte moves; a timeout
  is a live host that went quiet. Latching on it would turn one slow frame into a
  browser that never draws again. There is also nothing to suppress: a timeout comes out
  of `Terminal::draw`, which `Engine::pump` propagates and `pixel-node` treats as a fatal
  exit, so the run ends on the first one. Written down at the field itself
  (`terminal_windows.rs`).
- **The other caller was the quieter half of the bug.** `Terminal::clear_frame` runs from
  `Drop` and swallows every error — against a stalled host it swallowed them *after*
  blocking forever, so the browser could not exit either. It needed no change beyond the
  deadline, and that is what makes shutdown finish.
- **A timeout is deliberately not `recoverable`.** The one replay `request` does exists
  for a host that *went away*; a host that may still be about to answer would be asked
  twice and cost a second deadline. Pinned by
  `a_timed_out_request_is_not_replayed_onto_a_pipe_of_unknown_state`, which asserts the
  server saw one request.
- **`CancelIoEx` only asks.** Until a cancelled operation actually completes the kernel
  holds pointers into the `OVERLAPPED` and the buffer, so both live in a boxed
  `PendingIo` the connection owns, and a cancellation that will not settle inside
  `CANCEL_GRACE_MS` leaks the box and the handle rather than freeing memory the kernel
  may still write. Unreachable in practice; it is the only way to keep the give-up path
  itself bounded.

The fixture grew `Turn::Stall` — read the request, answer nothing, hold the connection
open until the server is dropped — which is the case a `Turn::Hangup` never covered, and
`Turn::ReplyAfter` so that "slow" is tested as distinct from "stuck". Five new tests
against the real pipe; the suite was 44 tests in `agwinterm` at 1.05s when this task
landed, and `06-acceptance.md` §6 is where that count is kept current.

### Task 6: Verify acceptance criteria

- [x] kill a running browser with `Stop-Process -Force` and confirm one `pane-clear`
      restores the pane fully — no frame, cursor visible, no mouse bytes on move
- [x] kill the **CLI** rather than the browser and confirm the same, since that is the
      case the current code does not cover
- [x] confirm a dev build refuses to publish into the production instance, **from the CLI
      as well as the engine** — the two have separate copies of the fallback
- [x] confirm `pane-clear` reports rather than clears when the pane holds a placement this
      browser never made
- [x] confirm `pnpm test` cannot hang
- [x] confirm a stalled control-pipe host does not wedge rendering or block shutdown
- [x] run the full suite: `cargo nextest run --workspace`, `node --test`
- [x] run `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all --check`

Done 2026-08-24. The criteria were not eyeballed once and ticked: they are
`tools/acceptance/pane-clear.test.mjs`, seven tests that spawn `node cli/dist/main.js
pane-clear` as a process against a real named pipe and read what came back. The
browser it recovers from is a real process that plants a publisher's frame directory
and is then ended with `taskkill /F`, which is what `Stop-Process -Force` does and what
runs no destructor. Only the eye is left over — whether the pane *looks* right — and the
bytes that make it look right are asserted against `DISABLE_REPORTING` as loaded from
the same build the child ran.

| criterion | how it is now checked |
|---|---|
| killed browser, one `pane-clear` | one `image.clear` for this pane reaches the host, the report says `cleared`, and the escape string is on stdout |
| killed **CLI** | the frames survive, nothing cleared them, and the verb still recovers |
| dev guard, CLI **and** engine | CLI: a bound wrong-instance host receives nothing and the report names the variable; the unset fallback to `agwinterm` is refused by name; the named instance still works. Engine: `a_dev_build_refuses_a_pipe_the_allow_list_does_not_name` and three beside it |
| a placement not ours | zero bytes to the host, `nothing of ours to clear`, console restored anyway |
| `pnpm test` cannot hang | `--test-timeout=120000` plus Task 3's helpers; 340 tests in 8.9s wall clock when Task 6 measured it. `06-acceptance.md` §6 is where that count is kept current — it has moved every review round since |
| a stalled host | engine: `a_thread_blocked_on_a_stalling_host_can_still_be_joined` (1.08s) and `a_timed_out_request_is_not_replayed_onto_a_pipe_of_unknown_state`. CLI: the verb exits 0 in under a second against a host that accepts and never answers |

Three things the work turned up:

- **Killing the CLI kills the browser, on Windows.** The test was written expecting the
  browser to outlive its parent and asserted so; it failed. libuv puts a child spawned
  without `detached` into a job object that terminates when the parent does, and
  `openInForeground` documents spawning exactly that way — "Not detached, and not
  unref'd: this process is the pane's foreground job". So one `taskkill /F` on the CLI
  takes down *both* halves of the mechanism at once: `ModeGuard::drop` never runs in the
  browser and the CLI's clear never runs either. That makes this case worse than the
  killed-browser one, not a variant of it, and it is the strongest argument for the verb
  existing. Measured, not reasoned about: the probe is in the test's comment.
- **A test suite that spawns a browser is one `AGWINTERM_PIPE` away from being the bug.**
  Every child here gets an environment with every inherited `AGWINTERM_*` and
  `TERMINAL_BROWSER_*` variable stripped and a pipe this file bound itself, with
  `TERMINAL_BROWSER_ALLOW_PIPE` set on top so a leak is refused rather than delivered —
  and `TEMP`/`TMP`/`LOCALAPPDATA` redirected, which is also how "no instance registered"
  is established rather than assumed. The fallback test deliberately binds *nothing* for
  the production name: the claim is that no socket is opened at all, and binding
  `\\.\pipe\agwinterm` to prove it would be the thing being guarded against.
- **The two literal lint commands cannot be green in this tree and never could.** The
  vendored tree is not rustfmt-clean (298 complaints) and carries 12 clippy warnings;
  reformatting it is the silent edit the port's Constraints forbid. The enforced form is
  `tools/vendor-check/fmt-scope.py` and `clippy-scope.py`, which run the real check and
  `git blame` every complaint against `45b5e43` — both report **0 on a line this port
  wrote**, which is the claim `docs/design/06-acceptance.md` §6 records.

For Task 7: the results table in `docs/design/06-acceptance.md` §6 was stale by this
round — as measured on 2026-08-24 it wanted `cargo nextest run --workspace` **439
passed**, 1 skipped; `node --test` **340 passed**, 87 suites; clippy 12 warnings / 0
port lines; fmt 298 complaints / 0 port lines. Those four are a measurement with a date
on it, not a standing claim: every review round since has moved two of them, and §6 is
the one place that carries the current pair.

`hostOn` moved out of `tools/cli/pane-clear.test.mjs` into `tools/lib/control-host.mjs`
rather than being copied, for the reason `deadline.mjs` exists: two suites now make the
same claim about bytes on a pipe, and a second copy is a second place for "what the host
does when it stops answering" to drift.

### Task 7: [Final] Update documentation — **done 2026-08-24**

- [x] document the recovery command in `README.md`
- [x] correct `docs/design/06-acceptance.md` per Task 2's finding
- [x] add a short note to `docs/design/07-as-built.md` recording that the port shipped
      unreviewed by revmux and when that was remedied — the gap is part of the record
- [x] the round's self-contained doc corrections were already applied when it ran (the
      `presentBitmap` row, the stale "Two lesser ones" count, the README and brief
      cross-references, the backwards cell-metrics order, the milestone runner header).
      Do not redo them; check they still hold after Tasks 1-6 move the code

Checked, all five, and all five still hold: the `presentBitmap` row is pinned by
`docs.test.mjs`'s "the dropped fast paths name the presenter Windows actually runs" and
its gate (`event.texture || shmFrame`) has not moved; "The lesser ones" carries no count
to go stale; the README and `00-port-brief.md` both point at `06-acceptance.md` §5 for
all three keep-unchanged divergences, and the anchor resolves; the cell-metrics order in
§3 matches `cell_size()`'s three arms in the order it takes them; and
`run-milestone.cmd`'s header still explains its `agwinterm-dev` default. Nothing was
redone.

What did need correcting was newer than the round. **`06-acceptance.md` §4 asserted the
opposite of what Task 6 measured** — "the CLI is the pane's foreground job, so it
outlives the browser by construction" — which is true only when the browser is what
died. That sentence is now the thing the warning beside it corrects, since a criterion
whose write-up contradicts the test that checks it is worse than one that says nothing.
§6's results table was stale by three rows and its coverage table by nine, so both now
carry the date they were counted alongside the numbers. The numbers themselves are
deliberately not repeated here: every review round after this one moved them again, and
a plan that restates a table it does not own is the same failure this task was fixing.
§6 is the copy that is kept current; the two lint rows (12 / 0 port lines and 298 / 0
port lines) are the ones that have not moved.

`07-as-built.md` grew a §4 rather than absorbing the changes into §1-3, because the
three things Tasks 1-5 added are not what the port decided — they are what it got wrong
and what a person meets afterwards: the `TERMINAL_BROWSER_ALLOW_PIPE` guard (and why it
is enforced twice), the 1040 ms exchange deadline with its derivation, and the review
that did not run. §1's "Taking the picture back" went from two paths to three, with the
ownership rule all three now share.

Two things the work turned up:

- **The tests are the part that does not rot.** Four new ones in
  `tools/docs-check/docs.test.mjs`, in that file's existing idiom — assert the *names* a
  paragraph promises still exist, never read for sense. The recovery verb the README
  tells a user to type is dispatched by `main.ts` and carried by `help.ts`; the three
  documented `image.clear` paths all resolve, including the exit path's
  `clearOwnedPaneFrame(process.env, { pid: child.pid })`, whose pid argument *is* the
  ownership rule and whose loss would be the exact regression §1 warns about; the
  **1040** in the prose is parsed out and compared to `EXCHANGE_DEADLINE`, so a constant
  that moves without its derivation moving fails; and `TERMINAL_BROWSER_ALLOW_PIPE` is
  checked in `cli/src/pane.ts` as well as in `agwinterm.rs`, which is the "enforced
  twice" claim rather than a restatement of the existing knobs test — that one only
  reaches the engine.
- **A count in a doc is a claim with a date on it.** Adding those four tests moved the
  node total from 340 to 344 mid-task and falsified three sentences written minutes
  earlier. Both tables now say when they were counted, and the coverage table's rows sum
  to the total above it — so the next reader can tell a stale number from a wrong one.

## Deferred from the revmux round

Findings triaged out of this plan rather than dropped. Full text in
`.revmux/tasks/port-windows-full/01-initial/report.md` and `dropped-findings.md`; the
disposition table is in that task's `task.md`.

**Wants its own plan — the vendored-tree guard does not cover the vendored tree.**

- `tools/vendor-check/unchanged.test.mjs:43` diffs only `engine/crates/pixel-core/src`.
  `pixel-node` and `pixel-react` are vendored upstream trees with **no baseline check at
  all**, so an edit there — or a re-vendor that drops one — is invisible to `pnpm test`.
  Six edited vendored files sit outside the guard, while `docs/design/UPSTREAM.md:55`
  tells a re-vendorer its divergence list is exhaustive and test-backed. Most fail loudly
  at compile time if dropped, which caps the blast radius, but the document is wrong.
- `tools/vendor-check/native-build.test.mjs:74` skips three tests when `pixel.node` is
  missing and never checks staleness, against the rule `tools/lib/built.mjs` sets for the
  rest of the tree — "a stale `dist/` is worse, because everything passes against
  yesterday's source."
- `tools/docs-check/docs.test.mjs:133` asserts one direction of a contract its own doc
  comment says is bidirectional: a parser value that loses its doc row is caught, a doc
  row the parser stops honouring is not.
- `blame()` is duplicated verbatim, safety rationale and all, between
  `tools/vendor-check/clippy-scope.py:61` and `fmt-scope.py:82`. Lift it beside the other
  vendor-check work rather than on its own.

**Windows-specific bugs in vendored browser code.** Fixing these creates new upstream
divergences that need written reasons in `UPSTREAM.md`, which is a cost worth deciding on
its own rather than as review fallout:

- `browser/src/profile.ts:35` treats every `process.kill(pid, 0)` error as a dead owner.
  On Windows, probing a live higher-integrity browser returns `EPERM`, so a second browser
  overwrites the first's lock and selects the same Chromium `userData` directory. The
  changed instance-registry code already handles this correctly — `store/src/instances.ts`
  is the model. Confidence 95.
- `browser/src/foreground.ts:65` closes through `app.exit`, which Electron specifies does
  not emit `will-quit` — the only event `profile.ts` removes the lock from. The lock
  survives every foreground close, and if Windows reuses that PID the next launch silently
  picks a different profile, so the user appears logged out. The `will-quit`-only cleanup
  is upstream's; the port's new foreground path is what makes it routine. Confidence 95.

**Was deferred, then done — and resolved narrower than the finding asked.**
`engine/crates/pixel-core/src/clipboard_image.rs:84` accepted `file://` URLs without
converting them to Windows paths, so `file:///C:/…` became `/C:/…` and a UNC URL became a
relative path; both failed `is_file`, and pasting a valid local image URL was silently
treated as ordinary text. The existing test constructed the nonstandard `file://C:\…` form
and so missed it. Confidence 88.

Fixed 2026-08-25 in a review round after Task 7, by `file_url_path`, which unwraps the
empty-authority form (`file:///C:/…`) and leaves a named authority alone. The finding also
asked for the **UNC authority forms**, and that half was **declined on purpose**:
`looks_absolute` now refuses UNC entirely, because `is_file` on `\\host\share\…` is an
outbound SMB/WebDAV connect with implicit authentication made synchronously on the
`handle_event` thread — a page that puts `\\attacker.example\s\a.png` on the clipboard
would get a credential handshake out of the machine on the next Ctrl+V. The
extended-length spelling of a local path (`\\?\C:\…`) is still admitted. Pinned by
`a_file_url_with_an_empty_authority_resolves`, `a_unc_share_is_never_probed` and
`an_extended_length_local_path_is_still_local`; the reason is carried in `UPSTREAM.md`
divergence 4, which now records it as a divergence in intent rather than a portability fix.

**Other work landed after Task 7 closed**, all of it review-round fallout on the plan's own
deliverables rather than new scope:

- `cli/src/pane.ts` — the console-modes half of `restorePaneConsole` (Task 1) was
  `process.stdin.setRawMode(false)`, which was measured to reach no syscall at all and
  could not be honest about it. Replaced by `cookConsoleModes`, a `cmd.exe /c exit` child
  spawned with `stdio: "inherit"`, gated on `isTTY`, with `%SystemRoot%` read from this
  process rather than from the pane's addressing environment. `07-as-built.md` §1 carries
  the measurement.
- `engine/crates/pixel-core/src/agwinterm.rs` — the Task 5 connection now opens with
  `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`, so a process that squatted the
  predictable `agwinterm` pipe name cannot impersonate this user. `07-as-built.md` §4.
- `engine/crates/pixel-core/src/frame_file.rs` — a write that fails part-way now unlinks
  its file, because a truncated frame with no `PANE_FILE` marker is exactly the shape the
  CLI's ownership rule (Task 1) adopts as "a browser left a picture here".
- `engine/crates/pixel-core/src/terminal_windows.rs` — a console control event interrupts
  a blocked read by succeeding with zero bytes; reading that as end of input left the
  browser drawing with no thread that could deliver a keystroke. And a mode-2048 resize
  baseline now stores zero pixels, because `window_size` reports zero always and a
  baseline that kept the reported extent could never compare equal to the poll.

**Accepted, not planned:** `TerminalBackend`'s `pub use` in `pixel-core/src/lib.rs:92` has
no caller outside tests, but `lib.rs` is already a written divergence for other reasons, so
removing it buys nothing back. Revisit at the next re-vendor.

## Post-Completion

**Manual verification**: leave a browser running a long session and confirm the pane
survives a laptop sleep/wake, which is a kill the code has never seen.

**Process**: the bridge failing took the whole review phase down with a one-line error
that scrolled past. Consider whether ralphex should treat "external review tool failed to
start" as fatal rather than as a review that produced nothing — a review that cannot run
should stop the run, not be indistinguishable from a clean one.
