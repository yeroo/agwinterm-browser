# Acceptance — what was checked, how, and what it found

Task 14 of [the port plan](../plans/20260821-windows-port.md). Every criterion below
was run rather than reasoned about, on this machine, on 2026-08-21. Two of them
failed the first time and the fixes are recorded with them; a criterion that passed
only after a change is not a criterion that passed.

The live checks ran against a **Debug agwinterm on its own pipe** (`--app-id
agwinterm-dev`), built from `src/Agwinterm.Win32` and stopped afterwards. The
Constraints forbid testing against the real instance, and every check recorded below
was driven through a pane of the Debug one — created with `agwintermctl --pipe
agwinterm-dev session new` and typed into with `session.type`.

**That is a claim about the checks below, and it was written as a claim about the
run.** It is not one. The morning after, a pane of the *real* instance was found
holding a stale browser frame with SGR mouse reports streaming into its shell prompt,
about eighteen hours after the run ended — so some run during the port did publish
into the real instance, and it is not any of the ones recorded here.

What the state itself narrows it to: mouse reporting is turned on by `ModeGuard`
against the console the engine *attached* to, and the frame was placed on that same
pane, so the engine ran with the real pane's console and inherited its `AGWINTERM_*`
— that is, it was launched from the run's own shell rather than from a pane of the
Debug instance. Nothing else in the port has that shape. The best-supported candidate
in the run log is Task 10's ad-hoc probing between 18:20 and 18:38 on 2026-08-21
("Probe electron env and cell override", "Re-run with correct cell metrics override"),
which ran `electron.exe` through `cmd /c set …` rather than through the dev pane and
ended at "Kill electron and rebuild native" — a force-kill runs no `Drop`, which is
exactly a frame left placed and the reporting modes left on. The log records the
invocation but not its environment, so that last step is a reconstruction; the part
that is not is that a run outside the dev instance happened at all.

The correction is the guard, not the sentence: `TERMINAL_BROWSER_ALLOW_PIPE` (the
corrections plan's Task 2) makes a debug build refuse an instance it was not named
at, so "which pane did that go to" stops depending on remembering. The dev workflow
it belongs to is in [the README](../../README.md#working-on-the-browser).

---

## 1. Every Overview requirement is implemented

| requirement | where it lives | evidence |
|---|---|---|
| a real Chromium browser | stock Electron 43.3.0, OSR | `browser/node_modules/electron/dist/electron.exe`, 348 MB, registry-sourced |
| rendered inside a terminal pane | `frame_file.rs` → `image.frame` → agwinterm | the captures below |
| working keyboard | `terminal_windows.rs` read loop + the inherited decoder | Task 11; Ctrl+Q quits the browser in §4 |
| working mouse | SGR reports through the same decoder | Task 11, at cell resolution (accepted ceiling) |
| stock Electron | no fork, no patch | §2 |
| no WSL | — | §2 |
| split one module | `terminal.rs` → `terminal_types.rs` + the gated tty half + the decoder | Tasks 3–4 |
| port one | `terminal_windows.rs` | Task 5 |
| drop one | `ghostty.rs`, `#[cfg(unix)]` in `lib.rs` | §5 — the file itself is byte-identical |
| keep forty-three | — | §5, and it is now forty and three explained |

The two ceilings the Overview accepts are still ceilings and are still documented:
cell-resolution pointing ([`04-cell-metrics.md`](04-cell-metrics.md)) and unpublished
cell metrics, with `TERMINAL_BROWSER_CELL_PX` as the explicit override.

## 2. No WSL, no patched Electron

- `grep -rniI wsl` over the tree hits documentation only — the brief, the plan, the
  README and this project's own progress log, every one of them saying it is out of
  scope. No script, config or code path.
- `browser/package.json` has **no fork fetch**. Its `postinstall` is
  `node node_modules/electron/install.js` — the stock installer, run explicitly
  because Electron 43 dropped its own build script and would otherwise download
  lazily on first `require`. Divergence 1 in [`UPSTREAM.md`](UPSTREAM.md).
- `pnpm-lock.yaml` resolves `electron@43.3.0` by npm-registry integrity hash. There
  is **no `tarball:` resolution, no non-registry URL, and no `overrides`/`resolutions`
  block** anywhere in the lockfile or the workspace manifests — the three ways a fork
  mirror could enter.
- The installed binary reports `43.3.0` in `dist/version` and `electron/electron` as
  its repository.

## 3. The file-based path carries a frame when the fast one is asked for

Run: `TERMINAL_BROWSER_FRAME_TRANSPORT=shm`, which names `image.frameshm` — a verb
this build does not produce and agwinterm does not answer. The frame must go out
anyway, over `image.frame`, and the reason must be said once rather than per frame.

`tools/milestone/run-fallback.cmd` in a dev pane, with a frame-budget TSV:

```
# seq  canvas      span    bytes     encode_ms  write_ms  publish_ms
0      1920x1280   120x40  2765237   20.21      0.99      10.00
1      1920x1280   120x40  9832498   34.50      3.20      11.51
...
```

Eleven rows. `publish_ms` **is** the `image.frame` round trip, so a row is a frame
that went out over the file path. On screen:

![the page, with the fast path requested](img/14-file-fallback-shm-requested.png)

Pinned by `frame_file.rs`'s `asking_for_the_fast_path_still_publishes_over_the_file_one`
and `the_unavailable_fast_path_is_said_once_and_not_per_frame`.

➕ **A test-isolation bug surfaced here.** The transport tests share one process-wide
log store behind a mutex, but the mutex was taken only by the tests that *read* it —
and the test that publishes under `shm` *writes* it. Under `cargo test`'s threads its
line landed inside another test's window, failing "the path that exists is never
apologised for" about a warning it never emitted. `cargo nextest` gives each test its
own process and cannot see this class of bug at all; `cargo test` can, which is why
both are run.

## 4. A killed browser leaves the pane usable as a terminal

**This one failed, and the failure was invisible to every check but the eye.**

Force-killing the browser left the shell running and answering — `session.text`
returned its prompt, and typing `echo` into the pane produced output. And none of it
could be read, because the last frame was still on screen over it.

A frame is a **placement**: agwinterm holds the last PNG until something replaces it.
That is the property Task 10 relied on (switching sessions and back costs no repaint)
and it is exactly what makes an exiting browser a problem. Nothing in the port ever
sent `image.clear`.

Fixed in the two places that can, because neither covers the other:

- **`Terminal::drop`** (`terminal_windows.rs`) → `FramePublisher::clear`. Covers an
  ordinary quit and an unwind. A publisher that never published sends nothing — that
  placement belongs to whoever *did* draw it.
- **`clearOwnedPaneFrame`** (`cli/src/pane.ts`), after `openInForeground`'s wait. Covers
  the exits that run no destructor: `taskkill /F`, a crash, a kill from another pane.
  The CLI is the pane's foreground job, so it outlives the browser whenever the browser
  is what died. Best-effort and unable to change the exit code: every failure means the
  placement is gone anyway.

⚠️ **"Whenever the browser is what died" was written as "by construction", and that
was the gap.** Kill the CLI instead and it takes the browser with it, so neither of the
two runs — see the re-check below, and the third path it produced.

Its addressing repeats `HostTarget::from_env`'s rules deliberately — `AGWINTERM_ENABLED`,
session-then-pane id, `"active"` refused, the default pipe name — because the engine
places the frame and the CLI takes it back, and a disagreement would not error, it
would clear someone else's pane.

Both paths verified live:

| | |
|---|---|
| ![after a taskkill /F](img/14-killed-browser-pane-recovers.png) | `taskkill /F` on the browser started by `terminal-browser open`. The picture is gone and the shell echoes. |
| ![after ctrl+q](img/14-clean-quit-pane-recovers.png) | Ctrl+Q, with no CLI in the chain — so this is `Drop` doing it. `[milestone] exit=0` and the scrollback is readable. |

Tests: the ownership rule in `frame_file.rs` — the verb goes out last; a publisher
that never drew clears nothing; one whose first frame was *refused*, or that the host
answered `frame:0/0` for, clears nothing either; a refused clear is still an exit; a
frame nobody placed names no pane — and the whole of `tools/cli/pane-clear.test.mjs`,
driving a real `net.Server` on a real named pipe. The counts live in §6's coverage
table and nowhere else: a second copy here is a second thing to go stale, which is
exactly what happened to the first one.

➕ **Re-checked, harder, on 2026-08-24 — and the first check had the wrong half.**
Force-killing the *browser* is the mild case: the CLI is still there and clears the
frame on its way out. Killing the **CLI** is the one nothing covered, and on Windows it
is not a variant of the other — libuv puts a child spawned without `detached` into a job
object that terminates with its parent, which is exactly how `openInForeground` spawns
("this process is the pane's foreground job"). So one `taskkill /F` on the CLI takes
down *both* cleanup halves at once: `ModeGuard::drop` never runs in the browser and the
CLI's clear never runs either. Measured rather than reasoned about, and it is the
strongest argument for the `pane-clear` verb existing
([the corrections plan](../plans/20260822-post-port-corrections.md), Tasks 1 and 6).
Both cases are now processes rather than eyes: `tools/acceptance/pane-clear.test.mjs`
spawns `node cli/dist/main.js pane-clear` against a real named pipe, with a browser that
is a real process planting a real frame directory and then ended with `taskkill /F`, and
reads what came back.

The other correction the verb forced is upstream of it. `openInForeground` sent
`image.clear` on **every** exit path with no test for whether this browser had ever
drawn — the CLI contradicting the engine's own rule that a publisher which never
published has nothing to take back, because "asking anyway would clear a placement some
*other* process owns" (`frame_file.rs`). A browser that died before its first frame
would have taken down whatever the pane was showing beforehand. It asks now, by pid.

## 5. The keep-unchanged files

Of `pixel-core`'s **46** vendored source files, **4 differ** from the vendoring
commit (`45b5e43`):

| file | why |
|---|---|
| `terminal.rs` | one of the three replaceable modules — the port *is* this diff |
| `lib.rs` | module declarations: six new modules, two `#[cfg(unix)]` gates, one re-export |
| `clipboard_image.rs` | divergence 4 — POSIX path assumptions widened behind `cfg!(windows)` |
| `engine/mod.rs` | divergence 6 — one added `#[test]`, no production line touched |

So of the 43 the plan calls keep-unchanged, **40 are byte-identical** and three have
a written reason. `ghostty.rs` and `herdr.rs` are byte-identical too: "drop one" is a
`#[cfg(unix)]` in `lib.rs`, so both still compile and still run their tests on unix.

⚠️ The plan expected **one** diff here (the Task 3 re-export shim). Task 4 predicted
the list would grow and said why: `inventory.test.mjs` screens for unix *APIs*, and
`clipboard_image.rs` had none while assuming unix *paths* in three places. **"No unix
API" is not "portable."** The two other path-handling files in the 43 —
`image_cache.rs` and `native.rs` — pass their tests today, and that is the only
evidence there is about them.

Now checked by `tools/vendor-check/unchanged.test.mjs`, which fails if the set moves
in either direction and cross-checks that every entry has an `UPSTREAM.md` section.

## 6. Tests, lints and coverage

Re-run on **2026-08-24**, after the six tasks of
[the corrections plan](../plans/20260822-post-port-corrections.md). The numbers this
table carried on 2026-08-21 were 421 / 364+57 / 266, and leaving them would have made
the table a claim about a tree that no longer exists.

| check | result |
|---|---|
| `cargo nextest run --workspace` | **452 passed**, 1 skipped (`bench_encode`, a manual benchmark) |
| `cargo test --workspace` | 395 + 57 passed — run *as well*, because it shares one process and can see races nextest cannot |
| `node --test "tools/*/*.test.mjs"` | **364 passed**, 88 suites, 8.7 s wall clock |
| inherited `pixel-core` tests | the 203 measured at Task 4 are still green, on Windows |
| `cargo clippy --workspace --all-targets` | 12 warnings, **0 on a line this port wrote** |
| `cargo fmt --all --check` | 298 complaints, **0 on a line this port wrote** |

The two lint rows are the scoped scripts below rather than the bare commands, and that
is not a softening: the bare commands cannot be green in this tree and never could —
298 rustfmt complaints and 12 clippy warnings are the *vendored* tree's, and
reformatting it is the silent edit the Constraints forbid. The two scripts under
`tools/vendor-check/` run the real check and `git blame` every complaint.
And a suite that cannot hang is now part of what "passed" means: `--test-timeout` plus
the shared waits in `tools/lib/deadline.mjs` (corrections plan, Task 3).

### The two probe crates are not in this table, on purpose

`tools/conpty-probe` and `tools/console-inherit-probe` are standalone cargo packages
with their own lockfiles, absent from `engine/Cargo.toml`'s workspace members — so
`cargo test --workspace` does not reach their 278 lines of tests, and nothing in CI
does either.

That is deliberate rather than an oversight, but it has a cost worth stating. They
are **one-shot measurements**, not regression tests: they answered "does a ConPTY
child read SGR mouse reports" (Task 1) and "does a GUI-subsystem child inherit its
parent's console" (Task 3), and those answers are what the process model and
`ENABLE_REPORTING` were built on. Adding them to the workspace would mean every
`cargo test` spawning real pseudoconsoles and real child processes, which is slow and
flaky in a way unit tests should not be.

The cost is that a Windows or toolchain change invalidating either measurement is
invisible here. What stands in for them is narrower and cheap: `tools/process-model/
entry.test.mjs` pins `electron.exe`'s PE subsystem, which is the property the
inheritance measurement turns on. Run the probes by hand
(`cd tools/console-inherit-probe && cargo test`) when that pin fails, or when the
foreground shape stops working on a new Windows build.

### Why the two lint checks are scoped, and how the scope is enforced

The vendored tree does not pass either check and never did —
[`01-baseline-errors.md`](01-baseline-errors.md) measured 172 rustfmt hunks at the
baseline, most of them inside the 43. Reformatting them is precisely the silent edit
the Constraints forbid, and it would destroy §5's diff. So the disposition recorded
at Task 1 stands: **these checks apply to code this port writes.**

That is a weaker claim only if it is unenforceable, so it is enforced.
`tools/vendor-check/fmt-scope.py` and `clippy-scope.py` run the real check and
`git blame` every complaint: a complaint on a line written after `45b5e43` fails the
script. Both report zero. rustfmt names the first line of its context rather than the
line it objects to, so the fmt script blames the *removed* lines instead — otherwise a
vendored misformat gets charged to whichever commit added a module declaration near
it, which is how two false positives and two real ones were told apart.

The two real ones were fixed: a stray blank line in `terminal_backend.rs` and another
in the port's `read_exact_at` shim in `capture.rs`.

### Coverage

The project standard is the plan's own: *every task carries new or updated tests, as
separate checklist items, covering success and error scenarios.* There is no coverage
percentage in this repo and inventing one at the last task would be a number rather
than a standard. What is checkable is that every module the port added is tested, and
every one is:

| module | `#[test]`s | | suite | `test()`s |
|---|---|---|---|---|
| `terminal_windows.rs` | 54 | | `cli/pane-clear.test.mjs` | 73 |
| `agwinterm.rs` | 48 | | `vendor-check/inventory.test.mjs` | 37 |
| `frame_file.rs` | 40 | | `cli/endpoint.test.mjs` | 32 |
| `frame_shm.rs` | 10 | | `cli/unsupported.test.mjs` | 30 |
| `terminal_backend.rs` | 9 | | `launcher/launch.test.mjs` | 28 |
| `terminal_types.rs` | 5 | | `input/page-input.test.mjs` | 23 |
| | | | `offscreen/present.test.mjs` | 18 |
| | | | the rest | 123 |

Counted on 2026-08-24; the node column sums to the 364 above. The three biggest
movers since 2026-08-21 are the corrections plan's: `pane-clear.test.mjs` (13 → 73),
`agwinterm.rs` (29 → 48, the exchange deadline) and `terminal_windows.rs` (38 → 54).
The plan and the first review round after it took them to 60, 46 and 53, and the last
five of each are that round's: the frame roots the engine could have chosen, a pid the
caller asked about and does not have, the evidence consumed with the placement it
authorised, and the two ends of the `u32` a Win32 wait must never be given. The five
rounds below carry them the rest of the way.

A second review round moved seven more, and all seven are about the same seam — which
of two panes a wreck on disk belongs to. `frame_file.rs` (32 → 36) gained the pane
marker the engine now writes beside the first frame a host accepts, and the rule that a
*failed* clear leaves its directory standing for the CLI to find; `pane-clear.test.mjs`
(60 → 63) gained the host that answers `ok:false` — bytes on the pipe that are not a
repair — and the wreck belonging to the pane next door.
Two suites in the table did not exist then — `tools/lib/deadline.test.mjs` and
`tools/acceptance/pane-clear.test.mjs` — and are inside "the rest".

A third round moved one more, and it is about what the recovery verb *says*.
`restorePaneConsole` returns both halves now rather than one boolean set from the write
alone, so `pane-clear` no longer reports a console "out of raw mode" on a run where
stdin was redirected and `SetConsoleMode` was never reached — the one wording that sends
a user away from a console that still does not echo. The same round raised the Win32
wait slack in `agwinterm.rs` from 2 ms to one system timer tick, which is what the
deadline test was actually losing to; it needed no new test, only the one it already had
passing forty times out of forty instead of thirty-eight.

A fourth round moved three, and both are about a guard that was asked too late.
`pane-clear.test.mjs` (64 → 66) gained the recycled pid: a directory named after the
process the CLI just spawned, whose `PANE_FILE` marker names a *different* pane, is no
longer adopted by the exit path — a pid is unique among live processes and nothing
more, and `sweep_stale` leaves a wreck standing for an hour. `terminal_windows.rs`
(53 → 54) gained the ordering the dev-instance guard needs: `Terminal::new` asks
`HostTarget::from_env` before `attach_console`, so a refused engine no longer takes the
pane's console, alternate screen and mouse reporting on the way to declining to publish.

A fifth round moved seven, and each is a claim that was true of a narrower case than
the code applied it to. `pane-clear.test.mjs` (66 → 69) gained the pane wrecked
twice — a successful clear now retires *every* directory it would have accepted, because
a pane holds one placement and the older wreck's was replaced long before the run, while
an older marker left standing reads as fresh ownership to the next run — and the two
halves of `clearOwnedPaneFrame` now read the same environment, so a caller that hands
one over is not told "nothing of ours to clear" over roots it never named.
`frame_file.rs` (37 → 39, and the table said 36 for a round) gained `frame:0/0`: an
`ok:true` reply that placed nothing is not a placement, so it neither marks the pane nor
enters `written`. `agwinterm.rs` (46 → 47) gained the peer that drips a byte and never a
newline — past the deadline `millis_until` hands out a fresh millisecond so an in-flight
read can still be cancelled, and `read_line` was going round for another one, so the
only remaining bound on an exchange was `MAX_REPLY_BYTES`. `tools/docs-check` gained the
slug: a heading slugger *stricter* than GitHub's agrees with a broken anchor instead of
failing on it, which is how `05-cli-and-endpoints.md`'s link to the
`TERMINAL_BROWSER_ALLOW_PIPE` section of `07-as-built.md` passed while landing at the
top of the file.

A sixth round moved five, and each is a claim the code makes that nothing was
watching. `pane-clear.test.mjs` (69 → 73) gained the three report branches no test
constructed — the guard refusing a pane that *does* hold a wreck, the same guard with
nothing found, and the escapes that failed while the input modes went back — and
`retire`'s fallback, reached by standing a working directory inside the wreck so
`fs.rmSync` says no: the directory stays, its claim on this pane does not. `frame_file.rs`
(39 → 40) gained the other end of `frame:0/0`, a reply this build cannot parse, which
counts as a placement precisely so a host that grows a field does not quietly cost the
publisher its frames. `agwinterm.rs` (47 → 48) gained `expired` itself, because the
write half of the loop bound has no fixture — a request never fills the pipe buffer —
and `tools/acceptance/pane-clear.test.mjs` gained the stray argument, which is the one
command line the verb does not exit 0 for. The same round scoped the frame roots to the
environment the caller handed over: `os.tmpdir()` answers for this process and no
other, so it is a root only when there is no other environment to answer for.

The stronger claim is the one Task 4 bought: the **203 inherited tests** in
keep-unchanged modules run on Windows and stay green, which is what turns "keep
forty-three unchanged" from a promise into a thing that breaks loudly.

---

## What this run cost, and what it did not check

Two defects found, both by doing rather than reading, and both invisible to the test
suite as it stood: a frame left on a pane after the browser died, and a shared log
store two tests raced over.

Still unchecked, and deliberately: everything under **Post-Completion** in the plan —
real browsing on heavy pages, video, long-running handle and memory counts, several
instances at once, and the judgement call about whether cell-resolution pointing is
merely awkward or disqualifying. Those need a person using it, not a harness.

### What it did not catch, and how that was found out

Four more defects surfaced the next morning, and none of them by re-reading this
document — they came from looking at what the run had left behind on the machine: a
wrecked pane of the *real* instance (the preamble above), three `node` processes wedged
since the evening before, and a review that never started. They became
[the corrections plan](../plans/20260822-post-port-corrections.md): a `pane-clear` verb,
a dev-build pipe guard, bounded waits in the test suite, and a deadline on the engine's
control-pipe exchange. Its Task 6 re-ran the suites and the pane criteria above, which
is where the 2026-08-24 numbers came from.

The last of the four is the one worth carrying: **the review this project is built
around never ran.** `.ralphex/config` pointed at `./tools/ralphex-revmux.cmd`, and
`exec.Command` hands a `.cmd` to cmd.exe, which reads the leading `.` / `/` as a switch
prefix — so the bridge failed to start with a one-line error that scrolled past, and a
review that could not run was indistinguishable from a clean one. All fifteen port tasks
were reviewed only by the internal reviewer. The round finally ran on 2026-08-24 against
the whole port (`.revmux/tasks/port-windows-full/01-initial/`, base `45b5e43`, profile
`comprehensive`): 19 findings, one of them major. That major one became the corrections
plan's Task 5 — an unbounded `read_line` on the control pipe — and the rest were triaged
in the open, into fixes, a **Deferred** section in that plan, and one finding accepted
with a reason. Several of the doc corrections in this file's neighbours are its too.
