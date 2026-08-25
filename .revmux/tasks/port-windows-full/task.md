---
description: the winterm-browser Windows port as built — all 15 tasks, reviewed after the fact
branch: windows-port
base: 45b5e43
---

The port shipped without this review. `.ralphex/config` pointed the external review phase at
`./tools/ralphex-revmux.cmd`; ralphex runs that through `exec.Command`, which on Windows goes to
cmd.exe, which reads the leading `/` as a switch prefix. Every iteration's review died with
`'.' is not recognized as an internal or external command` and ralphex treated the empty result as
a review that found nothing.

So all 15 tasks were reviewed only by ralphex's internal per-iteration Claude reviewer — the six
`fix: address code review findings` commits are its output. This task is the external panel run
after the fact, over the whole port at once rather than task by task.

Base is `45b5e43`, the commit that vendored upstream. Before it there is no port; after it there
is nothing but.

## Triage (2026-08-24)

19 findings raised, 11 survived synthesis, 12 in `01-initial/report.md` (synthesis merged one
back in as pre-existing). Every raised finding is dispositioned below, including the seven
synthesis dropped — the plan requires that none be silently lost, and three of the drops turned
out to be the most consequential findings of the round. Their full text is in `01-initial/dropped-findings.md`, since `stages/` is not committed.

### Synthesis over-applied the "already known" instruction

`input/scope.md` listed the four defects already planned in
`docs/plans/20260822-post-port-corrections.md` and told the panel not to re-report them. The
finders respected that correctly — one drop even opens "Deepening evidence for known defect #2,
not a restatement of it" — but the synthesis stage dropped them anyway as duplicates of the known
set. They are not duplicates: they are *second code paths with the same defect*, which the scope
explicitly asked for. Recovered by hand from `stages/1-found.json`.

### Fold into the corrections plan — these change tasks already written

| finding | file | conf | effect on the plan |
|---|---|---|---|
| CLI repeats the engine's unguarded production-pipe fallback | `cli/src/pane.ts:58` | 60 | **Task 2 is scoped too narrowly.** Its evidence row names only `engine/.../agwinterm.rs:57`; `pane.ts` holds an independent copy of `DEFAULT_PIPE` and the fallback, in a module that deliberately imports nothing from the workspace and so cannot inherit a guard added elsewhere. Task 2 as written closes the engine and leaves this open. |
| "one rule for what counts as a pane" is three rules that disagree | `cli/src/unsupported.ts:115` | 75 | Task 2 again. `inAgwintermPane` does not check the pipe name at all, the engine permits only `[A-Za-z0-9._-]`, `paneClearRequest` rejects only `[\/]`. A pane with `AGWINTERM_PIPE=agwinterm 2` passes the CLI gate and then fails inside the engine. |
| `openInForeground` clears the pane unconditionally | `cli/src/main.ts:484` | 65 | **Task 1 must not copy this.** The engine's `FramePublisher::clear` returns early when it never published — "asking anyway would clear a placement some *other* process owns." The CLI half has no such guard, so a failed launch clears an image another process placed. The new `pane-clear` verb needs the same rule, which cuts against Task 1's "succeed loudly when there was nothing to fix". |
| Control-pipe replies have no deadline **(the round's only major)** | `engine/.../agwinterm.rs:277` | 90 | Needs a **new task**. `read_line` waits forever; if agwinterm accepts but stalls, the render thread blocks permanently and `PixelEngine::stop` hangs joining it. Same class as Task 3's unbounded wait, but in shipped engine code rather than a test. |

### Fix now — self-contained, no design decision

| finding | file | conf |
|---|---|---|
| as-built names `presentBitmap` as the Windows frame path; `BitmapPresenter` is what runs | `docs/design/07-as-built.md:117` | 90 |
| "Two lesser ones" heading sits over five bullets | `docs/design/07-as-built.md:218` | 95 |
| README promises three written divergences, UPSTREAM.md lists two | `README.md:16` | 70 |
| comment claims Ctrl+Shift+F "still finds" above an assertion that it does not | `tools/input/keybindings.test.mjs:151` | 88 |
| `"C:\work\site"` collapses to `C:worksite`, so the test asserts nothing | `tools/launcher/launch.test.mjs:253` | 80 |
| module doc states the cell-metrics resolution order backwards | `engine/.../agwinterm.rs:40` | 50 |
| milestone runner header says the CLI "only spawns the daemon" (untrue since Task 13) | `tools/milestone/run-milestone.cmd:4` | 78 |

### Fold into a later plan — real work, not a one-liner

| finding | file | conf |
|---|---|---|
| vendor-check guards only `pixel-core/src`; `pixel-node` and `pixel-react` are unguarded, and UPSTREAM.md's list omits six edits while claiming to be exhaustive | `docs/design/UPSTREAM.md:55`, `tools/vendor-check/unchanged.test.mjs:43` | 90 |
| napi-module suite skips on a missing artifact and never checks staleness, against the rule `tools/lib/built.mjs` sets for the rest of the tree | `tools/vendor-check/native-build.test.mjs:74` | 58 |
| docs-check asserts one direction of a contract its own comment says is bidirectional | `tools/docs-check/docs.test.mjs:133` | 75 |
| `file://` URLs are not converted to Windows paths — `file:///C:/…` and UNC both fail `is_file`, so a valid pasted image URL is treated as text | `engine/.../clipboard_image.rs:84` | 88 |

### Pre-existing — inherited from upstream, made routine by this port

| finding | file | conf | disposition |
|---|---|---|---|
| `EPERM` treated as a dead profile owner; on Windows that is what probing a higher-integrity browser returns | `browser/src/profile.ts:35` | 95 | fold — fixing it creates a new vendored divergence, which needs a written reason in UPSTREAM.md |
| `app.exit` bypasses the `will-quit` profile-lock cleanup, so the lock survives every foreground close | `browser/src/foreground.ts:65` | 95 | fold — the upstream helper is unchanged but the port's new foreground path is what makes it routine |

### Accepted, with reason

| finding | file | reason |
|---|---|---|
| `TerminalBackend` re-exported with no caller outside tests | `engine/.../lib.rs:92` | Real, and the fix is one line — but `lib.rs` is already a written divergence for other reasons, so dropping the `pub use` does not buy back the divergence it is charged with. Revisit at the next re-vendor. |
| `blame()` duplicated verbatim between `clippy-scope.py` and `fmt-scope.py` | `tools/vendor-check/clippy-scope.py:61` | Accepted for now: two 22-line copies with an identical safety rationale is a genuine hazard, but both scripts are invoked together and a divergence shows up as a scope mismatch in CI. Folded into the same later plan as the other vendor-check work. |
