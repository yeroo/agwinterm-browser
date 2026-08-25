# Review: ralphex-20260822-post-port-corrections / 20260825-172421

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260822-post-port-corrections\20260825-172421\input\scope.md`

## Minor

### The removed early return in `terminateTree`'s catch is pinned by no test

`cli/src/main.ts:388-402`

The `catch` was changed from `return` to `child.kill()` plus fall-through to `await Promise.race([dead, 1s])`. That is the substantive behavioural fix of this round, and the invariant it establishes — a failed or timed-out `taskkill` must still get a second route and must still be awaited before the caller retires the frame and cooks the console — is enforced by nothing.

`tools/cli/pane-clear.test.mjs` pins every neighbouring property of this same function by source-scraping the identical slice: `taskkill` is asked for `/T` (line 414), for `/F` (415), is bounded by `TASKKILL_TIMEOUT_MS` (431), the named constant (436), and the kill-before-clear ordering (402). Searching for `terminateTree` across the repo returns only that file (lines 399, 410, 426), and neither `child.kill` nor `catch` appears anywhere in it; `tools/acceptance/pane-clear.test.mjs` uses `taskkill` only as a tool to kill a process and never exercises this helper.

Failure case: a future edit restores `catch { return }` — the shape the function had until this round, and the shape a reader trimming a swallowing catch would reach for. The full suite still passes green, because `/T`, `/F` and the timeout are all still present. The pane is then back to the state the previous round diagnosed: `taskkill` times out with the tree alive, `terminateTree` reports a still-live browser as stopped, `openInForeground` proceeds to `clearOwnedPaneFrame` and `restorePaneConsole`, the CLI exits, and libuv's job object takes the browser down after both the evidence and the repair are gone.

The other three code fixes in this same round each got a pinning test (the drive-qualified `%SystemRoot%` regex at pane-clear.test.mjs:534, both `~` separators at clipboard_image.rs:400, `\AppData\Local` and the share at endpoint.test.mjs:132/149). This one is the exception, and the project profile names "missing tests for a code path the change introduced" as reportable.

Fix: Add a source-reading test beside the existing ones in `tools/cli/pane-clear.test.mjs`, over the same `terminateTree` slice already extracted at line 425: assert the `catch` body reaches `child.kill()`, and that `Promise.race` appears after the `catch` — i.e. no bare `return` sits between the failure path and the wait.

_confidence: 99 | sources: bugs+impl, arch+quality, docs+tests | lenses: impl, architecture, tests | verdict: confirmed_

## Pre-existing

### `restorePaneConsole` still cooks the console on a spawn that never produced a process

`cli/src/main.ts:564`

The change did not introduce this — it touched the comment above the call, not the call itself. The newly written justification is what makes it worth naming now.

The comment at main.ts:551-563 defends the unconditional call on the grounds that "nothing here can tell the two exits apart — `clearOwnedPaneFrame`'s evidence is a frame directory, and a browser can set the modes and die before its first frame." That reasoning is correct for the two exits it names. It does not cover a third, and the code twelve lines above already knows about it: main.ts:539-543 documents that "a spawn that failed outright leaves `child.pid` undefined", and passes exactly that to `clearOwnedPaneFrame` so the frame half asks nothing.

Failure case: `terminal-browser open https://example.com` with a missing or unrunnable Electron binary. Node's `spawn` does not throw here — it returns a `ChildProcess` with `pid === undefined` and emits `error` asynchronously, so main.ts:467's handler writes "could not start …", sets `running = false`, and resolves `exited` with 1. `terminateTree` is skipped, `clearOwnedPaneFrame` correctly no-ops on the undefined pid — and then `restorePaneConsole()` runs, `process.stdin.isTTY` is true in a pane, and `cookConsoleModes` spawns `cmd.exe /c exit` against a console no engine ever touched. Per this file's own measurement (mode 999), that turns `ENABLE_QUICK_EDIT_MODE` back on and clears `ENABLE_MOUSE_INPUT` and `ENABLE_WINDOW_INPUT`. A user whose install is broken loses their console's non-default input bits as collateral of an error message.

Small in blast radius, and the author's recorded trade ("a console at cmd's default is one every shell is happy in") arguably covers it. But it is the one case where the gating question the comment says does not exist does exist, and it is the same expression the line above already reads.

Fix: Either gate the modes half on the evidence already in hand — `if (child.pid !== undefined) restorePaneConsole(); else restorePaneConsole(process.stdout, { isTTY: false })`, or an explicit option — or extend the comment at main.ts:557-563 to say that the never-started exit is knowingly included, so the next reader does not have to re-derive that `child.pid` was available and unused.

_confidence: 85 | sources: bugs+impl | lenses: bugs, impl_

## Immaterial

### Home expansion validates only the suffix, not the expanded path

`engine/crates/pixel-core/src/clipboard_image.rs:115`

On Windows, if `USERPROFILE` is a UNC path such as `\\profiles\users\ada`, pasting `~\Pictures\a.png` passes `under_home` because only `Pictures\a.png` is checked. Joining it to the home directory produces a UNC path, and the subsequent `is_file()` performs the synchronous SMB probe that `looks_absolute` and the documented "no share is opened" contract are intended to prevent. This change newly exposes the backslash spelling; the same defect was pre-existing for `~/Pictures/a.png`. The trigger requires a redirected or custom UNC `USERPROFILE`, so the impact is contained to that unusual configuration.

Fix: After expansion, reapply the local-path/UNC check to the complete joined path, or reject a UNC `home_dir()` on Windows before joining.

_confidence: 90 | sources: adversarial | lenses: adversarial | verdict: immaterial_

### The UNC prefix check accepts a server name without a share

`store/src/paths.ts:90`

The new regex accepts any value beginning with two separators and one non-separator, including an incomplete UNC value such as `\\srv`. `appPaths` then joins the application name onto it, turning that application name into the share component (`\\srv\terminal-browser-…\data`) instead of rejecting the malformed `LOCALAPPDATA` and using the profile fallback. Startup can consequently attempt an unintended network connection, fail while creating the data directory, or use a coincidentally matching remote share. This incomplete-UNC case was also accepted by the previous `path.win32.isAbsolute` check, so the behaviour is not new, but the touched validation now explicitly claims that only a real `\\server\share` is accepted.

Fix: Require both non-empty server and share components when recognizing UNC roots; otherwise use the profile-derived fallback.

_confidence: 85 | sources: adversarial | lenses: adversarial | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 2659056 | 2 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 2205921 | 2 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 1802280 | 3 | ok |
| adversarial | codex | gpt-5.6-sol | high | 89870 | 2 | ok |
