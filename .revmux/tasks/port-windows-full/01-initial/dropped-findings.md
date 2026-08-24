# Findings dropped at synthesis

`stages/` is gitignored, so without this file these would exist nowhere in the record and the
corrections plan's "do not silently drop any" would be violated by the tooling rather than by a
decision.

19 findings were raised and 11 survived synthesis. One of the eight cut (`EPERM is treated as a
dead profile owner`) re-entered the report as pre-existing, so these **seven** are the ones that
would otherwise have no record at all. They are reproduced verbatim from `stages/1-found.json` —
body, location, confidence and proposed fix as the finder wrote them.

Synthesis appears to have applied `input/scope.md`'s "four defects already known — do not re-report"
instruction to findings that were *adjacent* to the known set rather than restatements of it. The
scope asked for exactly that adjacency: "a second code path with the same defect, a case the planned
fix will not cover." Three of the seven are that, and are dispositioned in `../task.md` as changes to
tasks already written in `docs/plans/20260822-post-port-corrections.md`.

---

## 1. openInForeground clears the pane unconditionally, including when the browser never placed a frame
`cli/src/main.ts:484`

_confidence: 65 | lenses: bugs, impl_

`openInForeground` sends `image.clear` on every exit path, with no test for whether this browser ever placed anything. The engine deliberately does the opposite: `FramePublisher::clear` (engine/crates/pixel-core/src/frame_file.rs:485-491) returns early when `written` is empty, and its doc comment gives the reason — "A publisher that never published has nothing to take back, and asking anyway would clear a placement some *other* process owns." The CLI half of the same recovery mechanism has no equivalent guard.

Concrete failure: a pane is displaying an image placed by something else (an `agwintermctl image.frame` from a viewer script, or an earlier tool). The user runs `terminal-browser open`. Electron fails to start — `spawn` reports ENOENT/EACCES asynchronously, so `child.on("error")` at cli/src/main.ts:466 resolves the race with 1 and `running` is false — or it starts and the engine cannot reach the host at all (`Terminal::host` latches `host_absent` and `draw` returns NotConnected), so no frame is ever published. Control still falls through to line 484, `paneClearRequest` builds a valid request from `AGWINTERM_ENABLED`/`AGWINTERM_SESSION_ID`, and `image.clear` wipes the pane's existing placement — one this process never made.

This is not the known defect #1 (recovery missing on other exit paths); it is the inverse, on the one path that does run. `docs/plans/20260822-post-port-corrections.md` Task 1 will make the same unguarded call reachable as a user-invoked `pane-clear` verb, where clearing unconditionally is correct — but that does not fix the automatic call here.

The adjacent `restorePaneConsole()` at line 490 is fine unconditionally: mode resets are idempotent and its doc says so. `image.clear` is not idempotent with respect to a placement someone else owns.

**Fix:** Only send the clear when this invocation could have drawn. The cheapest signal available to the CLI is whether the child ever ran: skip `clearPaneFrame` when the race resolved through `child.on("error")` (spawn never produced a process). For the engine-never-drew case, mirror the engine's own rule rather than guessing — e.g. have the browser touch a per-session marker on its first successful publish, or accept the narrower spawn-failure guard and note the remaining case.

---

## 2. The CLI repeats the engine's unguarded fallback to the production "agwinterm" pipe
`cli/src/pane.ts:58`

_confidence: 60 | lenses: impl_

Deepening evidence for known defect #2, not a restatement of it. `paneClearRequest` resolves its target with `nonempty(env, "AGWINTERM_PIPE") ?? DEFAULT_PIPE` where `DEFAULT_PIPE = "agwinterm"` — the production instance — with nothing guarding which instance is being addressed. This is a second, independent copy of the constant and the fallback, in a module that deliberately imports nothing from the workspace ("kept apart from `main.ts` ... so the addressing rules can be tested without a pane") and therefore cannot pick up a guard added elsewhere.

`docs/plans/20260822-post-port-corrections.md` scopes Task 2 to the engine only: its evidence row names `engine/crates/pixel-core/src/agwinterm.rs:57` and nothing else, and its checklist items are "the guard refusing an unlisted pipe under a dev build" / "release builds being unaffected" — both phrased around the publish path. As written, the plan closes the engine's fallback and leaves this one open.

Concrete failure after Task 2 lands: a dev build is launched from a pane of the *real* agwinterm with `AGWINTERM_PIPE` unset — exactly the configuration that produced the observed 18-hour incident. The engine now refuses to publish, so nothing is painted. On exit, `openInForeground` still calls `clearPaneFrame(process.env)`, which dials `\\.\pipe\agwinterm` and sends `image.clear` against the production instance's pane. The dev-build guard is bypassed by the recovery half of the same feature.

Severity is minor because `image.clear` against a pane that holds nothing is harmless; it becomes real only when combined with the finding above (a placement the browser did not make).

**Fix:** Route the CLI's pipe resolution through the same guard Task 2 adds for the engine, and add a checklist item to Task 2 naming `cli/src/pane.ts` alongside `agwinterm.rs`. `pane.ts`'s no-workspace-imports constraint means the guard has to be duplicated there the way the addressing rules already are — `tools/cli/unsupported.test.mjs` already drives one shared table through both sides and can cover this too.

---

## 3. The "one rule for what counts as a pane" is still three rules, and they disagree on AGWINTERM_PIPE
`cli/src/unsupported.ts:115`

_confidence: 75 | lenses: architecture, quality_

`inAgwintermPane` (cli/src/unsupported.ts:115-120) documents itself as "the one rule ... shared by everything that asks" and says "There were three, and they disagreed. This one is the engine's." It is not the engine's. The engine additionally validates the pipe name: `HostTarget::from_env` refuses the pane unless `valid_pipe_name` holds (engine/crates/pixel-core/src/agwinterm.rs:154, 190-195), which permits only `[A-Za-z0-9._-]`. The third reader, `paneClearRequest` (cli/src/pane.ts:99), rejects only `[\\/]`. `inAgwintermPane` checks the pipe not at all.

Failure: a pane whose host sets `AGWINTERM_ENABLED=1`, `AGWINTERM_SESSION_ID=s1`, `AGWINTERM_PIPE=agwinterm 2` (any character outside the engine's set — a space, a colon, non-ASCII). `windowsHostRefusal` returns null, so `requireGraphics` (cli/src/main.ts:675) lets the command through and `openInForeground` spawns the browser. Inside it, `Terminal::host()` calls `ControlClient::from_env`, `valid_pipe_name` fails, `host_absent` latches, and `Terminal::draw` returns `Err(NotConnected)` (terminal_windows.rs:1171-1178). Per the port's own written claim in two places (agwinterm.rs:71-72 and terminal_windows.rs:1561-1566), an `Err` out of `draw` propagates through `Engine::pump` and pixel-node treats it as a fatal engine exit. The result is a browser that starts and shows nothing — the exact outcome the `"active"` clause of this same function exists to prevent, reached by a different input.

The shared-rule test cannot see this: `HOST_CASES` (tools/cli/unsupported.test.mjs:175-191) contains eleven env shapes and not one of them sets `AGWINTERM_PIPE`, so the two readers it drives agree vacuously on the axis where they differ.

**Fix:** Give `inAgwintermPane` the engine's pipe-name check (`/^[A-Za-z0-9._-]+$/` on `AGWINTERM_PIPE` when set), tighten `paneClearRequest`'s `/[\\/]/` test to the same set, and add `AGWINTERM_PIPE` rows to `HOST_CASES` so the three readers are pinned on that axis too.

---

## 4. Milestone runner's header still says the CLI "only spawns the daemon"
`tools/milestone/run-milestone.cmd:4`

_confidence: 78 | lenses: comments, docs_

The file's header comment reads:

```
rem Not a product entry point -- `cli/src/main.ts` is, and it still only spawns the
rem daemon (Task 13). This is the smallest thing that exercises the whole Windows
rem path end to end: Electron OSR -> pixel-core composite -> frame_file -> image.frame.
```

That was true when Task 10 wrote it. Task 13 (`736eb1a`) shipped `openInForeground` in `cli/src/main.ts` — the foreground wait, `terminateTree`, the `FOREGROUND_SIGNALS` registration, `clearPaneFrame` and `restorePaneConsole`, all of which `tools/cli/pane-clear.test.mjs:224-298` pins by reading that same function out of `main.ts`. The "(Task 13)" parenthetical reads as a forward reference to work that has since landed, and the sentence describes behaviour the CLI no longer has.

Failure case: this script is the documented bring-up path (`docs/design/02-frame-budget.md` measures against it, and `tools/milestone/startup.test.mjs:116-127` asserts it stays wired). Someone reproducing the frame-budget numbers reads this header, concludes `node cli\dist\main.js <url>` cannot drive a foreground browser, and keeps using the raw-Electron runner where the README's supported invocation would now do — measuring a path that skips the CLI's console and pane handling entirely.

**Fix:** Update to something like: "Not a product entry point -- `cli/src/main.ts` is, since Task 13. This is the smallest thing that exercises the whole Windows path end to end, with no CLI in the way."

---

## 5. "Exactly the ones the parser accepts" checks one direction; its own comment claims both
`tools/docs-check/docs.test.mjs:133`

_confidence: 75 | lenses: tests, comments_

The doc comment above the test states the contract explicitly: "Both directions matter: a value the docs promise must be accepted, and a value the parser accepts must be documented, or the doc's table quietly becomes a subset."

The body implements only the second direction. It extracts `accepted` from `frame_shm.rs`'s `parse` body — `{auto, default, file, png, image.frame, shm, frameshm, image.frameshm}` — then loops `for (const value of accepted)` asserting the as-built table mentions it. The first direction is covered only by the hardcoded `assert.ok(accepted.has("auto") && accepted.has("file") && accepted.has("shm"))` on line 143, which pins the three canonical values and none of the five aliases.

Failure case: drop `"png"` (or `"image.frame"`, `"default"`, `"frameshm"`, `"image.frameshm"`) from `Transport::parse` at `frame_shm.rs:93-100`. The alias row in `07-as-built.md:73-77` — "`file` | `png`, `image.frame`" — becomes a promise the parser no longer honours, a user setting `TERMINAL_BROWSER_FRAME_TRANSPORT=png` silently gets `auto` with a "names no transport" warning, and this test, whose entire purpose is to catch a doc that stopped being true, stays green. That is precisely the "prose does not fail when the code moves" failure the file's header says it exists to prevent.

**Fix:** Add the reverse loop: parse the alias cells out of the `### How to force either` table and assert each backticked value is in `accepted`.

---

## 6. The napi-module suite skips on a missing artifact and never checks it is current
`tools/vendor-check/native-build.test.mjs:74`

_confidence: 58 | lenses: tests_

```js
const built = fs.existsSync(ARTIFACT);
const skip = built ? false : "engine/packages/pixel-react/native/pixel.node is not built";
```

Three tests — that `pixel.node` is this platform's image, that it loads and exports all seven symbols, and that the C-backed tree-sitter and pulldown-cmark halves actually run under MSVC — degrade to a skip when the artifact is absent, and there is no staleness check at all when it is present.

This is the opposite of the rule the tree states for itself two directories over. `tools/lib/built.mjs` exists precisely to make both cases loud: it throws on a missing `dist/` and throws again when `dist/` is older than `src/`, with the comment "a stale `dist/` is worse, because everything passes — against yesterday's source. That is precisely the failure the whole `tools/vendor-check/` suite exists to prevent." `endpoint.test.mjs:31`, `store.test.mjs:39` and `registry.test.mjs:32` all call it. `entry.test.mjs:144` likewise hard-fails on a missing `electron.exe` rather than skipping. This file is the outlier, and it guards the artifact the project profile singles out — "MSBuild silently serves stale DLLs in several documented ways. 'It builds' is not evidence the new code ran."

Failure case: `pixel.node` is a *copy* made by `build-native.mjs`. Edit `engine/crates/pixel-node/src/lib.rs`, run `pnpm test` without rebuilding, and "loads, and exports every symbol pixel-react binds to" passes against the previous DLL. Delete the copy step and the same suite reports three skips inside an otherwise-green run — the exact ENOENT-shaped stall the file's header says it was written to make impossible to rediscover.

**Fix:** Point the artifact check at `requireBuilt(REPO, "engine/packages/pixel-react/native/pixel.node", "engine/crates/pixel-node/src", "corepack pnpm -r build")` so a missing or stale copy fails with the build command instead of skipping.

---

## 7. Module doc states the cell-metrics resolution order backwards
`engine/crates/pixel-core/src/agwinterm.rs:40`

_confidence: 50 | lenses: comments, docs_

The module header summarises `cell_size` as: "the host is asked for [`METRICS_CMD`], an explicit [`CELL_PX_VAR`] overrides it, and the last resort is [`FALLBACK_CELL`]".

The code resolves in the other order. `cell_size` (line 645) returns from `cell_override(env)` at line 646 *before* the client is touched; `client.pane_metrics()` at line 654 is only reached when the variable is unset or unparseable. Both other records of this decision state it the other way round and treat the ordering as load-bearing: `docs/design/07-as-built.md:198-201` — "Three sources in order — `TERMINAL_BROWSER_CELL_PX`, then the host verb, then `(16, 32)` … **The override is first on purpose**: it is … how a user corrects a host that reports the wrong thing after a mixed-DPI move" — and README.md's knobs table, "Consulted before the host, so it also corrects a host that answers wrongly."

"Overrides it" is defensible as a statement about which value wins, which is why my confidence is not higher. But the sequence it describes is not what runs, and the difference is observable: with `TERMINAL_BROWSER_CELL_PX` set, `session.metrics` is never sent, so there is no round trip and no capability latch. A reader debugging why a dev pane shows no `session.metrics` traffic would look for a failed probe rather than a short-circuit.

**Fix:** Reword to match the code and the other two records: "an explicit [`CELL_PX_VAR`] is consulted first, then the host is asked for [`METRICS_CMD`], and the last resort is [`FALLBACK_CELL`] with a warning that names the fix."
