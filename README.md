# winterm-browser

A real Chromium browser rendered inside a Windows terminal pane — a Windows-native port of
[zenbu-labs/terminal-browser](https://github.com/zenbu-labs/terminal-browser), hosted by
[agwinterm](https://github.com/) rather than a Kitty-graphics-over-stdout terminal.

Upstream is macOS/Linux only, for two independent reasons: its Rust engine does not compile on
Windows (41 errors, unconditional `termios`/`shm`/`UnixStream` use), and its transport — Kitty
graphics APC escapes written to stdout — is stripped by ConPTY before any Windows emulator sees it.
Both are covered in [`docs/design/00-port-brief.md`](docs/design/00-port-brief.md).

So the port keeps upstream's Electron browser and TypeScript CLI, drops the `pixel-core` terminal
engine entirely, and lets agwinterm be the compositor: Electron's offscreen paint buffer travels
through a shared-memory ring to agwinterm's control pipe, and agwinterm places it as a Kitty image
scaled to the cell grid.

**WSL is out of scope.** This is a Windows-native port.

## How this project is built

| role | tool |
|---|---|
| planning + implementation | [ralphex](https://github.com/) — plans in `docs/plans/`, executed autonomously |
| review | [revmux](https://github.com/umputun/revmux) — every plan and every diff, before acceptance |

`.revmux/` is committed: the lenses, profiles and severity bar are this project's versioned review
standard, not one maintainer's habits. Note that a checked-in lens is executed by a headless agent
with a shell — read it like you would read a `Makefile`.

## Status

Design brief and implementation plan written, reviewed by a revmux triage panel, and revised.
The review report is at `.revmux/tasks/plan-windows-port/01-initial/report.md`.
Implementation has not started.
