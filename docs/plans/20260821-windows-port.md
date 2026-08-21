# winterm-browser — Windows-native port

## Overview

Bring terminal-browser to Windows, hosted by agwinterm: a real Chromium browser rendered inside a
terminal pane, with working keyboard and mouse, on stock Electron, with no WSL.

The authoritative design is [`docs/design/00-port-brief.md`](../design/00-port-brief.md). Read it
first — it records what was measured rather than assumed, and it already overturned one plausible
architecture. In short:

- Upstream cannot run here for two independent reasons: `pixel-core` does not compile on Windows
  (41 errors), and its transport — Kitty APC escapes on stdout — is stripped by ConPTY before any
  Windows emulator sees it.
- But the unix dependency is **concentrated, not pervasive**: 64 of 68 unix-API references live in
  `terminal.rs`, and **19 of 22 `pixel-core` modules have none at all**. The compositor, layout and
  text stack (taffy, tiny-skia, fontdue) are portable Rust. That matters because the browser chrome
  renders through `pixel-react` into `pixel-core` — dropping it would have meant rewriting the whole
  chrome.
- Upstream's fast frame paths need an Electron fork they build themselves, macOS and Linux only. But
  `presentBitmap` (`browser/src/page/paint.ts:104`) already implements a stock-Electron path:
  `image.toBitmap()` → `surface.present({bgra, width, height, damage})`. Windows gets that for free.

**So the port is: replace one module, port one, drop one, keep nineteen** — plus a new output
backend that speaks agwinterm's control pipe instead of writing escapes to a tty.

## Context (from discovery)

Upstream reference (read-only, never committed): `.reference/terminal-browser/`.
agwinterm source: `C:\Users\boris\source\agwinterm`.

| area | file | note |
|---|---|---|
| tty layer to replace | `engine/crates/pixel-core/src/terminal.rs` | 64 unix hits: termios raw mode, `/dev/tty`, `rustix::shm`, `pipe`+`O_NONBLOCK`, and the Kitty-to-stdout encoder |
| IPC to port | `engine/crates/pixel-core/src/herdr.rs` | `UnixStream`/`UnixListener` → named pipes, or gated off for v1 |
| to drop | `engine/crates/pixel-core/src/ghostty.rs` | `SIGUSR2` to ghostty; no Windows analogue |
| keep unchanged | the other 19 `pixel-core` modules | `canvas`, `paint`, `text_input`, `image_cache`, `menu`, `kitty`, `shape`, `wrap`, `style`, `scrollbar`, … |
| napi bridge | `engine/crates/pixel-node/src/{lib,surface}.rs` | `SurfacePixels` gates IOSurface on macOS and shm on linux; the `Owned { bgra, width, height }` variant is the Windows path and already exists |
| the seam | `Surface.present` from `pixel-react` | what `browser/` calls; the Windows backend plugs in here |
| Electron capture | `browser/src/page/{offscreen,paint}.ts` | `offscreenPreferences` branches darwin/linux; `initOffscreenMode` throws on darwin without shared textures |
| host frame path | agwinterm `src/Agwinterm.Pty/ControlServer.cs:249` | `image.frame` today; `image.frameshm` per the agwinterm plan |
| host input | agwinterm `TerminalEmulator.cs:403-405`, `emulator.rs:809` | SGR mouse `?1000/?1002/?1003/?1006` and kitty keyboard already work |

**Tooling upstream already uses**, and this port keeps: `cargo nextest run --workspace`,
`cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`, and
`node --test` for the TypeScript packages. 37 Rust source files carry tests; they are the
regression net for everything in the "keep unchanged" column.

## Constraints

- **Windows-native only. WSL is out of scope** and is not an acceptable fallback for any task.
- **Stock Electron.** Do not fetch or build a patched Electron; if a task seems to need one, the
  task is wrong. `scripts/fetch-electron.sh` is upstream's, and it does not apply here.
- **This plan depends on the agwinterm plan** for the shm fast path only
  (`agwinterm/docs/plans/20260821-image-frameshm-command.md`, contract in
  `agwinterm/docs/specs/image-frameshm.md`). Everything up to and including the
  first-frame-on-screen milestone uses the file-based `image.frame`, which needs no agwinterm change.
  If the contract is not ready when Task 9 starts, stop and say so rather than inventing a shape.
- **Never test against the real agwinterm instance.** Use a Debug agwinterm (instance id
  `agwinterm-dev`, its own pipe and data dir) and verify routing with
  `agwintermctl --pipe agwinterm-dev tree` before trusting any result. Running against the real
  data dir has destroyed real session state before.
- **Do not weaken the "keep unchanged" 19 modules to make something compile.** If one of them needs
  a change, that is a finding worth recording in the plan (➕), not a quiet edit.
- Upstream's licence and provenance travel with the vendored code.

## Development Approach

- **Testing approach**: Regular (code first, then tests).
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
  - unit tests for new and modified functions, as separate checklist items
  - success and error scenarios both
- **CRITICAL: all tests must pass before starting the next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- Run `cargo clippy -- -D warnings` and `cargo fmt --check` as part of "tests pass".

## Testing Strategy

- **Unit tests**: required every task. Rust via `cargo nextest`, TypeScript via `node --test`.
- **Platform-behaviour tests**: the console and control-pipe layers are where assumptions die.
  Prefer a test that drives the real thing (a real named pipe, a real `MemoryMappedFile`, a real
  Debug agwinterm) over a mock that encodes a guess about Win32.
- **Visual confirmation** is a milestone, not a test: Task 8 is "a page is legibly on screen".
  Screenshot verification belongs in Post-Completion, not in a checkbox.
- **No e2e browser-automation suite in this plan.** Scope is a working port.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update the plan when implementation deviates from scope.

## Implementation Steps

### Task 1: Vendor upstream and record the true Windows baseline

- [ ] copy upstream `engine/`, `browser/`, `cli/`, `terminals/`, `store/` from `.reference/` into the
      repo root, preserving `LICENSE` and recording the upstream commit in `docs/design/UPSTREAM.md`
- [ ] do **not** copy `scripts/` wholesale — `install.sh`, `fetch-electron.sh`, `apparmor.sh` and
      `bundle.sh` are unix/patched-Electron specific; port them later, individually, when needed
- [ ] run `cargo check --workspace` and commit the full error list to
      `docs/design/01-baseline-errors.md`, grouped by module
- [ ] run `pnpm install` and record which packages install cleanly on Windows and which do not
- [ ] confirm the baseline matches the brief's claim (errors concentrated in `terminal.rs`,
      `herdr.rs`, `ghostty.rs`) and record any module the brief did not predict as a ➕ finding
- [ ] write a test asserting the vendored `pixel-core` module list matches what the plan expects, so
      an upstream re-vendor cannot silently add a new unix-bound module
- [ ] run tests — must pass before Task 2

### Task 2: Put the tty layer behind a backend seam

- [ ] define a `TerminalBackend` trait in `pixel-core` covering what `terminal.rs` does for the rest
      of the crate: enter/leave raw mode, report size, deliver input events, present a composited
      frame, and wake the event loop
- [ ] derive the trait from `terminal.rs`'s existing callers, not from a fresh design — the goal is
      the seam upstream already implies, so the 19 portable modules keep compiling untouched
- [ ] move the existing unix implementation behind `#[cfg(unix)]` so upstream behaviour is preserved
      rather than deleted
- [ ] add a `#[cfg(windows)]` stub that compiles and returns "unimplemented" for every method
- [ ] `#[cfg(unix)]`-gate `ghostty.rs` and `herdr.rs` for now, recording herdr as deferred
- [ ] write tests that the trait's contract holds for a fake backend (event delivery ordering,
      size reporting, raw-mode enter/leave pairing)
- [ ] verify `cargo check --workspace` is clean on Windows — this is the task's real deliverable
- [ ] run tests — must pass before Task 3

### Task 3: Windows console input

- [ ] implement the input half of the Windows backend: enable VT input with `SetConsoleMode`
      (`ENABLE_VIRTUAL_TERMINAL_INPUT`, disabling line and echo input), restoring the prior mode on
      exit including on panic
- [ ] read from the console input handle and feed the bytes to the existing VT input decoder rather
      than writing a second decoder
- [ ] decode SGR mouse reports (`?1006`) and kitty keyboard sequences — agwinterm emits both, so the
      work is consuming them, not negotiating them
- [ ] request the modes the backend needs on startup and release them on shutdown
- [ ] handle resize: derive it from the console screen buffer info, since there is no `SIGWINCH`
- [ ] write tests for the decoder over recorded byte sequences: ordinary keys, modified keys, kitty
      keyboard forms, SGR press/drag/release, and a sequence split across two reads
- [ ] write tests for raw-mode restoration on both the normal and panicking exit path
- [ ] run tests — must pass before Task 4

### Task 4: agwinterm control-pipe client

- [ ] implement a Rust client for the agwinterm control pipe: connect to the pipe named by
      `%AGWINTERM_PIPE%`, write one JSON request per line, read the
      `{"ok":true,"result":...}` / `{"ok":false,"error":...}` envelope back
- [ ] target the session named by `%AGWINTERM_SESSION_ID%` rather than `"active"`, so a frame can
      never land in a pane the user switched to
- [ ] detect the host: absent `AGWINTERM_ENABLED`, fail with a clear message naming what is required
      instead of producing a blank pane
- [ ] handle a closed or unavailable pipe as a recoverable error with reconnect, not a panic
- [ ] write tests against a real named-pipe server fixture: request/response round-trip, an error
      envelope, a server that closes mid-request, and a server that never accepts
- [ ] write tests for host detection with the env vars present and absent
- [ ] run tests — must pass before Task 5

### Task 5: File-based frame output (bring-up path)

- [ ] implement the output half of the Windows backend using the **existing** `image.frame` command:
      encode the composited frame to PNG, write it to a temp path, and publish it via the control
      pipe with `cols`/`rows` set to the pane's cell span so it scales to the grid
- [ ] reuse ids across frames so agwinterm's content-signature cache behaves as designed
- [ ] clean up temp files, and survive a frame whose file write fails
- [ ] keep this path permanently as the fallback and as the thing the shm path is diffed against —
      it is not throwaway scaffolding
- [ ] write tests for cell-span computation from pixel size and cell metrics, including a pane too
      small to place into
- [ ] write tests for the publish path against the named-pipe fixture from Task 4
- [ ] run tests — must pass before Task 6

### Task 6: `pixel-node` on Windows

- [ ] make `pixel-node` build on Windows: the `Owned { bgra, width, height }` variant of
      `SurfacePixels` already exists and is the Windows path
- [ ] give `draw_frame`'s match a Windows-valid arm set, and confirm `surface.rs` has no
      macOS/linux-only variant left unguarded
- [ ] confirm the napi module loads under Node v22 on Windows
- [ ] write tests for `draw_frame` over the `Owned` variant, including a stride wider than the width
      and a zero-area damage rect
- [ ] run tests — must pass before Task 7

### Task 7: Electron offscreen capture on stock Electron

- [ ] add a Windows branch to `offscreenPreferences` in `browser/src/page/offscreen.ts` returning
      `{ useSharedTexture: false, deviceScaleFactor }` — no shared memory, no patched build
- [ ] make `initOffscreenMode` report `bitmap` on Windows without throwing
- [ ] confirm `presentPaint` falls through to `presentBitmap` and that `BitmapPresenter`'s coalescing
      is what throttles frame delivery
- [ ] set the frame rate through the existing `frame-rate.ts` path rather than a new knob
- [ ] write tests for `offscreenPreferences` per platform
- [ ] write tests for `presentPaint` selecting the bitmap path when no texture and no shm frame are
      present, and for a zero-area image being rejected
- [ ] run tests — must pass before Task 8

### Task 8: Milestone — a page on screen

- [ ] wire the pieces: launch Electron OSR, composite through `pixel-core`, publish through the
      file-based path, into a Debug agwinterm pane
- [ ] load a static page and confirm it is legibly on screen at the right size and position
- [ ] confirm the pane still behaves as a terminal around the image (scroll, resize, switch away and
      back)
- [ ] measure and record the achieved frame rate and where the time goes, in
      `docs/design/02-frame-budget.md` — this number is the case for the shm path
- [ ] fix whatever this reveals before continuing; record surprises as ➕ or ⚠️ items
- [ ] write tests for the startup sequence's failure modes: no agwinterm, pane too small, Electron
      failing to launch
- [ ] run tests — must pass before Task 9

### Task 9: Interactive input

- [ ] route decoded keyboard and mouse events into Chromium via the existing `browser/src/page/input.ts`
      path, translating from the terminal's cell coordinates to page pixels
- [ ] verify the translation accounts for `deviceScaleFactor` and the pane's cell metrics, since an
      off-by-one cell is a wrong click target
- [ ] confirm the existing keybindings (`browser/src/session/keybindings.ts`) resolve sensibly on
      Windows, mapping Cmd-based bindings to Ctrl
- [ ] write tests for cell→pixel translation including edge cells and a scaled display
- [ ] write tests for modifier mapping and for a mouse drag sequence producing the expected page events
- [ ] run tests — must pass before Task 10

### Task 10: Shared-memory fast path

- [ ] **precondition**: `agwinterm/docs/specs/image-frameshm.md` exists and the verb is available on
      the Debug instance. If not, stop and report rather than guessing the layout.
- [ ] implement the producer side: create the named mapping, write BGRA into the inactive slot,
      publish by bumping the ready sequence, and send `image.frameshm`
- [ ] carry BGRA end to end — no PNG encode, no swizzle, no temp file
- [ ] keep the file-based path selectable by env var, and fall back to it automatically when
      `image.frameshm` is unavailable, so an older agwinterm still works
- [ ] release the mapping on shutdown, and ensure an abnormal exit cannot leave the terminal reading
      a stale slot
- [ ] write tests for slot alternation and sequence monotonicity
- [ ] write tests for the fallback triggering on an `{"ok":false,"error":"unknown command..."}` reply
- [ ] write tests for the producer surviving the consumer disappearing
- [ ] re-measure the frame budget and update `docs/design/02-frame-budget.md` with the comparison
- [ ] run tests — must pass before Task 11

### Task 11: Port the CLI

- [ ] port `cli/src/` entry points: `main.ts`, `control.ts`, `instances.ts`, `registry.ts`, `ls.ts`,
      `action.ts` — path handling, the instance registry location, and process discovery
- [ ] use Windows-appropriate application data locations rather than unix conventions
- [ ] `sandbox.ts` is apparmor-specific: stub it with an explicit "not supported on Windows" rather
      than silently pretending a sandbox is in place
- [ ] `ssh.ts` and `upgrade.ts`: decide per command whether to port, stub or drop, and record the
      decision — do not leave a command that appears to work but does not
- [ ] write tests for path and registry resolution on Windows
- [ ] write tests for each stubbed command reporting unsupported clearly
- [ ] run tests — must pass before Task 12

### Task 12: Verify acceptance criteria

- [ ] verify every requirement in the Overview is implemented
- [ ] verify the port runs with no WSL and no patched Electron anywhere in the dependency chain
- [ ] verify the file-based fallback still works with `image.frameshm` disabled
- [ ] verify a killed browser process leaves the pane usable as a terminal
- [ ] verify the 19 "keep unchanged" modules are in fact unchanged (`git diff` against the vendored
      baseline); justify or revert any that are not
- [ ] run the full test suite: `cargo nextest run --workspace` and `node --test`
- [ ] run `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all --check` —
      all issues fixed
- [ ] verify test coverage meets the project standard

### Task 13: [Final] Update documentation

- [ ] update `README.md` status, install and usage for Windows
- [ ] update `docs/design/00-port-brief.md` where implementation diverged from the brief — the brief
      was already corrected once by measurement and should stay honest
- [ ] document the two frame transports, when each is used, and how to force either
- [ ] record what was dropped (`ghostty.rs`, the Swift helper, apparmor sandboxing) and why, so the
      absences read as decisions rather than oversights

## Technical Details

**The seam.** `Surface.present({ bgra, width, height, damage })` is where upstream's browser hands
pixels to the engine, and it is unchanged by this port. Everything above it — Electron, React chrome,
tabs, modals — is upstream code running as-is. Everything below it is what gets replaced.

**Why the terminal never sees an escape sequence.** ConPTY strips APC, so the Windows backend does
not write graphics to stdout at all. Frames leave through a side channel — the agwinterm control
pipe — while the pane's normal text stream stays a normal text stream. This is why the port targets
agwinterm specifically rather than "Windows terminals".

**Input direction is opposite to output.** Input arrives *through* the pty as ordinary VT sequences
(agwinterm already emits kitty keyboard and SGR mouse), so it needs no side channel; output cannot
use the pty at all. The asymmetry is the thing to hold onto when reading the backend.

## Post-Completion

**Manual verification**:
- Real browsing: a heavy page, a video, a page with a text input, devtools open.
- Long-running behaviour: memory and handle counts over an extended session.
- Behaviour when the pane is hidden, since agwinterm gates repaint on visibility.
- Multiple browser instances in different panes at once.

**External system updates**:
- agwinterm must ship `image.frameshm` for the fast path; the file-based path is the compatibility
  floor.
- Upstream terminal-browser moves independently. Decide and record a re-vendoring policy — the
  19 unchanged modules are what make re-vendoring cheap, and that only holds if they stay unchanged.

**Deliberately out of scope**:
- WSL, in any form.
- A patched Electron build for Windows.
- Zero-copy D3D11 shared-texture capture. Stock Electron on Windows can expose a shared texture
  handle and agwinterm renders with Direct2D, so the path exists — but it is a separate effort,
  justified by the Task 10 measurements or not at all.
- Terminals other than agwinterm.
