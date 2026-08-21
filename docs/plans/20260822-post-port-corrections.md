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

- [ ] add a `pane-clear` (or `doctor`) verb to the CLI that calls `clearPaneFrame` and
      `restorePaneConsole` against the current pane and exits
- [ ] register it in `cli/src/help.ts` alongside the other verbs, with body text saying
      what it fixes: a frame left painted over the shell, and a console left with mouse
      reporting on, the cursor hidden, or the alternate buffer active
- [ ] make it work when the engine is **not** running — that is its whole purpose; it
      must not require an instance in the registry
- [ ] make it succeed loudly when there was nothing to fix, so a user cannot tell
      "it worked" from "it did nothing" only by the pane looking the same
- [ ] write tests for the verb dispatching to both halves
- [ ] write tests for it running with no browser alive and no instance registered
- [ ] write tests for it reporting cleanly when `AGWINTERM_PIPE` is unset
- [ ] run tests — must pass before Task 2

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
- [ ] leave release behaviour unchanged — a shipped browser publishes where the pane says
- [ ] document the dev workflow in one place: build Debug agwinterm, `--app-id
      agwinterm-dev`, verify with `agwintermctl --pipe agwinterm-dev tree`, then run
- [ ] write tests for the guard refusing an unlisted pipe under a dev build
- [ ] write tests for release builds being unaffected
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

### Task 4: Run the review that never ran

- [ ] confirm the bridge works end to end before relying on it: `RALPHEX_REVMUX_DRY_RUN=1`
      through the exact configured path, then one real round
- [ ] run revmux over the **whole port**, not just this plan's diff — base it against the
      first commit of the vendored tree so the 15 tasks are in scope
- [ ] use `comprehensive`; the port spans Rust, TypeScript and a C# host contract, and the
      roster's spread matters more here than depth on one file
- [ ] triage the findings into: fix now, fold into a later plan, or record as accepted
      with a reason. Do not silently drop any
- [ ] commit the report under `.revmux/tasks/` the way the plan-review round was
- [ ] for each finding fixed, add the test that would have caught it
- [ ] run tests — must pass before Task 5

### Task 5: Verify acceptance criteria

- [ ] kill a running browser with `Stop-Process -Force` and confirm one `pane-clear`
      restores the pane fully — no frame, cursor visible, no mouse bytes on move
- [ ] kill the **CLI** rather than the browser and confirm the same, since that is the
      case the current code does not cover
- [ ] confirm a dev build refuses to publish into the production instance
- [ ] confirm `pnpm test` cannot hang
- [ ] run the full suite: `cargo nextest run --workspace`, `node --test`
- [ ] run `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all --check`

### Task 6: [Final] Update documentation

- [ ] document the recovery command in `README.md`
- [ ] correct `docs/design/06-acceptance.md` per Task 2's finding
- [ ] add a short note to `docs/design/07-as-built.md` recording that the port shipped
      unreviewed by revmux and when that was remedied — the gap is part of the record

## Post-Completion

**Manual verification**: leave a browser running a long session and confirm the pane
survives a laptop sleep/wake, which is a kill the code has never seen.

**Process**: the bridge failing took the whole review phase down with a one-line error
that scrolled past. Consider whether ralphex should treat "external review tool failed to
start" as fatal rather than as a review that produced nothing — a review that cannot run
should stop the run, not be indistinguishable from a clean one.
