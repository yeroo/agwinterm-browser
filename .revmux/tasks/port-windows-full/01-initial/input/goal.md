# What I want out of this review

## Read this first: what has and has not already been reviewed

This code was written by ralphex, autonomously, one task at a time. After each task an internal
Claude reviewer looked at **that task's diff alone**. It found real things — six
`fix: address code review findings` commits came out of it.

The external panel — this one, the project's actual review standard — **never ran**. The bridge
died on a path bug and the failure scrolled past as one line, so all 15 tasks shipped with only
the per-iteration reviewer behind them.

That history tells you where to spend effort. Assume the cheap, local, within-one-diff defects
were mostly caught. **Hunt what a per-iteration reviewer structurally could not see:**

- A contract established in an early task and quietly broken by a later one. Task 3 defines a
  seam; task 12 changes its shape; both diffs look fine alone.
- Something declared done in task N whose test only ever exercised the stub that task N+3
  replaced.
- Invariants that span the Rust engine, the TypeScript browser and the C# host contract. No
  single task's diff contains more than one side of those.
- Cleanup, lifetime and shutdown ordering across components that were built in different tasks.

## The specific places I most suspect

The as-built record and the commit subjects admit to a lot. These are worth reading as
confessions, not as history:

1. **"the shared-memory fast path — the gate that held, and the half that shipped"** (`9124708`).
   Half of something shipped. Which half, and what happens on the path that was not built? The
   shm path is the one place this port does manual memory lifetime across a process boundary into
   C#, so a mistake there is a use-after-free or a torn frame, not a cosmetic bug.
2. **"the frame that outlived the browser"** (`77928ad`) — acceptance found this and something was
   done about it. Is what was done sufficient, or does it cover only the case the test exercises?
3. **"interactive input — Cmd is Ctrl, and the key that never came back up"** (`26c1c86`). A key
   that never releases is a stuck-modifier bug. Are there other paths into the same state —
   focus loss, resize, a browser that dies mid-chord?
4. **"the resize that was never wired"** (`b871875`) — wired later, or still not?
5. **`presentBitmap` on stock Electron.** Upstream never ran this path in anger on Windows. Frame
   pacing, backpressure when the terminal cannot keep up, and what happens when frames arrive
   faster than they drain.
6. **The vendored-tree boundary.** `tools/vendor-check/` exists to keep the port honest about what
   it changed in upstream code. Does it actually do that, or can a change slip past it?

## What a finding is worth to me

I have to triage every one of these into fix-now, fold-into-a-later-plan, or accepted-with-reason,
and I am not allowed to silently drop any. So:

- **A finding I can act on beats a finding I have to investigate.** Name the file and line, and
  say concretely what input or state makes it go wrong.
- **Say if it is pre-existing** — inherited from upstream rather than introduced here. It changes
  what I do about it entirely.
- **Confidence should be the confidence you actually have.** I am running with no confidence
  floor precisely so that a well-reasoned 40 reaches me. Do not inflate one to survive a filter
  that is not there, and do not suppress one either.

## What I do not need

- Findings about the four defects already listed in scope.md as known.
- Style, formatting, or naming preferences. Clippy and fmt already ran and pass.
- A verdict on whether the port was a good idea. It shipped; I need to know what is wrong with it.
- Restatements of the design back to me.
