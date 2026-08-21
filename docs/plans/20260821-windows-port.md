# winterm-browser — Windows-native port

> **Revision 2**, after a revmux triage panel (`.revmux/tasks/plan-windows-port/01-initial`) raised
> 4 critical and 19 major findings against revision 1. Four things changed structurally: an
> architecture decision task now precedes all console work; the Electron install and launcher move
> ahead of the milestone; `terminal.rs` is split rather than gated; and the file-based frame path
> writes unique paths. Findings are cited inline as `[triage: …]` where the reason is not obvious.

## Overview

Bring terminal-browser to Windows, hosted by agwinterm: a real Chromium browser rendered inside a
terminal pane, with working keyboard and mouse, on stock Electron, with no WSL.

The authoritative design is [`docs/design/00-port-brief.md`](../design/00-port-brief.md). Read it
first — it records what was measured rather than assumed, and it has now been corrected twice by
evidence. In short:

- Upstream cannot run here for two independent reasons: `pixel-core` does not compile on Windows
  (41 errors), and its transport — Kitty APC escapes on stdout — is stripped by ConPTY.
- The unix dependency is **concentrated**: 64 of 68 unix-API references are in `terminal.rs`;
  **43 of `pixel-core`'s 46 source files have none**. The compositor, layout and text stack are
  portable Rust, and the browser chrome renders through them — so keeping `pixel-core` avoids
  rewriting the chrome.
- But `terminal.rs` is itself split: lines 1251–1909 are a 659-line VT input decoder with zero unix
  references and 27 passing byte-sequence tests. That decoder is what the Windows backend needs.
  Gating the module wholesale would strand it.
- Upstream's fast frame paths need an Electron fork they build themselves, but `presentBitmap`
  (`browser/src/page/paint.ts:104`) already implements a stock-Electron path.

**So the port is: split one module, port one, drop one, keep forty-three** — plus a new output
backend on agwinterm's control pipe, and an architecture decision about where the engine runs.

### What this port cannot fix, and is accepting

Two ceilings are host-side and are accepted rather than solved here
[triage: mouse quantisation, cell metrics]:

- **Pointer resolution is one character cell.** agwinterm discards the sub-cell offset at the encode
  site and has no `?1016`. Small link targets, hover, drag-select and scrollbar grabs all quantise.
- **Cell pixel metrics are not published**, so the renderer cannot match the pane's physical pixels
  without a host change.

Both have a cheap host-side fix, and both are now **explicit dependencies on the agwinterm plan**
rather than assumptions. If that plan does not ship them, this port still works — with a
cell-resolution pointer and a possibly-resampled image — and that is the documented outcome, not a
surprise discovered at Task 11.

## Context (from discovery)

Upstream reference (read-only, never committed): `.reference/terminal-browser/`.
agwinterm source: `C:\Users\boris\source\agwinterm`.

| area | file | note |
|---|---|---|
| tty layer to replace | `pixel-core/src/terminal.rs` lines 4, 193–1250 | termios raw mode, `/dev/tty`, `rustix::shm`, `pipe`+`O_NONBLOCK`, Kitty-to-stdout encoder |
| **decoder to keep** | `pixel-core/src/terminal.rs` lines **1251–1909** | zero unix refs; `parse_csi`, `parse_sgr_mouse`, `parse_kitty_keyboard`, `parse_osc_color`, … all take `&[u8]` |
| **types to extract** | `terminal.rs:11-175` | `Event`, `KeyEvent`, `KeyKind`, `Mods`, `Key`, `Mouse`, `MouseKind`, `MouseButton`, `TerminalColors`, `ColorSlot`, `WindowSize`, `Waker`, `SessionEnv` — imported by 11 keep-unchanged modules; `lib.rs` re-exports `SessionEnv` at crate root |
| seam width | `impl Terminal`, `terminal.rs:336-1061` | **24 public methods**, including 5 clipboard calls reached via `&mut Terminal` from `engine/clipboard.rs` |
| IPC to port | `pixel-core/src/herdr.rs` | `UnixStream`/`UnixListener` → named pipes, or gated off for v1 |
| to drop | `pixel-core/src/ghostty.rs` | `SIGUSR2` to ghostty; no Windows analogue |
| daemon architecture | `cli/src/main.ts:119,155,301`, `browser/src/daemon.ts:96-106`, `browser/src/main.tsx:55` | tty-by-path into a detached daemon; no Windows analogue |
| launcher | `cli/src/main.ts:65-68,80-86,109` | `/bin/sh -c`, `ELECTRON_DEV_BIN=["electron"]` (no `.exe`), POSIX quoting, `2>>` redirection |
| install hook | `browser/package.json:7` | `"postinstall": "bash ../scripts/fetch-electron.sh"` — fetches the fork |
| pnpm gate | `pnpm-workspace.yaml` | `onlyBuiltDependencies: [better-sqlite3, esbuild]` — **electron is not listed**, so its own binary download is blocked |
| napi bridge | `pixel-node/src/{lib,surface}.rs` | `Owned { bgra, width, height }` is ungated and is the Windows path; buffer recycling at `surface.rs:53-58` is built around it |
| unix sockets | `store/src/paths.ts:46-48`, `browser/src/daemon.ts:38-39`, `browser/src/registry.ts:52-57` | **two** socket protocols, persisted in `store/src/schema.ts:7`, consumed by 4 CLI modules |
| the seam | `Surface.present` from `pixel-react` | what `browser/` calls; the Windows backend plugs in here |
| host frame path | agwinterm `ControlServer.cs:249`, `HandleImageFrame` at `:426` | `ContentSignature` at `:487-496` is mtime^length^hash(path) — it never reads bytes |

**Tooling**: `cargo nextest run --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo fmt --all --check`, `node --test`. `pixel-core` has **246 `#[test]` functions across 25 files**;
~197 are in keep-unchanged modules and become a live per-task regression net the moment Task 4 lands.

## Constraints

- **Windows-native only. WSL is out of scope** and is not an acceptable fallback for any task.
- **Stock Electron.** No patched build. Note this is not free: removing the fork fetch without also
  allowing electron's own postinstall leaves `node_modules/electron/dist` empty and no `electron.exe`
  anywhere — a worse failure, hit at the milestone rather than at install. Task 1 handles both halves.
- **This plan depends on the agwinterm plan** for three things now, not one: `image.frameshm`
  (Task 12, optional, self-guarding), cell metrics (Task 6, blocking), and `?1016` pixel mouse
  (Task 11, degrades gracefully). Contract lives in `agwinterm/docs/specs/image-frameshm.md`.
  **Tasks 1–10 have zero dependency on the agwinterm plan** [triage: confirmed against
  `HandleImageFrame` — every capability Task 7 needs is in shipped code].
- **Never test against the real agwinterm instance.** Debug build → instance id `agwinterm-dev`, own
  pipe and data dir. Verify with `agwintermctl --pipe agwinterm-dev tree` before trusting a result.
- **Do not weaken the 43 keep-unchanged files to make something compile.** A needed change there is a
  ➕ finding, not a quiet edit.

## Development Approach

- **Testing approach**: Regular (code first, then tests).
- Complete each task fully before moving to the next.
- **CRITICAL: every task MUST include new/updated tests**, as separate checklist items, covering
  success and error scenarios.
- **CRITICAL: all tests must pass before starting the next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- `cargo clippy -- -D warnings` and `cargo fmt --check` are part of "tests pass".

## Testing Strategy

- **Unit tests**: every task. Rust via `cargo nextest`, TypeScript via `node --test`.
- **Platform-behaviour tests**: prefer driving the real thing (a real named pipe, a real
  `MemoryMappedFile`, a real Debug agwinterm) over a mock encoding a guess about Win32.
- **The ~197 inherited tests are the regression net.** From Task 4 onward they must run on Windows
  and stay green; that is what makes "keep forty-three unchanged" a checkable claim.
- **Visual confirmation is a milestone, not a test** (Task 10). Screenshots go in Post-Completion.

## Progress Tracking

- Mark completed items `[x]` immediately. Add discovered tasks with ➕. Blockers with ⚠️.

## Implementation Steps

### Task 1: Vendor, make `pnpm install` actually work, and take a full-tree baseline

- [x] copy upstream `engine/`, `browser/`, `cli/`, `terminals/`, `store/` into the repo root,
      preserving `LICENSE`, and record the upstream commit in `docs/design/UPSTREAM.md`
      — ⚠️ **there is no commit to record**: the reference checkout carries no VCS metadata, so
      `UPSTREAM.md` records content digests instead. Also vendored `assets/` (root, distinct from
      `engine/assets/` — `session.tsx:89` resolves it at runtime) and `package.json` /
      `pnpm-workspace.yaml` / `pnpm-lock.yaml`. The Rust workspace root stays at `engine/`, so
      cargo commands run from there, not the repo root.
- [x] do **not** copy `install.sh`, `fetch-electron.sh`, `apparmor.sh`, `bundle.sh` — `scripts/`
      was not copied at all; also skipped `herdr-plugin/`, `release-worker/`, `skill/`
- [x] **remove the `postinstall` hook from `browser/package.json:7`** — it runs `bash` on the
      patched-Electron fetch script the Constraints forbid, and with `scripts/` uncopied it fails on
      a missing file regardless. Record it as the first intentional divergence from upstream.
- [x] **add `electron` to `onlyBuiltDependencies` in `pnpm-workspace.yaml`** (or fetch the stock
      binary explicitly) — pnpm 10 blocks the electron package's own binary download, which is *why*
      upstream substituted the fork fetch. Removing the hook alone yields an install that succeeds
      and still has no Electron binary. [triage: critical]
      — ➕ **the premise no longer holds for Electron 43.3.0: it has no `postinstall` at all.**
      It dropped one and downloads lazily on first `require("electron")`, so listing it in
      `onlyBuiltDependencies` is currently inert. Both halves were done anyway: the entry is kept
      for a version that reinstates a build script, and the hook was **replaced** rather than
      removed, with `node node_modules/electron/install.js` — cross-platform, stock binary,
      idempotent. That is the plan's "or fetch the stock binary explicitly" branch.
- [x] run `pnpm install` and confirm `node_modules/electron/dist/electron.exe` exists — this is the
      pass/fail, not "the command exited 0"
      — verified at `browser/node_modules/electron/dist/electron.exe`, 348 MB, stock 43.3.0 win32-x64,
      produced by `pnpm install` alone from a deleted `dist/`. Note `pnpm` is not on PATH on this
      machine; it runs via `corepack pnpm` (10.13.1, matching `packageManager`).
- [x] run `cargo check --workspace`; commit the error list to `docs/design/01-baseline-errors.md`
      — **41 errors, in exactly 3 files** (`terminal.rs` 37, `ghostty.rs` 3, `herdr.rs` 1); the other
      43 `pixel-core` files produce zero. Not one error falls in `terminal.rs:1251–1909`. The brief's
      numbers are confirmed. `openh264-sys2` builds clean under MSVC, closing a Task 8 risk early.
      ⚠️ `cargo fmt --all --check` reports 172 diffs across 30 vendored files, most of them
      keep-unchanged — see the disposition in the baseline doc; the check is scoped to code this
      port writes, since reformatting them is the silent edit the Constraints forbid.
- [x] **run the same unix-API disposition pass over `browser/`, `cli/`, `store/`, `terminals/` and
      the JS build scripts**, recording it beside the `pixel-core` table — the Rust measurement
      covered the least risky layer, and every blocker found so far was outside it [triage: major]
      — 27 files, ranked by disposition in the baseline doc. Also recorded: the vendored
      `pixel-terminals` suite is 28/29 on Windows, and the one failure is pre-existing upstream
      breakage (`herdr.ts:45` has no fallback), not a porting problem.
- [x] **probe ConPTY input fidelity**: from a child under a Debug agwinterm with
      `ENABLE_VIRTUAL_TERMINAL_INPUT` set, record the exact bytes received for an SGR mouse report
      and a kitty-keyboard CSI-u report. These are synthesized host-side and pass through conhost's
      `INPUT_RECORD` round-trip; CSI-u forms are exotic and Task 11 is the first thing that would
      notice a loss. Record next to the `cargo check` baseline. [triage: minor, cheap, de-risks two tasks]
      — done against a **real ConPTY created by the probe itself** (`tools/conpty-probe`) rather than
      a Debug agwinterm: no agwinterm build exists on this machine, only the live instance the
      Constraints forbid touching, and the risk being measured is conhost's, not agwinterm's.
      **Result: every sequence survives verbatim** — SGR press/release/drag, three-digit coordinates,
      CSI-u plain and modified, modified arrows, and a four-sequence burst. Task 11's "if CSI-u did
      not survive" branch can be closed.
      — ➕ **a ConPTY child's std handles can be `NUL` while it is attached to the pty**:
      `GetFileType` says `FILE_TYPE_CHAR`, every console API returns `ERROR_INVALID_HANDLE`, and the
      process looks console-less. Task 5 must open `CONIN$`/`CONOUT$` by name — the analogue of
      upstream opening `/dev/tty` rather than using fd 0. This was the cause of a first probe run
      that reported *everything* dropped, control case included.
- [x] write a test asserting the vendored `pixel-core` file inventory (46 files) matches expectation,
      so a re-vendor cannot silently add a unix-bound module
      — `tools/vendor-check/inventory.test.mjs`: 46 files, exact set match, unix APIs confined to the
      3 replaceable modules, 43 files unix-free, and the decoder region still unix-free. A companion
      `install.test.mjs` pins the two install fixes so a re-vendor cannot silently undo them.
      Note `throttle.rs` carries `#[cfg(target_os = "macos")]` code and compiles on Windows
      untouched, so the scan matches unix *APIs*, not any platform mention.
- [x] run tests — must pass before Task 2 — 14 node tests + 15 Rust tests green; `cargo fmt --check`
      and `cargo clippy -- -D warnings` clean on `tools/conpty-probe`

### Task 2: Decide where the engine process lives on Windows

**This is a design task and it blocks all console work.** Upstream's daemon opens the client's tty by
path; Windows has no path that names another process's ConPTY, and the daemon is spawned detached
with no console at all. [triage: critical]

- [x] write `docs/design/03-process-model.md` choosing between: (a) host the engine in the foreground
      process, or (b) keep the daemon and forward stdin from the CLI client over IPC
      — **(a).** One browser process per pane, attached to that pane's console. The daemon stays in
      the tree, still entered by `--daemon`, and is not what the Windows CLI launches.
- [x] cost each against what it actually touches. For (a): `browser/src/main.tsx:55` calls
      `runDaemon(cdpPort)` unconditionally and does not inspect the `--daemon` argument, so there is
      no foreground mode to switch to — this is a restructure of the browser process's top level, not
      a flag. For (b): input latency, and a second stdin protocol to own.
      — costed in the doc. (a)'s real price is one Chromium per pane and per-pane profiles;
      `claimProfile()` already hands 32 concurrent processes their own `userData` dir, and the
      instance registry is already keyed per session, so neither needed new code.
      ➕ **(b) is much larger than "a second stdin protocol"**: `query_colors` (`terminal.rs:892`)
      and `cell_size` (`:869`) write a query and read the reply off the same descriptor under a
      300 ms deadline, and 5 clipboard calls (`:1035-1057`) are reached through `&mut Terminal` from
      `engine/clipboard.rs`. (b) is a bidirectional RPC over the whole 24-method seam, plus loading
      the native addon into the Node CLI to touch `CONIN$` at all. Latency was never the issue.
- [x] note that `createRoot({tty: null})` is already a supported shape
      (`pixel-react/src/index.ts:262-264` falls back to a stdio bridge; `session.tsx:313` has a
      `!this.ctx.tty` branch) — this is the seam either option builds on
      — confirmed, and `SessionContext.tty` is optional (`session.tsx:49`), so `foreground.ts`
      simply does not set it. (a) adds no new engine code path.
- [x] confirm the output side is unaffected either way: frames leave via the control pipe addressed
      by `AGWINTERM_SESSION_ID` and never need a tty
      — confirmed, including for the daemon shape, which looks like it should break the addressing
      and does not: the client already sends `env: process.env` (`cli/src/main.ts:206`), the daemon
      forwards it (`daemon.ts:109`), and it reaches the engine as `sessionEnv` (`session.tsx:318`),
      where `SessionEnv::of_session` (`terminal.rs:320`) exists for exactly this. The decision rests
      on input alone.
- [x] record the decision, the rejected option and why, so Task 5 has a brief to work from
      — "What Task 5 must do, that upstream did not", four numbered items, plus a third shape
      (per-pane console proxy to a shared daemon) considered and rejected as strictly worse than (b).
- [x] write tests for whichever process-boundary shape is chosen, at the level the decision permits
      (an IPC round-trip test for (b); a foreground-entry smoke test for (a))
      — two layers. `tools/console-inherit-probe` (new crate) measures the Win32 fact the decision
      rests on with real processes: a real ConPTY, a console-subsystem middle standing in for the CLI,
      and a grandchild standing in for `electron.exe`, both grandchildren running the identical body
      so the PE subsystem is the only variable. `tools/process-model/entry.test.mjs` is the
      foreground-entry smoke test; it compiles the import-free `browser/src/entry.ts` with the repo's
      esbuild (`browser/` cannot be typechecked until `pixel-react` builds in Task 8) and asserts the
      wiring in `main.tsx`/`foreground.ts` by reading them.
      ➕ **the measurement overturned the assumption behind (a)**: a GUI-subsystem child is *not*
      given the pane's console even on an ordinary spawn — `CONIN$` fails with `ERROR_INVALID_HANDLE`
      — while the console-subsystem control gets it for free. Electron is `SUBSYSTEM_WINDOWS_GUI`
      (pinned by a test against the installed 43.3.0 binary). It can *take* the console with
      `AttachConsole`, by parent or by named pid, and then reads the pane's SGR mouse report
      verbatim. **Task 5's `open` therefore needs an attach step upstream never had.**
      ➕ `AttachConsole` on an already-attached process returns `ERROR_ACCESS_DENIED` — one console
      per process, measured. That, not `DETACHED_PROCESS`, is what rules the daemon out; a detached
      child re-attaches to its parent's console fine, so "drop `detached: true`" is not a fix.
      ➕ scope: the decision was made executable rather than left on paper — `browser/src/entry.ts`,
      `browser/src/foreground.ts`, and a three-line switch in `main.tsx`. Off Windows nothing changes,
      because the CLI still passes `--daemon` and that still selects the daemon.
- [x] run tests — must pass before Task 3 — 14 Rust tests in `console-inherit-probe` (7 unit,
      7 driving real pseudoconsoles) plus 24 node tests across `tools/`; `cargo fmt --check` and
      `cargo clippy --all-targets -- -D warnings` clean on the new crate; `conpty-probe`'s 15 still
      green; `engine`'s `cargo check --workspace` still exactly the 41 baseline errors.

### Task 3: Extract `terminal.rs`'s portable type vocabulary

Done before any gating, because `lib.rs` declares `mod terminal;` unconditionally and re-exports
`pub use terminal::SessionEnv;` at crate root — a bare `#[cfg(unix)]` breaks the crate root and 11
keep-unchanged modules. [triage: major]

- [x] move `Event`, `KeyEvent`, `KeyKind`, `Mods`, `Key`, `Mouse`, `MouseKind`, `MouseButton`,
      `TerminalColors`, `ColorSlot`, `WindowSize`, `Waker`, `SessionEnv` into their own module
      — `pixel-core/src/terminal_types.rs`, the crate's 47th file and the first the port adds.
      Three private members widened to `pub(crate)` because the decoder and the tty code still
      construct them: `KeyEvent::plain` (18 call sites, all in the decoder), `TerminalColors::set`
      (`terminal.rs:986`), and `Waker.fd` (built at `:774`, read at `:785`). Nothing became `pub`.
      ⚠️ **`Waker` is in the vocabulary but is not portable**: its body is the write end of the tty
      backend's self-pipe (`rustix::fd::OwnedFd`). It moved because `lib.rs` exports it at the crate
      root, so gating it would break the root — but Task 5 replaces the body, not just the backend.
      It happens to *compile* on Windows (rustix aliases `fd` to the socket types there), which is
      why the baseline error count did not move; that is not the same as working.
- [x] **re-export them from `terminal`** so all 11 importers and `lib.rs`'s `pub use` are untouched:
      `engine/{clipboard,doc,embed,input,keys,mod,pointer,scroll}.rs`, `menu.rs`, `native.rs`,
      `text_input.rs`
      — one `pub use crate::terminal_types::{…}` at `terminal.rs:14`. All 11 importers and both of
      `lib.rs`'s `pub use terminal::…` lines are byte-identical; `git diff` inside `pixel-core` is
      two files, and `lib.rs`'s is a single added `mod terminal_types;`.
- [x] verify `text_input.rs`'s tests still resolve `crate::terminal::Mods` and `KeyKind` (:1345-1351)
      — verified by compiling, not by reading: `cargo check -p pixel-core --all-targets
      --target x86_64-unknown-linux-gnu` is clean, and that target is the only one on which the
      crate compiles at all today. ➕ **cross-checking against a unix target is how this task got
      real verification on a Windows box.** `rustup target add x86_64-unknown-linux-gnu` plus
      `cargo check` needs no linker, so the unix build — including every `#[cfg(test)]` target — is
      compile-verified here. This is a development check, not a WSL fallback; nothing runs.
- [x] note in the commit that a re-export shim is the expected diff, so Task 14's unchanged-check
      does not read it as a violation
      — noted in the commit body, and made mechanical rather than remembered: the Task 1 vendor-check
      now separates `PORT_ADDED_FILES` from upstream's 46 and asserts the shim's shape directly
      (every moved name re-exported, no importer rewritten onto the new path, `lib.rs` limited to the
      one `mod` line). Its decoder-region test was re-anchored to `enum RawEvent` … `mod tests`
      instead of hardcoded lines 1251-1909, since this extraction shifted the region up by 178 lines
      and Task 4's gating will move it again.
- [x] write tests asserting each re-exported path still resolves (a compile-level test module)
      — `terminal_types.rs`'s `mod tests`: three sub-modules naming the vocabulary through
      `crate::terminal::_`, through the crate root, and as the importers themselves spell it, plus a
      test that a value built through one path is assignable through another (a duplicate definition
      rather than an alias would fail to compile there). Five behavioural tests cover the moved
      bodies — `KeyEvent::plain`, `TerminalColors::set`, `WindowSize::cell_size`, `SessionEnv::var`.
      ⚠️ The compile-level half is verified now; the `#[test]` bodies cannot *run* until Task 4 makes
      `pixel-core` build on Windows, since running them on a unix target would need WSL.
- [x] run tests — must pass before Task 4 — 30 node tests (24 before, +6 for the split), 15
      `conpty-probe` and 14 `console-inherit-probe` Rust tests still green. `cargo check -p
      pixel-core --all-targets --target x86_64-unknown-linux-gnu` clean; `cargo clippy` on that
      target yields a warning set **identical to HEAD's, file for file** (15, all pre-existing
      upstream); `rustfmt --check` clean on `terminal_types.rs` and unchanged (23 diffs, as before)
      on the vendored `terminal.rs`. `cargo check --workspace` on Windows: still exactly the 41
      baseline errors, in the same three files.

### Task 4: The backend seam — gate the tty code, keep the decoder

- [ ] define `TerminalBackend` covering the **24 public methods** of `impl Terminal`
      (`terminal.rs:336-1061`): `new`, `open`, `reports_color_scheme`, `relayed`, `kitty_keyboard`,
      `set_key_event_types`, `draw`, `read_event`, `poll_event`, `waker`, `watch_resize`, `size`,
      `reports_pixel_mouse`, `frames_are_inline`, `forget_cell_size`, `cell_size`, `query_colors`,
      `request_colors`, `set_pointer_shape`, `set_clipboard`, `request_clipboard`,
      `clipboard_data_supported`, `request_clipboard_types`, `request_clipboard_data`
- [ ] the five clipboard methods are **not optional** — `engine/clipboard.rs` takes `&mut Terminal`
      at `:96,:121,:157,:181,:220`. They are OSC-52-shaped and return `io::Result`, so they trait
      cleanly, but they must be on the trait [triage: major, revision 1 omitted clipboard entirely]
- [ ] derive the trait from existing callers, not from a fresh design
- [ ] **`#[cfg(unix)]` covers the tty and frame-transport code only (lines 4, 193–1250).
      Lines 1251–1909 — the VT decoder — and its `#[cfg(test)] mod tests` at 1911 stay
      unconditional.** Gating the module wholesale strands 659 lines of portable code and 27 tests
      that Task 5 needs. [triage: major]
- [ ] add a `#[cfg(windows)]` stub returning "unimplemented" for every method
- [ ] `#[cfg(unix)]`-gate `ghostty.rs`; record `herdr.rs` as deferred to Task 13
- [ ] verify `cargo check --workspace` is clean on Windows — the task's real deliverable
- [ ] verify the ~197 inherited tests in keep-unchanged modules now **run and pass on Windows**;
      record the count, since it is the regression net for every task after this
- [ ] write tests for the trait contract against a fake backend: event ordering, size reporting,
      raw-mode enter/leave pairing, clipboard request/response
- [ ] run tests — must pass before Task 5

### Task 5: Windows console input

- [ ] implement the input half of the Windows backend, **in the process Task 2 chose**
- [ ] enable VT input with `SetConsoleMode` (`ENABLE_VIRTUAL_TERMINAL_INPUT`, line and echo input
      off), restoring the prior mode on exit **including on panic**
- [ ] **reuse the existing decoder at `terminal.rs:1251-1909` — do not write a second one.** It
      already handles kitty CSI-u, SGR mouse, OSC color and incomplete tails; its
      `parse_event_consumes_one_event_and_reports_incomplete_tails` test (:2144) is exactly the
      split-across-two-reads case
- [ ] handle resize from the console screen buffer, since there is no `SIGWINCH`
- [ ] write tests only for what is genuinely new — the Windows read loop, mode set/restore, and
      resize — rather than re-testing the inherited parser
- [ ] write tests for raw-mode restoration on the normal and panicking exit paths
- [ ] run tests — must pass before Task 6

### Task 6: agwinterm control-pipe client, and where cell metrics come from

- [ ] implement a Rust client for the control pipe: connect to `%AGWINTERM_PIPE%`, one JSON request
      per line, read the `{"ok":true,"result":...}` / `{"ok":false,"error":...}` envelope
- [ ] target `%AGWINTERM_SESSION_ID%`, never `"active"` — a frame must not land in a pane the user
      switched to
- [ ] absent `AGWINTERM_ENABLED`, fail with a message naming what is required rather than producing
      a blank pane
- [ ] handle a closed pipe as recoverable with reconnect, not a panic
- [ ] **decide and record where cell pixel metrics come from before Task 7 needs them.** Neither of
      `pixel-core`'s mechanisms works here: `\x1b[16t` hits agwinterm's `csi_dispatch`
      (`emulator.rs:964-1045`) which has no `t` arm, and `tcgetwinsize`'s `ws_xpixel` has no Windows
      equivalent. No control verb and no `AGWINTERM_*` variable carries them. The options are a new
      agwinterm verb, a config value, or "render at a fixed resolution and let `cols`/`rows` scale
      it". **Do not let `terminal.rs:840-843`'s hardcoded `(16, 32)` fallback stand as the answer** —
      it is a silent wrong guess and produces wrong click targets. [triage: major]
- [ ] if the choice is a host change, open it in the agwinterm plan and record the dependency here
- [ ] write tests against a real named-pipe server fixture: round-trip, error envelope, server closes
      mid-request, server never accepts
- [ ] write tests for host detection with the env vars present and absent
- [ ] run tests — must pass before Task 7

### Task 7: File-based frame output (bring-up path)

- [ ] implement the output half using the **existing** `image.frame`, publishing with `cols`/`rows`
      set to the pane's cell span
- [ ] **write each frame to a unique path, or write-then-atomically-rename.** Do not reuse one path.
      agwinterm's phase 1 does `ContentSignature(path)` then `File.ReadAllBytes(path)` synchronously
      while a free-running producer is already writing the next frame: `ReadAllBytes` either hits a
      sharing violation — swallowed by the bare `catch { data = null; }` at `ControlServer.cs:458`,
      silently re-placing the stale image — or returns a partial PNG the decoder then fails on.
      [triage: major]
- [ ] **drop the id-reuse-for-cache rationale.** `ContentSignature` is
      `mtime ^ (length<<1) ^ hash(path)` and never reads bytes. Every browser frame differs, so the
      cache never skips; worse, two consecutive frames of equal PNG length within the filesystem's
      timestamp granularity produce the *same* signature and the new frame is silently dropped.
      [triage: major]
- [ ] clean up the resulting file churn, and survive a failed frame write
- [ ] keep this path permanently as the fallback and as the baseline the shm path is diffed against
- [ ] write tests for cell-span computation, including a pane too small to place into
- [ ] write tests for unique-path generation and cleanup under sustained frame production
- [ ] write tests for the publish path against the Task 6 pipe fixture
- [ ] run tests — must pass before Task 8

### Task 8: `pixel-node` on Windows

- [ ] **build the native dependencies under MSVC first**: `openh264` with the `source` feature
      compiles C++ via a build script, and seven tree-sitter grammars build C. Whether they compile
      under MSVC is unchecked, and a toolchain failure here should surface as its own finding rather
      than as a confusing napi error. [triage: immaterial-but-actionable]
- [ ] make `pixel-node` build: `SurfacePixels::Owned { bgra, width, height }` is ungated and is the
      Windows path — on Windows the enum has exactly one variant. Note the `Owned` path is *tuned*,
      not vestigial: `SurfaceMailbox::submit` (`surface.rs:53-58`) recycles the dropped frame's
      `Vec<u8>`, and `BitmapPresenter` unions damage across coalesced frames
- [ ] give `draw_frame`'s match a Windows-valid arm set
- [ ] **fix the napi build script's hardcoded `.dylib`/`.so`** so it finds the Windows `.dll`
      artifact [triage: minor]
- [ ] confirm the napi module loads under Node v22 on Windows
- [ ] write tests for `draw_frame` over `Owned`, including a stride wider than the width and a
      zero-area damage rect
- [ ] run tests — must pass before Task 9

### Task 9: Electron capture and the launcher

Moved ahead of the milestone: revision 1 put the launcher in Task 11, three tasks *after* the
milestone that needs it. [triage: critical]

- [ ] add a Windows branch to `offscreenPreferences` (`browser/src/page/offscreen.ts`) returning
      `{ useSharedTexture: false, deviceScaleFactor }`, and make `initOffscreenMode` report `bitmap`
      on Windows without throwing. **Check first whether the existing non-darwin branch already does
      this** — if so, say that in the plan and skip it rather than adding dead code [triage: minor]
- [ ] confirm `presentPaint` falls through to `presentBitmap` and that `BitmapPresenter` throttles
- [ ] **port the launch path out of `cli/src/main.ts`**: `:109` builds
      `["/bin/sh", "-c", line]`, which does not exist on Windows; `:65-68` sets
      `ELECTRON_DEV_BIN = ["electron"]` for every non-darwin platform, but the Windows artifact is
      `electron.exe`, so the `fs.existsSync` guard at `:80-86` fails and reports
      `"missing … — build the browser first"` — the wrong diagnosis; `:105-108` applies POSIX
      single-quote escaping and `2>>` redirection
- [ ] spawn without a shell, and resolve the binary with the `.exe` suffix
- [ ] leave the registry, `ssh`, `sandbox` and `upgrade` surface to Task 13
- [ ] write tests for `offscreenPreferences` per platform
- [ ] write tests for `presentPaint` selecting the bitmap path, and rejecting a zero-area image
- [ ] write tests for binary resolution and argument construction on Windows
- [ ] run tests — must pass before Task 10

### Task 10: Milestone — a page on screen

Everything this needs now exists: install (1), process model (2), engine (3–5), transport (6–7),
napi (8), launcher (9). It needs **no agwinterm change** — `image.frame` already ships every
capability it uses, and a static page is precisely the workload it is in production for. [triage: critical, confirmed]

- [ ] launch Electron OSR, composite through `pixel-core`, publish through the file-based path, into
      a Debug agwinterm pane
- [ ] load a static page; confirm it is legibly on screen at the right size and position
- [ ] confirm the pane still behaves as a terminal around the image (scroll, resize, switch away)
- [ ] measure and record the frame budget in `docs/design/02-frame-budget.md`: PNG encode, file
      write, agwinterm's read, its async PNG decode. **This number is the case for Task 12** — and
      if a single static page takes seconds to appear, that is a finding, not a milestone
- [ ] fix what this reveals before continuing; record surprises as ➕ or ⚠️
- [ ] write tests for the startup failure modes: no agwinterm, pane too small, Electron fails to launch
- [ ] run tests — must pass before Task 11

### Task 11: Interactive input

- [ ] route decoded keyboard and mouse events into Chromium via `browser/src/page/input.ts`
- [ ] translate cell coordinates to page pixels, accounting for `deviceScaleFactor` and the metrics
      decision from Task 6
- [ ] **expect `reports_pixel_mouse()` to be false** and verify the consequences are the documented
      ceiling rather than a bug: `engine/mod.rs:352` sets the flag, `engine/pointer.rs:61` gates
      `let located = self.pixel_mouse.then_some(point)` so hover and pairing get no position, and
      `engine/scroll.rs:192` gates `wants_cursor`
- [ ] compare against the Task 1 ConPTY probe: if CSI-u forms did not survive, that is the cause
- [ ] map Cmd-based bindings (`browser/src/session/keybindings.ts`) to Ctrl
- [ ] write tests for cell→pixel translation including edge cells and a scaled display
- [ ] write tests for modifier mapping and a drag sequence producing the expected page events
- [ ] run tests — must pass before Task 12

### Task 12: Shared-memory fast path

- [ ] **precondition**: `agwinterm/docs/specs/image-frameshm.md` exists **and states the literal
      `Local\` name prefix and the producer slot-reuse invariant**. The spec existing is not enough —
      agwinterm's own Task 6 writes its throughput number into the same file, so it is authoritative
      from Task 1 but incomplete until Task 6. If either field is missing, stop and report.
- [ ] implement the producer: create the **named** mapping (never a raw `HANDLE` — a Win32 handle is
      process-local and meaningless in the consumer without `DuplicateHandle`), write BGRA into the
      inactive slot, publish by bumping `ready`, send `image.frameshm`
- [ ] **honour the producer invariant**: do not begin filling a slot until the reply for the frame
      two back has returned. Two slots are sufficient *only* because the control pipe is
      request/response; the two-slot alternation alone does not carry the no-tearing claim
      [triage: major]
- [ ] carry BGRA end to end — no PNG encode, no swizzle, no temp file
- [ ] keep the file path selectable by env var and fall back automatically when the verb is absent —
      the reply is literally `{"ok":false,"error":"unknown command '...'"}` (`ControlServer.cs:250`)
- [ ] release the mapping on shutdown; an abnormal exit must not leave a stale slot readable
- [ ] write tests for slot alternation, sequence monotonicity, and **a producer publishing faster
      than the consumer drains**
- [ ] write tests for the fallback triggering on the unknown-command reply
- [ ] write tests for the producer surviving the consumer disappearing
- [ ] re-measure and update `docs/design/02-frame-budget.md` with the comparison
- [ ] run tests — must pass before Task 13

### Task 13: CLI, and the two Unix-socket protocols

Larger than revision 1's "port the CLI": upstream has **two** socket protocols, not one, and their
endpoint strings are persisted and consumed across four CLI modules. [triage: major]

- [ ] port both to named pipes behind **one shared endpoint abstraction**: the daemon socket
      (`store/src/paths.ts:46-48`, `browser/src/daemon.ts:38-39`) and the per-browser socket
      (`browser/src/registry.ts:52-57`), both currently filesystem paths deleted with `fs.rmSync`
- [ ] update the persisted endpoint column (`store/src/schema.ts:7`) and its four consumers —
      `cli/src/{main,control,instances,action}.ts`
- [ ] cover stale-endpoint cleanup, which has no `fs.rmSync` analogue for named pipes
- [ ] port `registry.ts`, `ls.ts` and application-data locations to Windows conventions
- [ ] `sandbox.ts` is apparmor-specific: stub it with an explicit "not supported on Windows" rather
      than silently pretending a sandbox is in place
- [ ] `ssh.ts`, `upgrade.ts`: port, stub or drop per command, and record the decision — do not leave
      a command that appears to work but does not
- [ ] port `herdr.rs` to named pipes, or record it as permanently disabled on Windows with a reason
- [ ] **`--split` is out of scope unless agwinterm gains a matching verb.** `pixel-terminals` has no
      agwinterm detector, and agwinterm's `session.split` takes an operation but not a command
      (`ControlServer.cs:134-135,163`), so upstream's `--split` semantics cannot be met without a
      further host change. Record it as unsupported. [triage: major]
- [ ] write tests for path, endpoint and registry resolution on Windows
- [ ] write tests for stale-endpoint cleanup
- [ ] write tests for each stubbed command reporting unsupported clearly
- [ ] run tests — must pass before Task 14

### Task 14: Verify acceptance criteria

- [ ] verify every requirement in the Overview is implemented
- [ ] verify no WSL and no patched Electron anywhere in the dependency chain — including that
      `browser/package.json` has no `postinstall` and no fork mirror appears in the lockfile
- [ ] verify the file-based fallback works with `image.frameshm` disabled
- [ ] verify a killed browser process leaves the pane usable as a terminal
- [ ] **verify the 43 keep-unchanged files are unchanged** (`git diff` against the vendored baseline)
      — all 46 `pixel-core` source files including the five subdirectories, not the 19 revision 1
      named. The Task 3 re-export shim is the one expected diff. [triage: major]
- [ ] verify the inherited ~197 tests still pass
- [ ] run `cargo nextest run --workspace` and `node --test`
- [ ] run `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all --check`
- [ ] verify coverage meets the project standard

### Task 15: [Final] Update documentation

- [ ] update `README.md` status, install and usage for Windows
- [ ] update `docs/design/00-port-brief.md` where implementation diverged — the brief has been
      corrected twice by evidence and should stay honest
- [ ] document the two frame transports, when each is used, how to force either
- [ ] record what was dropped (`ghostty.rs`, the Swift helper, apparmor sandboxing, `--split`) and
      why, so absences read as decisions
- [ ] record the accepted ceilings (cell-resolution pointer, cell metrics) and what would lift them

## Technical Details

**The seam.** `Surface.present({ bgra, width, height, damage })` is where upstream's browser hands
pixels to the engine, and it is unchanged by this port. Everything above it — Electron, React chrome,
tabs, modals — is upstream code running as-is. Everything below it is replaced.

**Why the terminal never sees an escape sequence.** ConPTY strips APC, so the Windows backend does
not write graphics to stdout. Frames leave through the control pipe while the pane's text stream
stays a normal text stream. This is why the port targets agwinterm specifically.

**Input direction is opposite to output.** Input arrives *through* the pty as ordinary VT sequences,
so it needs no side channel; output cannot use the pty at all. Hold onto that asymmetry when reading
the backend — and note it is also why the daemon architecture breaks on input only (Task 2).

## Post-Completion

**Manual verification**: real browsing (heavy page, video, text input, devtools); long-running memory
and handle counts; hidden-pane behaviour; multiple instances at once. Pay attention to whether
cell-resolution pointing is merely awkward or actually disqualifying for real use — that judgement
decides whether `?1016` becomes a funded agwinterm change.

**External system updates**: agwinterm ships `image.frameshm` (fast path), cell metrics (blocking for
Task 6) and optionally `?1016`. Upstream terminal-browser moves independently — record a re-vendoring
policy; the 43 unchanged files are what make re-vendoring cheap, and only if they stay unchanged.

**Deliberately out of scope**: WSL in any form; a patched Electron for Windows; zero-copy D3D11
shared-texture capture (justified by Task 12's measurements or not at all); terminals other than
agwinterm; `--split` pane integration.
