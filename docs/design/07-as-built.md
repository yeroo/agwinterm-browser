# As built — transports, drops and ceilings

Task 15 of [the port plan](../plans/20260821-windows-port.md). The other design docs
say what was decided ([00](00-port-brief.md), [03](03-process-model.md),
[04](04-cell-metrics.md), [05](05-cli-and-endpoints.md)) and what was checked
([06](06-acceptance.md)). This one says what a person running the thing actually
meets: how a frame gets to the pane and how to force the other way, what upstream
offers that this tree does not, and the two places where the picture is worse than
upstream's on purpose.

Every absence below is a decision with a reason. That is the point of writing them
down: a missing feature with no record reads as an oversight, and the next person to
find one has to re-derive whether it was.

---

## 1. The two frame transports

The seam is `Surface.present({ bgra, width, height, damage })` — upstream's, unchanged.
Below it, on Windows, a transport carries the composited canvas to agwinterm. There are
two, and **only one of them exists today**.

| | file path | shared-memory path |
|---|---|---|
| verb | `image.frame` | `image.frameshm` |
| carries | a PNG on disk, named per frame | BGRA in a named file mapping |
| host requirement | none — shipped agwinterm (`ControlServer.cs:426`) | a verb agwinterm has not implemented |
| in this build | **yes**, `pixel-core/src/frame_file.rs` | **no** — see below |
| cost | 38 ms/frame at 131×37 cells, 26 fps ([02](02-frame-budget.md)) | projected under 10 ms, floor ~150 fps |

### What happens on the file path, per frame

1. `cell_span` decides how many cells the frame covers, clamped to the pane.
2. `encode_png` encodes the canvas.
3. The bytes go to a **fresh path** inside a private directory under `%TEMP%`
   (`terminal-browser-frames-<pid>-<n>`), and the file is closed.
4. `image.frame` goes out over the control pipe naming that path, at image id 1,
   placed at the pane's origin.
5. agwinterm reads the file, decodes it on its own thread, and swaps the placement.

**The fresh path per frame is load-bearing, not tidiness.** Rewriting one path races
the host's `File.ReadAllBytes`, whose failure is swallowed (`ControlServer.cs:458`)
and silently re-places the *stale* image; and agwinterm's staleness check is
`mtime ^ (length << 1) ^ hash(path)`, which never reads a byte, so two frames of equal
length written inside the filesystem's timestamp granularity collide at a fixed path
and the second is dropped. Both present as "the browser stopped updating", in no log.
The image *id* stays fixed for the opposite reason — it keeps the emulator's image
table at one entry rather than growing per frame. Files past the last three are reaped
as the next frame goes out, the directory is removed on drop, and a fresh publisher
sweeps directories older than an hour left by processes that died before they could.

### Why the fast path is not here

`image.frameshm`'s precondition is a published contract: `agwinterm/docs/specs/image-frameshm.md`
must exist and state the literal `Local\` mapping-name prefix and the producer slot-reuse
invariant. **It does not exist.** agwinterm has a plan for the verb whose spec task is
unchecked, and `ControlServer.cs:249` still dispatches `image.frame` and nothing else.

A producer written against that gap would be inventing a header layout and calling it a
contract, and the first real consumer would disagree in the shape of a torn or silently
rejected frame. So the producer is absent and its absence is recorded — in
[`02-frame-budget.md`](02-frame-budget.md), in this file, and in `frame_shm.rs`'s own
module docs. What *did* ship is the half that does not depend on the layout: the
transport selection below, and `is_unknown_command` — the literal refusal a host gives
for a verb it lacks, read the same way by every capability probe in the crate.

### How to force either

`TERMINAL_BROWSER_FRAME_TRANSPORT`, read through `SessionEnv` like every other
`TERMINAL_BROWSER_*` variable, so it answers for the pane that asked rather than for the
process that happened to start.

| value | aliases | what it does |
|---|---|---|
| unset / `auto` | `default` | the fast path where the host has it, the file path otherwise. Today: always the file path. |
| `file` | `png`, `image.frame` | the file path **even on a host that offers the fast one**. This is what makes the [02](02-frame-budget.md) baseline re-measurable after the fast path lands. |
| `shm` | `frameshm`, `image.frameshm` | ask for the fast path, and **say once** why it is not carrying the frame. Publishes over `image.frame` regardless — the picture is the same, the cost is the file path's. |

Matching is case- and whitespace-insensitive because a person types it into a shell. A
value that parses as nothing is a typo rather than a request: it warns, names the three
it accepts, and uses `auto`.

`shm` deliberately does not fail. A frame refused for a debug knob would be a worse
answer than a slower frame — but silence would be worse still, because a working browser
under `=shm` reads as "the fast path is on" and would make every number measured
afterwards wrong. So it explains itself once per run and names the missing spec.

### Taking the picture back

Not a third transport but part of the same contract: a frame is a **placement**,
which agwinterm holds until something replaces it. That is why switching sessions and
back costs no repaint — and why an exiting browser leaves a page painted over a shell
that is running underneath, readable by `session.text` and not by a person. Two paths
send `image.clear`, because neither covers the other:

- `Terminal::drop` → `FramePublisher::clear`, for an ordinary quit or an unwind. A
  publisher that never published sends nothing: that placement belongs to whoever drew it.
- `clearPaneFrame` (`cli/src/pane.ts`) after `openInForeground`'s wait, for the exits
  that run no destructor — `taskkill /F`, a crash, a kill from another pane. Best-effort,
  and it cannot change the exit code: every failure means the placement is gone anyway.

Both addressed by `HostTarget::from_env`'s rules, repeated deliberately, because the
engine places the frame and the CLI takes it back and a disagreement would not error —
it would clear someone else's pane.

---

## 2. What was dropped, and why

### Dropped in the engine

| | what it was | why it is not here |
|---|---|---|
| `ghostty.rs` | `SIGUSR2` signalling to a ghostty host | no Windows analogue for either half — no signals, no ghostty. `#[cfg(unix)]` in `lib.rs`; the **file is byte-identical** to upstream and still builds and tests on unix. |
| `herdr.rs` | an alternate graphics host reached over a unix socket | **permanently disabled, not pending.** It negotiates `pane.graphics.info` and refuses to speak unless the host answers `file_frame_transport: "direct-kitty"` (`herdr.rs:56`). Kitty escapes are exactly what ConPTY strips, so porting the socket would produce a client that connects and then cannot draw. The host does not run on Windows either. |
| the Swift native-scroll helper | a background macOS app reporting trackpad and pointer events the terminal cannot | dropped by a gate **upstream already had**: `build.rs` returns early unless `CARGO_CFG_TARGET_OS` is `macos`, and `native.rs:87` spawns nothing unless `NATIVE_SCROLL_HELPER` names a binary. `native-scroll-helper.swift` is vendored and byte-identical; it simply never compiles here. Its absence costs smooth/precise scrolling, and it is what makes `reports_pixel_mouse() == false` change nothing that runs (§3). |
| the patched-Electron fast paths | `useSharedTexture` (darwin), `useSharedMemory` (linux) | they need an Electron fork built from `zenbu-labs/electron-releases`, which the Constraints forbid. `presentPaint` falls through to `presentBitmap` (`browser/src/page/paint.ts:104`), but the controller only calls `presentPaint` when a texture or an shm frame is present (`controller.ts:175`), and on stock Electron here neither ever is. So every Windows frame goes to the throttled `BitmapPresenter` (`paint.ts:132`) instead, which coalesces a burst on `setImmediate`, unions the damage rects and calls `surface.present` itself; `presentBitmap` is the fallback behind it and is never invoked on this platform. |
| `CpuThrottle` | frame pacing | not dropped by this port — `supported()` is `cfg!(target_os = "macos")` upstream, so it is inert here and was inert before. Named so the 26 fps in [02](02-frame-budget.md) is not read as a throttled number. |

### Dropped or refused in the CLI

The rule is Task 13's: **do not leave a command that appears to work but does not.**
Each refusal names its own obstacle, because "not supported on Windows" is the part the
user already knows. `cli/src/unsupported.ts` owns the wording and imports nothing.

| | why | lifted by |
|---|---|---|
| `--ssh` | the tunnel is multiplexed over an ssh control socket (`ssh -S`, `ssh -O exit`) and reused by every later command. ControlMaster is a unix-socket feature Win32 OpenSSH does not implement, so the tunnel cannot be held open between invocations. The rest of `ssh.ts` would port. | OpenSSH-for-Windows implementing ControlMaster. Not this repo's to lift. |
| `upgrade` | runs the release channel's install URL through `bash -c 'curl … \| bash'`. No Windows release channel publishes one, and a default install has no bash. | a Windows release channel. Until then: pull the repo and rebuild. |
| `--split` | two things are missing. `pixel-terminals` has no agwinterm detector, so `detect()` returns null in a pane; and agwinterm's `session.split` takes an operation but **not a command** (`ControlServer.cs:134-135,163`), so even with a detector the new pane could not be told to run the browser. | an agwinterm host change, plus a detector. |
| `shutdown` | there is no daemon in the Windows shape ([03](03-process-model.md)). This mattered more than a message: `shutdownDaemon` falls back to `daemonPid()`, which returns *the first live instance pid* — in the foreground shape, a browser somebody is using — and would have killed it while reporting that it stopped a daemon. | nothing. There is nothing to shut down. |
| `setup`'s AppArmor step | **not unsupported — previously silent.** `apparmorSetup` returned 0 off Linux without a word, which reads as "a sandbox was configured". Chromium *is* sandboxed on Windows, by the OS, with nothing to install; the AppArmor profile is a Linux-only workaround for Ubuntu withholding unprivileged user namespaces. It now says so. | nothing. It is correct as it stands. |
| `probeGraphics` | writes an APC escape and waits for a reply. ConPTY strips APC, so on Windows it can only time out — and it asks about the wrong channel anyway, since frames never go through the terminal's own output. Replaced by `windowsHostRefusal`, which asks the question that actually decides it: is this an agwinterm pane. | nothing. |
| `--all` / "here" scoping | `--split` being unsupported makes the Windows shape one browser per pane, in the foreground, holding that pane's console for as long as it lives — so a CLI process running in that pane *at the same time* is impossible and `inCurrentTab` is false for every browser, always. Filtering on it would scope every command to nothing, so `scopeHere` returns the whole list and `--browser <key>` disambiguates. | `--split`, above. |

### Not copied from upstream at all

`scripts/` (`install.sh`, `fetch-electron.sh`, `apparmor.sh`, `bundle.sh` — POSIX shell,
and the second fetches the forbidden fork), `herdr-plugin/`, `release-worker/`, `skill/`,
build output, and upstream's own `README.md`/`AGENTS.md`/`CLAUDE.md`. The full list and
the reasons are in [`UPSTREAM.md`](UPSTREAM.md), which also records the six deliberate
edits to vendored files — each pinned by a test in `tools/vendor-check/`, so a re-vendor
that drops one fails loudly rather than at the milestone.

---

## 3. The accepted ceilings

Two, both named in the Overview before implementation started, both still true, and both
**host-side**: they are agwinterm changes, not winterm-browser ones. Neither is a bug and
neither is fatal, which is why the port shipped over them.

### Ceiling 1 — the pointer quantises to one character cell

**What it is.** Every click, hover, drag and scrollbar grab lands at the centre of a
character cell. There is no sub-cell position anywhere in the chain.

**Where it is lost.** At the encoder, before the port can see it: agwinterm computes
`col = (pxX - ox) / cw` and `row = (pxY - oy) / ch` as integers and emits
`\x1b[<btn;col+1;row+1M` (`Program.Input.cs:442-453`). The sub-cell offset is discarded
at the encode site and is unrecoverable downstream. `?1016` (SGR-Pixels) appears nowhere
in agwinterm's `src` or `native`; the mode handlers cover 1000/1002/1003/1006 only.

**What the port does with that.** `mouse_position_px` multiplies the cell back up to a
cell *centre* in the canvas's own coordinate space, using the same cell size the canvas
was sized with. Because both sides use one number, the click lands on what the user
pointed at — to within half a cell. The pointer is coarse; it is not *wrong*.

**One thing this is not.** `reports_pixel_mouse()` is `false` here, and the two gates it
feeds (`engine/pointer.rs:61`, `engine/scroll.rs:192`) are **unreachable on this
platform** — both sit behind `self.native`, the out-of-process scroll helper, which
nothing on Windows spawns (§2). So the false flag costs nothing that runs; the
quantisation is in the coordinates, not in the flag. Pinned by an added `#[test]` in
`engine/mod.rs` (divergence 6), which is what makes that a documented ceiling rather than
a bug — if upstream ever spawns a helper without `NATIVE_SCROLL_HELPER`, that test fails
and this paragraph stops being true.

**What would lift it.** agwinterm implementing `?1016`: the mode handler, the pixel
coordinates in the report, and a DECRQM answer for `\x1b[?1016$p` — `pixel-core` already
probes for all three (`terminal.rs:361`, `terminal.rs:945-948`). No change here beyond
letting the probe succeed.

### Ceiling 2 — the host publishes no cell pixel metrics

**What it is.** Without `TERMINAL_BROWSER_CELL_PX`, frames are rendered at 16×32 px per
cell and agwinterm resamples them into the pane. Text goes soft, and the CSS viewport is
the canvas size — so against a real ~9.6×19.9 px cell the page gets a viewport about 1.8×
larger than the pane and everything in it renders proportionally smaller once downscaled.

**Why.** `pixel-core` has two ways to learn a cell size and neither works here.
`CSI 16 t` (XTWINOPS) falls to `Unhandled` — agwinterm's `csi_dispatch` has no `t` arm at
all — so the query times out; and `tcgetwinsize`'s `ws_xpixel`/`ws_ypixel` has no Win32
equivalent, since `GetConsoleScreenBufferInfo` reports cells and nothing in pixels. No
control verb reports pane geometry and no `AGWINTERM_*` variable carries it. The metrics
*exist* host-side (`Program.cs:336`, pushed to the emulator as `CellPixelWidth`/
`CellPixelHeight`); they are simply not published.

**What the port does with that.** Three sources in order — `TERMINAL_BROWSER_CELL_PX`,
then the host verb, then `(16, 32)` with a warning that names the fix. The override is
first on purpose: it is the only source that exists today, and it is how a user corrects
a host that reports the wrong thing after a mixed-DPI move. Crucially `cell_size()`
**never answers `None`**: the canvas and the pointer are derived from the same number, and
what actually moves click targets is the two disagreeing, which is what a `None` arm on
one side and an `unwrap_or((16, 32))` on the other used to produce.

**What it costs to leave.** More than sharpness: the wrong cell size is **2.5× the frame**.
Same pane, same page, fallback vs `TERMINAL_BROWSER_CELL_PX=10x20` — 4.69 MB vs 1.83 MB of
PNG, 10.3 ms vs 3.7 ms to encode, 19.8 ms vs 11.8 ms of producer total. Roughly a whole
pipeline stage ([02](02-frame-budget.md)).

**What would lift it.** agwinterm's `session.metrics` verb, whose wire shape is specified
in [`04-cell-metrics.md`](04-cell-metrics.md) and whose client — `ControlClient::pane_metrics`
— **is already written and tested here**. A host that predates it answers
`unknown command 'session.metrics'`, which this client latches as a capability gap and does
not ask about again. ⚠️ Note the override can only ever be close: the host's cell size is a
float (`Program.cs:1127`) and `TERMINAL_BROWSER_CELL_PX` takes integers. The verb can be exact.

### The lesser ones, named so they are not surprises

- **No key releases.** Only the kitty keyboard protocol reports them, and agwinterm
  implements none, so `kitty_keyboard()` is false. Left alone this held Chromium with
  every key down — `keyUp` never reached the page and only a blur flushed it. `PageInput`
  now closes the press itself when the host reports no releases. Lifted by agwinterm
  implementing the kitty keyboard protocol.
- **The clipboard is the OS clipboard, not the terminal's.** Upstream writes `OSC 52`
  and lets the terminal decide; agwinterm implements none, and ConPTY would strip the
  reply exactly as it strips Kitty graphics, so that route is closed here for the same
  reason the frame route was. `set_clipboard` and `request_clipboard` go through
  `arboard` instead — already a `pixel-core` dependency and already used on this
  platform by `clipboard_image.rs`. A read answers immediately rather than arriving as
  a reply, so it is parked and handed back by `poll_event` as the same `Event::Paste`
  the `OSC 52` decode would have produced; nothing above the backend can tell.
  **Typed** clipboard data (`OSC 5522`) is still unimplemented, and unreachable:
  `clipboard_data_supported()` is false, which is the gate `engine/clipboard.rs` checks
  before asking. This was not optional — while `set_clipboard` answered `Unsupported`,
  the error propagated through `?` from `engine/doc.rs` and `engine/clipboard.rs` out of
  `Engine::pump`, which `pixel-node` treats as a fatal engine exit: **Ctrl+C in the
  address bar closed the browser**. Nothing on that path inspects the error *kind*, so
  answering a different kind would have changed the message and not the outcome: the
  Windows `set_clipboard` returns no error at all and logs instead. A clipboard another
  process is holding — `arboard` gives up on `OpenClipboard` after five tries at 5 ms,
  which a clipboard manager or RDP redirection outlasts easily — is a lost copy, not a
  lost browser.
- **No Super modifier**, for the same reason, so `cmdModifier` is `ctrl` on Windows:
  new tab, address bar, reload, copy and quit are Ctrl chords. Not a degradation — it is
  the Windows convention — but it is why a `cmd+p` chord written for a Mac is mapped
  rather than dropped. **Two of the accelerators are not letters, and Ctrl cannot carry
  them.** `ENABLE_VIRTUAL_TERMINAL_INPUT` encodes Ctrl+a..z as the C0 bytes `0x01..=0x1a`
  and has no encoding for the rest: Ctrl+`=` arrives as a plain `=` with no modifier on
  it, and Ctrl+`[` arrives as `0x1b`, which is Escape. So zoom is **Alt+`=`/`-`/`0`** and
  back/forward are **Alt+Left/Alt+Right** — the spellings an Esc prefix and `CSI 1;3D`
  deliver intact, and the ones a Windows browser binds anyway. Alt is accepted for those
  two and nowhere else, so it stays a page modifier: alt+t is still not "new tab".
- **The console's input code page is switched to UTF-8 and put back.**
  `ReadFile` on `CONIN$` is `ReadConsoleA`, so conhost encodes every character that is
  not part of a VT sequence with the console's *input* code page — OEM 437, 850, 932 on
  a default install — while the decoder those bytes are handed to (`terminal.rs`'s
  `parse_plain_bytes`) reads UTF-8 and nothing else. Without the switch, `é` arrives as
  a lone `0xE9` under CP1252: a two-byte lead with no continuation, which the decoder
  cannot finish and which then sits at the head of `pending` and glues itself to the
  next keystroke. Characters the code page cannot represent at all never reach the
  backend — conhost substitutes `?`. `SetConsoleCP` is process-wide, so the previous
  value is recorded once and restored by `ModeGuard::drop` and by the panic hook, the
  same two paths that restore the console modes. The *output* code page is left alone:
  everything this backend writes to `CONOUT$` is ASCII escape bytes.
- **Ctrl+Shift is not a chord this host has**, which is the same encoding fact one step
  further on: the C0 bytes carry ctrl and nothing else, so `ctrl+shift+f` and `ctrl+f`
  arrive identically and a `ctrl+shift+*` binding can never match. Upstream's non-darwin
  defaults are all Ctrl+Shift, so find, devtools and record were unpressable — and
  Ctrl+Shift+R, arriving as a plain Ctrl+R, was taken by Reload instead. Windows gets its
  own defaults: **find is Ctrl+F**, **devtools is F12**, **record is Alt+R** and
  **Alt+Enter** finishes a recording. Record is Alt rather than a bare Ctrl+R because the
  record key is tested before the accelerators, so binding it to Ctrl+R would have taken
  Reload; Alt+Enter because conhost sends Ctrl+Enter as `0x0a`, which is Ctrl+J, so
  `complete()` was unreachable and Enter took one more snapshot instead. macOS and Linux
  keep every binding they had.
