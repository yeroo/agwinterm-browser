# Where cell pixel metrics come from on Windows

**Decision: a new agwinterm control verb, `session.metrics`, is the source. An
explicit `TERMINAL_BROWSER_CELL_PX` overrides it and is what works before the verb
ships. When neither answers, the backend returns `(16, 32)` with a warning that names
the fix — and, crucially, returns it *rather than `None`*.**

*Status, 2026-09: the verb is on agwinterm `main` at `8230d0e`, beside `image.frameshm`,
and in no release; on a release the override is still what works.*

This is the port plan's Task 6. It had to be settled before Task 7 because the frame
path publishes a `cols`/`rows` cell span and the renderer scales the image into it.

## The question, and why neither of `pixel-core`'s two mechanisms answers it

`pixel-core` has two ways to learn a cell size, and both are unavailable here:

- **`CSI 16 t`** (`terminal.rs:880`). agwinterm's `csi_dispatch`
  (`native/agwinterm-core/src/emulator.rs:964-1045`) matches
  `H f A B C D G d J K X m r L M @ P S T q` and, under `?`, only `h`, `l` and DECRQM
  `?2026$p`. There is no `t` arm at all, so `14t`/`16t`/`18t` fall to `Unhandled` and
  the query times out.
- **`tcgetwinsize`'s `ws_xpixel`/`ws_ypixel`** (`terminal.rs:732`). Windows has no
  equivalent. `GetConsoleScreenBufferInfo` reports `srWindow` in *cells* and nothing
  in pixels, which is why `terminal_windows.rs` reports both pixel fields as zero
  rather than guessing, and `WindowSize::cell_size()` honestly answers `None`.

Nothing else publishes them either: no control verb in either switch
(`ControlServer.cs:104-250`) reports pane geometry, and the session environment
(`Program.Sessions.cs:112-124`) exports `AGWINTERM`, `AGWINTERM_ENABLED`,
`AGWINTERM_PIPE`, `AGWINTERM_SESSION_ID`, `AGWINTERM_PANE_ID`,
`AGWINTERM_WORKSPACE_ID`, `AGWINTERM_WINDOW_ID`, `TERM_PROGRAM` and
`TERM_PROGRAM_VERSION` — nothing dimensional.

The metrics do exist host-side. `Agwinterm.Win32/Program.cs:336` computes them and
`Program.Render.cs:356` pushes them into the emulator as
`CellPixelWidth`/`CellPixelHeight`. They are simply not published.

## What a wrong cell size actually costs — a correction

The port plan said a wrong cell size "silently produces wrong click targets". Reading
the two consumers together, that is not quite what happens, and the difference decides
the design.

Both the canvas and the pointer are derived from *the same* number:

| consumer | code | what it does with the cell size |
|---|---|---|
| the canvas | `engine/mod.rs:43-55`, `window_from` | `width = cols * cell.0`, `height = rows * cell.1` |
| the pointer | `terminal_windows.rs`, `mouse_position_px` | `x = (col - 1) * cell.0 + cell.0 / 2` |

An SGR mouse report addresses a *cell*, and it is mapped to the centre of that cell in
the canvas's own coordinate space. So if both sides use the same `w`, the click lands
in the right place **whatever `w` is**. What a wrong-but-consistent `w` costs is:

- **resolution.** agwinterm draws the placement at `p.Cols * cw` by `p.Rows * ch` with
  `BitmapInterpolationMode.Linear` (`Program.Render.cs:77-87`), so a frame rendered at
  the wrong scale is resampled. Text goes soft.
- **layout.** The CSS viewport is the canvas size, so a 16×32 assumption against a
  real 9×19 cell gives the page a viewport ~1.8× larger than the pane and everything
  in it renders proportionally smaller once downscaled.

Neither is fatal, which is why Tasks 7–10 can proceed without the host change.

**What *does* move click targets** is the two consumers disagreeing — and that is
exactly what the code did before this task. `cell_size()` returned `Unsupported`,
`engine/mod.rs:347` has `term.cell_size()?.unwrap_or((16, 32))` and would have sized
the canvas at 16×32 per cell, while `mouse_position_px`'s `None` arm returned raw cell
units. A click on column 40 would have been delivered at x=39 in a canvas 640px wide.

So the design constraint is not "get the right number". It is **"return one number,
and return it to both"**. Hence `Terminal::cell_size` never answers `None`.

## The choice: a control verb, not XTWINOPS

agwinterm's plan (`docs/plans/20260821-image-frameshm-command.md`, Task 6b) offers
both. XTWINOPS is the standard answer and `pixel-core` already speaks it. The control
verb wins here for three reasons specific to this port:

1. **The pipe client exists anyway.** Task 6 builds it for the frame path regardless,
   so consuming one more verb is a method, not a mechanism. XTWINOPS would need a
   second write-then-read-the-reply state machine on the console, on top of the one
   `query_colors` already runs.
2. **The console read path is the fragile one.** Task 5 established that console input
   arrives on a reader thread through an inbox because records that translate to no
   bytes break the obvious loop. A deadline-bounded reply parse layered on that — for
   a value needed during construction and again on every resize — is the part most
   likely to go wrong intermittently. The pipe is request/response with no deadline
   and no interleaving.
3. **One round trip answers everything Task 7 needs.** `cols`, `rows`, the cell size
   *and* the pane's pixel box come back together. The console screen buffer supplies
   cells only, and nothing supplies the pixel box.

This does not argue against agwinterm also implementing XTWINOPS — it would help every
other client — only that this consumer does not need it and should not be blocked on
it.

### The wire shape

Request, addressed to the pane (never `"active"`):

```json
{"cmd":"session.metrics","target":"<pane id>"}
```

Reply, an object rather than a string — `OkRaw`, the way `tree` and `window.state`
answer:

```json
{"ok":true,"result":{"cols":132,"rows":37,"cellWidth":9,"cellHeight":19,"widthPx":1188,"heightPx":703}}
```

- `cellWidth`/`cellHeight` are the live `_cellW`/`_cellH` in device pixels. They are
  the only two fields a consumer cannot do without; a reply missing either, or with
  either zero, is read as "no metrics" rather than as an error.
- `cols`/`rows`/`widthPx`/`heightPx` are optional to consume and default to zero.
- camelCase, matching `window.state`'s `sidebarVisible`/`activeWorkspace`.
- A host that predates the verb answers `{"ok":false,"error":"unknown command
  'session.metrics'"}`, which this client latches as a capability gap and does not
  ask about again.

**Dependency**: agwinterm's Task 6b implements this. It is recorded there, in that
task's first checkbox, as the mechanism chosen by the consumer. Until it lands, the
override below is the working path.

## `TERMINAL_BROWSER_CELL_PX`, and why it is consulted first

`<width>x<height>` in pixels — `TERMINAL_BROWSER_CELL_PX=9x19`. Read through
`SessionEnv`, like `TERMINAL_BROWSER_CONSOLE_PID`, so it works in the daemon shape too.

It is checked **before** the host verb, which is the less obvious ordering. Two
reasons: it is the only source that exists before Task 6b ships, so bring-up needs it
to be authoritative; and it is how a user corrects a host that reports the wrong thing
(a mixed-DPI move, a font the metrics lag behind). A value that is present but
unparseable is warned about and ignored rather than silently dropped — a typo is
otherwise indistinguishable from not having set it.

## The fallback, and why it is `(16, 32)`

Not because it is right. Because it is the number `engine/mod.rs:347` substitutes for
a `None`, and matching it means the backend and the engine cannot disagree even if a
future caller reaches the engine's `unwrap_or` first. It is logged at `warn` with the
variable that fixes it, so it is a visible degradation rather than a silent guess:

```
[warn] agwinterm: no cell metrics: this host publishes none and TERMINAL_BROWSER_CELL_PX
is unset, so frames are rendered at 16x32px per cell and agwinterm resamples them to fit
the pane. Set TERMINAL_BROWSER_CELL_PX=<width>x<height> to render sharp
```

## What was considered and rejected

- **`GetCurrentConsoleFontEx` on `CONOUT$`.** Under a pseudoconsole this reports the
  pseudoconsole's own notion of a font, not the GUI renderer's, so it would answer
  confidently and wrongly — the worst of the options.
- **"Render at a fixed resolution and let `cols`/`rows` scale it."** This is what the
  fallback *is*; the objection to adopting it as the answer is that it permanently
  accepts a resampled image, and the sharp path costs agwinterm one verb.
- **Deriving the cell size from the pane's pixel size and cell count.** Would work,
  but nothing publishes the pane's pixel size either, so it is the same host change
  wearing a different hat.

## Where this lives in code

- `pixel-core/src/agwinterm.rs` — `cell_size()` is the three-source resolution above,
  `ControlClient::pane_metrics()` is the verb, `FALLBACK_CELL` is the last resort.
- `pixel-core/src/terminal_windows.rs` — `Terminal::cell_size` caches the result and
  `mouse_position_px` reads the same cache, which is the invariant this document
  exists to protect.
