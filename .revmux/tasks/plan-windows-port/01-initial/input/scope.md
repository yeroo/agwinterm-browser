# Item under triage: the winterm-browser Windows port plan

Two implementation plans and the design brief they rest on, before any code is written.

## What to read, in this order

1. `docs/design/00-port-brief.md` — the authoritative design. States why upstream cannot run on
   Windows and what the port replaces.
2. `docs/plans/20260821-windows-port.md` — the plan under triage. 13 tasks.
3. `C:\Users\boris\source\agwinterm\docs\plans\20260821-image-frameshm-command.md` — the dependency
   plan, in a **different repository**. 8 tasks. It defines the shared-memory frame command the
   Windows plan consumes at its Task 10.

## What is being proposed

Port [zenbu-labs/terminal-browser](https://github.com/zenbu-labs/terminal-browser) — a Chromium
browser rendered inside a terminal pane via the Kitty graphics protocol — to run natively on Windows
inside the agwinterm terminal. No WSL.

The claim is that this is tractable because:

- The unix dependency in the Rust engine is **concentrated**: 64 of 68 unix-API references live in
  `pixel-core/src/terminal.rs`; `herdr.rs` and `ghostty.rs` have 2 each; the other **19 of 22
  modules have none**. So the compositor/layout/text stack (taffy, tiny-skia, fontdue) ports for
  free, and the browser chrome — which renders through it via `pixel-react` — is untouched.
- Upstream's fast frame paths need an Electron fork upstream builds themselves (macOS/Linux only),
  but `presentBitmap` in `browser/src/page/paint.ts:104` already implements a stock-Electron path
  that should work on Windows unmodified.
- ConPTY strips the Kitty APC escapes upstream writes to stdout, so frames must travel out-of-band
  through agwinterm's control pipe instead. agwinterm already does this for images
  (`ControlServer.cs:249`, `image.frame`), file-based; the plan adds a shared-memory variant for
  video rates.

## Where to verify claims

- Upstream source, read-only: `.reference/terminal-browser/` in this repository.
- agwinterm source: `C:\Users\boris\source\agwinterm`.
- The baseline compile failure is reproducible: `cargo check --workspace` in
  `.reference/terminal-browser/engine/` on Windows produces 41 errors in `pixel-core`.

## Facts already established by direct check on this machine (2026-08-21)

Do not spend effort re-establishing these; do challenge them if you find them wrong.

- Windows 11 10.0.26200; agwinterm 0.17.2 running, `AGWINTERM_ENABLED=1`.
- Go 1.26.1, Rust cargo 1.96.0, Node v22.19.0, both `claude` and `codex` on PATH.
- WSL is **not installed**, and is explicitly out of scope rather than a fallback.
- agwinterm supports SGR mouse (`?1000/?1002/?1003/?1006`) and the kitty keyboard protocol.
- agwinterm's `tests/conformance/control-api.json` is a contract **shared with a second project**
  (agliteterm), which is why the new verb is deliberately kept out of it.
