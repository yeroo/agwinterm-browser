# As built — transports, drops and ceilings

Task 15 of [the port plan](../plans/20260821-windows-port.md). The other design docs
say what was decided ([00](00-port-brief.md), [03](03-process-model.md),
[04](04-cell-metrics.md), [05](05-cli-and-endpoints.md)) and what was checked
([06](06-acceptance.md)). This one says what a person running the thing actually
meets: how a frame gets to the pane and how to force the other way, what upstream
offers that this tree does not, the two places where the picture is worse than
upstream's on purpose, and — §4 — the three things added after the port shipped,
including the review that should have caught them and did not run.

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

**A reply is not a placement.** agwinterm can answer `ok:true` with `frame:0/0` — it skips
an image whose file it cannot open *before* it counts it, so a redirected `TEMP`, a pane
hosted by another user and an antivirus quarantine all present this way, as success on
every frame with the pane left blank. That is treated exactly as a refusal is: the file is
deleted as litter rather than kept as history, the directory is not marked, and nothing
enters `written`, so the publisher's `Drop` sends no `image.clear` at a picture it never
put there.

**The fresh path per frame is load-bearing, not tidiness.** Rewriting one path races
the host's `File.ReadAllBytes`, whose failure is swallowed (`ControlServer.cs:458`)
and silently re-places the *stale* image; and agwinterm's staleness check is
`mtime ^ (length << 1) ^ hash(path)`, which never reads a byte, so two frames of equal
length written inside the filesystem's timestamp granularity collide at a fixed path
and the second is dropped. Both present as "the browser stopped updating", in no log.
The image *id* stays fixed for the opposite reason — it keeps the emulator's image
table at one entry rather than growing per frame. Files past the last three are reaped
as the next frame goes out, the directory is removed on drop, and a fresh publisher
sweeps directories older than an hour left by processes that died before they could — a
week, once the directory names a pane (`MARKED_STALE_AFTER`), for the reason *Taking the
picture back* gives. The `pane` marker (see there) is written beside the first frame the
host *does* place, is exempt from that reaping, and is rewritten if something removes the
directory out from under a live publisher.

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
that is running underneath, readable by `session.text` and not by a person. **Three**
paths send `image.clear`, because no one of them covers the others:

- `Terminal::drop` → `FramePublisher::clear`, for an ordinary quit or an unwind. A
  publisher that never published sends nothing: that placement belongs to whoever drew it.
- `clearOwnedPaneFrame` (`cli/src/pane.ts`) after `openInForeground`'s wait, for the exits
  that run no destructor — `taskkill /F`, a crash, a kill from another pane. Best-effort,
  and it cannot change the exit code: every failure means the placement is gone anyway.
- the **`pane-clear`** verb, for the exit that runs *neither*. Killing the CLI kills the
  browser with it on Windows — a child spawned without `detached` sits in a job object
  that terminates with its parent, which is exactly how `openInForeground` spawns — so
  the pane's foreground job is gone and there is nobody left in the chain to clear
  anything. It is the only one of the three a person invokes, it needs no browser running
  and no instance registered, and it puts the **console** back as well as the frame.

The console is the half that is easy to forget. A dead browser also leaves the alternate
screen buffer on, the cursor hidden and mouse reporting live, so the shell comes back
cursorless, echoless, and typing `\x1b[<…M` at the prompt on every pointer move.
`restorePaneConsole` undoes that by **two** mechanisms rather than one — the escape
sequences, written to stdout when stdout is the pane, and the console *input modes*,
which only `SetConsoleMode` restores — because a recovery that sent only the escapes
would hand back a shell that still does not echo.

The second mechanism is not the obvious one, and the obvious one does not work.
`process.stdin.setRawMode(false)` reaches no syscall at all: `uv_tty_set_mode` returns
early when the requested mode equals the one it recorded, and a `uv_tty_t` is born
NORMAL, so a CLI that never turned raw mode *on* — this one never does; the engine did
it, in another process — asks for NORMAL, matches, and nothing happens. Forcing the
transition is worse: `setRawMode(true)` is also where libuv saves the mode it *found*,
and `uv_tty_reset_mode` puts that broken mode back when Node tears down stdio. Both
measured on Windows 11 — a console left at `1008` is still `1008` afterwards, either way.
So the restore has to outlive this process, which means it has to happen in another one:
`cookConsoleModes` spawns `%SystemRoot%\System32\cmd.exe /c exit` with `stdio: "inherit"`,
and `cmd` cooking the console it inherits takes `1008` to `999`. That is a Windows
built-in doing what shells do, not a trick.

The two halves are reported separately because they fail apart, and the modes half has
three ways to fail: a redirected stdin, which is not the console the child would have to
inherit (so it is gated on `isTTY` rather than attempted blind); a platform with no
`SetConsoleMode`; and a child that would not run or would not exit cleanly. All three
are one report — the user needs to know echo was left as the browser set it and where to
run this next, not which of the three it was.

The escapes half has the mirror of the first of those, and it is the reason it is gated
the same way. The engine does not write `ENABLE_REPORTING` to *its* stdout: it opens
`CONOUT$` by name, for the reason `terminal_windows.rs` gives in its header, so
`terminal-browser open <url> > log.txt` still puts the pane on the alternate screen while
the undo goes into `log.txt`. Node cannot follow it to the device — `fs.openSync` resolves
every path before `CreateFileW` sees it, so `"CONOUT$"` creates a file of that name in
the working directory and `"\\.\CONOUT$"` picks up a trailing separator the call rejects
(measured on Node 22 / Windows 11) — so the write stays on stdout, which is the right
device on every run that is not redirected, and `escapes` is set from the stream being a
console rather than from the write returning. A redirected run therefore says the escapes
did not land and names the redirect to drop, rather than claiming a repair that went into
a file. It runs before anything is printed, too:
`DISABLE_REPORTING` ends with `?1049l`, so a report written first would land on the
alternate screen and be thrown away with it, which is the one arrangement in which the
verb genuinely looks like it did nothing.

All three ask the same question first: **is this placement ours?** `FramePublisher::clear`
answers it from its own state — it never published, so there is nothing of its to take
back. The CLI's two answer it from disk, and from **two** pieces of evidence rather than
one: the directory name, `terminal-browser-frames-<pid>-<n>`, and a file called `pane`
written inside it beside the first frame the host actually places, holding the pipe name
and the session id that frame was addressed to.

Neither question is "the newest frame directory on this machine". The exit path knows the
pid it spawned and asks the exact question — but a pid names a *live* process and nothing
more, `frame_file.rs` burns a counter precisely because Windows recycles them, and
`sweep_stale` leaves a wreck standing for an hour, so a marker naming a **different** pane
disqualifies the directory even there. A wreck that *names* a pane is held for a week
instead (`MARKED_STALE_AFTER`): the marker is the whole of `pane-clear`'s evidence and the
verb has no override for its absence, so an hour would let any browser launched in any
other pane sweep away the only route back to this one — and the run this verb was written
for came back to its pane roughly eighteen hours later. `pane-clear` runs after everything is dead and has
no pid at all, and the marker is the whole of its answer: without it, two panes wrecked at
once would mean the verb repairing one of them on the other's evidence and then deleting
it. A directory with frames and no marker is read as nobody's rather than as ours — an
engine predating the file stays recoverable by the process that spawned it, and by nothing
else.

The evidence goes with the placement it authorised. A clear the host **confirms** retires
every directory the run would have accepted, not only the one it reported: a pane holds one
placement, so an older wreck's picture was replaced long before this run started, and an
older marker left standing would read as fresh ownership to the next run. A clear the host
**refused** leaves everything where it is — the pane is still painted, and the directory is
what a later run needs in order to try again. A directory that will not delete has its
marker removed on its own, which downgrades it to an unattributed wreck rather than leaving
a live claim behind.

Where the three differ is what they do with a *no*: the exit path stays quiet, and
`pane-clear` **says so** and leaves the picture alone. That is the one place where "report
that something happened" and "do not take down what is not yours" pull against each other,
and ownership wins.

All three are addressed by `HostTarget::from_env`'s rules, repeated deliberately, because
the engine places the frame and the CLI takes it back and a disagreement would not error —
it would clear someone else's pane. On the dev-build path they now share a guard as well:
`TERMINAL_BROWSER_ALLOW_PIPE` (§4).

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
| the pane's own agwinterm instance | two checks, both the engine's, applied before anything is spawned. `AGWINTERM_PIPE` must be a pipe name (`valid_pipe_name`'s `[A-Za-z0-9._-]`), because `\\.\` is a normalised device path and `..\` walks out of the pipe namespace into the filesystem; and under `TERMINAL_BROWSER_ALLOW_PIPE` it must be an instance the list names. Refused at launch rather than at the first frame, because a browser the CLI started and the engine then refused every frame from is a browser that starts and shows nothing. | unset `TERMINAL_BROWSER_ALLOW_PIPE`, add the pipe to it, or set it to `*`. The pipe-name half is not lifted — it is the guard against the device path. |
| `--all` / "here" scoping | `--split` being unsupported makes the Windows shape one browser per pane, in the foreground, holding that pane's console for as long as it lives — so a CLI process running in that pane *at the same time* is impossible and `inCurrentTab` is false for every browser, always. Filtering on it would scope every command to nothing, so `scopeHere` returns the whole list and `--browser <key>` disambiguates. | `--split`, above. |

### Not copied from upstream at all

`scripts/` (`install.sh`, `fetch-electron.sh`, `apparmor.sh`, `bundle.sh` — POSIX shell,
and the second fetches the forbidden fork), `herdr-plugin/`, `release-worker/`, `skill/`,
build output, and upstream's own `README.md`/`AGENTS.md`/`CLAUDE.md`. The full list and
the reasons are in [`UPSTREAM.md`](UPSTREAM.md), which also numbers the twelve deliberate
edits to vendored files that are not the port's own subject matter. Since **2026-08-26**
each is checked — by a diff against `45b5e43` for the nine the port applied, by content
for the three the vendoring commit applied and so cannot show a diff — so a re-vendor
that drops one fails by name. That sentence used to say "six" and used to claim each was
pinned by a test; it was true of two of the six. See
[the guard that covered one tree of three](#the-guard-that-covered-one-tree-of-three).

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

---

## 4. Added after the port shipped

Three things below were not in the port. They are here rather than in the corrections
plan because this file is what a person running the thing meets, and all three change
what they meet. The plan is
[`20260822-post-port-corrections.md`](../plans/20260822-post-port-corrections.md).

### `TERMINAL_BROWSER_ALLOW_PIPE` — a dev build refuses an instance it was not named at

A pane's `AGWINTERM_PIPE` names whichever agwinterm that pane belongs to, and with the
variable unset it is `agwinterm` — the machine's real terminal. So a browser launched
from an ordinary shell during development publishes into *that*, and a frame is a
placement: a force-kill leaves the page painted over a working shell with mouse
reporting still on. That is not hypothetical. It is how a pane of the production
instance was found wrecked eighteen hours after the port run ended
([`06-acceptance.md`](06-acceptance.md), preamble).

The guard is **opt-in**, because on Windows the shipped product *is* a checkout —
`pnpm -r build` runs `cargo build -p pixel-node` with no `--release` — so a guard that
refused an unlisted instance by default would refuse every ordinary run. Set it, and the
browser addresses only the instances it names (comma- or semicolon-separated, or `*`),
and says the variable's name when it refuses.

A name is matched **case-insensitively**, because that is how the object manager
resolves a pipe name: `Agwinterm-Dev` and `agwinterm-dev` are one instance, and a guard
that told them apart would refuse the very instance the developer listed. `*` is
matched before the fold, being a literal rather than a name.

The fold is **ASCII-only** in all three readers — Rust's `eq_ignore_ascii_case`, and an
`asciiLower` in the two TypeScript copies rather than `String.toLowerCase`. The pipe
itself is ASCII by `valid_pipe_name`, so the choice only shows on the other operand: an
entry is whatever the variable held, and `AGWINTERM-KIOSK` with its first `K` written as
U+212A KELVIN SIGN is one a Unicode fold lowercases onto `agwinterm-kiosk` and a byte
comparison cannot. A CLI folding the wider way would clear such a launch through
preflight for the engine to refuse a frame at a time later.

The **padding** taken off an entry is the same set in all three, which neither
language's own trim gives: ECMAScript counts U+FEFF ZWNBSP as whitespace and
Unicode `White_Space` does not, so `String.trim` takes a byte-order mark off an
entry that `str::trim` leaves on — an editor that prefixes one writes a list the
CLI passes and the engine refuses. U+0085 NEL parts the other way. Each reader
trims the union (`PADDING` in the two TypeScript copies, `trimmed` in
`agwinterm.rs`), and it is the same trim `AGWINTERM_PIPE` and `AGWINTERM_SESSION_ID`
go through, since a pane addressed by one reader and drawn by another has to be
one pane.

It is enforced in **three** places, and only one of them can be debug-only. The engine's
copy (`agwinterm.rs`'s `pipe_refusal`) takes `cfg!(debug_assertions)`, so a `--release`
engine ignores the variable outright. The CLI's two copies cannot: `tsc` emits the same
JavaScript for every build, so there is no build kind for them to consult, and they
honour the variable whenever it is set. They are not the same weight and the difference
is worth stating —

| reader | what it withholds | build-gated |
|---|---|---|
| `agwinterm.rs` `HostTarget::from_env` | the **run** — `Terminal::new` asks before `attach_console`, so a refused engine never takes the pane's console either | yes, `debug_assertions` |
| `cli/src/unsupported.ts` `inAgwintermPane` | the **launch** — `open` fails before Electron is spawned | no |
| `cli/src/pane.ts` `paneClearRequest` | the `image.clear` on the way out, and `pane-clear`'s | no |

The engine's copy is asked at construction rather than at the first frame, and that
ordering is load-bearing. A frame is only half of what a browser does to a pane: the
other half is `Terminal::new` attaching the pane's console, putting it on the alternate
screen, hiding the cursor and turning on any-motion mouse reporting. Resolved lazily —
on the first `draw`, which is where the target used to be needed — a refused engine had
already done all of that, and a `taskkill /F` on it runs no `ModeGuard::drop`. That is
the wreck this guard exists for, minus the picture. So `refuse_unlisted_instance`
(`terminal_windows.rs`) runs before `attach_console`, and only on
`PermissionDenied`: every other refusal out of `from_env` means "there is no pane here",
which a browser has to go on running through. It is also the only placement where the
message is read — `logging::warn` goes to the ring the browser UI drains, and on the
engine-direct path that UI is the thing not being drawn.

The ungated launch refusal is the one with a user-visible edge: a value left behind in a
shell profile stops `open` in a shipped build. It is mitigated by the same fact that made
the guard opt-in — the shipped build is that unoptimised checkout, so its engine reads
the variable too and would have refused every frame anyway. Refusing at the launch, with
a message naming the variable and the way out, is the legible form of a browser that
would otherwise start and show nothing.

The duplication itself is the same one the addressing rules already have, for the same
reason: `cli/src/pane.ts` imports nothing from the workspace — a deliberate constraint,
so the CLI can address a pane with no build and no engine — which means it carries its
own copy of the fallback pipe name, and a guard on the engine alone would leave the CLI
publishing into production. It is pinned the same way: `HOST_CASES` now carries
`AGWINTERM_PIPE` rows so all three readers of a pipe name — `inAgwintermPane`,
`paneClearRequest` and the engine — are held to one character set and cannot drift apart
again. The dev workflow the variable belongs to is in
[the README](../../README.md#working-on-the-browser).

### A control-pipe exchange has a deadline

`ControlClient` used to write a request and then `read_line` with no deadline of any
kind. A host that accepts the connection and then stalls — inside its own
`File.ReadAllBytes`, on a `TEMP` redirected to a network share — would block the render
thread permanently, and block *shutdown* too, since `PixelEngine::stop` joins it. The
quieter half was `Terminal::clear_frame`, which runs from `Drop` and swallows every
error: against a stalled host it swallowed them after blocking forever, so the browser
could not exit either.

The handle is opened `FILE_FLAG_OVERLAPPED` now, and every read and write is collected
with `GetOverlappedResultEx` against **one** deadline for the whole exchange — the write
and the reply share a budget rather than each getting their own. The number is
**1040 ms**: a hundred times the 10.4 ms round trip
[`02-frame-budget.md`](02-frame-budget.md) measures for a 2.48 Mpx frame, which is the
slowest of the three it records. A hundredfold because that measurement is a median on
an idle machine and the tail this must not clip is a loaded one; no more than that
because the wait is charged to the render thread and, through the join, to shutdown. The
odd number carries its derivation — a round second would read as a guess and would not
move if the round trip were re-measured.

The same open pins the impersonation level, which is a different concern that happens to
live on the same flags word. A named-pipe *client* gets `SecurityImpersonation` unless it
asks otherwise, so the server may `ImpersonateNamedPipeClient` and act with this user's
token — and the Win32 pipe namespace is first-come, so any local process can create
`agwinterm` before the real host does, against a client that dials a predictable name and
authenticates nothing. `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` lets the host
learn who is calling and not act as them. It is the default `NamedPipeClientStream`
applies, which is why `agwintermctl` was already hardened and this client was not. The
three flags are a named constant (`CLIENT_FLAGS`) rather than terms in the builder chain
because dropping one of them fails *open*: the handle still connects and the exchange
still works, so a test is the only thing that can see it.

"One deadline for the whole exchange" is a claim about the *loop*, not only about each
wait, and it takes a second test to be one. `millis_until` answers an expired deadline
with one millisecond rather than zero, because a zero wait does not time out — it
returns immediately with a read still pending, and the buffer the kernel is holding
would be freed under it. That floor is what a peer can spend: one that hands over a byte
inside each of those milliseconds and never a newline used to keep `read_line` going
round for another read, leaving `MAX_REPLY_BYTES` as the only bound on an exchange the
render thread and `PixelEngine::stop`'s join are waiting behind. So the deadline is
tested before each *new* read or write is started, and never before collecting one
already begun.

A timeout is deliberately **not** retried. The one replay `request` does exists for a
host that went *away*; a host that may still be about to answer would be asked twice and
cost a second deadline on a pipe whose state is now unknown. It is also not latched into
`host_absent`, which answers a different question — "is there a pane to draw into" — and
would turn one slow frame into a browser that never draws again.

### One request per connection, on the per-browser endpoint

`browser/src/registry.ts` answers `open-tab` and friends on a name any local process can
dial — the pipe namespace is machine-global and the endpoint is computable from public
inputs, which [`store/src/paths.ts`](../../store/src/paths.ts) records as an accepted
gap. Its comment said one request per connection; nothing enforced it. `connection.end`
half-closes rather than destroying, so a peer that sent two lines got a second `data`
event, a second dispatch **with real side effects**, and an
`ERR_STREAM_WRITE_AFTER_END` into a handler that swallows errors. It is a flag now, set
on the first line, and a protocol property of this endpoint rather than an assumption
about well-behaved callers — `tools/cli/registry.test.mjs` sends the second line as its
own event, which is what the unfixed code needs to reach the second dispatch.

### The review that did not run, and when it did

This project's README says every plan and every diff is reviewed by
[revmux](https://github.com/umputun/revmux) before acceptance, and `.revmux/` is
committed so that standard is versioned rather than remembered. **For the fifteen tasks
of the port, it did not happen.** `.ralphex/config` named the bridge as
`./tools/ralphex-revmux.cmd`; ralphex invokes a custom review script as
`exec.Command(script, promptFile)`, and a `.cmd` goes through cmd.exe, which reads the
leading `.`/`/` as a switch prefix. Every task's review phase died on
`'.' is not recognized as an internal or external command` — one line, scrolled past —
and the run continued. The six `fix: address code review findings` commits in that run
came from ralphex's own internal reviewer, not from revmux.

Two of the four spellings work (`tools\ralphex-revmux.cmd`, `.\tools\ralphex-revmux.cmd`)
and two do not; the config now uses a working one. The round ran on **2026-08-24**
against the whole port rather than one diff — base `45b5e43`, the vendoring commit,
profile `comprehensive` — and is committed at
`.revmux/tasks/port-windows-full/01-initial/`. It raised 19 findings, one major: the
missing deadline above.

The gap is recorded here rather than quietly closed because the failure mode is the
interesting part. **A review that could not start was indistinguishable from a review
that found nothing.** Anything downstream of an external tool needs to fail loudly when
the tool does not run, or its absence reads as a pass.

### The guard that covered one tree of three

The same shape again, found by the review above. `tools/vendor-check/` exists to catch a
silent edit to vendored upstream code, and until **2026-08-26** it did that for
`engine/crates/pixel-core/src` and nowhere else: `unchanged.test.mjs` opened with
`const SRC = "engine/crates/pixel-core/src"` and diffed the 46 paths named in
`pixel-core-files.json`. `engine/crates/pixel-node/src` and `engine/packages/pixel-react`
are vendored upstream trees too, and neither had a baseline check of any kind. Four files
in them differed from the baseline, plus both edited `Cargo.toml`s. An edit there — or a
re-vendor that dropped one — passed `pnpm test` in silence.

**[`UPSTREAM.md`](UPSTREAM.md) said otherwise, in two sentences.** That the divergence list
was "everything else, so the claim 'the other 43 files are untouched' stays checkable", and
that each divergence "is asserted by a test in `tools/vendor-check/`, so a re-vendor that
drops one fails loudly rather than at the Task 10 milestone". The second was true of two of
the six entries. Both sentences are gone; the section now says which trees are guarded and
where the scope comes from, and `upstream-doc.test.mjs` pins the retired claim by its own
words so it cannot be copied forward from an old revision.

Worse than the coverage gap was a recorded divergence whose recorded scope was wrong.
Divergence 5 described `pixel-node/src/lib.rs` as "one line — `WATCH_RESIZE = cfg!(windows)`"
against a diff of 237 insertions: the `SurfaceSink` trait, its `impl` for `Engine`, and the
genericisation of `draw_frame` and `draw_pixels`. A re-vendorer working down the checklist
would have restored the constant, lost the trait and the six tests hanging off it, and had
nothing tell them so.

The repair is [`20260826-vendor-check-gap.md`](../plans/completed/20260826-vendor-check-gap.md), and
its one design decision is that **the scope is derived, not listed**. `universe.mjs` asks
`git show --name-only 45b5e43` what was vendored — 239 paths, four declared out with a
reason each — so every path that commit carried is in scope with nobody to remind. That
query is a **diff**, not an inventory: `45b5e43` has a parent, and its tree holds 291
paths. The 52 it does not report are this repo's own harness, committed before the
vendoring, which is why the two answers agree about upstream — a coincidence, now written
down as `PRE_BASELINE` and held to `git ls-tree` by `assertUniverseIsTheWholeSnapshot`,
because the day `BASELINE` moves to a re-vendor commit every upstream file unchanged
across it would leave the universe with no count moving to say so. Note the other edge,
because it is the one thing a one-commit scope cannot do: a file vendored
*later* is not in the universe, and committing it under this baseline silences the
untracked finding without putting it in scope. For genuinely new upstream code the answer
is a re-vendor that moves `BASELINE`, which `untrackedMessage` and the checklist at the end
of `UPSTREAM.md` both say out loud.

A per-tree manifest was the first option and was rejected for reproducing the defect: the
scope would still have been whatever someone remembered to write down. Everything that
differs now carries a disposition in `dispositions.mjs`, deletions are caught, and an untracked file in
a vendored tree is caught — that last one found by hand-testing the finished guard, which
was still at 472/472 with an intruder sitting in each tree, because every check it had asked
a question about a path the vendoring commit introduced.

Deriving the *trees* from that same commit needed one declaration on top, and leaving it out
made the untracked check a repo-wide nag for a review round. `45b5e43` did two jobs — it
imported upstream and it laid down this repo's scaffolding — so `tools/` and `docs/design/`
qualified as directories the commit put vendored files in, though `UPSTREAM.md`'s "What was
copied" lists neither. Every tool and design note written since, 66 of them including the
five files of this change, was an untracked-file failure until it was staged. `EXCLUSIONS`
could not repair it: those paths belong in the universe and must stay byte-identical, so
declaring them out would have traded a false finding for a real hole in the diff.
`PROJECT_ROOTS` names the two roots instead, with a reason each and a staleness check of its
own, and subtracts them from the tree derivation only.

The gap is recorded here rather than quietly closed for the reason the revmux gap is. **A
check that covers a third of its subject looks exactly like a check that covers all of it**
— green, fast, and cited in the documentation as proof. It had been passing for five days.
The question worth carrying forward is which other checks in this repo are trusted because
they have never failed.
