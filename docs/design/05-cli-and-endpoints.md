# The CLI on Windows: one endpoint abstraction, and the refusals

This is the port plan's Task 13. It covers the two control protocols the CLI speaks,
where the application's own files live, and the commands that Windows cannot honour.

## Two protocols, not one

Upstream has two unix-socket protocols and it is easy to see only the first:

| protocol | server | client | address |
|---|---|---|---|
| daemon | `browser/src/daemon.ts` | `cli/src/main.ts` | `<runtime>/<app>/daemon.sock` |
| per-browser control | `browser/src/registry.ts` | `cli/src/control.ts`, reached from `main`, `instances`, `ls`, `action` | `<runtime>/<app>/instances/<key>.sock` |

The second one is **persisted**: its address is a column in the instances table
(`store/src/schema.ts`), written by every browser at startup and read back by four
CLI modules. Porting the first and missing the second would leave `ls`, `new-tab`
and `action` addressing files that do not exist.

## The abstraction is about lifetime, not transport

Node's `net` speaks Windows named pipes through the same API as unix sockets: pass
`\\.\pipe\<name>` where a path went, and `createServer`/`connect` behave. So the
line protocol, the framing and every handler are untouched by this port.

What is not the same is **the lifetime of the name**:

- A socket file outlives the process that listened on it. A crash leaves a path
  that `connect` refuses and `listen` will not bind, so upstream unlinks before
  binding and unlinks again on shutdown.
- A named pipe has no existence apart from its server. The name disappears from the
  object manager when the last instance closes — including when the process dies —
  so there is nothing to unlink, and `listen` on a name someone still holds fails
  with `EADDRINUSE`, which is the correct answer because the owner is alive.

`store/src/endpoint.ts` is that difference and nothing else:

- `isPipeEndpoint` / `pipeEndpoint` / `pipeSegment` — naming, with the sanitiser
  that keeps a key from smuggling a `\` and silently nesting the pipe name.
- `removeEndpoint` — a real unlink for a path, an honest no-op for a pipe, and it
  returns which so a caller can tell the difference.
- `endpointAlive` — connect and hang up. On Windows this is the *only* stale-check
  available; there is no file to `stat`.
- `reclaimEndpoint` — probe, then unlink. Upstream unlinked without probing, which
  on unix silently detaches a live server from its name.

`store/src/paths.ts` composes the names; `endpoint.ts` never imports it, so the
naming rules can be tested without a home directory.

### Stale-endpoint cleanup

The plan asks for the cleanup that has "no `fs.rmSync` analogue for named pipes".
The answer is that on Windows there is nothing to clean up at the endpoint, and the
thing that actually goes stale is the **row**:

`listInstances` (`store/src/instances.ts`) drops any row whose pid is gone, on both
platforms, and calls `removeEndpoint` after it — which does the unlink on unix and
nothing on Windows. That is not the no-op it looks like. A dead browser's pipe name
is already free; a dead browser's row is not, and it is the row that strands
`terminal-browser ls` behind a two-second control timeout per phantom.

One related fix: `alive(pid)` treated *any* `process.kill(pid, 0)` throw as death.
Windows reports `EPERM` for a live process at a higher integrity level, which would
have pruned a running browser's row out from under it. Only `ESRCH` is death now.

### The persisted column

`instances.socket` became `instances.endpoint`, by migration
`0003_windows_named_pipes`, because on Windows the value is neither a socket nor a
path. The rename is a real `ALTER TABLE … RENAME COLUMN`, so an existing database
keeps its rows; the four CLI consumers and `ls --json`'s output field follow.

## Where the files live

Upstream is XDG: four base directories plus `XDG_RUNTIME_DIR`, each overridable on
its own. Windows has one convention in place of all five — `%LOCALAPPDATA%`, one
directory per application, subdivided by the application. So:

| | unix | Windows |
|---|---|---|
| data | `$XDG_DATA_HOME/<app>` | `%LOCALAPPDATA%\<app>\data` |
| logs | `$XDG_STATE_HOME/<app>/logs` | `%LOCALAPPDATA%\<app>\logs` |
| favicons | `$XDG_CACHE_HOME/<app>/favicons` | `%LOCALAPPDATA%\<app>\cache\favicons` |
| instances | `$XDG_RUNTIME_DIR/<app>/instances` | `%LOCALAPPDATA%\<app>\instances` |
| daemon endpoint | `$XDG_RUNTIME_DIR/<app>/daemon.sock` | `\\.\pipe\<app>-daemon` |
| browser endpoint | `<instances>/<key>.sock` | `\\.\pipe\<app>-instance-<key>` |

`<app>` is unchanged: `terminal-browser[-dev]-<8 hex of the install root>`. It is
what keeps two installs, and a dev tree beside a release, from sharing a pipe name.

`appPaths(platform, env, home, appDirName)` is a pure function so both columns of
that table are checked from one test run on one machine.

The browser's fd 2 under the CLI is `logs\stderr.log`, and since 2026-09 the engine's
warnings and errors are appended there as `engine <level> <target>: …` lines
(`browser/src/engine-log.ts`); a browser started by hand keeps them off the console.

## What is scoped to "here"

`--split` is unsupported (below), so the Windows shape is one browser per pane,
running in the foreground and holding that pane's console for as long as it lives
(`03-process-model.md`). A CLI process running *in that pane at the same time* is
therefore impossible, and `inCurrentTab` is false for every browser, always.

Filtering on it would scope every command to nothing. `scopeHere`
(`cli/src/instances.ts`) returns the whole list on Windows instead, which makes
`ls` behave as though `--all` were passed and leaves `--browser <key>` as the way
to disambiguate when more than one is running. `action`'s "no terminal browser in
this terminal tab" is reworded to match, because on Windows the tab is not the
reason.

## The refusals

The rule is the plan's: **do not leave a command that appears to work but does
not.** Each of these names its obstacle rather than the platform.
`cli/src/unsupported.ts` owns the wording, imports nothing, and is driven directly
by `tools/cli/unsupported.test.mjs`.

**`--ssh`** — the tunnel is multiplexed over an ssh control socket (`ssh -S`,
`ssh -O exit`) and reused by every later command, including `tar` for `--ssh-bundle`.
ControlMaster multiplexing is a unix-socket feature Win32 OpenSSH does not
implement, so the tunnel cannot be held open between invocations. The rest of
`ssh.ts` would port; this one thing does not. Refused in `validateSshTarget`, which
is on the argument-parsing path, so nothing is spawned first.

**`upgrade`** — runs the release channel's install URL through
`bash -c 'curl … | bash'`. No Windows release channel publishes such a script and a
default install has no bash. Refused before the version lookup, so the message is
the real obstacle rather than "could not perform upgrade" from a missing dist root.

**`--split`** — two things are missing, not one. `pixel-terminals` has no agwinterm
detector, so `detect()` returns null in a pane and there is no `split` to call; and
agwinterm's `session.split` takes an operation but not a command
(`ControlServer.cs:134-135,163`), so even with a detector the new pane could not be
told to run the browser. Lifting this needs a host change. Refused in
`takeSplitFlag` before the direction is validated, so an unsupported flag is not
reported as a mistyped one.

**`setup`'s sandbox step** — not unsupported, but previously silent. `apparmorSetup`
returned 0 off Linux without a word, which reads as "a sandbox was configured".
Chromium *is* sandboxed on Windows, by the OS, with nothing to install; the AppArmor
profile is a Linux-only workaround for Ubuntu withholding unprivileged user
namespaces. It now says so.

**`shutdown`** — there is no daemon in the Windows shape. This mattered more than a
message: `shutdownDaemon` falls back to `daemonPid()`, which returns *the first live
instance pid* — in the foreground shape, a browser somebody is using — and then
`kill`s it while reporting that it stopped a daemon. The Windows branch returns
before that.

**the pane's own agwinterm instance** — added after the port, by
`20260822-post-port-corrections.md`'s Task 2. `open` refuses two things about the pane
it was run in, both of them checks the engine already made, moved ahead of the spawn:
an `AGWINTERM_PIPE` that is not a pipe name (`[A-Za-z0-9._-]`, because `\\.\` is a
normalised device path and `..\` walks out of the pipe namespace), and — when
`TERMINAL_BROWSER_ALLOW_PIPE` is set — an instance that list does not name. Refused
here rather than at the first frame because a browser the CLI launched and the engine
then refused every frame from is a browser that starts and shows nothing. The allow-list
half is `debug_assertions`-gated in the engine and cannot be in the CLI; the asymmetry
and its consequence are in
[07](07-as-built.md#terminal_browser_allow_pipe--a-dev-build-refuses-an-instance-it-was-not-named-at).

**`herdr`** (`pixel-core/src/herdr.rs`, already `#[cfg(unix)]`) — permanently
disabled, not pending. It is not a transport for the agwinterm path; it is a
different host, found through `HERDR_SOCKET_PATH` and negotiated with
`pane.graphics.info`, which must answer `file_frame_transport: "direct-kitty"`
before the module will speak to it (`herdr.rs:56`). Kitty escapes are what ConPTY
strips, so porting the socket would produce a client that connects and then cannot
draw. The host does not run on Windows either.

## What `open` does on Windows

The one addition beyond the plan's checklist, because without it the CLI still only
knew how to spawn a daemon and Task 10's milestone had to be driven by a `.cmd`
file. `openInForeground` (`cli/src/main.ts`) spawns Electron with `stdio: "inherit"`
and no detach, waits, and carries the exit code out — this process is the pane's
foreground job. It also sets `TERMINAL_BROWSER_CONSOLE_PID` to its own pid, so the
engine's `AttachConsole` (`terminal_windows.rs:347`) has an explicit target instead
of relying on the process tree staying exactly one level deep.

The graphics check is replaced rather than skipped. `probeGraphics` writes an APC
escape and waits for a reply; ConPTY strips APC, so on Windows it can only time out,
and the answer would be about the wrong channel anyway. `windowsHostRefusal` asks
the questions that decide it — is this an agwinterm pane, is its `AGWINTERM_PIPE` a
pipe name, and is its instance one `TERMINAL_BROWSER_ALLOW_PIPE` names — from the
pane's own environment. The last two were added after the port; see the refusals above.

`openInForeground` also takes the pane back on its way out, which is the other half of
`pane-clear` below: `clearOwnedPaneFrame` sends an `image.clear` only for a frame
directory the process it spawned actually left behind, and `restorePaneConsole` undoes
the alternate screen, the hidden cursor and mouse reporting.

## `pane-clear`, when neither half ran

The exits that run no destructor — a `taskkill /F` on the CLI, a console that went away
underneath both — leave the pane holding a placement with mouse reporting on, and leave
no process to take either back. `terminal-browser pane-clear` is that second chance,
run in the wrecked pane, with no engine, no instance in the registry and no browser
alive. It is dispatched ahead of every liveness check in `cli/src/main.ts` and always
exits 0, because it is a repair tool run against something already broken. `cli/src/pane.ts`
holds it and imports nothing from the workspace for exactly that reason. What decides
whether it sends anything is the engine's rule read off the filesystem: the frame
directory `FrameDir`'s `Drop` would have removed, *and* the `pane` marker the engine
wrote inside it naming the pipe and session that frame was placed on. The marker is
what makes this a question about this pane rather than about the machine — without it,
two panes wrecked at once means repairing one on the other's evidence — so a directory
with frames and no marker is one this verb will not touch. See
[07](07-as-built.md#taking-the-picture-back).
