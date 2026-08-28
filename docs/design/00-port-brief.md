# winterm-browser — port brief

A Windows-native port of [zenbu-labs/terminal-browser](https://github.com/zenbu-labs/terminal-browser):
a real Chromium browser rendered inside a terminal pane. The host terminal is
[agwinterm](file:///C:/Users/boris/source/agwinterm) (`TERM_PROGRAM=agwinterm`).

Upstream sources are kept for reference (never committed) at `.reference/terminal-browser/`.
The agwinterm source tree lives at `C:\Users\boris\source\agwinterm`.

> ### This brief was written before the port and has been corrected three times
>
> Twice during design, by measurement; a third time now, by the implementation. **It is kept
> as the argument, not as the record.** Where a claim below did not survive contact with
> the code, an `⚠️ As built` note says so on the spot rather than in an errata section, and
> [`07-as-built.md`](07-as-built.md) is the shipped description. Nothing has been quietly
> rewritten to look prescient: a brief that gets edited into being right is not evidence
> about anything.
>
> The four that matter, in one place:
>
> | this brief said | what shipped |
> |---|---|
> | frames travel over a shared-memory ring (`image.frameshm`) | **PNG over `image.frame`.** The fast path's contract was never published, so it was not built. [§ Chosen transport](#chosen-transport) |
> | where the engine process lives is unresolved | **resolved:** the foreground process, one browser per pane. [`03-process-model.md`](03-process-model.md) |
> | 43 files kept unchanged | **40 byte-identical, 3 with a written reason.** "No unix API" turned out not to mean "portable". [`06-acceptance.md` §5](06-acceptance.md#5-the-keep-unchanged-files) tabulates all three; [`UPSTREAM.md`](UPSTREAM.md) numbers two of them. |
> | `herdr.rs`: port to named pipes, or gate off for v1 | **gated off permanently**, and the reason is not effort. [§ the unix dependency](#the-unix-dependency-is-concentrated-not-pervasive) |
>
> Everything the brief got right is left standing without comment, including the load-bearing
> bet — keeping `pixel-core` really was cheaper than dropping it, and the browser chrome really
> did port for free.

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

> ⚠️ **As built.** The helper half is right — it is dropped by a gate upstream already had, and
> the sequences all survive ConPTY verbatim, CSI-u included. The kitty-keyboard half is not:
> agwinterm parses those escapes but does not *speak* the protocol, so `kitty_keyboard()` is false
> here, and two things follow that "solved" does not suggest. **No key releases are reported** —
> which held Chromium down with every key until `PageInput` was taught to close the press itself —
> and **there is no Super modifier to bind**, so `cmdModifier` is `ctrl` on Windows. Upstream's
> substitute for a host with no Super is *Alt*, which would have put new tab, address bar, reload,
> back, forward and zoom on alt-chords, on the one platform where every one of them is Ctrl by
> convention and Alt is a modifier pages use in their own right.

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

> ⚠️ **As built.** Neither landed, and both are now accepted ceilings rather than open questions —
> written up with what would lift them in [`07-as-built.md § 3`](07-as-built.md#3-the-accepted-ceilings).
> The port shipped over both, which this section did not expect it could: the cell-metrics half
> was reclassified from *blocking* to *degrades* once [`04-cell-metrics.md`](04-cell-metrics.md)
> found that the cost of a wrong-but-consistent cell size is sharpness rather than click accuracy,
> and `TERMINAL_BROWSER_CELL_PX` is the override that makes it a user's choice. The `?1016` half is
> exactly as bad as described. One correction to the paragraph above it: `reports_pixel_mouse()` is
> indeed `false`, but **both gates it feeds are unreachable here** — they sit behind the native
> scroll helper, which nothing on Windows spawns — so the quantisation is entirely in the
> coordinates, and the flag costs nothing that runs.

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

> ⚠️ **As built**, two rows of that table came out differently.
>
> **`herdr.rs` is gated off permanently, and porting the socket would have been wasted work.**
> It is not a transport — it is a *different host*, found through `HERDR_SOCKET_PATH` and
> negotiated with `pane.graphics.info`, which must answer `file_frame_transport: "direct-kitty"`
> before the module will speak to it (`herdr.rs:56`). Kitty escapes are what ConPTY strips, so a
> ported client would connect and then be unable to draw. The host does not run on Windows either.
> Both it and `ghostty.rs` are byte-identical to upstream: "drop one" is a `#[cfg(unix)]` in
> `lib.rs`, not an edit, so both still build and still run their tests on unix.
>
> **Of the 43, 40 are byte-identical and three have a written reason** — the Task 3 re-export
> shim in `lib.rs`, plus `clipboard_image.rs` and one added `#[test]` in `engine/mod.rs`. The
> lesson is in the first of those and it generalises: this count screens for unix **APIs**, and
> `clipboard_image.rs` used none while assuming unix **paths** in three places, so three of its
> five tests failed on Windows. *"No unix API" is not "portable."* The measurement above is still
> right about what it measured; it was read as answering a slightly larger question than it did.
> Each divergence is recorded in [`UPSTREAM.md`](UPSTREAM.md) and pinned by
> `tools/vendor-check/unchanged.test.mjs`, which fails if the set moves in either direction.

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

> ⚠️ **As built.** `presentBitmap` itself is never reached on Windows. The controller calls
> `presentPaint` only when `event.texture || shmFrame` (`browser/src/page/controller.ts:175`), and
> on stock Electron neither is ever set, so every frame takes the `BitmapPresenter` branch and that
> class calls `surface.present` directly. The coalescing described above is real; the function name
> is not the one on the path.

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

⚠️ **As built**, three rows of that column read differently:

| row | what shipped |
|---|---|
| Frame pixels → terminal | **PNG to a fresh path under `%TEMP%`, named to the host over `image.frame`.** The BGRA ring is deferred, not chosen against — [§ Chosen transport](#chosen-transport). |
| `herdr.rs` IPC | **not ported** — permanently `#[cfg(unix)]`, for a reason that is not effort (above). |
| CLI / terminals / store | ported, and the two named files ended as **refusals rather than Windows work**: ControlMaster is a unix-socket feature Win32 OpenSSH does not implement, and there is no AppArmor profile to install where Chromium is sandboxed by the OS. Both say so out loud ([`05`](05-cli-and-endpoints.md), [`07`](07-as-built.md#dropped-or-refused-in-the-cli)). |

Everything else in the table held, including the two rows the whole bet rested on: the browser
chrome and the compositor are unchanged, and the stock-Electron bitmap path needed no patch.

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

> ⚠️ **As built: resolved, and the reasoning above survived being tested.** The engine runs in the
> foreground process — one browser per pane, holding that pane's console — and the daemon is kept
> in the tree, still entered by `--daemon`, and is not what the Windows CLI launches.
> [`03-process-model.md`](03-process-model.md) has the measurements, made with real
> pseudoconsoles rather than reasoned about, and they add one finding this section did not have:
> a GUI-subsystem child (which `electron.exe` is) gets **no** console even on an ordinary
> non-detached spawn, and has to take one with `AttachConsole`. So `detached: true` was never the
> obstacle, and anyone who "fixed" the daemon by removing it would have fixed the wrong thing.
> What rules the daemon out is that no process can hold two consoles at once.

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
[agwinterm's versioned `image.frameshm` contract](https://github.com/yeroo/agwinterm/blob/main/docs/specs/image-frameshm.md);
do not invent one.**

This spans **two repositories**: agwinterm gains the command, winterm-browser produces the frames.
The existing file-based `image.frame` stays as the fallback and as the bring-up path.

> ⚠️ **As built: this did not ship, and the bring-up path is the only path.** agwinterm never
> gained the command. Its spec — the one this section ends by insisting on — does not exist:
> `agwinterm/docs/specs/image-frameshm.md` was never written, agwinterm's own plan leaves the
> header-layout task unchecked, and `ControlServer.cs:249` still dispatches `image.frame` and
> nothing else. So there is no mapping layout to write BGRA into, and a producer built anyway
> would have been inventing a wire format and calling it a contract.
>
> The gate was honoured rather than worked around, which is the whole value of having written
> "do not invent one" here. What shipped instead is the half that survives the blocker:
> `TERMINAL_BROWSER_FRAME_TRANSPORT`, so the file path stays *explicitly* selectable and this
> baseline stays re-measurable; and `is_unknown_command`, the one reading of a host's refusal that
> every capability probe in the crate now shares. The cost of the gap is measured, not guessed —
> **38 ms per frame at a 131×37 pane, 26 fps**, of which the fast path would delete about 27.6 ms
> outright ([`02-frame-budget.md`](02-frame-budget.md)). The diagram above is still the design;
> it is now a design with a baseline to beat.

> ⚠️ **Host update, 2026-08-28.** agwinterm now implements `image.frameshm`, including the
> versioned contract linked above, the ctl surface, malformed-producer validation and the BGRA
> renderer path. This does not rewrite what winterm-browser shipped: its current transport remains
> the PNG fallback until a separate consumer change adopts the fast path.

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
