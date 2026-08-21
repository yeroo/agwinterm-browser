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
- **Keyboard input is solved** — SGR mouse (`?1000/?1002/?1003/?1006`,
  `Agwinterm.Core/TerminalEmulator.cs:403-405`) and the kitty keyboard protocol
  (`emulator.rs:809 kitty_keyboard`). No macOS-style background helper app is needed;
  upstream's Swift input helper has no analogue here and is simply dropped.

### Two host gaps that are not solved, and are the port's real ceiling

An earlier draft of this section claimed "input is solved" outright. It is not, in two specific ways,
and both are agwinterm-side rather than fixable from this repo.

**Mouse position is quantised to one character cell.** agwinterm's encoder
(`src/Agwinterm.Win32/Program.Input.cs:442-453`) computes `col = (pxX - ox) / cw` and
`row = (pxY - oy) / ch` as integers before emitting `\x1b[<btn;col+1;row+1M` — the sub-cell offset is
discarded at the encode site and is unrecoverable downstream. `?1016` (SGR-Pixels) appears nowhere in
`src` or `native`; the mode handlers cover 1000/1002/1003/1006 only, in both the C# and Rust cores.

This is load-bearing, not cosmetic. `pixel-core` probes for it — `terminal.rs:361` requests
`\x1b[?1016h`, `terminal.rs:945-948` sends the DECRQM `\x1b[?1016$p` — and agwinterm's DECRQM handler
answers only for mode 2026, so the probe times out and `mouse_pixels = false`. That flag gates
`engine/pointer.rs:61` (`let located = self.pixel_mouse.then_some(point)`, so hover and pairing get
no position at all) and `engine/scroll.rs:192`. For a real browser it means every click, hover, drag
and scrollbar grab snaps to a cell lattice.

**Cell pixel metrics are not published anywhere.** `pixel-core` has two ways to learn them and
neither works here: `terminal.rs:880` writes `\x1b[16t` (XTWINOPS), and agwinterm's `csi_dispatch`
(`emulator.rs:964-1045`) has no `t` arm at all — it falls to `Unhandled`; and `size()` reads
`ws_xpixel`/`ws_ypixel` via `tcgetwinsize`, which has no `GetConsoleScreenBufferInfo` equivalent.
The shipping app *computes* real metrics (`Agwinterm.Win32/Program.cs:336`, pushed to the emulator as
`CellPixelWidth`/`CellPixelHeight`) and keeps them host-side for sixel cell-span. No control verb and
no `AGWINTERM_*` environment variable carries them. `terminal.rs:840-843` falls back to a hardcoded
`(16, 32)` — a silent wrong guess, which is precisely the failure mode this project's conventions
exist to prevent.

Both are small, well-localised host-side changes, and both are **additional cross-repo dependencies**
that must be decided before the plan reaches them. They are tracked in the agwinterm plan.

## Architecture

An earlier draft of this brief proposed dropping `pixel-core` wholesale and letting agwinterm
composite. Measurement says otherwise, and the cheaper design won.

### The unix dependency is concentrated, not pervasive

Counting `rustix::` / `std::os::unix` / `termios` / `libc::` / `/dev/tty` references per module
across `pixel-core`'s **46** source files — 22 at the top level of `src/` plus 24 more across five
subdirectories (`engine/` 12, `scroll/` 5, `selection/` 2, `surfaces/` 2, `tree/` 3):

| module | hits | disposition |
|---|---|---|
| `terminal.rs` | **64** | **split** — see below; it is not wholly unix |
| `herdr.rs` | 2 | port — `UnixStream`/`UnixListener` → Windows named pipes (or gate off for v1) |
| `ghostty.rs` | 2 | drop — ghostty-specific `SIGUSR2` signalling, no Windows analogue |
| **all 43 others** | **0** | **keep unchanged** |

All 24 subdirectory files score zero on the same pattern. `canvas.rs`, `paint.rs`, `text_input.rs`,
`image_cache.rs`, `menu.rs`, `kitty.rs`, `shape.rs`, `wrap.rs`, `style.rs`, `scrollbar.rs` and the
rest are already portable Rust — taffy, tiny-skia and fontdue are all cross-platform. **The
compositor and UI toolkit port for free.** This matters because the browser chrome (tab strip, URL
bar, menus, modals — `browser/src/ui/*.tsx`) renders through `pixel-react` into `pixel-core`.
Dropping `pixel-core` would have meant rewriting the entire browser chrome; keeping it means the
chrome is untouched.

Both dependencies worth suspecting resolve clean: `fontdue` loads fonts via `include_bytes!`
(`paint.rs:775`, `menu.rs:356`), not from a system font path, and `arboard` has one guarded call
site (`clipboard_image.rs:56`, `.ok()?`) and already resolves to `clipboard-win` on this platform in
`engine/Cargo.lock`. `rustix` itself builds on Windows — `pipe`/`shm`/`termios` are
`#[cfg(not(windows))]` behind an explicitly supported target — so `cfg`-gating the source is
sufficient for the crate.

### `terminal.rs` is not one thing — and gating it wholesale would strand the decoder

The 64 unix references sit at line 4 and in lines 193–1250. **Lines 1251–1909 are 659 lines of
production code with zero unix references** — 25% of the file — and they are the VT input decoder:
`parse_event_kitty` (1337), `parse_plain_bytes` (1383), `byte_key_event` (1430), `parse_csi` (1452),
`parse_kitty_key` (1630), `parse_sgr_mouse` (1771), `parse_kitty_keyboard` (1811), `parse_osc_color`
(1860). Every one takes `&[u8]`; none takes an fd or a `Termios`. Its `mod tests` (1911) is gated on
`#[cfg(test)]` only, and 27 of its 29 tests are byte-sequence parser tests — including the
split-across-two-reads case.

That decoder is exactly what the Windows backend needs. A naive `#[cfg(unix)]` over the whole module
would carry it and its tests out of reach on Windows, and the port would reimplement what it already
owns. **The gate covers the tty and frame-transport code only.**

The module also holds the crate's type vocabulary — `Event`, `KeyEvent`, `KeyKind`, `Mods`, `Key`,
`Mouse`, `MouseKind`, `MouseButton`, `TerminalColors`, `ColorSlot`, `WindowSize`, `Terminal`,
`Waker`, `SessionEnv` — imported by **11 keep-unchanged modules**, and `lib.rs` re-exports
`pub use terminal::SessionEnv;` at crate root. A module-level gate breaks the crate root too. The
types come out into their own module with a re-export shim before anything is gated.

And the seam is wider than "five platform operations": `impl Terminal` has **24 public methods**,
including five clipboard calls (`request_clipboard`, `set_clipboard`, `clipboard_data_supported`,
`request_clipboard_types`, `request_clipboard_data`) that `engine/clipboard.rs` takes `&mut Terminal`
to reach. All are OSC-52-shaped and return `io::Result`, so they are trait-able — but they must be
on the trait.

So the port is: **split one module, port one, drop one, keep forty-three.**

### What this measurement did not cover

It counted Rust identifiers inside one crate. Every blocker found since sits **outside** that
region: the daemon's tty-by-path architecture (`cli/`, `browser/` TypeScript), the `/bin/sh` launcher
(`cli/src/main.ts:109`), the `bash` postinstall (`browser/package.json:7`), a napi build script that
hardcodes `.dylib`/`.so`, two Unix-domain-socket protocols in `store/` and `browser/`, and a missing
cell-metrics capability that is a *host* gap rather than a guest one.

The architectural bet survives — keeping `pixel-core` really is cheaper than dropping it — but the
evidence for it was calibrated on the layer that turned out to be least risky. The same disposition
pass is owed to `browser/`, `cli/`, `store/`, `terminals/` and the JS build scripts, and the port
plan's Task 1 now runs it.

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

### The unresolved question: where the engine process lives

Upstream is a **daemon/client split, and the daemon reaches the user's terminal by opening a path.**
`cli/src/main.ts:119` `ownTtyPath()` shells out to the unix `tty` command and keeps the result only
if it `startsWith("/dev/")`; `main.ts:301-303` refuses to run without it; the path crosses a unix
socket to the daemon, which rejects any open without a `tty` (`browser/src/daemon.ts:96-106`) and
passes it to `createSession`; it reaches `createRoot({ tty })` (`session/session.tsx:315-316`) and
finally `File::options().read(true).write(true).open(tty_path)` (`terminal.rs:348-349`). The daemon
is spawned `{ detached: true, stdio: "ignore" }` (`main.ts:155`) — it has no console by construction.

**On Windows there is no path that names another process's ConPTY.** `CONIN$`/`CONOUT$` resolve to
the *calling* process's console, and a detached process has none. `AttachConsole(pid)` is the only
cross-process mechanism, is one-console-per-process, and attaches to a console the caller does not
own.

Output is accidentally immune — frames leave out-of-band through the control pipe addressed by
`AGWINTERM_SESSION_ID`, so they never need the tty. **Input has no such escape.** Either the engine
moves into the foreground process, or the client forwards stdin over IPC. Note that
`createRoot({tty: null})` is a supported shape (`pixel-react/src/index.ts:262-264` falls back to a
stdio bridge), but `browser/src/main.tsx:55` calls `runDaemon(cdpPort)` unconditionally without even
inspecting the `--daemon` argument — so there is no foreground mode to switch to, and choosing one is
a restructure of the browser process's top level, not a configuration flag.

This is decided in the port plan's Task 2, before any console work is specified.

### Chosen transport

Extend agwinterm with a shared-memory frame command so Electron's paint buffer reaches the
renderer with **no PNG encode, no disk round-trip and no base64**:

```
Electron paint(BGRA)
  └─> CreateFileMapping, NAMED: Local\winterm-browser-<pid>-<id>
        └─> pipe: {"cmd":"image.frameshm","args":{"images":[
                    {"id":N,"name":"Local\\...","slot":N,"seq":N,
                     "width":N,"height":N,"stride":N,"format":N,
                     "row":N,"col":N,"cols":N,"rows":N}]}}
              └─> MemoryMappedFile.OpenExisting(name) -> KittyImage (BGRA)
                    └─> D2D texture
```

**The mapping is addressed by name, not by handle.** An earlier draft of this diagram showed
`{"handle":..,"w":..,"h":..}`. That is wrong and would not have worked: a Win32 `HANDLE` is
process-local, and its numeric value means nothing in the consumer without a `DuplicateHandle` into
the consumer's process, which needs the consumer's PID and rights over it. A `Local\` name needs
neither. The args also mirror `image.frame`'s `images[]` array rather than being flat, so the two
verbs read as siblings. **The exact name prefix is pinned in
`agwinterm/docs/specs/image-frameshm.md`; do not invent one.**

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
