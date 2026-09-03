# The frame budget of the file-based path

> Measured at the Task 10 milestone, on Windows 11, against a **Debug agwinterm**
> (instance `agwinterm-dev`) with a real Electron 43.3.0 OSR browser publishing real
> frames. Nothing here is estimated. The instrumentation that produced it is
> permanent — see [How to re-measure](#how-to-re-measure) — because Task 12 has to
> diff `image.frameshm` against this, and a fast path with no baseline to beat is a
> claim rather than a measurement.

## What the milestone showed

A static page reaches the pane, legibly, at the pane's size and origin, in
**737 ms** from `session new` to the first published frame — cold Electron start
included. It is a milestone, not a finding: the plan's own tripwire was "if a single
static page takes seconds to appear, that is a finding", and it does not.

Screenshots are in [Post-Completion](../plans/completed/20260821-windows-port.md#post-completion).

## The stages, measured

One frame goes through five stages. The first three are the browser's and block its
draw loop; the last two are agwinterm's, and only the fourth is inside the round
trip the browser waits on.

| # | stage | who | in `publish_ms`? |
|---|---|---|---|
| 1 | PNG encode (`encode_png`) | browser | — |
| 2 | file write (`write_frame`) | browser | — |
| 3 | `image.frame` round trip | browser waits | itself |
| 4 | `File.ReadAllBytes` + placement lock | agwinterm, synchronous | yes |
| 5 | PNG decode to premultiplied BGRA | agwinterm, **async on its own thread** | no |

Stages 1–3 come from the browser's own budget file. Stages 4 and 5 are measured from
outside it: stage 4 by issuing `image.frame` on the control pipe directly, stage 5 by
running `DecodePixels` (`Program.Render.cs:212`) — `System.Drawing.Bitmap` +
`LockBits(Format32bppPArgb)` + copy — on the frame the browser actually produced.
That is not a proxy for the host's decoder; it is the host's decoder.

### Medians, per frame

| canvas | pane | PNG | encode | write | round trip | host read | host decode | **producer** | **to pixels** |
|---|---|---|---|---|---|---|---|---|---|
| 790×580 (0.46 Mpx) | 79×29 @ 10×20 | 1.83 MB | 3.7 ms | 0.9 ms | 7.2 ms | 0.5 ms | 2.7 ms | **11.8 ms** | **14.5 ms** |
| 1264×928 (1.17 Mpx) | 79×29 @ 16×32 | 4.69 MB | 10.3 ms | 1.8 ms | 7.7 ms | 1.4 ms | 5.6 ms | **19.8 ms** | **25.4 ms** |
| 2096×1184 (2.48 Mpx) | 131×37 @ 16×32 | 9.93 MB | 24.7 ms | 2.9 ms | 10.4 ms | 2.7 ms | 14.4 ms | **38.0 ms** | **52.4 ms** |

"Producer" is stages 1–3, which is what caps the browser's frame rate: **26 fps** at
the largest size measured, 85 fps at the smallest. "To pixels" adds the host's decode,
which is latency the user sees but not backpressure on the browser.

Everything scales with **pixels**, not with cells: encode and decode are both within
10% of linear in canvas area across a 5.4× range.

## Two findings the numbers make plain

### The cell size is a frame-cost decision, not only a sharpness one

Task 6 recorded that a wrong-but-consistent cell size costs resolution rather than
click accuracy. It also costs **2.5× the frame**. `FALLBACK_CELL` is `(16, 32)` while
this host's cell is about 9.6 × 19.9 px, so the fallback renders 2.56× the pixels the
pane can show and agwinterm resamples them back down. Same pane, same page:

| | fallback `(16,32)` | `TERMINAL_BROWSER_CELL_PX=10x20` | |
|---|---|---|---|
| canvas | 1264×928 | 790×580 | |
| PNG | 4.69 MB | 1.83 MB | **2.6× smaller** |
| encode | 10.3 ms | 3.7 ms | **2.8× faster** |
| host decode | 5.6 ms | 2.7 ms | **2.1× faster** |
| producer total | 19.8 ms | 11.8 ms | **1.7× faster** |

So the value of agwinterm's `session.metrics` (its plan's Task 6b) is larger than
Task 6 costed it: it is worth roughly as much as a whole stage. ⚠️ Note the host's
cell size is a **float** (`Program.cs:1127`, `_cellW = run.Metrics.Width / 10f`) and
`TERMINAL_BROWSER_CELL_PX` takes integers, so the override can only ever be close;
the verb can be exact.

### The round trip has a fixed cost, and `image.frameshm` still pays it

A bare `ping` on the same pipe, including connect, is **0.26 ms**. An `image.frame`
naming a 1.83 MB file is **6.6 ms**, of which the host's own read is 0.5 ms and its
placement lock is 0.05 ms (`AGWINTERM_PERF`). About **5.5 ms is fixed cost inside the
verb** — not the pipe, not the read, not the lock. It is charged per frame at every
size measured.

That is a constraint on Task 12, not an argument against it: `image.frameshm` removes
stages 1, 2, 4 and 5 but keeps stage 3, so **the fixed cost is the floor** — roughly
**150 fps**, whatever the frame contains. The measurement is recorded rather than
explained; finding out where the 5.5 ms goes is agwinterm's question.

## Task 12: the comparison that could not be made

⚠️ **`image.frameshm` was not built, so there is no second column to put beside the
numbers above.** The reason is a missing contract, not a missing effort.

Task 12 opens with a precondition — `agwinterm/docs/specs/image-frameshm.md` must
exist *and* state the literal `Local\` mapping-name prefix and the producer
slot-reuse invariant. That file does not exist. agwinterm has a plan for the verb
(`docs/plans/20260821-image-frameshm-command.md`) whose Task 1 — the one that defines
the header layout and publishes the spec — is entirely unchecked, and
`ControlServer.cs:249` still dispatches `image.frame` and nothing else.

A producer written against that gap would be inventing a header layout and calling it
a contract. The failure mode when the real consumer disagrees is a torn or silently
rejected frame, which is precisely the class of bug the file path's unique-path design
exists to eliminate — so guessing here would trade a measured 26 fps for an unmeasured
picture. The gate was honoured.

**What shipped instead** is the half of Task 12 that does not depend on the layout,
in `pixel-core/src/frame_shm.rs`:

- `TERMINAL_BROWSER_FRAME_TRANSPORT` (`auto` | `file` | `shm`) — the file path stays
  *explicitly* selectable rather than becoming whatever the newest code prefers. This
  is what re-measures the baseline below once the fast path lands, on the same host in
  the same session.
- The `unknown command` probe: the literal refusal `ControlServer.cs:250` gives for a
  verb it does not have, read the same way by every capability question in the crate.
  `session.metrics` had this open-coded and now shares it. It is the fallback trigger
  the fast path will hang on, and it is tested against the real reply string today.
- `TERMINAL_BROWSER_FRAME_TRANSPORT=shm` publishes over `image.frame` and says so,
  once per run, naming the missing spec. Silence would be worse than the gap: a
  working browser under `=shm` reads as "the fast path is on", which would make every
  number measured afterwards wrong.

**What remains** when the spec lands: the named mapping (never a raw `HANDLE`), the
BGRA write into the inactive slot, the `ready` bump, the two-slot alternation with the
producer invariant that request/response makes sufficient, release on shutdown, and
then this comparison.

## The case for it, unchanged

At the largest pane measured the producer spends **38 ms** per frame, of which
**27.6 ms** (encode + write) is work `image.frameshm` deletes outright, and a further
14.4 ms of host decode disappears with it. What remains is the ~7 ms round trip and a
BGRA copy into shared memory. So the expected shape is **38 ms → under 10 ms**, and
the honest ceiling is the fixed round-trip cost above.

It is worth doing, and the ordering in the plan is right: PNG at 26 fps is enough for
a static page and enough for the milestone, and not enough for scrolling. That case is
made by the numbers above and is not weakened by the blocker — what is missing is the
host's half of the contract, not a reason.

## How to re-measure

Two knobs, both off by default.

- `TERMINAL_BROWSER_FRAME_BUDGET=<path>` — the browser appends one tab-separated line
  per frame: `seq, canvas, span, bytes, encode_ms, write_ms, publish_ms, transport,
  copy_ms` — `transport` is `file` or `shm`, and the stages a transport does not pay
  are `0.00`, so both paths can be read off one file. Implemented
  in `pixel-core/src/frame_file.rs` (`BudgetLog`), read through `SessionEnv` like every
  other `TERMINAL_BROWSER_*` variable so it works in the daemon shape too.
- `AGWINTERM_PERF=<path>` — agwinterm's own, already shipped
  (`ControlServer.cs:484`): `frame images= transmits= readKB= lockMs=`.

The host-side halves are `tools/milestone/measure-host-decode.ps1` (stage 5, and the
read in isolation), `tools/milestone/measure-frame-verb.ps1` (stage 4 end to end) and
`tools/milestone/measure-pipe.ps1` (the `ping` floor). `tools/milestone/run-milestone.cmd`
is the launcher the whole thing was driven with; it takes a URL and defaults to
`tools/milestone/static-page.html`.

⚠️ Re-measure against a **Debug** agwinterm (`--pipe agwinterm-dev`), never the real
instance — and note the Debug build is not optimised, so stages 4 and 5 are, if
anything, pessimistic.
