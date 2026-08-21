# winterm-browser — port brief

A Windows-native port of [zenbu-labs/terminal-browser](https://github.com/zenbu-labs/terminal-browser):
a real Chromium browser rendered inside a terminal pane. The host terminal is
[agwinterm](file:///C:/Users/boris/source/agwinterm) (`TERM_PROGRAM=agwinterm`).

Upstream sources are kept for reference (never committed) at `.reference/terminal-browser/`.
The agwinterm source tree lives at `C:\Users\boris\source\agwinterm`.

## Why a port and not a build flag

Upstream cannot run on Windows, for two *independent* reasons. Either alone is fatal.

### Blocker 1 — the Rust engine does not compile on Windows

`cargo check --workspace` in `.reference/terminal-browser/engine/` on `windows/amd64`,
Rust 1.93.1 (the pinned `rust-toolchain.toml` channel), fails with **41 errors** in `pixel-core`.
The unix assumptions are unconditional — not `cfg`-gated — so there is nothing to switch on:

| upstream file | unix-only API |
|---|---|
| `engine/crates/pixel-core/src/terminal.rs:4` | `rustix::termios::{OptionalActions, Termios}` — raw mode via `tcgetattr`/`tcsetattr` |
| `engine/crates/pixel-core/src/terminal.rs:505,544` | `rustix::shm::unlink` |
| `engine/crates/pixel-core/src/terminal.rs:1161` | `OpenOptions::mode(0o600)` (unix-only trait) |
| `engine/crates/pixel-core/src/terminal.rs:770` | `rustix::pipe::pipe` + `fcntl_setfl(O_NONBLOCK)` |
| `engine/crates/pixel-core/src/herdr.rs:2,308` | `std::os::unix::net::{UnixStream, UnixListener}` |
| `engine/crates/pixel-core/src/ghostty.rs:121` | `rustix::process::kill_process(pid, Signal::USR2)` |

`pixel-node` gates its zero-copy surface transports on `cfg(target_os="macos")` (IOSurface) and
`cfg(target_os="linux")` (shm). **There is no `cfg(windows)` anywhere in the workspace.**
The installer agrees: `scripts/install.sh:9-14` maps only `Darwin-arm64`, `Linux-x86_64`,
`Linux-aarch64`, and otherwise prints *"terminal-browser does not support …"*.

### Blocker 2 — ConPTY strips the transport

Upstream's entire output model is *write Kitty graphics APC escapes to stdout at frame rate*.
On Windows, ConPTY strips APC before the host emulator ever sees it. agwinterm's own gap
analysis states this (`docs/agterm-gap-analysis.md:41`):

> Kitty graphics via the control pipe (docxy), delivered out-of-band because ConPTY strips APC.

So even a hypothetical compiling `pixel-core` would paint a blank pane. The transport must change,
which is the real reason this is a port rather than a patch.

## What agwinterm already gives us

The host side is further along than the guest side, and this is what makes the port tractable:

- **Kitty graphics model** — `Agwinterm.Core/KittyGraphics.cs` holds `KittyImage` (raw PNG or
  RGB/RGBA pixels) and `ImagePlacement` with `Cols`/`Rows` cell-span scaling (Kitty `c=`/`r=`),
  so one full-pane image scales to the grid. Parsing lives in
  `native/agwinterm-core/src/emulator.rs` (`finalize_kitty_image`, `parse_kitty_keys`).
- **An out-of-band frame path already exists** — `Agwinterm.Pty/ControlServer.cs:249`
  `image.frame` takes an `images[]` array, content-signature-caches each id to skip
  re-transmits, reads pixel bytes *off* the render lock, and swaps placements under a
  microsecond-scale lock. It is a video path fed by file paths.
- **Input is solved** — SGR mouse (`?1000/?1002/?1003/?1006`,
  `Agwinterm.Core/TerminalEmulator.cs:403-405`) and the kitty keyboard protocol
  (`emulator.rs:809 kitty_keyboard`). No macOS-style background helper app is needed;
  upstream's Swift input helper has no analogue here and is simply dropped.

## Architecture

An earlier draft of this brief proposed dropping `pixel-core` wholesale and letting agwinterm
composite. Measurement says otherwise, and the cheaper design won.

### The unix dependency is concentrated, not pervasive

Counting `rustix::` / `std::os::unix` / `termios` / `libc::` / `/dev/tty` references per module
across `pixel-core`'s 22 source files:

| module | hits | disposition |
|---|---|---|
| `terminal.rs` | **64** | replace — this is the tty layer and the Kitty-to-stdout encoder |
| `herdr.rs` | 2 | port — `UnixStream`/`UnixListener` → Windows named pipes (or gate off for v1) |
| `ghostty.rs` | 2 | drop — ghostty-specific `SIGUSR2` signalling, no Windows analogue |
| **all 19 others** | **0** | **keep unchanged** |

`canvas.rs`, `paint.rs`, `text_input.rs`, `image_cache.rs`, `menu.rs`, `kitty.rs`, `shape.rs`,
`wrap.rs`, `style.rs`, `scrollbar.rs` and the rest are already portable Rust — taffy, tiny-skia and
fontdue are all cross-platform. **The compositor and UI toolkit port for free.** This matters
because the browser chrome (tab strip, URL bar, menus, modals — `browser/src/ui/*.tsx`) renders
through `pixel-react` into `pixel-core`. Dropping `pixel-core` would have meant rewriting the entire
browser chrome; keeping it means the chrome is untouched.

So the port is: **replace one module, port one, drop one, keep nineteen.**

### No patched Electron needed

Upstream's fast paths require an Electron fork they build themselves
(`scripts/fetch-electron.sh` pulls from `zenbu-labs/electron-releases`, macOS and Linux only) —
`useSharedTexture` on darwin, `useSharedMemory` on linux (`browser/src/page/offscreen.ts`).

But `presentPaint` already falls through to `presentBitmap` (`browser/src/page/paint.ts:104`),
which uses stock Electron's `paint` event: `image.toBitmap()` →
`surface.present({ bgra, width, height, damage })`, coalesced by `BitmapPresenter`. That path
runs on **stock Electron on Windows with no patch**, and `Surface.present` is the exact seam the
Windows backend plugs into.

Optimising past the bitmap copy is deliberately deferred. Stock Electron on Windows can expose a
D3D11 shared-texture handle, and agwinterm renders with Direct2D, so a genuine zero-copy path
exists later — it is not v1.

| layer | upstream (macOS/Linux) | winterm-browser |
|---|---|---|
| Browser + chrome UI | Electron OSR + React via `pixel-react` | **unchanged** |
| Compositor / layout / text | `pixel-core` (taffy / tiny-skia / fontdue) | **unchanged** — already portable |
| Electron frame capture | patched Electron: IOSurface / shm | **stock Electron bitmap path** (already written) |
| Frame pixels → terminal | Kitty APC → stdout | Windows file-mapping shared BGRA ring → control pipe |
| tty layer (`terminal.rs`) | termios raw mode, `/dev/tty`, shm, kitty encoder | **rewritten** for Windows console + agwinterm |
| Raw-mode input | termios + macOS Swift helper | Windows console VT input; helper dropped entirely |
| `herdr.rs` IPC | `UnixStream` | Windows named pipes |
| `ghostty.rs` | `SIGUSR2` to ghostty | dropped |
| CLI / terminals / store | TypeScript | mostly portable; `ssh.ts` and `sandbox.ts` (apparmor) need Windows work |

### Chosen transport

Extend agwinterm with a shared-memory frame command so Electron's paint buffer reaches the
renderer with **no PNG encode, no disk round-trip and no base64**:

```
Electron paint(BGRA)
  └─> CreateFileMapping (shared BGRA ring)
        └─> pipe: {"cmd":"image.frameshm","args":{"handle":..,"w":..,"h":..}}
              └─> KittyImage (f=32, raw RGBA)
                    └─> D2D texture
```

This spans **two repositories**: agwinterm gains the command, winterm-browser produces the frames.
The existing file-based `image.frame` stays as the fallback and as the bring-up path.

## Working agreement

- **ralphex** is the implementer. Plans live in `docs/plans/`; execution is autonomous.
- **revmux** is the review harness, run natively on Windows. Every plan and every diff goes
  through it before it is accepted. `.revmux/` is committed, so the review standard is versioned
  with the code.
- Both `claude` and `codex` CLIs are present, so full-roster profiles (`comprehensive`,
  `grill-me`) are available rather than `claude-only`.

## Verified environment

Established by direct check on this machine, 2026-08-21:

| tool | state |
|---|---|
| Windows | 11 Home Single Language, 10.0.26200 |
| agwinterm | 0.17.2, `AGWINTERM_ENABLED=1` |
| Go | 1.26.1 windows/amd64 |
| Rust | cargo 1.96.0 |
| Node | v22.19.0 |
| Python | 3.13.7 |
| revmux | builds and runs natively on Windows (`lock_windows.go`, `procgroup_windows.go`); both `--task` and `/task:` flag styles accepted |
| ralphex | installed at `~/go/bin/ralphex.exe` |
| claude / codex | both on PATH |
| WSL | **not installed — and explicitly out of scope.** This is a Windows-native port. |
