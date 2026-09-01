# Where the engine process lives on Windows

**Decision: (a) — the engine runs in the foreground process. One browser process per
pane, attached to that pane's console. The daemon is kept in the tree, still entered
by `--daemon`, and is not what the Windows CLI launches.**

This is the port plan's Task 2. It blocks all console work, because Task 5 cannot be
told to "read the console input handle" until something says which process holds one.

## What forced the question

Upstream is a daemon/client split in which **the daemon reaches the user's terminal by
opening a path**. The chain, end to end:

| step | where |
|---|---|
| the client finds its own tty by shelling out to `tty(1)` | `cli/src/main.ts:119` |
| it refuses to run without one | `cli/src/main.ts:301-303` |
| the path crosses a unix socket in the `open` request | `cli/src/main.ts:202-209` |
| the daemon rejects any open without it | `browser/src/daemon.ts:96-106` |
| it reaches `createRoot({ tty })` | `browser/src/session/session.tsx:313-316` |
| and is finally `File::options()…open(tty_path)` | `pixel-core/src/terminal.rs:348-349` |

and the daemon is spawned `{ detached: true, stdio: "ignore" }` (`cli/src/main.ts:155`),
so it has no terminal of its own by construction. It does not need one: it opens
everyone else's.

**Windows has no path that names another process's ConPTY.** `CONIN$` and `CONOUT$`
resolve to the *calling* process's console. So either the engine moves into a process
that has the pane's console, or the terminal is proxied across a process boundary.

## What was measured

`tools/console-inherit-probe` builds the deployment topology out of real processes — a
real `CreatePseudoConsole`, a console-subsystem middle process standing in for the CLI
in the pane, and a grandchild standing in for `electron.exe` — and varies only the
grandchild's PE subsystem and creation flags. Both grandchildren run the identical body
(`src/child.rs`), so "GUI programs do not get a console" cannot be confused with "this
harness spawns wrong". Reproduce with `cargo run` in that directory:

```
pseudoconsole 132x37 -> console-subsystem middle -> grandchild

scenario           attached  console    conin    attach    after      read from pane
console-inherit    true      132x37     0        5         132x37     \e[<0;12;5M   [pane console]
gui-inherit        false     0x0        6        0         132x37     \e[<0;12;5M   [no console]
gui-detached       false     0x0        6        0         132x37     \e[<0;12;5M   [no console]
gui-attach-by-pid  false     0x0        6        0         132x37     \e[<0;12;5M   [no console]
```

Read: `attached` and `console` are what the grandchild was *given*, probed before it
touched `AttachConsole`; `conin` is `GetLastError` from opening `CONIN$`; `attach` is
`GetLastError` from `AttachConsole`; `after` is the console size once that returned.

Four findings, each pinned by a test in `tests/inheritance.rs`:

1. **A console-subsystem child inherits the pane for free** and reads its input
   verbatim. The control holds, so the rows below mean something.
2. **A GUI-subsystem child does not** — `CONIN$` fails with `ERROR_INVALID_HANDLE` (6)
   even on an ordinary spawn with no detach flag. `electron.exe` is
   `IMAGE_SUBSYSTEM_WINDOWS_GUI` (verified against the installed 43.3.0 binary, and
   pinned by `tools/process-model/entry.test.mjs`), so this is Electron's case, not a
   curiosity.
3. **But it can take the console**, by `AttachConsole` — with `ATTACH_PARENT_PROCESS`
   or with an explicitly named process id, equally — and then the pane's SGR mouse
   report arrives byte for byte. **This is what makes (a) viable**, and it is a step
   upstream never had to take.
4. **A process that already has a console cannot attach to a second**:
   `ERROR_ACCESS_DENIED` (5). One console per process is a hard Win32 rule.

Finding 4 is the structural one. A single daemon serving *N* panes would need *N*
consoles simultaneously, and no process can hold two. Note what this does **not** say:
`DETACHED_PROCESS` is not the obstacle — row 3 shows a detached child re-attaching to
its parent's console without trouble. Anyone tempted to "fix" the daemon by dropping
`detached: true` would be fixing the wrong thing. What rules the daemon out is that it
outlives the pane that spawned it and then serves panes it is not a child of, each of
which would need a console it cannot simultaneously hold.

## Option (a): host the engine in the foreground process

**What it costs.** `browser/src/main.tsx:55` called `runDaemon(cdpPort)` unconditionally
and never inspected the `--daemon` argument the CLI passes, so there was no foreground
mode to switch to — this is a restructure of the browser process's top level, not a
flag. Done here, and deliberately small:

- `browser/src/entry.ts` — `entryMode(argv)`, import-free so it is testable without a
  built engine, matching `--daemon` exactly rather than by substring.
- `browser/src/foreground.ts` — one session, `createSession` from the same factory the
  daemon uses, signal handling, exit on close.
- `browser/src/main.tsx` — three lines, choosing between them.

The daemon path is entered exactly when the CLI asks for it, which every existing
platform still does, so nothing changes off Windows.

**What it costs beyond that**, honestly:

- **One Chromium per pane** instead of one shared across all of them. This is the real
  price, and it is not small in memory.
- **Profiles do not merge.** `claimProfile()` (`browser/src/profile.ts`) already hands
  each concurrent process its own `userData` directory out of a pool of 32, with a
  pid lock — it was written for a pre-daemon world and its own comment says the daemon
  made it unnecessary. It works, so (a) needs no new code here; but it means cookies and
  browsing state are per-pane. Chromium locks a profile directory, so this is not a
  choice (a) gets to make differently.

  > **Corrected 2026-08-26.** "Needs no new code here" held for the pool and not for
  > its lifecycle, and the two defects that cost were both in the lifecycle.
  > `claimProfile` removes the lock from Electron's `will-quit`, and `app.exit` — how a
  > foreground browser ordinarily ends — emits no `will-quit`, so the lock outlived
  > every exit; once Windows reissued the pid the next launch skipped to the next
  > numbered directory and handed the user a profile with none of their cookies in it,
  > which reads as being logged out. And the probe deciding "stale" answered every
  > failure with "dead", including the `EPERM` Windows returns for a live
  > higher-integrity holder. `releaseProfileLock` (`browser/src/foreground.ts`) now runs
  > before every `app.exit` in `browser/src`, and `alive()` treats `ESRCH` as the only
  > "gone" — `docs/design/UPSTREAM.md` divergence 13. Plan:
  > [`20260826-deferred-browser-defects.md`](../plans/completed/20260826-deferred-browser-defects.md).
- **Nothing else in the tree assumes one process.** The instance registry is already
  per-session, not per-daemon: `Registry` (`browser/src/registry.ts:52-56`) listens on
  a socket named by the session key, and the key is `${process.pid}-${seq}`
  (`daemon.ts:102`), which is unique across processes. `tb ls` and `tb action` enumerate
  `INSTANCES_DIR` and keep working unchanged.
- The daemon's lifecycle verbs (`shutdown`, idle-exit) have no foreground analogue.
  That lands on Task 13 with the rest of the CLI.

## Option (b): keep the daemon, forward stdin over IPC

Rejected. The stated cost was "input latency, and a second stdin protocol to own". The
latency is not the problem — a local named pipe is well under a frame. The protocol is,
and it is much larger than "stdin".

**The terminal seam is a conversation, not a feed.** Forwarding keystrokes would be
easy; the seam is not keystrokes. `impl Terminal` is 24 public methods
(`terminal.rs:336-1061`), and several of them *write a query to the terminal and read
its reply off the same descriptor under a deadline*:

- `query_colors` (`:892`) writes 18 OSC colour queries and reads replies for up to
  300 ms, counting `rgb:` occurrences, interleaved with whatever input arrives.
- `cell_size` (`:869`) writes `\e[16t` and reads the report back, with a 300 ms budget
  and a "this terminal does not support it" latch.
- Five clipboard calls (`:1035-1057`) write OSC 52 and expect the answer to come back
  as an `Event` — and they are reached through `&mut Terminal` from
  `engine/clipboard.rs:97,127,168,194,242`, deep inside engine code that is otherwise
  keep-unchanged.

Proxying that means a bidirectional, stateful, latency-bounded RPC for the whole seam,
plus a second owner of console raw mode, plus rewriting call sites in files this port is
not supposed to touch. And the client side is Node: it cannot open `CONIN$` or call
`SetConsoleMode` without native code, so (b) also needs the native addon loaded into the
CLI — at which point the terminal backend is split across two processes rather than
moved.

(b)'s one genuine advantage over (a) is a shared Chromium and a shared profile. That is
a real advantage, and it is what (a) gives up.

**A third shape was considered and rejected with (b):** a per-pane helper process that
owns the console and proxies the seam to a shared daemon. It buys back the shared
profile, but it pays (b)'s full protocol cost *and* adds a process per pane, so it is
strictly worse than (b) on the axis (b) already lost on.

## The seam both options build on

`createRoot({ tty: null })` is already a supported shape, and neither option invents it:

- `pixel-react/src/index.ts:262-264` — `options.tty ? new Bridge(tty, …) : getBridge(…)`;
  with no tty it takes the default bridge instead of opening someone else's terminal.
- `session/session.tsx:313` — a `!this.ctx.tty` branch that writes the OSC 2 marker to
  its own stdout, which is what a process in its own pane would do.
- `SessionContext.tty` is optional (`session.tsx:49`), so the foreground session simply
  does not set it.

So (a) is not a new code path in the engine. It is the existing no-tty path, with the
Windows backend supplied behind it by Tasks 4 and 5.

## The output side is unaffected either way

Frames do not travel over the terminal. They leave through agwinterm's control pipe,
addressed to `%AGWINTERM_SESSION_ID%` — Task 7's path — so the frame path never needs a
tty and does not care which process holds one.

Nor does the daemon shape break the addressing, which is worth stating because it looks
like it should. The environment agwinterm sets in a pane is per-pane, and a daemon
inherits its variables from whichever pane happened to spawn it first — but the open
request already carries `env: process.env` from the client (`cli/src/main.ts:206`), the
daemon passes it into the session (`daemon.ts:109`), and it reaches the engine as
`sessionEnv` (`session.tsx:318`), where `SessionEnv::of_session` (`terminal.rs:320`)
exists for exactly this. Per-session environment is already plumbed. The decision
therefore rests on input alone, which is where the asymmetry actually is.

## What Task 5 must do, that upstream did not

This is the brief the decision exists to produce.

1. **Attach before opening.** In the foreground shape the engine process is
   GUI-subsystem and starts with *no* console, even though it was launched from the
   pane. `Terminal::new` (the no-path constructor) must, on Windows, call
   `AttachConsole` before touching `CONIN$`/`CONOUT$`, and treat `ERROR_ACCESS_DENIED`
   as "already attached, carry on" rather than as failure. Skipping this is the measured
   `conin_err=6` above: every console call fails and the process looks terminal-less.
2. **Open by name, never `GetStdHandle`.** Task 1 recorded that a ConPTY child's std
   handles can be `NUL` while it is attached — `FILE_TYPE_CHAR`, and then
   `ERROR_INVALID_HANDLE` from every console API. `CONIN$`/`CONOUT$` are the analogue of
   upstream opening `/dev/tty` instead of using fd 0.
3. **Prefer an explicitly named process id** over `ATTACH_PARENT_PROCESS`. Both were
   measured to reach the same console, but the named form does not require the console
   owner to be the *direct* parent, which leaves Task 9's launcher free to put a wrapper
   in between. `ATTACH_PARENT_PROCESS` stays as the fallback when no id is passed.
4. **The CLI must not read console input.** A console has one input buffer. In the
   foreground shape the launcher and the engine are both in the pane, and only the
   engine may read. Upstream's `attachHere` (`cli/src/main.ts:300-337`) already only
   waits and handles signals, so this is a constraint to preserve, not a change to make.

### What Task 5 actually built, and what Task 9 now owes it

Task 5 implemented all four, in `pixel-core/src/terminal_windows.rs`. Two details
were settled there and are contracts for the launcher rather than internals:

- **`TERMINAL_BROWSER_CONSOLE_PID` is the name of point 3's process id.** It is read
  through `SessionEnv`, not `std::env`, so it works in the daemon shape as well as
  the foreground one — the client already forwards its whole environment. When it is
  absent, unparseable, or names a process that cannot be attached to, the backend
  logs and falls back to `ATTACH_PARENT_PROCESS`. **Task 9's launcher sets it to the
  pid of whatever process holds the pane's console**, which is what buys the freedom
  to put a wrapper in between.
- **The console is read on a dedicated thread, not by the caller.** This is not a
  style choice: under `ENABLE_VIRTUAL_TERMINAL_INPUT` an input record that translates
  to no bytes (key-up, focus, buffer-size) still signals the handle but is consumed
  silently, so "wait, then `ReadFile`" blocks past the caller's deadline — and every
  keypress queues exactly such a record. The blocking read therefore lives on its own
  thread and `poll_event` waits on a condvar. The consequence Task 9 should know
  about is that the thread can outlive a clean shutdown while parked in `ReadFile`;
  there is one engine per process, so it ends with the process.

Point 4 is unchanged and still a constraint on the launcher: one console, one input
buffer, and only the engine may read it.

## Risks this decision accepts

- **Parent lifetime is unmeasured.** `AttachConsole` needs the console owner to still be
  alive when the engine calls it. The foreground launcher waits for Electron to exit, so
  it is alive by construction — but a launcher that exec'd away, or a `cmd /c` wrapper
  that exits early, would break this in a way no test here would catch. Task 9 owns it.
- **Memory.** One Chromium per pane is the accepted cost of the decision. If it proves
  unacceptable in practice, the escape hatch is (b) with its full seam proxy, and the
  measurements above are what that would have to be re-argued against.
