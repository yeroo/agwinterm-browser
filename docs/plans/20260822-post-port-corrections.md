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

- [ ] determine which run actually did it. `docs/design/06-acceptance.md` states the
      live checks ran against a Debug instance on `--app-id agwinterm-dev` and that
      "none of this touched" the real one. The observed pane contradicts that for *some*
      run. Correct whichever document is wrong — do not leave both standing
- [ ] add an opt-in env guard (e.g. `TERMINAL_BROWSER_ALLOW_PIPE`) consulted only when
      a development/debug build is detected, so a dev build refuses to publish into an
      instance it was not told to use, and names the variable in the error
- [ ] **route `cli/src/pane.ts` through the same guard.** Its no-workspace-imports
      constraint means the rule has to be duplicated there the way the addressing rules
      already are — a guard on the engine alone leaves the CLI publishing into
      production, which is the case that actually wrecked a pane
- [ ] give `inAgwintermPane` the engine's pipe-name check and tighten `paneClearRequest`'s
      `[\/]` test to the same character set, so the "one rule" comment becomes true
- [ ] leave release behaviour unchanged — a shipped browser publishes where the pane says
- [ ] document the dev workflow in one place: build Debug agwinterm, `--app-id
      agwinterm-dev`, verify with `agwintermctl --pipe agwinterm-dev tree`, then run
- [ ] write tests for the guard refusing an unlisted pipe under a dev build
- [ ] write tests for release builds being unaffected
- [ ] write tests for the CLI's own fallback refusing the same way
- [ ] add `AGWINTERM_PIPE` rows to `HOST_CASES` so all three readers are pinned on that
      axis and cannot drift apart again
- [ ] run tests — must pass before Task 3

### Task 3: A hung test must not wedge the suite

`tools/cli/registry.test.mjs` waits on a real named-pipe connection with no timeout of
any kind. It hung for 18 hours and took `pnpm test` with it.

- [ ] add `--test-timeout` to the `test` script in `package.json` so no run can hang
      indefinitely regardless of which test is at fault
- [ ] give every socket/pipe wait in `tools/cli/*.test.mjs` its own bounded timeout that
      fails with a message naming what it was waiting for
- [ ] audit the other `tools/*/*.test.mjs` for unbounded waits and bound them too
- [ ] ensure servers and pipes are torn down in `after` hooks even when a test fails
- [ ] write a test that a wait which never completes fails on the timeout rather than hanging
- [ ] verify `pnpm test` completes from a clean checkout, and record the wall-clock time
- [ ] run tests — must pass before Task 4

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

- [ ] bound every request/response exchange with timed or overlapped pipe I/O
- [ ] on expiry, discard the connection and return an error rather than retrying on a
      pipe whose state is now unknown
- [ ] choose the timeout against the frame budget in `docs/design/02-frame-budget.md`, and
      say in a comment why that number and not a rounder one
- [ ] check whether `host_absent` latching already covers the recovery path, or whether a
      timed-out exchange needs to latch it too
- [ ] write a test with a server that accepts and never answers, asserting the exchange
      fails on the deadline instead of blocking
- [ ] write a test that `PixelEngine::stop` completes while such a server is stalling
- [ ] run tests — must pass before Task 6

### Task 6: Verify acceptance criteria

- [ ] kill a running browser with `Stop-Process -Force` and confirm one `pane-clear`
      restores the pane fully — no frame, cursor visible, no mouse bytes on move
- [ ] kill the **CLI** rather than the browser and confirm the same, since that is the
      case the current code does not cover
- [ ] confirm a dev build refuses to publish into the production instance, **from the CLI
      as well as the engine** — the two have separate copies of the fallback
- [ ] confirm `pane-clear` reports rather than clears when the pane holds a placement this
      browser never made
- [ ] confirm `pnpm test` cannot hang
- [ ] confirm a stalled control-pipe host does not wedge rendering or block shutdown
- [ ] run the full suite: `cargo nextest run --workspace`, `node --test`
- [ ] run `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all --check`

### Task 7: [Final] Update documentation

- [ ] document the recovery command in `README.md`
- [ ] correct `docs/design/06-acceptance.md` per Task 2's finding
- [ ] add a short note to `docs/design/07-as-built.md` recording that the port shipped
      unreviewed by revmux and when that was remedied — the gap is part of the record
- [ ] the round's self-contained doc corrections were already applied when it ran (the
      `presentBitmap` row, the stale "Two lesser ones" count, the README and brief
      cross-references, the backwards cell-metrics order, the milestone runner header).
      Do not redo them; check they still hold after Tasks 1-6 move the code

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

**Also deferred:** `engine/crates/pixel-core/src/clipboard_image.rs:84` accepts `file://`
URLs without converting them to Windows paths, so `file:///C:/…` becomes `/C:/…` and a UNC
URL becomes a relative path; both fail `is_file`, and pasting a valid local image URL is
silently treated as ordinary text. The existing test constructs the nonstandard
`file://C:\…` form and so misses it. Confidence 88.

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
