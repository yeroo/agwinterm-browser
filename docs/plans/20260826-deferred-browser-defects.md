# The deferred browser defects

## Overview

Three items were triaged out of the post-port corrections plan and recorded in its
Deferred section rather than dropped. This plan closes what is left of them.

Two are real Windows defects in the browser's profile handling, both rated confidence 95
by the revmux round, both with user-visible consequences that read as data loss:

- a live browser is mistaken for a dead one, so a second browser takes over its profile
- the profile lock outlives every foreground exit, so a later launch silently picks a
  different profile and the user appears logged out

The third is the `pane-clear` hang observed on a real wrecked pane on 2026-08-25, which
four constructed scenarios could not reproduce. This plan does **not** claim to fix it —
it adds the coverage that would catch it, in the one dimension no existing test exercises.

The `file://` URL item from the same Deferred section is **already fixed** and is not in
scope; see Context.

## Context (from discovery)

Measured on 2026-08-26 against `main` at `678f702`.

| item | state | evidence |
|---|---|---|
| `file://` URLs not converted to Windows paths | **already fixed** — drop from the deferred list | `engine/crates/pixel-core/src/clipboard_image.rs:172` now has `fn file_url_path`, with tests `file_urls_percent_decode` and `a_file_url_with_an_empty_authority_resolves`. Fixed during the corrections run |
| `EPERM` treated as a dead profile owner | **open** | `browser/src/profile.ts:35-42` — `alive(pid)` is `try { process.kill(pid, 0); return true } catch { return false }`. Every error means dead |
| profile lock survives foreground exit | **open** | `browser/src/foreground.ts:30` and `:65` both call `app.exit`, which Electron specifies does not emit `will-quit` — the only event `profile.ts` removes the lock from |
| `pane-clear` hang | **unreproduced** | `cli/src/pane.ts:510-517` — `cookConsoleModes` runs `execFileSync(cmd.exe, ["/c","exit"], { stdio: "inherit", timeout: 2000 })`. No test feeds input to that console while the verb runs |

### The correct model already exists in this repo

`store/src/instances.ts:26-28` gets it right, and says why:

> `EPERM` means the process exists and is someone else's — Windows reports it for
> processes at a higher integrity level. `ESRCH` is the only "gone".

`browser/src/profile.ts` is the same question answered wrongly, two directories away.

### What each fix costs, which is not the same for the two

This matters more than it looks, and the vendor-check work done on 2026-08-26 is what
makes it answerable at all:

- **`browser/src/profile.ts` is vendored and currently byte-identical to `45b5e43`.**
  Editing it creates a genuinely new divergence from upstream. It needs a numbered entry
  in `docs/design/UPSTREAM.md` and a disposition in `tools/vendor-check/dispositions.mjs`,
  or the vendored guard fails — correctly.
- **`browser/src/foreground.ts` is port-added, not vendored.** Editing it costs nothing.

The revmux finding proposed three fixes for the lock: remove it during explicit foreground
shutdown, register cleanup on `process.exit`, or use a quit path that emits `will-quit`.
The first lives entirely in the port's own file. Prefer it, and take the divergence only
where there is no alternative — which is the `EPERM` fix alone.

## Constraints

- **One new vendored divergence at most.** `profile.ts` is the only file here worth
  diverging for. If a fix can be made in port-added code instead, make it there.
- **A new divergence is not done until it is recorded.** `UPSTREAM.md` entry plus
  `dispositions.mjs` entry, both, or `node --test` fails. That is the guard working.
- **Do not claim the `pane-clear` hang is fixed.** It has been reproduced exactly once,
  in conditions not recreated since. A test that covers the untested dimension is the
  deliverable; a fix is only warranted if that test actually fails.
- **`EPERM` must not become "assume alive on any error".** `ESRCH` is the only "gone", but
  an unexpected code should be loud rather than silently treated either way.
- Regular testing (code first, then tests), same as the prior plans.

## Development Approach

- Complete each task fully before the next.
- **CRITICAL: every task MUST include new/updated tests**, as separate checklist items.
- **CRITICAL: all tests pass before the next task starts.**
- `node --test "tools/*/*.test.mjs"`, `cargo nextest run --workspace`, and the scoped
  `fmt-scope.py` / `clippy-scope.py` are part of that. `cargo fmt --all --check` fails on
  this tree by design; the scoped scripts are the real gate.
- Rebuild before testing when touching `browser/` or `cli/` — `tools/lib/built.mjs` will
  fail a stale `dist/` rather than pass against yesterday's source.
- Update this plan when scope changes.

## Implementation Steps

### Task 1: Stop reading EPERM as a dead profile owner

- [x] change `alive()` in `browser/src/profile.ts` so `ESRCH` is the only "gone", matching
      `store/src/instances.ts:26-28` — inspect the error code rather than swallowing it
- [x] decide and record what an unexpected code does; do not let it fall silently into
      either answer
- [x] add a numbered entry to `docs/design/UPSTREAM.md` for this divergence, saying why it
      is Windows-specific: probing a live higher-integrity browser returns `EPERM`, and
      reading that as death lets a second browser take the first one's `userData`
- [x] add the matching disposition to `tools/vendor-check/dispositions.mjs` as an
      incidental divergence pointing at that entry
- [x] write tests for `EPERM` meaning alive and `ESRCH` meaning dead
- [x] write a test for the unexpected-code behaviour chosen above
- [x] confirm the vendored guard passes *because* the divergence is recorded — temporarily
      remove the disposition and see it fail, then restore it
- [x] run tests — must pass before Task 2

### Task 2: Release the profile lock on foreground exit

- [x] remove the owned lock on the explicit foreground shutdown path in
      `browser/src/foreground.ts`, before either `app.exit` call — this keeps the fix in
      port-added code and creates no new vendored divergence
- [x] make it safe to run twice and safe when no lock is owned; a recovery path that
      throws on a second call is worse than the leak
- [x] do not remove a lock this process does not own — the same ownership rule
      `FramePublisher::clear` and `pane-clear` already follow
- [x] check the other `app.exit` site at `foreground.ts:30` is covered too, not just the
      one at `:65`
- [x] write tests that the lock is gone after a normal foreground exit
- [x] write tests that a lock owned by another live process is left alone
- [x] write tests for the double-call and no-lock-owned cases
- [x] run tests — must pass before Task 3

### Task 3: Cover the dimension the pane-clear hang lives in

`pane-clear` hung once, on a real pane, on 2026-08-25, and left the shell refusing input.
Four scenarios built since — clean pane, console-wrecked pane, browser killed with the CLI
surviving, and CLI killed leaving an orphaned frame — all pass. Three explanations were
tried and disproved: not the `cookConsoleModes` half on its own, not a slow `%TEMP%` scan,
and not a hang before first output.

The one condition none of them recreate is the one the real pane had: mouse reporting
live with a pointer moving over it, so SGR bytes were arriving on stdin *continuously
while the verb ran*. `cookConsoleModes` hands that stdin to `cmd.exe` with
`stdio: "inherit"` (`cli/src/pane.ts:510-517`).

- [x] add a test that spawns `pane-clear` as a real process and writes to its stdin
      continuously while it runs — SGR-shaped bytes, at a rate a moving pointer produces
      — `tools/acceptance/pane-clear.test.mjs`, "stdin that does not stop while the verb
      runs". `runClear` grew a `stdin` knob; `feedPointer` writes `\e[<35;C;RM` motion
      reports at 125 Hz — one per ~8ms, the rate `?1003h` sends for a pointer crossing a
      pane — onto a live pipe on the verb's fd 0, from spawn until after exit
- [x] assert it still completes, reports both halves, and exits 0 within a bounded time,
      so a hang fails the test rather than wedging the run — exit 0, `frame: cleared`
      *and* a `console:` line, one `image.clear` at the host, and `< 15s`. `CHILD_MS`
      alone would have been satisfied by a hang the harness cut short, so the run is
      bounded twice. The number of reports actually delivered is asserted too
      (`>= 5`), so a run that finished before any bytes arrived cannot pass as coverage
- [x] cover the console-restore half specifically, since that is where the inherited
      stdin goes — second test, and it needed its own process: with fd 0 a pipe,
      `restorePaneConsole` sees `isTTY` false and never spawns the cooking child at all.
      So the child opens the gate on the *real* `process.stdin` (`defineProperty`) and
      the real `cookConsoleModes` runs — `cmd.exe`, `stdio: "inherit"`, on a fd the
      parent is still writing to — then `input.pause()` runs against that same stdin
- [x] **if the test fails, that is the reproduction** — not reached: both tests pass, so
      no bound on the `cookConsoleModes` exchange and no stdin drain were added. Changing
      that code on a green test would be a fix for a defect this run did not find
- [x] if the test passes, say so in the plan and leave the hang open rather than closing
      it on absence of evidence — **it passes, and the hang stays open.** Measured
      2026-08-26: the verb finished in 916ms with ~100 motion reports delivered onto its
      stdin, and the restore half finished in 938ms with `modes: true` — the cooking
      child ran and returned. What that rules out is a `cmd.exe` inheriting a *pipe*
      with unread bytes still arriving on it. What it does not touch is the console
      shape of the same condition: a console input buffer filling with `INPUT_RECORD`s,
      and libuv's `uv_tty_read_stop` writing a wake-up record into a buffer that is
      already full. Node cannot reach that from a test — there is no `CREATE_NEW_CONSOLE`
      on `spawn`, and the only console this suite could hand a child is the runner's own
      real pane, which is the wreck being avoided. A pseudoconsole is
      `tools/conpty-probe`'s territory and a standalone cargo package by design. That is
      the fifth scenario, and it is still unbuilt
- [x] run tests — must pass before Task 4 — 535 node tests (10 in the acceptance suite,
      2 of them new), 467 `cargo nextest` tests, all green

### Task 4: Verify acceptance criteria

- [ ] confirm a second browser launched against a live first one does not take its profile
- [ ] confirm no `terminal-browser.lock` remains after a normal foreground quit
- [ ] confirm a stale lock naming a dead pid is still reclaimed — the fix must not make
      recovery from a real crash worse
- [ ] confirm `node --test` fails if the new `profile.ts` divergence loses either its
      `UPSTREAM.md` entry or its disposition
- [ ] rebuild, then run the full suite: `node --test "tools/*/*.test.mjs"`,
      `cargo nextest run --workspace`
- [ ] run `python tools/vendor-check/fmt-scope.py` and `clippy-scope.py` — 0 on port lines

### Task 5: [Final] Update documentation

- [ ] record the new `profile.ts` divergence in the re-vendoring checklist in `UPSTREAM.md`
- [ ] update the Deferred section of
      `docs/plans/20260822-post-port-corrections.md`: mark the `file://` item as already
      fixed, and point the two profile items at this plan
- [ ] note in `docs/design/07-as-built.md` what the `pane-clear` test established, and
      whether the hang is now explained or still open — do not leave the reader guessing
      which

## Technical Details

**Why `ESRCH` only.** `process.kill(pid, 0)` sends no signal; it asks whether the process
can be signalled. On Windows, Node maps "exists but you may not touch it" to `EPERM`,
which is precisely the case of a browser running at a higher integrity level. Treating
that as death is how two browsers end up on one Chromium `userData` directory, whose
symptom is a profile-lock startup failure or a concurrent-profile conflict, not a clean
error.

**Why `app.exit` leaks the lock.** Electron specifies that `app.exit` terminates
immediately and does **not** emit `will-quit`. `profile.ts` removes the lock only from
that event. The upstream helper is unchanged and would be fine in upstream's own quit
path; the port's foreground shape is what makes `app.exit` the ordinary exit, so the leak
is routine here and rare there. That is also the argument for fixing it on the port's side.

**Scope note on Task 3.** The deliverable is coverage, not a fix. The hang is real — it
happened, and recovery took `image.clear` over the control pipe plus recreating the
session — but one unreproduced observation does not justify changing code on a guess. If
the new test reproduces it, the fix follows immediately in the same task.

## Post-Completion

**Manual verification**: launch a browser, leave it running, and launch a second from
another pane — confirm the second refuses or picks its own profile rather than taking the
first's. Then quit the first normally and confirm no lock file is left behind.

**Still open after this plan**: the `pane-clear` hang, unless Task 3 reproduces it. If it
recurs in the wild, capture the pane state before recovering it — the recovery destroys
the evidence, which is what happened the first time.
