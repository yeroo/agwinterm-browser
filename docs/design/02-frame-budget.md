# The frame budget: the file path, and what `image.frameshm` deleted

> Two measurements, on Windows 11, with a real Electron 43.3.0 OSR browser
> publishing real frames. The **baseline** was taken at the Task 10 milestone
> (2026-08) against a **Debug agwinterm** (instance `agwinterm-dev`). The
> **comparison** was taken on 2026-09-04 against a **Release agwinterm built from
> `main` at `3c8a56f`** (one commit past v0.17.10; the verb landed at `8230d0e`),
> both transports in the same instance, the same pane and the same page, minutes
> apart. Nothing here is estimated. The instrumentation that produced it is
> permanent — see [How to re-measure](#how-to-re-measure) — because the fast path
> was measured *against* the baseline, and a fast path with no baseline to beat is
> a claim rather than a measurement.

## What the milestone showed

A static page reaches the pane, legibly, at the pane's size and origin, in
**737 ms** from `session new` to the first published frame — cold Electron start
included. It is a milestone, not a finding: the plan's own tripwire was "if a single
static page takes seconds to appear, that is a finding", and it does not.

Screenshots are in [Post-Completion](../plans/completed/20260821-windows-port.md#post-completion).

## The stages, measured

One frame over the file path goes through five stages. The first three are the
browser's and block its draw loop; the last two are agwinterm's, and only the fourth
is inside the round trip the browser waits on.

| # | stage | who | in `publish_ms`? |
|---|---|---|---|
| 1 | PNG encode (`encode_png`) | browser | — |
| 2 | file write (`write_frame`) | browser | — |
| 3 | `image.frame` round trip | browser waits | itself |
| 4 | `File.ReadAllBytes` + placement lock | agwinterm, synchronous | yes |
| 5 | PNG decode to premultiplied BGRA | agwinterm, **async on its own thread** | no |

Over `image.frameshm` there are three: a copy into the mapping's inactive slot
(`copy_ms`, the browser's), the `image.frameshm` round trip (`publish_ms`), and
inside that round trip the host's copy out of the slot plus the same placement lock.
There is no encode, no file, and no decode after the reply.

Stages 1–3, and the copy, come from the browser's own budget file. Stages 4 and 5
are measured from outside it: stage 4 by issuing `image.frame` on the control pipe
directly, stage 5 by running `DecodePixels` (`Program.Render.cs:212`) —
`System.Drawing.Bitmap` + `LockBits(Format32bppPArgb)` + copy — on the frame the
browser actually produced. That is not a proxy for the host's decoder; it is the
host's decoder.

### The baseline: medians per frame, file path, Debug host (2026-08)

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

### The comparison: medians per frame, both transports, Release host at `3c8a56f` (2026-09-04)

The same three canvases, each measured over `file` and then over `shm` in the same
instance, same pane, same page. The `file` rows are the baseline re-taken on this
host — that is what `TERMINAL_BROWSER_FRAME_TRANSPORT=file` exists for — and they
land within 7% of the Debug-host baseline above at every size, so the two tables
are about the same thing.

| canvas | pane | transport | bytes | encode | write | copy in | round trip | **producer** | **fps** |
|---|---|---|---|---|---|---|---|---|---|
| 790×580 (0.46 Mpx) | 79×29 @ 10×20 | `file` | 1.83 MB PNG | 4.43 ms | 0.90 ms | — | 5.87 ms | **11.51 ms** | **87** |
| | | `shm` | 1.83 MB raw | — | — | 0.09 ms | 1.78 ms | **1.88 ms** | **532** |
| 1264×928 (1.17 Mpx) | 79×29 @ 16×32 | `file` | 4.69 MB PNG | 11.35 ms | 1.73 ms | — | 7.04 ms | **20.39 ms** | **49** |
| | | `shm` | 4.69 MB raw | — | — | 0.31 ms | 3.88 ms | **4.23 ms** | **236** |
| 2096×1184 (2.48 Mpx) | 131×37 @ 16×32 | `file` | 9.93 MB PNG | 26.86 ms | 3.17 ms | — | 9.79 ms | **40.43 ms** | **25** |
| | | `shm` | 9.93 MB raw | — | — | 0.70 ms | 7.52 ms | **8.74 ms** | **114** |

"Producer" is everything the browser's draw loop waits on: encode + write + round
trip on `file`, copy + round trip on `shm`. The raw rows are
`tools/milestone/measured-<transport>-<cell>-<span>.tsv`; the medians are over every
row, 31 to 40 per case, taken with `tools/milestone/measure-transports.mjs`.

The `bytes` column is the one coincidence worth naming: this page's PNG is the size
of its raw pixels — 1,833,583 against 1,832,800 — so at every size the file path
spent its encode to save nothing.

## What the fast path deleted

At the largest pane the producer went from **40.4 ms to 8.7 ms per frame**, 25 fps to
114 fps — a 4.6× cut, and the design's "38 ms → under 10 ms" landed where it said it
would. Per stage, at 2.48 Mpx:

- **The encode and the write, 30.0 ms, are gone outright.** They were the case for
  the fast path and they are what it removed. In their place is a 0.70 ms copy into
  the mapping — about 0.28 ms per megapixel, the browser's memcpy and nothing else.
  The first frame or two of a fresh mapping cost more — 3–3.5 ms at the largest
  size — which is the mapping's creation and its first page faults; every resize
  pays that once.
- **The round trip fell too, from 9.79 ms to 7.52 ms**, because the host reads no
  file. What remains of it scales with pixels — 1.78, 3.88, 7.52 ms across the
  three sizes, about 3 ms per megapixel — and that is the host's copy out of the
  slot (`ShmFrameReader.TryReadFrame`, done before the reply so that the slot is
  the producer's again). It is now nearly the whole cost of a frame at the small
  sizes and 86% of it at the largest.
- **The host's decode, 14.4 ms in the baseline, has nothing to decode.** The copy
  out of the slot *is* the pixels; "to pixels" on `shm` is the producer column.

The win is largest where it was least needed: 6.1× at the smallest pane, 4.6× at the
largest. That is the copy out of the slot growing with the frame while the fixed part
of the round trip shrank to almost nothing, and it is the next thing to look at.

## Two findings the baseline made plain, revisited

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
| producer total, `file` | 19.8 ms | 11.8 ms | **1.7× faster** |
| producer total, `shm` | 4.23 ms | 1.88 ms | **2.3× faster** |

The fast path made this *more* true, not less: with the encode gone the frame is
almost all copy, and a copy is linear in pixels. agwinterm's `session.metrics` is on
`main` beside the verb, and on a host that has it the browser sizes its canvas from
the pane's real cell, so the fallback is paid only on a host without the verb. ⚠️ The
host's cell size is a **float** (`Program.cs:1127`, `_cellW = run.Metrics.Width / 10f`)
and `TERMINAL_BROWSER_CELL_PX` takes integers, so the override can only ever be
close; the verb is exact.

### The round trip's fixed cost was `image.frame`'s, and `image.frameshm` does not pay it

The baseline found a bare `ping` on the pipe at **0.26 ms** and an `image.frame`
naming a 1.83 MB file at **6.6 ms**, of which the host's own read was 0.5 ms and its
placement lock 0.05 ms — about 5.5 ms unaccounted for inside the verb, at every
size. It read that as a floor the fast path would inherit, "roughly 150 fps,
whatever the frame contains".

It was not inherited. On the Release host the `ping` is 0.24 ms
(`measure-pipe.ps1`, 25 runs), `image.frame` at 1.83 MB is still 5.87 ms — and
`image.frameshm` at the same size is **1.78 ms**, of which the copy out of the slot
is most. Whatever the 5.5 ms was, it was on `image.frame`'s path and not on the
pipe's, and the fast path's floor is the copy, not a constant: 532 fps at the
smallest pane measured. Where the file verb's time went is still agwinterm's
question, and it matters less now that the browser no longer asks it per frame.

## How to re-measure

Two knobs, both off by default.

- `TERMINAL_BROWSER_FRAME_BUDGET=<path>` — the browser appends one tab-separated line
  per frame: `seq, canvas, span, bytes, encode_ms, write_ms, publish_ms, transport,
  copy_ms` — `transport` is `file` or `shm`, and the stages a transport does not pay
  are `0.00`, so both paths can be read off one file. Implemented
  in `pixel-core/src/frame_file.rs` (`BudgetLog`), read through `SessionEnv` like every
  other `TERMINAL_BROWSER_*` variable so it works in the daemon shape too.
- `AGWINTERM_PERF=<path>` — agwinterm's own, already shipped
  (`ControlServer.cs`, `Perf`): `frame images= transmits= readKB= lockMs=`, and the
  same line with `frameshm` for the fast path. On the Release host the lock is
  0.01 ms on both.

**The comparison** is `tools/milestone/measure-transports.mjs`: one session per
transport per cell size on a host named by `--pipe`, the shipped CLI in each, the
budget file waited on, the medians printed. A static page paints while it loads
and then never again, so after the load's burst the script opens a second tab on
the same page and switches between the two — every switch repaints the whole
canvas — until it has the rows it was asked for. The pane's size is the window's;
`window.resize` over the pipe (1004×640 gave 79×29 on this machine, 1505×800 gave
131×37) and `session.metrics` to check. It refuses to take `shm` rows from a host
that answers `unknown command`.

**The baseline** was driven by hand: `tools/milestone/run-milestone.cmd` in a pane
(it takes a URL and defaults to `tools/milestone/static-page.html`), one cell size at
a time. The host-side halves are `tools/milestone/measure-host-decode.ps1` (stage 5,
and the read in isolation), `tools/milestone/measure-frame-verb.ps1` (stage 4 end to
end) and `tools/milestone/measure-pipe.ps1` (the `ping` floor). Its raw rows are
`tools/milestone/measured-fallback-16x32.tsv` and `measured-override-10x20.tsv`, in
the seven-column shape the budget file had then.

⚠️ Measure against a second instance (`--app-id agwinterm-dev`, agwinterm's README),
never the real one. The baseline's was a Debug build, which is not optimised, so its
stages 4 and 5 are if anything pessimistic; the comparison's was a Release build from
`main` one commit past v0.17.10 — the release that carries the verb — because the
installed release on the measuring machine predated it, and a Debug host would have
put a build difference into a transport comparison.
