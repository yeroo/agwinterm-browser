# Windows baseline, measured on the vendored tree

Three measurements taken before anything was ported, so later tasks argue against
numbers rather than recollection. Everything here was run on Windows 11
(10.0.26200), MSVC toolchain, Node v22.19.0, pnpm 10.13.1. `engine/` builds on
rustc 1.93.1 via its pinned `rust-toolchain.toml`; `tools/conpty-probe` has no pin
and builds on the default 1.96.0.

Contents:

1. [Rust — `cargo check --workspace`](#1-rust--cargo-check---workspace)
2. [TypeScript — unix-API disposition](#2-typescript--unix-api-disposition)
3. [ConPTY input fidelity](#3-conpty-input-fidelity)

---

## 1. Rust — `cargo check --workspace`

Run from `engine/` (the workspace root is upstream's, not the repo root).

**41 errors, in 3 files.** The port brief predicted 41; it is 41.

| file | errors (lib) | errors (`--all-targets`) |
|---|---|---|
| `crates/pixel-core/src/terminal.rs` | 37 | 49 |
| `crates/pixel-core/src/ghostty.rs` | 3 | 3 |
| `crates/pixel-core/src/herdr.rs` | 1 | 3 |
| **every other `pixel-core` file (43 of 46)** | **0** | **0** |

By error code (lib):

| code | count | what it is |
|---|---|---|
| `E0433` | 31 | unresolved path — `rustix::{shm,mm,fs,pipe,process,termios}`, `std::os::unix` |
| `E0425` | 4 | `libc::{sigaction, SA_RESTART, SIGWINCH}` |
| `E0599` | 3 | `AsFd for Stdin/File`, `OpenOptions::mode` |
| `E0432` | 1 | `use rustix::termios` |
| `E0308` | 1 | signal-number width |
| `E0282` | 1 | inference that only resolved through a unix type |

`cargo check -p pixel-node` produces **no errors of its own** — it fails only
because `pixel-core` does. `pixel-node`'s real Windows disposition is unknown until
Task 4 unblocks it, and Task 8 is where it gets measured.

**`openh264-sys2 v0.9.7` builds clean under MSVC** (`cargo build -p openh264-sys2`,
exit 0). That was the flagged risk in Task 8's first checkbox; it is not a risk.

### Full error list (lib)

```
herdr.rs:2:14      E0433  could not find `unix` in `os`
terminal.rs:4:13   E0432  unresolved imports `rustix::termios`
ghostty.rs:121:31  E0433  could not find `process` in `rustix`
ghostty.rs:123:21  E0433  could not find `process` in `rustix`
ghostty.rs:123:56  E0433  could not find `process` in `rustix`
terminal.rs:214:53 E0599  `as_fd` on `&Stdin`
terminal.rs:215:43 E0599  `as_fd` on `&File`
terminal.rs:354:13 E0282  type annotations needed
terminal.rs:505:25 E0433  `rustix::shm`
terminal.rs:544:25 E0433  `rustix::shm`
terminal.rs:770:32 E0433  `rustix::pipe`
terminal.rs:771:17 E0433  `rustix::fs`      (x2 on this line)
terminal.rs:772:17 E0433  `rustix::fs`      (x2 on this line)
terminal.rs:785:46 E0308  expected `i32`, found `u64`
terminal.rs:787:35 E0425  `libc::sigaction` (type)
terminal.rs:789:37 E0425  `libc::SA_RESTART`
terminal.rs:790:22 E0425  `libc::sigaction` (fn)
terminal.rs:790:38 E0425  `libc::SIGWINCH`
terminal.rs:1158:22 E0433 could not find `unix` in `os`
terminal.rs:1161:14 E0599 `OpenOptions::mode`
terminal.rs:1166-1235  E0433 x19  `rustix::{fs,mm,shm}` — the frame-transport block
```

`--all-targets` adds 14 more, all inside `#[cfg(test)]` blocks in the same three
files: `terminal.rs:1956-1976` (shm round-trip tests), `terminal.rs:2492-2508`
(`libc::openpty`, `File::from_raw_fd`), `herdr.rs:308-316`.

### What this means for the task list

Every error is inside the code Task 4 gates. Nothing in the compositor, layout,
text, scroll, selection or tree modules fails. The line ranges line up with the
plan: `terminal.rs:4` and `193–1250` are the tty and frame-transport code, and
**not one error falls in `terminal.rs:1251–1909`** — the decoder Task 5 reuses.

`tools/vendor-check/inventory.test.mjs` asserts that split still holds after any
re-vendor.

---

## 2. TypeScript — unix-API disposition

The Rust measurement covered the least risky layer. This is the same pass over
`browser/`, `cli/`, `store/`, `terminals/` and the JS build scripts — 27 files
carry a platform-specific reference. Ranked by what it costs to port.

### Blocking — no Windows analogue, needs a decision

| file:line | what | disposition |
|---|---|---|
| `cli/src/main.ts:109` | `["/bin/sh", "-c", line]` launch | Task 9 — spawn without a shell |
| `cli/src/main.ts:61-77` | `ELECTRON_DEV_BIN` with no `.exe`, darwin/other only | Task 9 |
| `cli/src/main.ts:125` | `out.startsWith("/dev/")` — tty by path | Task 2; this is the daemon handoff that has no Windows form |
| `cli/src/main.ts:155` | `spawn(..., { detached: true, stdio: "ignore" })` | Task 2 |
| `terminals/src/shared.ts:25` | `/dev/${tty}` from `ps` | Task 2/13 |
| `store/src/paths.ts:48` | `DAEMON_SOCKET` = `…/daemon.sock` | Task 13 — named pipe |
| `browser/src/registry.ts:52-57,92` | per-instance `.sock` + `fs.rmSync` cleanup | Task 13 — the *second* socket protocol |
| `browser/src/daemon.ts:66,157` | `net.createServer`/`connect` on a path | Task 13 |
| `cli/src/control.ts:9`, `cli/src/main.ts:147` | `net.connect(socketPath)` | Task 13 |
| `store/src/schema.ts:7` | `socket` column persists a path | Task 13 |
| `store/src/instances.ts:39` | `fs.rmSync(row.socket)` — stale cleanup with no named-pipe analogue | Task 13 |
| `engine/packages/pixel-react/scripts/build-native.mjs:9` | `libpixel_node.dylib` / `.so`, no `.dll` | Task 8 |

### Blocking — drop or stub, not port

| file | what | disposition |
|---|---|---|
| `cli/src/sandbox.ts` (13 refs) | apparmor profile, `/proc/sys/kernel/...`, `process.getuid`, `execFileSync("bash", …)` | Task 13 — stub with an explicit "not supported on Windows" |
| `cli/src/upgrade.ts:63` | `spawn("bash", ["-c", "curl … \| bash"])` | Task 13 — port, stub or drop; record which |
| `cli/src/ssh.ts:85,198,306,388` | `$SHELL`, `XDG_DATA_HOME` remote paths, `/tmp/tb-ssh` with `mode: 0o700` | Task 13 |
| `browser/src/record/paths.ts:5` | `OUTPUT_ROOT = "/tmp/recordings"` | Task 13 — an absolute POSIX path |

### Conventions — mechanical, but wrong output if skipped

| file | what | disposition |
|---|---|---|
| `store/src/paths.ts:14-18` | `XDG_DATA_HOME`/`STATE`/`CACHE`/`RUNTIME` with `~/.local/...` fallbacks | Task 13 — `%LOCALAPPDATA%`/`%APPDATA%` |
| `cli/src/editors.ts:18-20,208` | `XDG_CONFIG_HOME`, `fs.chmodSync(…, mode)` | Task 13 |

### Signals — present, and mostly fine

`cli/src/main.ts` listens for `SIGWINCH` (:313), `SIGINT`/`SIGTERM`/`SIGHUP`
(:326-328, :348) and sends `SIGTERM` (:294); `browser/src/daemon.ts:63-64` and
`terminals/src/applescript.ts:8` do the same. Node on Windows emulates `SIGINT`
and `SIGTERM`; `SIGHUP` and `SIGWINCH` never fire. Console resize therefore needs
a poll or a wait on the screen-buffer handle — Task 5's "no `SIGWINCH`" checkbox.

### Already branched, only missing a Windows arm

`browser/src/page/offscreen.ts:4-23` picks `shared-texture` on darwin, `shm` on
linux, `bitmap` otherwise — **Windows already falls through to the stock-Electron
path** (Task 9 confirms rather than builds it). `browser/src/session/keybindings.ts`,
`browser/src/page/input.ts` and `browser/src/session/session.tsx` branch
darwin-vs-linux for modifiers, editing commands and wheel detents; Windows takes
the non-darwin arm today, which is right for Ctrl but leaves the linux-only
`ctrl+q` affordances unreachable (Task 11).

### ⚠️ The vendored tree is not `cargo fmt --check` clean

`cargo fmt --all --check` in `engine/` reports **172 diffs across 30 files**, most
of them in the 43 modules this port must leave unchanged (`canvas.rs`, `paint.rs`,
`tree/`, `selection/`, `pixel-node/*`, …). Upstream's own `justfile` runs the same
check in `just lint`, and upstream pins the toolchain that produces these diffs
(`rust-toolchain.toml` → 1.93.1, rustfmt 1.8.0), so this is not a toolchain
mismatch on our side. `--style-edition=2021` and `=2018` are worse, not better
(193 diffs each).

This collides with two rules at once: the Development Approach makes
`cargo fmt --check` part of "tests pass", and the Constraints forbid touching the
43 keep-unchanged files. **Reformatting them would be exactly the silent edit the
plan prohibits**, and it would destroy the `git diff`-against-baseline check that
Task 14 relies on to prove they are unchanged.

Disposition: `cargo fmt --all --check` applies to **code this port writes**, not to
the vendored tree. `tools/conpty-probe` is fmt-clean and stays that way. Task 14's
formatting check should be scoped accordingly. Recorded in the plan under Task 1.

### Vendored test baseline

`pnpm --filter pixel-terminals test`: **28 of 29 pass**.

The failure is `herdr falls back when the running herdr predates --right-click`
(`terminals/test/terminals.test.js:102`). It is **not** a Windows problem:
`terminals/src/terminals/herdr.ts:45` appends `--right-click pane` unconditionally
and has no fallback, so the test asserts behaviour the vendored source does not
implement. Pre-existing upstream breakage, recorded here so Task 13 does not read
it as damage this port caused.

---

## 3. ConPTY input fidelity

**Every sequence the decoder needs survives a ConPTY verbatim.** No loss, no
rewriting, no `INPUT_RECORD` round-trip damage.

Measured by `tools/conpty-probe`, which creates a real 200×40 pseudoconsole, spawns
a child into it, writes bytes into the pty's input pipe, and records what the child
reads. Reproduce with `cargo run` in `tools/conpty-probe`; `cargo test` asserts the
same results.

```
case                   mouse      sent            received        verdict
plain-ascii            requested  abc             abc             verbatim
arrow-up               requested  \e[A            \e[A            verbatim
sgr-mouse-press        requested  \e[<0;12;5M     \e[<0;12;5M     verbatim
sgr-mouse-release      requested  \e[<0;12;5m     \e[<0;12;5m     verbatim
sgr-mouse-drag         requested  \e[<32;13;5M    \e[<32;13;5M    verbatim
sgr-mouse-no-decset    not set    \e[<0;12;5M     \e[<0;12;5M     verbatim
csi-u-plain            requested  \e[97u          \e[97u          verbatim
csi-u-mods             requested  \e[97;6u        \e[97;6u        verbatim
csi-modified-arrow     requested  \e[1;5A         \e[1;5A         verbatim
```

The tests add two more: three-digit coordinates (`\e[<0;198;39M`) and a four-sequence
burst in one write, both verbatim and in order.

### What this settles

- **Task 11's fallback is not needed.** The plan's "if CSI-u forms did not survive,
  that is the cause" branch can be closed: they survive. `parse_kitty_keyboard` and
  `parse_sgr_mouse` can be fed pty bytes directly.
- **Task 5 can reuse the decoder unmodified.** No translation shim between conhost
  and `terminal.rs:1251-1909`.
- The `?1006` DECSET handshake does not gate *delivery* — mouse bytes arrive even
  when the client never requested mouse reporting. The handshake still matters, but
  as a signal to the host about what to send, not as a filter conhost enforces.

### ➕ A finding Task 5 needs, discovered building the probe

**A ConPTY child's std handles can be `NUL`, not its console.** Under the harness,
the child's `GetStdHandle(STD_INPUT_HANDLE)` returned a handle that
`GetFileType` reports as `FILE_TYPE_CHAR` — but every console API on it failed with
`ERROR_INVALID_HANDLE`, and `GetConsoleScreenBufferInfo` reported 0×0. The process
looked console-less while actually being attached to the pty.

Opening `CONIN$`/`CONOUT$` with `CreateFileW` instead returned the real console
immediately: 200×40, the harness's own size, and every read worked.

So the Windows backend must **open the console by name, not trust fd 0** — the
direct analogue of upstream opening `/dev/tty` rather than using stdin
(`terminal.rs:193-1250` does exactly this on unix). Had this been discovered in
Task 5 rather than here, it would have looked like "ConPTY drops all input".

This is why the first probe run reported every sequence as `DROPPED`, including the
plain-ASCII control. The control is what caught it.
