# Item under review: the winterm-browser Windows port, as built

The complete implementation of `docs/plans/20260821-windows-port.md` — 15 tasks, executed
autonomously by ralphex over 2026-08-21, plus the six follow-up fix commits its internal
reviewer produced.

## The diff

Run this yourself; it is the change under review:

```
git diff 45b5e43..HEAD
```

**113 files changed, 19,472 insertions, 938 deletions** — engine 17, browser 13, cli 12,
store 11, tools 38, docs 17.

`45b5e43` is the vendoring commit: it imported upstream terminal-browser wholesale (239 files,
54,844 lines). Everything before it is planning documents. Everything after it is this port's
own work, which is why the base sits there and not at the repository root. Upstream code that
`45b5e43` introduced is **not** under review except where a later commit modified it.

Useful shapes of the same diff:

```
git log --oneline 45b5e43..HEAD          # the 15 tasks, one commit each, then 6 fix commits
git diff --stat 45b5e43..HEAD
git show <commit>                        # a single task in isolation
```

## What this is

Upstream [zenbu-labs/terminal-browser](https://github.com/zenbu-labs/terminal-browser) renders a
Chromium browser inside a terminal pane via the Kitty graphics protocol. This port makes it run
natively on Windows inside the agwinterm terminal. No WSL.

The architectural bet: keep `pixel-core` and replace only its tty layer. 64 of 68 unix-API
references lived in `pixel-core/src/terminal.rs`; 19 of 22 modules had none. So the
compositor/layout/text stack ports unchanged and the browser chrome, which renders through it via
`pixel-react`, is untouched.

Two consequences shape most of the diff:

- **ConPTY strips the Kitty APC escapes** upstream writes to stdout, so frames travel out-of-band
  through agwinterm's control pipe instead — file-based first, then a shared-memory fast path.
- **Upstream's fast frame paths need an Electron fork** it builds itself (macOS/Linux only). This
  port uses the stock-Electron `presentBitmap` path instead.

## Where to verify claims

- **Upstream, read-only:** `.reference/terminal-browser/` in this repository. This is the code the
  port started from; diffing a ported file against its upstream original is often the fastest way
  to see what changed and what was dropped.
- **The host terminal:** `C:\Users\boris\source\agwinterm` — C# source. The control-pipe protocol
  this port speaks is defined there (`ControlServer.cs`), and the shared-memory frame command it
  depends on was added there. A mismatch between what this port sends and what that accepts is a
  real finding.
- **Design record:** `docs/design/` — the brief, the frame budget, the process model, the
  acceptance criteria, and `07-as-built.md`, which records where the build diverged from the plan.

## Already established — do not spend effort re-checking, do challenge if wrong

- `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`,
  `cargo nextest run --workspace` and `node --test` all pass on this tree. Do not run them.
- Windows 11 10.0.26200, agwinterm 0.17.2, Go 1.26.1, cargo 1.96.0, Node v22.19.0.
- WSL is not installed and is out of scope. A finding that recommends it is not useful.
- A browser was observed on screen, interactive, so the happy path demonstrably works.

## Four defects already known — do not re-report these as new

They are already planned in `docs/plans/20260822-post-port-corrections.md`:

1. Pane recovery (`clearPaneFrame` / `restorePaneConsole`) exists only on the CLI's own exit path,
   so a killed browser leaves a painted frame and live SGR mouse reporting in the user's shell.
2. The engine falls back to the `"agwinterm"` production pipe with nothing guarding the target
   instance, so a dev build publishes into the user's real terminal.
3. `tools/cli/registry.test.mjs` waits on a named-pipe connection with no timeout and hung
   `pnpm test` for 18 hours.
4. This review never ran, which is why you are being asked for it now.

Evidence that *deepens* one of these — a second code path with the same defect, a case the planned
fix will not cover — is valuable. A restatement of the four is not.
