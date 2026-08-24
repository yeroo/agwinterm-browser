//! The agwinterm control-pipe client.
//!
//! Frames do not leave through the terminal on Windows. ConPTY strips the Kitty
//! APC escapes upstream writes to stdout, so the output half of the port addresses
//! the host directly: one JSON request per line on the named pipe agwinterm sets
//! in every pane, answered by a `{"ok":true,"result":…}` /
//! `{"ok":false,"error":…}` envelope (`ControlServer.cs:521-523`).
//!
//! This module is that client. It is deliberately narrow — a target resolved from
//! the environment, a connection that can be re-dialled, and an envelope parser —
//! because the verbs on top of it belong to their own tasks: Task 7 sends
//! `image.frame`, and Task 12 was to send `image.frameshm` — which it does not,
//! because that verb's mapping layout is still unpublished. See
//! [`crate::frame_shm`], which holds what survives that blocker: the transport
//! selection, and the one reading of `unknown command` every capability probe here
//! shares.
//!
//! ## Addressing: the pane, never "active"
//!
//! agwinterm resolves a request's `target` as an id, a unique prefix, `"active"`,
//! or null-meaning-active. Every one of those but the id can land a frame in a pane
//! the user has since switched to, so this client always sends the id it was given
//! and refuses to start without one. `AGWINTERM_SESSION_ID` is the name; under a
//! split it is the *pane* id (`Program.Sessions.cs:117-118` sets it and
//! `AGWINTERM_PANE_ID` to the same value), which is the granularity a frame needs.
//!
//! ## A closed pipe is not a crash
//!
//! agwinterm serves each connection on its own thread and closes it when the client
//! goes; a restarted host, a closed window, or an `IOException` swallowed at
//! `ControlServer.cs:84` all present to us as a write that fails or a read that
//! ends. [`ControlClient::request`] treats those as recoverable: it drops the dead
//! connection, dials again, and replays the request **once**. Replay is safe for
//! the verbs this client sends because they are idempotent — `image.frame` replaces
//! the pane's placements outright and [`METRICS_CMD`] only reads — and any verb
//! added later must keep that property or send itself through [`ControlClient::attempt`].
//!
//! ## Where cell pixel metrics come from
//!
//! The decision the port plan's Task 6 owes is recorded in
//! `docs/design/04-cell-metrics.md`; [`cell_size`] is it in code. In short: an
//! explicit [`CELL_PX_VAR`] is consulted first, then the host is asked for
//! [`METRICS_CMD`], and the last resort is [`FALLBACK_CELL`] with a warning that
//! names the fix. The override is first on purpose — it is how a user corrects a
//! host that reports the wrong thing after a mixed-DPI move. What
//! matters more than the number is that *one* number reaches both the canvas and
//! the pointer, which is why this returns a value rather than an `Option`.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{ERROR_IO_PENDING, HANDLE, WAIT_TIMEOUT};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_OVERLAPPED, ReadFile, WriteFile};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResultEx, OVERLAPPED};

use crate::terminal::SessionEnv;

/// Set to `1` in every agwinterm pane. Its absence means the browser is running
/// somewhere that cannot show a frame.
pub(crate) const ENABLED_VAR: &str = "AGWINTERM_ENABLED";
/// The control pipe's name — not its path; see [`HostTarget::path`].
pub(crate) const PIPE_VAR: &str = "AGWINTERM_PIPE";
/// The pane to address. Unique per split pane.
pub(crate) const SESSION_VAR: &str = "AGWINTERM_SESSION_ID";
/// The same value under the name that says "pane" out loud, and the only one set by
/// hosts that predate the session/pane merge.
pub(crate) const PANE_VAR: &str = "AGWINTERM_PANE_ID";
/// The agwinterm window our pane lives in.
///
/// Not cosmetic. A content verb with no `window` in it resolves against the
/// *frontmost* window (`ControlServer.cs:126` -> `ResolveWindow(null)` ->
/// `Frontmost`), and each window's `Resolve` searches only its own workspaces
/// (`Program.ControlHost.cs:162`). So an unqualified `image.frame` from a pane in
/// a background window is answered `no session` — and a refused frame is an error
/// out of `Terminal::draw`, which `Engine::pump` propagates and `pixel-node` treats
/// as a fatal exit. Focusing a second agwinterm window would have *closed* the
/// browser. Hosts that predate multi-window ignore the field.
pub(crate) const WINDOW_VAR: &str = "AGWINTERM_WINDOW_ID";
/// `<width>x<height>` in pixels, overriding whatever the host says (or does not).
pub(crate) const CELL_PX_VAR: &str = "TERMINAL_BROWSER_CELL_PX";
/// The agwinterm instances a development build is allowed to publish into.
///
/// A comma- or semicolon-separated list of bare pipe names, or `*` for "anywhere".
/// See [`pipe_refusal`] for what it is for and why it is off unless set.
pub(crate) const ALLOW_PIPE_VAR: &str = "TERMINAL_BROWSER_ALLOW_PIPE";

/// What `agwintermctl` falls back to when `AGWINTERM_PIPE` is unset
/// (`Agwinterm.Ctl/Program.cs:371`), matched here so the two agree.
pub(crate) const DEFAULT_PIPE: &str = "agwinterm";

/// The verb that publishes pane geometry. Proposed by this port and implemented by
/// the agwinterm plan's Task 6b; a host without it answers `unknown command`, which
/// [`ControlClient::pane_metrics`] reads as a capability gap rather than a failure.
pub(crate) const METRICS_CMD: &str = "session.metrics";

/// The cell size used when nothing can supply one.
///
/// It is `engine/mod.rs:347`'s own `unwrap_or((16, 32))`, on purpose: the engine
/// substitutes that value for a `None` regardless, and the failure that actually
/// breaks click targets is the *backend* using a different number than the engine.
/// Returning it explicitly makes the two agree and lets the warning be logged once,
/// where the reason is known.
pub(crate) const FALLBACK_CELL: (u32, u32) = (16, 32);

/// `ERROR_PIPE_BUSY`. Every server instance is in use; the next `WaitForConnection`
/// will create another, so this is a wait rather than a failure.
const ERROR_PIPE_BUSY: i32 = 231;
/// `ERROR_NO_DATA` — the pipe is closing.
const ERROR_NO_DATA: i32 = 232;
/// `ERROR_PIPE_NOT_CONNECTED` — the server end has gone.
const ERROR_PIPE_NOT_CONNECTED: i32 = 233;
/// `ERROR_IO_INCOMPLETE` — the operation is still pending.
///
/// The *other* way a bounded collect reports "not yet", and the dangerous one:
/// `GetOverlappedResultEx` answers `WAIT_TIMEOUT` when a non-zero wait expires and
/// this when the wait was zero. Both leave the kernel holding the buffer, so both
/// have to reach [`Connection::give_up`] — a return that skips it frees a
/// [`PendingIo`] an in-flight read may still be writing into. [`millis_until`] keeps
/// the wait off zero so this should be unreachable; it is handled because "should be"
/// is not the standard the rest of this path is held to.
const ERROR_IO_INCOMPLETE: i32 = 996;

const OPEN_ATTEMPTS: u32 = 20;
const BUSY_WAIT: Duration = Duration::from_millis(25);

/// The longest one request/response exchange on the control pipe may take.
///
/// 1040 ms is one hundred times the slowest round trip `docs/design/02-frame-budget.md`
/// measured: 10.4 ms, for a 2.48 Mpx frame whose 9.93 MB file the host reads
/// synchronously inside the verb. The odd number is the point — a round 1000 ms or a
/// round 5 s would read as a guess, and this one carries its derivation, so a
/// re-measurement that moves the round trip moves this with it.
///
/// A hundredfold rather than a tenfold because the measured number is a *median* on
/// an idle machine, and the tail this must not clip is a loaded one: a host paging in
/// its decoder, a frame file on a slow volume, a debugger attached. And no more than
/// that because the wait is charged to the render thread, and through
/// `PixelEngine::stop`'s join to shutdown as well. Past about a second a user reads
/// the pane as hung, so there is nothing left to buy above it.
const EXCHANGE_DEADLINE: Duration = Duration::from_millis(1040);

/// How long a cancelled operation is given to finish before its connection is
/// abandoned rather than closed. See [`Connection::give_up`].
///
/// Not derived from the frame budget, because nothing about a frame is happening any
/// more by the time this runs: it is the kernel's own turnaround on a cancellation,
/// which is microseconds. 250 ms is a bound on a thing that should not need one.
const CANCEL_GRACE_MS: u32 = 250;

/// The most one reply line may grow to before it is refused. Matches
/// `cli/src/control.ts`'s `MAX_REPLY_BYTES`, which caps the other client of the
/// same protocol.
const MAX_REPLY_BYTES: u64 = 4 * 1024 * 1024;

/// The largest cell either dimension may claim to be, in pixels.
///
/// A sanity bound, not a font limit: the numbers arrive over the pipe and are
/// multiplied by the pane's columns and rows to size the canvas
/// (`engine/mod.rs`), and that product is a `u32` multiply which wraps rather than
/// panics in release. 1024 is roughly sixteen times the largest cell a readable
/// terminal font produces, and leaves the product of a full-screen pane far inside
/// the range.
const MAX_CELL_PX: u32 = 1024;

// ---------------------------------------------------------------------------
// Where to send, and whether there is anywhere to send to
// ---------------------------------------------------------------------------

/// The pane this process draws into, and the pipe that reaches it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HostTarget {
    pipe: String,
    session: String,
    /// The window the pane is in, when the host names one. See [`WINDOW_VAR`].
    window: Option<String>,
}

impl HostTarget {
    /// Reads the variables agwinterm sets in a pane.
    ///
    /// Through [`SessionEnv`] rather than `std::env`, so this answers for the pane
    /// that asked rather than for the pane that happened to start the process —
    /// the same reason `TERMINAL_BROWSER_CONSOLE_PID` is read that way.
    pub(crate) fn from_env(env: &SessionEnv) -> io::Result<Self> {
        if !hosted(env) {
            return Err(not_hosted(&format!("{ENABLED_VAR} is not set")));
        }
        let session = nonempty(env, SESSION_VAR)
            .or_else(|| nonempty(env, PANE_VAR))
            .ok_or_else(|| not_hosted(&format!("{SESSION_VAR} names no pane")))?;
        if session == "active" {
            return Err(not_hosted(&format!(
                "{SESSION_VAR} is \"active\", which addresses whichever pane is in \
                 front rather than this one"
            )));
        }
        let named = nonempty(env, PIPE_VAR);
        let pipe = named.clone().unwrap_or_else(|| DEFAULT_PIPE.to_owned());
        if !valid_pipe_name(&pipe) {
            return Err(not_hosted(&format!(
                "{PIPE_VAR}={pipe:?} is not a pipe name — it may contain only \
                 letters, digits, `.`, `_` and `-`"
            )));
        }
        let allow = nonempty(env, ALLOW_PIPE_VAR);
        if let Some(refusal) = pipe_refusal(
            allow.as_deref(),
            &pipe,
            named.is_some(),
            cfg!(debug_assertions),
        ) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, refusal));
        }
        Ok(Self {
            pipe,
            session,
            window: nonempty(env, WINDOW_VAR),
        })
    }

    /// The pipe's filesystem name. `AGWINTERM_PIPE` carries the bare name, the way
    /// `NamedPipeServerStream` takes it; a client has to spell the `\\.\pipe\` prefix.
    pub(crate) fn path(&self) -> String {
        format!(r"\\.\pipe\{}", self.pipe)
    }

    pub(crate) fn session(&self) -> &str {
        &self.session
    }
}

/// The characters a pipe name may carry, which is `store/src/endpoint.ts`'s
/// `pipeSegment` set — the same guard, on the other side of the same wire.
///
/// Not cosmetic, and not about the object manager's nesting rule alone. `\\.\` is a
/// *device* path, and unlike `\\?\` it is normalised on the way in: `..\` walks out
/// of the pipe namespace into the filesystem. An `AGWINTERM_PIPE` of
/// `..\C:\Users\me\.ssh\config` therefore turns [`Connection::open`] — which asks
/// for read *and* write — into an open of that file, and [`Connection::exchange`]
/// into a write of the request line over its first bytes. The value comes from the
/// environment, and the environment is not always one this process inherited: the
/// daemon shape takes it from whoever asked for the session
/// (`browser/src/daemon.ts`). So it is checked here rather than trusted.
fn valid_pipe_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Why a development build may not address this pipe, or `None` when it may.
///
/// ## The failure this exists for
///
/// A pane's `AGWINTERM_PIPE` names whichever agwinterm the pane belongs to, and with
/// the variable unset it is [`DEFAULT_PIPE`] — the machine's real instance. So a
/// browser built and launched from a checkout, in the terminal the developer is
/// working in, publishes into *that* terminal. A frame is a placement agwinterm holds
/// until something replaces it, and an exit that runs no destructor leaves it there:
/// a pane of the real instance was found holding a dead browser's page with mouse
/// reporting still on, eighteen hours after the run that drew it. Nothing in the code
/// distinguished "the pane I meant to draw in" from "the pane I happen to be running
/// in", because at the level of the environment they are the same thing.
///
/// ## Why it is off unless asked for
///
/// The dev workflow is the one in the README: a Debug agwinterm on `--app-id
/// agwinterm-dev`, and `TERMINAL_BROWSER_ALLOW_PIPE=agwinterm-dev` in the shell that
/// launches the browser. Once set, publishing anywhere else is refused by name.
///
/// It cannot default to on. On Windows the shipped product *is* a checkout —
/// `pnpm -r build` runs `cargo build -p pixel-node` with no `--release`, so the
/// binary a user runs has `debug_assertions` on — and a guard that refused an
/// unlisted pipe by default would refuse every ordinary run. `dev_build` narrows the
/// variable rather than arming it: a release build ignores the variable outright, so
/// a stray value inherited from a shell profile can never stop a shipped browser
/// drawing.
///
/// `explicit` distinguishes a pipe the pane named from one that came from the
/// fallback, because the two need different advice and the fallback is the case that
/// actually wrecked a pane.
fn pipe_refusal(
    allow: Option<&str>,
    pipe: &str,
    explicit: bool,
    dev_build: bool,
) -> Option<String> {
    if !dev_build {
        return None;
    }
    let allow = allow?;
    // A list with nothing in it is an unset variable, not a list that allows
    // nothing: `set TERMINAL_BROWSER_ALLOW_PIPE=` and a value of spaces are both how
    // a shell spells "off", and reading either as "refuse everything" would turn the
    // guard on for someone trying to turn it off.
    if allow.split([',', ';']).all(|entry| entry.trim().is_empty()) {
        return None;
    }
    if allows_pipe(allow, pipe) {
        return None;
    }
    let source = if explicit {
        format!("{PIPE_VAR} names {pipe:?}")
    } else {
        format!("{PIPE_VAR} is unset, so this pane resolves to {pipe:?}")
    };
    Some(format!(
        "{source}, and {ALLOW_PIPE_VAR}={allow:?} does not list it. This is a \
         development build, which publishes only into an instance it was told to \
         use — a frame sent to the wrong one is a placement left in a terminal \
         somebody is working in. Add {pipe:?} to {ALLOW_PIPE_VAR}, or set it to `*` \
         to allow any instance, or unset it to turn the guard off"
    ))
}

/// Whether an [`ALLOW_PIPE_VAR`] list names this pipe. `*` names every pipe.
///
/// Separators are `,` and `;` because both are what a shell hands over without
/// quoting — `set` on `cmd.exe` treats a comma as an argument separator, and a
/// developer who writes one means it as a list.
fn allows_pipe(list: &str, pipe: &str) -> bool {
    list.split([',', ';'])
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .any(|entry| entry == "*" || entry == pipe)
}

/// Whether this process is inside an agwinterm pane at all.
fn hosted(env: &SessionEnv) -> bool {
    match nonempty(env, ENABLED_VAR) {
        Some(value) => value != "0",
        None => false,
    }
}

/// A variable's value with the shell's padding taken off, or `None` when there is
/// nothing left.
///
/// Trimmed, because the CLI's copies of these rules trim (`pane.ts`'s `nonempty` is
/// `env[key]?.trim()`) and a reader that does not is a reader that disagrees: a pane
/// whose `AGWINTERM_SESSION_ID` arrived as `" s3 "` had the CLI clearing `s3` and the
/// engine drawing into `" s3 "`, and a padded `AGWINTERM_PIPE` failed
/// [`valid_pipe_name`] here while the CLI addressed it happily.
fn nonempty(env: &SessionEnv, key: &str) -> Option<String> {
    env.var(key)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// One message, naming everything that has to be true rather than reporting the
/// first thing that was not. A blank pane with no explanation is the failure this
/// exists to prevent.
fn not_hosted(missing: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "frames reach the pane through agwinterm's control pipe, and {missing}. \
             Run the browser inside an agwinterm pane, which sets {ENABLED_VAR}=1, \
             {SESSION_VAR}=<pane id> and {PIPE_VAR}=<pipe name>"
        ),
    )
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/// One dialled pipe, with a deadline on every exchange.
///
/// A named-pipe client is an ordinary file on Windows, and this used to be a
/// `BufReader<File>` for exactly that reason. It is not one any more: a blocking
/// `read_line` is a wait with no end, and this read happens on the render thread.
/// A host that accepts the connection and then stalls — inside its own
/// `File.ReadAllBytes`, say, on a `TEMP` redirected to a network share — would stop
/// rendering permanently, and stop *shutdown* too, because `PixelEngine::stop`
/// joins that thread. So the handle is opened `FILE_FLAG_OVERLAPPED` and every read
/// and write is collected with [`EXCHANGE_DEADLINE`] on it.
///
/// The cost of that is this struct: an overlapped handle cannot be read through
/// `std::io::Read`, which passes a null `OVERLAPPED` and would get undefined
/// results, so the line assembly is here rather than in a `BufReader`.
struct Connection {
    /// `None` only after [`Connection::drop`] has deliberately leaked it.
    pipe: Option<File>,
    /// The kernel's half of an in-flight operation. Heap-resident and never moved,
    /// because a cancelled operation completes on its own schedule.
    io: Option<Box<PendingIo>>,
    /// Bytes read past the reply's newline. The protocol is one reply per request
    /// (`ControlServer.cs:76-82`), so this is normally empty — but a chunk read is
    /// not a line read, and the remainder has to go somewhere.
    carry: Vec<u8>,
    /// Set when an operation was given up on before the kernel finished with it.
    /// See [`Connection::drop`].
    abandoned: bool,
}

/// Everything an in-flight overlapped operation points at.
///
/// Boxed and owned by the [`Connection`], because `CancelIoEx` only *asks*: until
/// the operation actually completes the kernel holds pointers to both fields and
/// may still write through them. A stack `OVERLAPPED` would be a use-after-free the
/// moment a timeout returned.
struct PendingIo {
    ov: OVERLAPPED,
    /// The write source or the read destination — never both at once, because an
    /// exchange writes its whole request before it reads a byte.
    scratch: Vec<u8>,
}

// SAFETY: a plain byte buffer and an `OVERLAPPED` whose `hEvent` is always null, so
// the only pointer-shaped field in it never points anywhere. The box is owned by one
// `Connection` and never shared, and Windows completes overlapped I/O against the
// handle rather than against the thread that started it — which is what lets the
// render thread be the only thread that ever touches this. `Connection` was `Send`
// as a `BufReader<File>`, and `ControlClient` lives in `Terminal`, so it stays one.
#[allow(unsafe_code)]
unsafe impl Send for PendingIo {}

/// How much of a reply to ask for at a time.
///
/// Replies are short — an envelope around a status string — so this is sized to
/// take every real one in a single read rather than to stream a large one well.
const READ_CHUNK: usize = 8 * 1024;

impl Connection {
    fn open(path: &str) -> io::Result<Self> {
        let mut attempt = 1;
        loop {
            match OpenOptions::new()
                .read(true)
                .write(true)
                // Not a performance choice. It is what makes a bounded wait possible
                // at all: a synchronous handle has no way to ask for a read that
                // gives up. See [`Connection`].
                .custom_flags(FILE_FLAG_OVERLAPPED)
                .open(path)
            {
                Ok(file) => {
                    return Ok(Self {
                        pipe: Some(file),
                        io: Some(Box::new(PendingIo {
                            ov: OVERLAPPED::default(),
                            scratch: Vec::new(),
                        })),
                        carry: Vec::new(),
                        abandoned: false,
                    });
                }
                // Every server instance is serving someone; agwinterm's accept loop
                // posts another as soon as one is taken, so this resolves itself.
                Err(err)
                    if err.raw_os_error() == Some(ERROR_PIPE_BUSY) && attempt < OPEN_ATTEMPTS =>
                {
                    attempt += 1;
                    std::thread::sleep(BUSY_WAIT);
                }
                Err(err) => {
                    return Err(io::Error::new(
                        err.kind(),
                        format!("could not reach agwinterm on {path} ({err})"),
                    ));
                }
            }
        }
    }

    /// One request line out, one reply line back, both inside one
    /// [`EXCHANGE_DEADLINE`]. The server is strictly request/response per connection
    /// (`ControlServer.cs:76-82`), so nothing else can arrive in between.
    ///
    /// The deadline covers the *exchange*, not each half of it, because what the
    /// caller is waiting for is the answer: a host that takes 900 ms to accept the
    /// request has already spent the frame's patience whether or not it then replies
    /// quickly.
    fn exchange(&mut self, request: &str) -> io::Result<String> {
        let deadline = Instant::now() + EXCHANGE_DEADLINE;
        self.write_all(request.as_bytes(), deadline)?;
        self.write_all(b"\n", deadline)?;
        self.read_line(deadline)
    }

    fn write_all(&mut self, bytes: &[u8], deadline: Instant) -> io::Result<()> {
        let mut sent = 0;
        while sent < bytes.len() {
            let chunk = &bytes[sent..];
            let io = self.io.as_mut().expect("a live connection has its buffers");
            io.scratch.clear();
            io.scratch.extend_from_slice(chunk);
            let moved = self.run(true, chunk.len(), deadline, "writing a request")?;
            if moved == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "agwinterm accepted none of the request",
                ));
            }
            sent += moved;
        }
        Ok(())
    }

    /// Reads until a newline, the cap, the deadline, or the host hanging up.
    fn read_line(&mut self, deadline: Instant) -> io::Result<String> {
        loop {
            if let Some(at) = self.carry.iter().position(|byte| *byte == b'\n') {
                let rest = self.carry.split_off(at + 1);
                let line = std::mem::replace(&mut self.carry, rest);
                return Ok(String::from_utf8_lossy(&line).into_owned());
            }
            // Capped, because this read is on the render thread and the reply is one
            // line from a peer that only has to be listening on the name to be
            // talking to us. `cli/src/control.ts` caps its half of the identical
            // protocol for the same reason. Only the reply that *fills* the cap is
            // refused; one that simply ends at EOF without its newline is still a
            // reply, and was accepted before.
            let room = MAX_REPLY_BYTES.saturating_sub(self.carry.len() as u64);
            if room == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("agwinterm's reply passed {MAX_REPLY_BYTES} bytes with no newline"),
                ));
            }
            let want = room.min(READ_CHUNK as u64) as usize;
            let io = self.io.as_mut().expect("a live connection has its buffers");
            io.scratch.clear();
            io.scratch.resize(want, 0);
            let read = match self.run(false, want, deadline, "waiting for a reply") {
                Ok(read) => read,
                // A hangup is not an error here — it ends the reply. Which of the
                // three the kernel reports depends on how the server end went away.
                Err(err) if ended(&err) => 0,
                Err(err) => return Err(err),
            };
            if read == 0 {
                if self.carry.is_empty() {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "agwinterm closed the control pipe before answering",
                    ));
                }
                let line = std::mem::take(&mut self.carry);
                return Ok(String::from_utf8_lossy(&line).into_owned());
            }
            let io = self.io.as_ref().expect("a live connection has its buffers");
            let chunk = io.scratch[..read].to_vec();
            self.carry.extend_from_slice(&chunk);
        }
    }

    /// One overlapped read or write, collected with whatever is left of `deadline`.
    ///
    /// `what` names the half of the exchange for the timeout message, because
    /// "agwinterm did not answer" and "agwinterm did not take the request" are
    /// different hosts to go and look at.
    #[allow(unsafe_code)]
    fn run(&mut self, write: bool, len: usize, deadline: Instant, what: &str) -> io::Result<usize> {
        let handle: HANDLE = self
            .pipe
            .as_ref()
            .expect("a live connection has its handle")
            .as_raw_handle()
            .cast();
        let io = self.io.as_mut().expect("a live connection has its buffers");
        io.ov = OVERLAPPED::default();
        let len = u32::try_from(len).expect("READ_CHUNK and one request line both fit a u32");
        let buffer = io.scratch.as_mut_ptr();
        let overlapped: *mut OVERLAPPED = &raw mut io.ov;
        // SAFETY: `handle` is the live pipe borrowed for this call; `buffer` points
        // at `len` bytes of `scratch`, which the caller just sized; `overlapped`
        // points at the boxed `OVERLAPPED`. Both outlive the operation — that is what
        // `PendingIo` and the leak in `drop` are for. The null count pointer is the
        // documented form for an overlapped call, whose byte count comes from
        // `GetOverlappedResultEx` instead.
        let started = unsafe {
            if write {
                WriteFile(handle, buffer, len, std::ptr::null_mut(), overlapped)
            } else {
                ReadFile(handle, buffer, len, std::ptr::null_mut(), overlapped)
            }
        };
        if started == 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                return Err(err);
            }
        }
        // Even a synchronous completion is collected here, so there is one path that
        // turns an `OVERLAPPED` into a byte count.
        let mut moved: u32 = 0;
        let wait = millis_until(deadline);
        // SAFETY: as above; `moved` is a live local for the duration of the call.
        let done = unsafe { GetOverlappedResultEx(handle, overlapped, &mut moved, wait, 0) };
        if done != 0 {
            return Ok(moved as usize);
        }
        let err = io::Error::last_os_error();
        if !still_pending(&err) {
            return Err(err);
        }
        self.give_up(handle, overlapped, &mut moved);
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!(
                "agwinterm did not respond within {} ms while {what}",
                EXCHANGE_DEADLINE.as_millis()
            ),
        ))
    }

    /// Cancels a timed-out operation and decides whether the connection can still be
    /// closed.
    #[allow(unsafe_code)]
    fn give_up(&mut self, handle: HANDLE, overlapped: *mut OVERLAPPED, moved: &mut u32) {
        // SAFETY: `handle` and `overlapped` are the ones the operation was started
        // with, and both are still alive — `overlapped` points into the box this
        // connection owns.
        unsafe {
            CancelIoEx(handle, overlapped);
        }
        // Cancellation is an ask, not an act: the operation completes when the kernel
        // gets to it, with `ERROR_OPERATION_ABORTED`. Waiting for that is what makes
        // the buffers reusable — or, here, freeable.
        //
        // SAFETY: as above.
        let settled =
            unsafe { GetOverlappedResultEx(handle, overlapped, moved, CANCEL_GRACE_MS, 0) };
        if settled == 0 && still_pending(&io::Error::last_os_error()) {
            // A cancellation that will not complete leaves the kernel holding
            // pointers into this connection. Freeing them is the one thing worse than
            // leaking them, so the connection is abandoned instead.
            self.abandoned = true;
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if !self.abandoned {
            return;
        }
        // An operation the kernel has not finished with may still write into
        // `scratch` and into the `OVERLAPPED`, and closing the handle does not change
        // that. So both are leaked, and the handle with them: `CloseHandle` is what
        // would let the address space be reused underneath the write.
        //
        // Unreachable in practice — a cancelled pipe read completes in microseconds —
        // and it costs one buffer and one handle when it is not.
        crate::logging::warn(
            "agwinterm",
            "a timed-out control-pipe operation would not cancel; \
             the connection is abandoned rather than closed",
        );
        std::mem::forget(self.pipe.take());
        std::mem::forget(self.io.take());
    }
}

/// Whether an error out of a read means "the reply ended", as opposed to "the read
/// failed".
///
/// A named pipe reports the far end going away as a failed `ReadFile` rather than as
/// zero bytes, so the three ways agwinterm can vanish mid-reply all arrive here.
fn ended(err: &io::Error) -> bool {
    matches!(err.kind(), io::ErrorKind::BrokenPipe)
        || matches!(
            err.raw_os_error(),
            Some(ERROR_NO_DATA) | Some(ERROR_PIPE_NOT_CONNECTED)
        )
}

/// Whether a failed collect means the operation is still in the kernel's hands.
///
/// The two codes `GetOverlappedResultEx` reports for "not finished": `WAIT_TIMEOUT`
/// when the wait it was given expired, [`ERROR_IO_INCOMPLETE`] when it was given no
/// wait at all. Anything else is a completion — with a status, possibly a failure —
/// and the buffers are the caller's again.
fn still_pending(err: &io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        Some(code) if code == WAIT_TIMEOUT as i32 || code == ERROR_IO_INCOMPLETE
    )
}

/// The deadline as the `dwMilliseconds` a Win32 wait takes.
///
/// Rounded **up**, and clamped away from both ends of the range:
///
///   - never zero, because a zero wait does not time out — it returns
///     [`ERROR_IO_INCOMPLETE`] immediately, on a read that is still pending. One
///     millisecond of over-wait is the price of every expiry taking the same path.
///   - never `u32::MAX`, which is `INFINITE`: the fallback for an arithmetic result
///     that does not fit would otherwise be "wait forever", which is the exact state
///     this whole rewrite exists to remove. Unreachable while
///     [`EXCHANGE_DEADLINE`] is a constant of 1040 ms, and a landmine the moment it
///     is not.
///   - rounded up rather than truncated so the collected wait is never *shorter*
///     than what is left of the deadline, which is what makes "the exchange took at
///     least `EXCHANGE_DEADLINE`" true rather than nearly true.
fn millis_until(deadline: Instant) -> u32 {
    let left = deadline.saturating_duration_since(Instant::now());
    let ms = left.as_millis() + u128::from(!left.subsec_nanos().is_multiple_of(1_000_000));
    u32::try_from(ms)
        .unwrap_or(u32::MAX - 1)
        .clamp(1, u32::MAX - 1)
}

/// Whether a failed exchange is worth re-dialling for, as opposed to reporting.
///
/// The distinction that matters: "the host went away mid-conversation" is
/// recoverable, "there is no host" is not — otherwise a missing agwinterm would be
/// retried forever instead of explained once.
///
/// [`io::ErrorKind::TimedOut`] is deliberately absent. A host that accepted the
/// request and then went quiet has not gone away; replaying the request would ask a
/// host that is already behind to do the work twice, and would spend a second
/// [`EXCHANGE_DEADLINE`] finding out. The connection is dropped and the error is
/// reported — the caller is better placed to decide than a retry loop is.
fn recoverable(err: &io::Error) -> bool {
    if matches!(
        err.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::UnexpectedEof
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::NotConnected
    ) {
        return true;
    }
    matches!(
        err.raw_os_error(),
        Some(ERROR_NO_DATA) | Some(ERROR_PIPE_NOT_CONNECTED)
    )
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/// A parsed `{"ok":…}` envelope.
///
/// `Ok` holds the `result` **as raw JSON**, because agwinterm answers with a string
/// for most verbs (`Ok`) and with an object for the structured ones (`OkRaw`), and
/// the caller is the only one that knows which it asked for. `Err` holds the
/// decoded message, which is always a string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Reply {
    Ok(String),
    Err(String),
}

impl Reply {
    fn parse(line: &str) -> io::Result<Self> {
        let line = line.trim();
        let malformed = |what: &str| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("agwinterm's reply {what}: {line}"),
            )
        };
        let ok = field_bool(line, "ok").ok_or_else(|| malformed("has no \"ok\" field"))?;
        let key = if ok { "result" } else { "error" };
        let raw = tail_value(line, key).ok_or_else(|| malformed(&format!("has no \"{key}\"")))?;
        Ok(if ok {
            Self::Ok(raw.to_owned())
        } else {
            Self::Err(unquote(raw).unwrap_or_else(|| raw.to_owned()))
        })
    }

    /// The `result`'s raw JSON, turning a refusal into an error.
    pub(crate) fn result(self) -> io::Result<String> {
        match self {
            Self::Ok(raw) => Ok(raw),
            Self::Err(message) => Err(io::Error::other(format!(
                "agwinterm refused the request: {message}"
            ))),
        }
    }

    /// The `result` of a verb that answers with a string, unescaped.
    pub(crate) fn text(self) -> io::Result<String> {
        let raw = self.result()?;
        Ok(unquote(&raw).unwrap_or(raw))
    }
}

/// A top-level value that runs to the end of the envelope — which is where
/// `result` and `error` always are, since `Ok`/`OkRaw`/`Err` put them last.
fn tail_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\":");
    let at = line.find(&needle)? + needle.len();
    line[at..].trim().strip_suffix('}').map(str::trim)
}

fn value_after<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\":");
    let at = json.find(&needle)? + needle.len();
    Some(json[at..].trim_start())
}

fn field_bool(json: &str, key: &str) -> Option<bool> {
    match value_after(json, key)? {
        rest if rest.starts_with("true") => Some(true),
        rest if rest.starts_with("false") => Some(false),
        _ => None,
    }
}

fn field_u32(json: &str, key: &str) -> Option<u32> {
    let rest = value_after(json, key)?;
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// Decodes a JSON string literal, including the `\uXXXX` escapes .NET's
/// `JsonSerializer` emits by default — an apostrophe in `unknown command
/// 'session.metrics'` arrives as `\u0027`, so this is not optional.
fn unquote(raw: &str) -> Option<String> {
    let body = raw.strip_prefix('"')?;
    let mut units: Vec<u16> = Vec::new();
    let mut buf = [0u16; 2];
    let mut chars = body.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(String::from_utf16_lossy(&units)),
            '\\' => match chars.next()? {
                'n' => units.push(u16::from(b'\n')),
                'r' => units.push(u16::from(b'\r')),
                't' => units.push(u16::from(b'\t')),
                'b' => units.push(0x08),
                'f' => units.push(0x0c),
                'u' => {
                    let hex: String = chars.by_ref().take(4).collect();
                    units.push(u16::from_str_radix(&hex, 16).ok()?);
                }
                // `"`, `\`, `/` and anything else stand for themselves.
                other => units.extend_from_slice(other.encode_utf16(&mut buf)),
            },
            other => units.extend_from_slice(other.encode_utf16(&mut buf)),
        }
    }
    None
}

/// Appends a JSON string literal. Control characters go out as `\uXXXX` rather
/// than raw, because a newline inside a value would split the request line in two.
pub(crate) fn push_quoted(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/// A lazily-connected control-pipe client for one pane.
///
/// Construction does not dial: resolving the target is what can fail informatively,
/// and a browser that starts before agwinterm has posted a server instance should
/// connect on its first frame rather than refuse to start.
pub(crate) struct ControlClient {
    target: HostTarget,
    conn: Option<Connection>,
    /// Latched once the host has said it does not know [`METRICS_CMD`], so a
    /// resize does not re-ask a host that will never answer.
    metrics_unsupported: bool,
}

impl ControlClient {
    pub(crate) fn from_env(env: &SessionEnv) -> io::Result<Self> {
        Ok(Self::to(HostTarget::from_env(env)?))
    }

    pub(crate) fn to(target: HostTarget) -> Self {
        Self {
            target,
            conn: None,
            metrics_unsupported: false,
        }
    }

    pub(crate) fn target(&self) -> &HostTarget {
        &self.target
    }

    /// Builds `{"cmd":…,"target":…,"window":…,"args":…}` and sends it.
    ///
    /// `window` is omitted when the host did not name one, which is what a
    /// single-window host and every host predating multi-window look like. When it
    /// is there it is load-bearing rather than decorative: see [`WINDOW_VAR`].
    ///
    /// `args` is raw JSON — an object literal the caller composed — because the
    /// frame verb's `images` array is built once per frame and a generic value
    /// type would allocate its way through the frame budget for nothing.
    pub(crate) fn send(&mut self, cmd: &str, args: Option<&str>) -> io::Result<Reply> {
        let mut line = String::from("{\"cmd\":");
        push_quoted(&mut line, cmd);
        line.push_str(",\"target\":");
        push_quoted(&mut line, &self.target.session);
        if let Some(window) = &self.target.window {
            line.push_str(",\"window\":");
            push_quoted(&mut line, window);
        }
        if let Some(args) = args {
            line.push_str(",\"args\":");
            line.push_str(args);
        }
        line.push('}');
        self.request(&line)
    }

    /// One request, with one reconnect if the pipe died under it.
    pub(crate) fn request(&mut self, line: &str) -> io::Result<Reply> {
        match self.attempt(line) {
            Err(err) if recoverable(&err) => {
                crate::logging::info(
                    "agwinterm",
                    format!("the control pipe went away ({err}); reconnecting"),
                );
                self.attempt(line)
            }
            other => other,
        }
    }

    /// One request, no retry. Any failure drops the connection, because a
    /// half-written request or an unread reply would desynchronise the next one.
    fn attempt(&mut self, line: &str) -> io::Result<Reply> {
        if self.conn.is_none() {
            self.conn = Some(Connection::open(&self.target.path())?);
        }
        let outcome = self
            .conn
            .as_mut()
            .expect("just opened")
            .exchange(line)
            .and_then(|reply| Reply::parse(&reply));
        if outcome.is_err() {
            self.conn = None;
        }
        outcome
    }

    /// `ping`, which every agwinterm implements — the cheapest proof that the pipe
    /// leads somewhere.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "driven only by the pipe fixture's round-trip tests; the frame path never pings, because the `image.frame` reply is itself the proof"
        )
    )]
    pub(crate) fn ping(&mut self) -> io::Result<String> {
        self.send("ping", None)?.text()
    }

    /// The pane's geometry, if this host publishes it.
    ///
    /// `Ok(None)` is the load-bearing case: a host that predates
    /// [`METRICS_CMD`] answers `unknown command`, which is a capability gap and
    /// not an error — the port is specified to work without it, resampled. A
    /// refusal for any *other* reason (no such pane, say) is a real error and is
    /// reported.
    pub(crate) fn pane_metrics(&mut self) -> io::Result<Option<PaneMetrics>> {
        if self.metrics_unsupported {
            return Ok(None);
        }
        match self.send(METRICS_CMD, None)? {
            Reply::Ok(raw) => match PaneMetrics::parse(&raw) {
                Some(metrics) => Ok(Some(metrics)),
                None => {
                    crate::logging::warn(
                        "agwinterm",
                        format!("`{METRICS_CMD}` answered without usable cell metrics: {raw}"),
                    );
                    Ok(None)
                }
            },
            // Shared with the frame transports' probe rather than open-coded:
            // there is one reading of `unknown command`, and every capability
            // question in this crate asks it the same way.
            Reply::Err(message) if crate::frame_shm::is_unknown_command(&message, METRICS_CMD) => {
                self.metrics_unsupported = true;
                crate::logging::info(
                    "agwinterm",
                    format!(
                        "this agwinterm does not publish cell metrics ({message}); \
                         set {CELL_PX_VAR}=<width>x<height> to render at the pane's \
                         real resolution"
                    ),
                );
                Ok(None)
            }
            refusal => refusal.result().map(|_| None),
        }
    }
}

/// What [`METRICS_CMD`] answers with. See `docs/design/04-cell-metrics.md` for the
/// wire shape and who implements it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PaneMetrics {
    pub(crate) cols: u32,
    pub(crate) rows: u32,
    pub(crate) cell_width: u32,
    pub(crate) cell_height: u32,
    pub(crate) width_px: u32,
    pub(crate) height_px: u32,
}

impl PaneMetrics {
    /// `None` when the cell size is missing, zero, or past [`MAX_CELL_PX`] — the
    /// only two fields anything downstream cannot do without, and the two it
    /// cannot do without being *plausible*. `cols`/`rows` default to zero rather
    /// than failing the whole reply, since the console screen buffer supplies those
    /// too.
    fn parse(raw: &str) -> Option<Self> {
        let cell_width = field_u32(raw, "cellWidth").filter(|width| plausible_cell(*width))?;
        let cell_height = field_u32(raw, "cellHeight").filter(|height| plausible_cell(*height))?;
        Some(Self {
            cols: field_u32(raw, "cols").unwrap_or(0),
            rows: field_u32(raw, "rows").unwrap_or(0),
            cell_width,
            cell_height,
            width_px: field_u32(raw, "widthPx").unwrap_or(0),
            height_px: field_u32(raw, "heightPx").unwrap_or(0),
        })
    }
}

// ---------------------------------------------------------------------------
// Cell metrics
// ---------------------------------------------------------------------------

/// The size of one character cell in pixels — the port plan's Task 6 decision, in
/// code. `docs/design/04-cell-metrics.md` records why it is shaped this way.
///
/// Three sources, in order:
///
/// 1. **[`CELL_PX_VAR`]**, if it parses. First because it is the only source that
///    exists before the host verb ships, and because it is how a user corrects a
///    host that reports the wrong thing.
/// 2. **[`METRICS_CMD`]**, the verb agwinterm's Task 6b adds.
/// 3. **[`FALLBACK_CELL`]**, with a warning naming the fix.
///
/// Infallible on purpose. A `None` here would be substituted by
/// `engine/mod.rs:347` with a number this backend does not know, and the pointer
/// would then be mapped in a different coordinate space than the canvas is drawn
/// in — which is the failure that actually moves click targets.
pub(crate) fn cell_size(client: Option<&mut ControlClient>, env: &SessionEnv) -> (u32, u32) {
    if let Some(cell) = cell_override(env) {
        crate::logging::info(
            "agwinterm",
            format!("cell metrics {}x{}px from {CELL_PX_VAR}", cell.0, cell.1),
        );
        return cell;
    }
    if let Some(client) = client {
        match client.pane_metrics() {
            Ok(Some(metrics)) => {
                crate::logging::info(
                    "agwinterm",
                    format!(
                        "cell metrics {}x{}px from `{METRICS_CMD}`",
                        metrics.cell_width, metrics.cell_height
                    ),
                );
                return (metrics.cell_width, metrics.cell_height);
            }
            Ok(None) => {}
            Err(err) => crate::logging::warn(
                "agwinterm",
                format!("asking for pane metrics failed ({err})"),
            ),
        }
    }
    crate::logging::warn(
        "agwinterm",
        format!(
            "no cell metrics: this host publishes none and {CELL_PX_VAR} is unset, so \
             frames are rendered at {}x{}px per cell and agwinterm resamples them to \
             fit the pane. Set {CELL_PX_VAR}=<width>x<height> to render sharp",
            FALLBACK_CELL.0, FALLBACK_CELL.1
        ),
    );
    FALLBACK_CELL
}

/// `<width>x<height>`. A value that is present but unreadable is complained about
/// rather than ignored — a typo here is otherwise indistinguishable from not
/// having set it.
fn cell_override(env: &SessionEnv) -> Option<(u32, u32)> {
    let raw = env.var(CELL_PX_VAR)?;
    match parse_cell_px(&raw) {
        Some(cell) => Some(cell),
        None => {
            crate::logging::warn(
                "agwinterm",
                format!("{CELL_PX_VAR}={raw:?} is not <width>x<height> in pixels; ignoring it"),
            );
            None
        }
    }
}

fn parse_cell_px(raw: &str) -> Option<(u32, u32)> {
    let (width, height) = raw.trim().split_once(['x', 'X'])?;
    let cell = (
        width.trim().parse::<u32>().ok()?,
        height.trim().parse::<u32>().ok()?,
    );
    (plausible_cell(cell.0) && plausible_cell(cell.1)).then_some(cell)
}

/// A cell dimension that could describe a real character cell. See [`MAX_CELL_PX`]
/// for why the upper bound exists at all.
fn plausible_cell(px: u32) -> bool {
    px > 0 && px <= MAX_CELL_PX
}

#[cfg(test)]
pub(crate) mod fixture {
    //! A real named-pipe server, in this process, scripted turn by turn.
    //!
    //! It lives beside the client rather than inside `mod tests` because Task 7's
    //! frame publisher is tested against it too: the claim that a frame reaches
    //! agwinterm is a claim about bytes on a pipe, and a second mock would be a
    //! second guess about Win32 rather than a second check of the same one.

    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::io::FromRawHandle;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;

    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW};

    /// `ERROR_PIPE_CONNECTED`: the client got there between `CreateNamedPipeW` and
    /// `ConnectNamedPipe`. Success, spelled as a failure.
    const ERROR_PIPE_CONNECTED: i32 = 535;
    const PIPE_UNLIMITED_INSTANCES: u32 = 255;

    /// What the server does with the next request it reads.
    #[derive(Clone, Debug)]
    pub(crate) enum Turn {
        /// Answer with this line.
        Reply(String),
        /// Read the request and close the connection without answering — the
        /// shape of a host that exits, or of `ControlServer.cs:84` swallowing an
        /// `IOException` mid-conversation.
        Hangup,
        /// Answer, but only after this long. A host that is slow rather than stuck,
        /// which is the case [`EXCHANGE_DEADLINE`] must *not* fail.
        ReplyAfter(Duration, String),
        /// Read the request and then answer nothing at all, holding the connection
        /// open. This is the failure the deadline exists for: not a pipe that died,
        /// which the client already recovers from, but a live one nobody is going to
        /// speak on. It ends when the [`PipeServer`] is dropped, or after
        /// [`STALL_CAP`] so that a test which forgets to drop it still terminates.
        Stall,
    }

    /// The longest a [`Turn::Stall`] holds its thread if nothing tells it to stop.
    /// Far past any deadline under test; it is a backstop, not a timing knob.
    const STALL_CAP: Duration = Duration::from_secs(30);

    /// A real named-pipe server, scripted turn by turn.
    ///
    /// It re-accepts after every hangup, so a script of `[Hangup, Reply(..)]` is
    /// exactly "the connection died and the client reconnected". Requests are
    /// recorded before the reply goes out, so an assertion that sees the reply can
    /// rely on seeing the request.
    pub(crate) struct PipeServer {
        pub(crate) name: String,
        requests: Arc<Mutex<Vec<String>>>,
        /// Set by [`PipeServer::drop`] so a stalling turn lets go of its thread.
        closing: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl PipeServer {
        pub(crate) fn scripted(turns: Vec<Turn>) -> Self {
            static SEQ: AtomicU32 = AtomicU32::new(0);
            let name = format!(
                "pixel-core-test-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            );
            let requests = Arc::new(Mutex::new(Vec::new()));
            let closing = Arc::new(AtomicBool::new(false));
            // The constructor does not return until the first instance exists.
            // Without this the client races the server thread and every pipe test
            // below fails as "no such pipe", which is a different test.
            let (ready, listening) = std::sync::mpsc::sync_channel(0);
            let thread = std::thread::spawn({
                let name = name.clone();
                let requests = Arc::clone(&requests);
                let closing = Arc::clone(&closing);
                move || serve(&name, turns, &requests, &closing, &ready)
            });
            listening
                .recv()
                .expect("the server thread announces its first instance")
                .expect("a private pipe name is free");
            Self {
                name,
                requests,
                closing,
                thread: Some(thread),
            }
        }

        /// A server that answers every request with the same line, eight times —
        /// enough for any single conversation, and finite so a test that loops
        /// forever fails rather than hangs.
        pub(crate) fn always(reply: &str) -> Self {
            Self::answering(reply, 8)
        }

        /// The same, for a test that knows how many requests it will make.
        pub(crate) fn answering(reply: &str, turns: usize) -> Self {
            Self::scripted(vec![Turn::Reply(reply.to_owned()); turns])
        }

        pub(crate) fn client(&self) -> ControlClient {
            ControlClient::to(HostTarget {
                pipe: self.name.clone(),
                session: "s3".to_owned(),
                window: None,
            })
        }

        /// The same client, in a host that named the window our pane is in.
        pub(crate) fn client_in_window(&self, window: &str) -> ControlClient {
            let mut target = self.client().target;
            target.window = Some(window.to_owned());
            ControlClient::to(target)
        }

        pub(crate) fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("no test panics here").clone()
        }
    }

    impl Drop for PipeServer {
        fn drop(&mut self) {
            // A stalling turn is the one kind of thread that *can* be released, and
            // releasing it closes the connection the test left open.
            self.closing.store(true, Ordering::Relaxed);
            // Otherwise deliberately not joined: a script the test did not exhaust
            // leaves the thread parked in `ConnectNamedPipe`, and joining it would
            // hang the suite. The handle is dropped, the thread ends with the
            // process.
            drop(self.thread.take());
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    /// A fresh server instance, owned by the returned `File` so it is closed once.
    #[allow(unsafe_code)]
    fn instance(name: &str) -> io::Result<File> {
        let path = wide(&format!(r"\\.\pipe\{name}"));
        // SAFETY: `path` is a NUL-terminated wide string that outlives the call and
        // the last argument is the documented "no security attributes" null. Byte
        // mode and blocking waits are all-zero flags, so `dwPipeMode` is 0.
        let handle: HANDLE = unsafe {
            CreateNamedPipeW(
                path.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                0,
                PIPE_UNLIMITED_INSTANCES,
                4096,
                4096,
                0,
                std::ptr::null(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `handle` is a valid file handle and ownership moves to the `File`,
        // which is the only thing that will close it.
        Ok(unsafe { File::from_raw_handle(handle.cast()) })
    }

    /// Blocks until a client arrives on this instance.
    #[allow(unsafe_code)]
    fn accept(pipe: &File) -> io::Result<()> {
        // SAFETY: `pipe` owns a live server end for the duration of the borrow, and
        // the null overlapped pointer is the documented synchronous form.
        let connected =
            unsafe { ConnectNamedPipe(pipe.as_raw_handle().cast(), std::ptr::null_mut()) };
        if connected == 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(ERROR_PIPE_CONNECTED) {
                return Err(err);
            }
        }
        Ok(())
    }

    fn serve(
        name: &str,
        turns: Vec<Turn>,
        requests: &Arc<Mutex<Vec<String>>>,
        closing: &Arc<AtomicBool>,
        ready: &std::sync::mpsc::SyncSender<io::Result<()>>,
    ) {
        let mut pending = match instance(name) {
            Ok(pipe) => {
                let _ = ready.send(Ok(()));
                pipe
            }
            Err(err) => {
                let _ = ready.send(Err(err));
                return;
            }
        };
        let mut turns = turns.into_iter();
        loop {
            if accept(&pending).is_err() {
                return;
            }
            let pipe = pending;
            // Post the next instance *before* serving this one, so the pipe name
            // never disappears in the gap between a hangup and the reconnect.
            pending = match instance(name) {
                Ok(next) => next,
                Err(_) => return,
            };
            let mut reader = BufReader::new(pipe);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
                requests
                    .lock()
                    .expect("no test panics here")
                    .push(line.trim().to_owned());
                match turns.next() {
                    Some(Turn::Reply(reply)) => {
                        let pipe = reader.get_mut();
                        if pipe.write_all(reply.as_bytes()).is_err()
                            || pipe.write_all(b"\n").is_err()
                        {
                            return;
                        }
                    }
                    Some(Turn::ReplyAfter(delay, reply)) => {
                        std::thread::sleep(delay);
                        let pipe = reader.get_mut();
                        if pipe.write_all(reply.as_bytes()).is_err()
                            || pipe.write_all(b"\n").is_err()
                        {
                            return;
                        }
                    }
                    // Hold the connection open and say nothing. Returning would close
                    // it, which is the *other* failure — the one the client already
                    // recovers from.
                    Some(Turn::Stall) => {
                        let cap = Instant::now() + STALL_CAP;
                        while !closing.load(Ordering::Relaxed) && Instant::now() < cap {
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        return;
                    }
                    // Break out to close this connection and accept a fresh one.
                    Some(Turn::Hangup) => break,
                    None => return,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! Two kinds of test here, and the split is deliberate.
    //!
    //! The envelope, the addressing and the metrics decision are pure functions of
    //! text and environment, and are tested as such. Everything that claims
    //! something about *a named pipe* is driven against a real
    //! `CreateNamedPipeW` server in this process — round-trip, an error envelope,
    //! a server that hangs up mid-request, and a pipe nobody is serving — because
    //! the interesting cases are precisely the ones a mock would encode a guess
    //! about.

    use super::fixture::{PipeServer, Turn};
    use super::*;
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn env_of(pairs: &[(&str, &str)]) -> SessionEnv {
        SessionEnv::of_session(
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect::<HashMap<_, _>>(),
        )
    }

    fn pane_env() -> SessionEnv {
        env_of(&[
            (ENABLED_VAR, "1"),
            (PIPE_VAR, "agwinterm-dev"),
            (SESSION_VAR, "s3"),
        ])
    }

    // -- host detection ---------------------------------------------------

    #[test]
    fn a_pane_supplies_the_pipe_and_the_id_to_address() {
        let target = HostTarget::from_env(&pane_env()).expect("a pane is a host");
        assert_eq!(target.session(), "s3");
        assert_eq!(target.path(), r"\\.\pipe\agwinterm-dev");
    }

    #[test]
    fn the_pipe_name_falls_back_to_the_one_agwintermctl_uses() {
        let target = HostTarget::from_env(&env_of(&[(ENABLED_VAR, "1"), (SESSION_VAR, "s3")]))
            .expect("the pipe name is optional");
        assert_eq!(target.path(), format!(r"\\.\pipe\{DEFAULT_PIPE}"));
    }

    #[test]
    fn a_pipe_name_that_could_leave_the_pipe_namespace_is_refused() {
        // `\\.\pipe\<name>` is a device path, and unlike `\\?\` it is normalised
        // before the object manager sees it — so a `..\` in the name walks out into
        // the filesystem, and `Connection::open`, which asks for read *and* write,
        // becomes an open of whatever it lands on, with the request line written
        // over its first bytes. The value comes from the environment, and in the
        // daemon shape the environment is handed over a control channel rather than
        // inherited, so it is checked rather than trusted. The allowed set is
        // `store/src/endpoint.ts`'s `pipeSegment`, which guards the names this
        // project creates.
        for hostile in [
            r"..\..\Users\me\.ssh\config",
            r"..\C:\Windows\System32\drivers\etc\hosts",
            "a/b",
            r"sub\name",
            "name with spaces",
        ] {
            let err = HostTarget::from_env(&env_of(&[
                (ENABLED_VAR, "1"),
                (SESSION_VAR, "s3"),
                (PIPE_VAR, hostile),
            ]))
            .unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::NotFound);
            assert!(
                err.to_string().contains(PIPE_VAR),
                "the refusal has to name the variable to fix: {err}",
            );
        }
    }

    #[test]
    fn the_pipe_names_agwinterm_actually_uses_still_pass() {
        // A guard that refuses the host is worse than no guard. These are the shapes
        // agwinterm and `agwintermctl` produce.
        for allowed in [
            DEFAULT_PIPE,
            "agwinterm-dev",
            "agwinterm.boris",
            "agw_1_2-3",
        ] {
            let target = HostTarget::from_env(&env_of(&[
                (ENABLED_VAR, "1"),
                (SESSION_VAR, "s3"),
                (PIPE_VAR, allowed),
            ]))
            .unwrap_or_else(|err| panic!("{allowed:?} is a pipe name: {err}"));
            assert_eq!(target.path(), format!(r"\\.\pipe\{allowed}"));
        }
    }

    #[test]
    fn a_shell_that_padded_the_values_still_names_the_same_pane() {
        // The CLI's copies of these rules trim (`pane.ts`'s `nonempty`), so a reader
        // here that did not was a reader that disagreed: the clear went to `s3` and
        // the frame to `" s3 "`, and a padded pipe name failed `valid_pipe_name`
        // here while `paneClearRequest` addressed it.
        let target = HostTarget::from_env(&env_of(&[
            (ENABLED_VAR, " 1 "),
            (SESSION_VAR, " s3 "),
            (PIPE_VAR, " agwinterm-dev "),
        ]))
        .expect("padding is not part of the value");
        assert_eq!(target.session(), "s3");
        assert_eq!(target.path(), r"\\.\pipe\agwinterm-dev");
    }

    #[test]
    fn the_pane_id_stands_in_when_only_it_is_set() {
        let target = HostTarget::from_env(&env_of(&[(ENABLED_VAR, "1"), (PANE_VAR, "w1:p2")]))
            .expect("a pane id addresses a pane");
        assert_eq!(target.session(), "w1:p2");
    }

    #[test]
    fn without_the_enabled_flag_the_error_names_everything_that_is_required() {
        let err = HostTarget::from_env(&env_of(&[])).expect_err("nothing to draw into");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        let message = err.to_string();
        for required in [ENABLED_VAR, SESSION_VAR, PIPE_VAR] {
            assert!(
                message.contains(required),
                "{required} is not named in {message:?}",
            );
        }
    }

    #[test]
    fn a_host_with_no_pane_id_is_refused_rather_than_defaulted() {
        let err = HostTarget::from_env(&env_of(&[(ENABLED_VAR, "1")]))
            .expect_err("there is no pane to address");
        assert!(err.to_string().contains(SESSION_VAR), "{err}");

        // Empty is the same as absent: agwinterm would read "" as null, and null
        // resolves to the active pane.
        assert!(
            HostTarget::from_env(&env_of(&[(ENABLED_VAR, "1"), (SESSION_VAR, "")])).is_err(),
            "an empty id must not become \"whichever pane is in front\"",
        );
    }

    #[test]
    fn the_literal_active_is_refused_because_it_is_not_this_pane() {
        let err = HostTarget::from_env(&env_of(&[(ENABLED_VAR, "1"), (SESSION_VAR, "active")]))
            .expect_err("\"active\" is whichever pane the user switched to");
        assert!(err.to_string().contains("active"), "{err}");
    }

    #[test]
    fn a_disabled_flag_is_not_a_host() {
        for value in ["", "0"] {
            assert!(
                HostTarget::from_env(&env_of(&[(ENABLED_VAR, value), (SESSION_VAR, "s3")]))
                    .is_err(),
                "{ENABLED_VAR}={value:?} claims a host that is not there",
            );
        }
    }

    // -- the development-instance guard -----------------------------------

    #[test]
    fn a_dev_build_refuses_a_pipe_the_allow_list_does_not_name() {
        let refusal = pipe_refusal(Some("agwinterm-dev"), DEFAULT_PIPE, false, true)
            .expect("a dev build must not publish into the instance it is running in");
        // The variable has to be in the message: a refusal that does not name the
        // way out is a browser that will not start for a reason the user cannot see.
        assert!(refusal.contains(ALLOW_PIPE_VAR), "{refusal}");
        assert!(refusal.contains(DEFAULT_PIPE), "{refusal}");
        // The fallback is the case that actually wrecked a pane, so it says so
        // rather than reporting a value nobody set.
        let unset = format!("{PIPE_VAR} is unset");
        assert!(refusal.contains(&unset), "{refusal}");
    }

    #[test]
    fn a_dev_build_publishes_into_the_instance_it_was_told_to_use() {
        assert_eq!(
            pipe_refusal(Some("agwinterm-dev"), "agwinterm-dev", true, true),
            None,
        );
        // A list, spelled either way a shell hands one over, and padded.
        for list in [
            "agwinterm-dev,other",
            "other;agwinterm-dev",
            " other , agwinterm-dev ",
            "*",
        ] {
            assert_eq!(
                pipe_refusal(Some(list), "agwinterm-dev", true, true),
                None,
                "{list:?} names the pipe and was refused anyway",
            );
        }
    }

    #[test]
    fn the_guard_is_off_until_the_variable_is_set() {
        // The constraint the port ships under: on Windows the product *is* a
        // checkout, so a guard that refused by default would refuse every ordinary
        // run. Unset means unchanged.
        assert_eq!(pipe_refusal(None, DEFAULT_PIPE, false, true), None);
        assert_eq!(pipe_refusal(Some("   "), DEFAULT_PIPE, false, true), None);
    }

    #[test]
    fn a_release_build_ignores_the_variable_entirely() {
        // A shipped browser publishes where the pane says. Otherwise a value left in
        // a shell profile would stop a browser somebody paid no attention to it in.
        assert_eq!(
            pipe_refusal(Some("agwinterm-dev"), DEFAULT_PIPE, false, false),
            None,
        );
        assert_eq!(pipe_refusal(Some(""), "anything", true, false), None);
    }

    #[test]
    fn the_refusal_reaches_from_env_as_a_permission_error() {
        // `NotFound` is "there is no pane"; this pane exists and is being refused,
        // and `Terminal::host` reports the message either way.
        let env = env_of(&[
            (ENABLED_VAR, "1"),
            (SESSION_VAR, "s3"),
            (PIPE_VAR, DEFAULT_PIPE),
            (ALLOW_PIPE_VAR, "agwinterm-dev"),
        ]);
        let result = HostTarget::from_env(&env);
        if cfg!(debug_assertions) {
            let err = result.expect_err("a debug build must refuse an unlisted instance");
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
            assert!(err.to_string().contains(ALLOW_PIPE_VAR), "{err}");
        } else {
            // `cargo test --release` reaches here, and it is the shipped behaviour:
            // the variable is not consulted at all.
            assert!(
                result.is_ok(),
                "a release build publishes where the pane says"
            );
        }

        // And the instance it was told to use is reached as before.
        let allowed = env_of(&[
            (ENABLED_VAR, "1"),
            (SESSION_VAR, "s3"),
            (PIPE_VAR, "agwinterm-dev"),
            (ALLOW_PIPE_VAR, "agwinterm-dev"),
        ]);
        assert_eq!(
            HostTarget::from_env(&allowed)
                .expect("the listed instance")
                .path(),
            r"\\.\pipe\agwinterm-dev",
        );
    }

    // -- the envelope -----------------------------------------------------

    #[test]
    fn a_string_result_is_unescaped_and_an_object_result_is_handed_over_raw() {
        let text = Reply::parse(r#"{"ok":true,"result":"agwinterm 1.2.3"}"#).unwrap();
        assert_eq!(text.text().unwrap(), "agwinterm 1.2.3");

        let object =
            Reply::parse(r#"{"ok":true,"result":{"cellWidth":9,"cellHeight":19}}"#).unwrap();
        assert_eq!(
            object,
            Reply::Ok(r#"{"cellWidth":9,"cellHeight":19}"#.to_owned()),
        );
    }

    #[test]
    fn dot_net_escapes_are_decoded_rather_than_shown_to_the_user() {
        // This is exactly what `Err("unknown command 'session.metrics'")` puts on
        // the wire: `JsonSerializer` escapes the apostrophe.
        let reply =
            Reply::parse(r#"{"ok":false,"error":"unknown command \u0027session.metrics\u0027"}"#)
                .unwrap();
        assert_eq!(
            reply,
            Reply::Err("unknown command 'session.metrics'".to_owned()),
        );
    }

    #[test]
    fn an_error_envelope_is_an_error_and_carries_the_hosts_words() {
        let err = Reply::parse(r#"{"ok":false,"error":"no session"}"#)
            .unwrap()
            .text()
            .expect_err("a refusal is not a result");
        assert!(err.to_string().contains("no session"), "{err}");
    }

    #[test]
    fn a_reply_that_is_not_an_envelope_is_invalid_data_rather_than_a_wrong_answer() {
        for not_an_envelope in [
            "",
            "hello",
            r#"{"result":"no ok field"}"#,
            r#"{"ok":true}"#,
            r#"{"ok":true,"result":"truncated""#,
        ] {
            let err =
                Reply::parse(not_an_envelope).expect_err("{not_an_envelope:?} is not an envelope");
            assert_eq!(
                err.kind(),
                io::ErrorKind::InvalidData,
                "{not_an_envelope:?}"
            );
        }
    }

    #[test]
    fn a_value_that_json_cares_about_survives_the_request_line() {
        let mut line = String::new();
        push_quoted(&mut line, "a\"b\\c\nd");
        assert_eq!(line, r#""a\"b\\c\u000ad""#);
        assert!(
            !line.contains('\n'),
            "a newline would end the request early"
        );
        assert_eq!(unquote(&line).as_deref(), Some("a\"b\\c\nd"));
    }

    // -- over a real pipe -------------------------------------------------

    #[test]
    fn a_request_round_trips_over_a_real_named_pipe() {
        let server = PipeServer::always(r#"{"ok":true,"result":"agwinterm 9.9.9"}"#);
        let mut client = server.client();

        assert_eq!(client.ping().unwrap(), "agwinterm 9.9.9");
        assert_eq!(
            server.requests(),
            [r#"{"cmd":"ping","target":"s3"}"#.to_owned()],
        );
    }

    #[test]
    fn a_request_names_the_window_the_pane_is_in_when_the_host_named_one() {
        // Without this the host resolves the pane against the *frontmost* window
        // and answers `no session` whenever another window is in front — which
        // `Terminal::draw` reports as an error and `pixel-node` turns into an exit.
        // See `WINDOW_VAR`.
        let server = PipeServer::always(r#"{"ok":true,"result":"pong"}"#);
        let mut client = server.client_in_window("win-7");

        assert_eq!(client.ping().unwrap(), "pong");
        assert_eq!(
            server.requests(),
            [r#"{"cmd":"ping","target":"s3","window":"win-7"}"#.to_owned()],
        );
    }

    #[test]
    fn a_host_that_names_no_window_gets_a_request_without_one() {
        // Hosts predating multi-window set no `AGWINTERM_WINDOW_ID`, and an empty
        // selector is not the same as an absent one: `ResolveWindow("")` is the
        // frontmost, which is right only by accident.
        let target = HostTarget::from_env(&pane_env()).expect("a pane");
        assert_eq!(target.window, None);
        let with_window = HostTarget::from_env(&env_of(&[
            (ENABLED_VAR, "1"),
            (SESSION_VAR, "s3"),
            (WINDOW_VAR, "win-7"),
        ]))
        .expect("a pane");
        assert_eq!(with_window.window.as_deref(), Some("win-7"));
    }

    #[test]
    fn every_request_addresses_the_pane_by_id_and_never_the_active_one() {
        let server = PipeServer::always(r#"{"ok":true,"result":"frame:1/1"}"#);
        let mut client = server.client();

        client
            .send("image.frame", Some(r#"{"images":[{"path":"a.png"}]}"#))
            .unwrap()
            .result()
            .unwrap();

        let sent = server.requests();
        assert_eq!(
            sent,
            [
                r#"{"cmd":"image.frame","target":"s3","args":{"images":[{"path":"a.png"}]}}"#
                    .to_owned()
            ],
        );
        assert!(
            !sent[0].contains("active"),
            "a frame must not be addressed to whichever pane is in front",
        );
    }

    #[test]
    fn an_error_envelope_from_a_real_server_surfaces_as_an_error() {
        let server = PipeServer::always(r#"{"ok":false,"error":"no session"}"#);
        let mut client = server.client();

        let err = client.ping().expect_err("the host refused");
        assert!(err.to_string().contains("no session"), "{err}");
    }

    #[test]
    fn a_server_that_hangs_up_mid_request_is_reconnected_to_rather_than_fatal() {
        let server = PipeServer::scripted(vec![
            Turn::Hangup,
            Turn::Reply(r#"{"ok":true,"result":"agwinterm 9.9.9"}"#.to_owned()),
        ]);
        let mut client = server.client();

        assert_eq!(
            client.ping().unwrap(),
            "agwinterm 9.9.9",
            "a dropped connection is recoverable",
        );
        assert_eq!(
            server.requests().len(),
            2,
            "the request was replayed on the new connection",
        );
    }

    #[test]
    fn a_reconnected_client_keeps_working_without_being_rebuilt() {
        let server = PipeServer::scripted(vec![
            Turn::Reply(r#"{"ok":true,"result":"first"}"#.to_owned()),
            Turn::Hangup,
            Turn::Reply(r#"{"ok":true,"result":"second"}"#.to_owned()),
            Turn::Reply(r#"{"ok":true,"result":"third"}"#.to_owned()),
        ]);
        let mut client = server.client();

        assert_eq!(client.ping().unwrap(), "first");
        assert_eq!(client.ping().unwrap(), "second", "reconnected in place");
        assert_eq!(client.ping().unwrap(), "third", "and stayed connected");
    }

    #[test]
    fn a_host_that_keeps_dying_gives_up_after_one_replay() {
        // Every turn hangs up, so the reconnect finds another corpse. The client
        // must stop rather than loop.
        let server = PipeServer::scripted(vec![Turn::Hangup; 6]);
        let mut client = server.client();

        let err = client.ping().expect_err("nothing ever answers");
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
        assert_eq!(
            server.requests().len(),
            2,
            "one attempt and exactly one replay",
        );
    }

    #[test]
    fn a_pipe_nobody_is_serving_names_the_pipe_rather_than_hanging() {
        let mut client = ControlClient::to(HostTarget {
            pipe: format!("pixel-core-absent-{}", std::process::id()),
            session: "s3".to_owned(),
            window: None,
        });

        let err = client.ping().expect_err("there is no server");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(
            err.to_string().contains("pixel-core-absent"),
            "the message should say which pipe: {err}",
        );
    }

    // -- the deadline -----------------------------------------------------
    //
    // A pipe that dies is already handled above. These are about the pipe that
    // does not: a host that took the request, holds the connection, and never
    // speaks. Before Task 5 that read blocked forever on the render thread.

    #[test]
    fn a_host_that_accepts_and_never_answers_fails_on_the_deadline() {
        let server = PipeServer::scripted(vec![Turn::Stall]);
        let mut client = server.client();

        let started = Instant::now();
        let err = client.ping().expect_err("nothing will ever answer");
        let waited = started.elapsed();

        assert_eq!(err.kind(), io::ErrorKind::TimedOut, "{err}");
        assert!(
            err.to_string().contains("waiting for a reply"),
            "the message should say which half of the exchange stalled: {err}",
        );
        assert!(
            waited >= EXCHANGE_DEADLINE,
            "gave up after {waited:?}, before the deadline it promised",
        );
        assert!(
            waited < EXCHANGE_DEADLINE * 3,
            "{waited:?} is not a bounded wait",
        );
    }

    #[test]
    fn a_wait_is_never_zero_and_never_infinite() {
        // The two values that break the give-up path, at opposite ends of the same
        // `u32`. A zero wait does not time out — `GetOverlappedResultEx` answers
        // `ERROR_IO_INCOMPLETE` immediately, which is not `WAIT_TIMEOUT` and so
        // would return past `give_up` with a read still pending and free the buffer
        // the kernel is holding. `u32::MAX` is `INFINITE`, which is the unbounded
        // wait this whole client was rewritten to remove.
        let past = Instant::now() - Duration::from_secs(1);
        assert_eq!(
            millis_until(past),
            1,
            "an expired deadline must still be a wait"
        );
        assert_eq!(millis_until(Instant::now()), 1);

        let ahead = millis_until(Instant::now() + EXCHANGE_DEADLINE);
        assert!(
            ahead >= 1 && ahead != u32::MAX,
            "{ahead} is INFINITE or zero"
        );
        // Rounded up, not truncated: the collected wait is never shorter than what
        // is left, which is what makes the deadline a floor rather than nearly one.
        assert!(
            u128::from(ahead) >= EXCHANGE_DEADLINE.as_millis(),
            "{ahead} ms is less than the {} ms remaining",
            EXCHANGE_DEADLINE.as_millis(),
        );
    }

    #[test]
    fn both_of_windows_not_finished_yet_codes_reach_the_cancel_path() {
        // `WAIT_TIMEOUT` when the wait expired, `ERROR_IO_INCOMPLETE` when there was
        // no wait. Only the first was handled, and the difference is a `PendingIo`
        // freed under an in-flight read rather than cancelled and waited out.
        assert!(still_pending(&io::Error::from_raw_os_error(
            WAIT_TIMEOUT as i32
        )));
        assert!(still_pending(&io::Error::from_raw_os_error(
            ERROR_IO_INCOMPLETE
        )));
        // A completion — with a status, possibly a failure — is not still pending;
        // treating one as pending would cancel an operation that already finished.
        assert!(!still_pending(&io::Error::from_raw_os_error(ERROR_NO_DATA)));
        assert!(!still_pending(&io::Error::from_raw_os_error(
            ERROR_PIPE_NOT_CONNECTED
        )));
        assert!(!still_pending(&io::Error::other("not an OS error at all")));
    }

    #[test]
    fn a_timed_out_request_is_not_replayed_onto_a_pipe_of_unknown_state() {
        // The reconnect above exists for a host that *went away*. This one did
        // not: it may still be about to answer, and asking twice would both
        // double the work and spend a second deadline on it.
        let server = PipeServer::scripted(vec![Turn::Stall]);
        let mut client = server.client();

        client.ping().expect_err("nothing will ever answer");

        assert_eq!(
            server.requests().len(),
            1,
            "a timed-out request was replayed: {:?}",
            server.requests(),
        );
    }

    #[test]
    fn a_timeout_is_not_a_pipe_that_went_away() {
        // The rule the test above depends on, stated where `request` reads it.
        assert!(!recoverable(&io::Error::new(
            io::ErrorKind::TimedOut,
            "agwinterm did not respond",
        )));
    }

    #[test]
    fn a_slow_host_is_still_answered_rather_than_cut_off() {
        // The deadline is a deadline, not an eagerness to fail. A quarter of a
        // second is twenty-four times the slowest round trip the frame budget
        // measured and still well inside the bound.
        let slow = Duration::from_millis(250);
        let server = PipeServer::scripted(vec![Turn::ReplyAfter(
            slow,
            r#"{"ok":true,"result":"pong"}"#.to_owned(),
        )]);
        let mut client = server.client();

        let started = Instant::now();
        assert_eq!(client.ping().unwrap(), "pong");
        assert!(
            started.elapsed() >= slow,
            "the fixture answered early, so this proved nothing",
        );
    }

    #[test]
    fn a_thread_blocked_on_a_stalling_host_can_still_be_joined() {
        // `PixelEngine::stop` sets its flag, wakes the render thread and joins it
        // (`pixel-node/src/lib.rs`). Joining is the whole risk: the thread can only
        // notice the flag between exchanges, so shutdown takes however long the
        // exchange in flight takes. This is that shape, with the exchange that used
        // to take forever.
        let server = PipeServer::scripted(vec![Turn::Stall]);
        let mut client = server.client();
        let stop = Arc::new(AtomicBool::new(false));

        let render = std::thread::spawn({
            let stop = Arc::clone(&stop);
            move || {
                while !stop.load(Ordering::Relaxed) {
                    let _ = client.ping();
                }
            }
        });

        // Long enough that the thread is inside the stalled exchange, so the flag
        // is set at the moment that used to be unrecoverable.
        std::thread::sleep(Duration::from_millis(100));
        stop.store(true, Ordering::Relaxed);

        let give_up_at = Instant::now() + EXCHANGE_DEADLINE * 4;
        while !render.is_finished() && Instant::now() < give_up_at {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            render.is_finished(),
            "the render thread is still in the exchange, so `stop` would hang",
        );
        render.join().expect("the render thread does not panic");
    }

    // -- cell metrics -----------------------------------------------------

    #[test]
    fn pane_metrics_reads_the_geometry_the_host_publishes() {
        let server = PipeServer::always(
            r#"{"ok":true,"result":{"cols":132,"rows":37,"cellWidth":9,"cellHeight":19,"widthPx":1188,"heightPx":703}}"#,
        );
        let mut client = server.client();

        assert_eq!(
            client.pane_metrics().unwrap(),
            Some(PaneMetrics {
                cols: 132,
                rows: 37,
                cell_width: 9,
                cell_height: 19,
                width_px: 1188,
                height_px: 703,
            }),
        );
        assert_eq!(
            server.requests(),
            [format!(r#"{{"cmd":"{METRICS_CMD}","target":"s3"}}"#)],
        );
    }

    #[test]
    fn a_host_without_the_verb_is_a_capability_gap_and_is_asked_only_once() {
        let server = PipeServer::always(
            r#"{"ok":false,"error":"unknown command \u0027session.metrics\u0027"}"#,
        );
        let mut client = server.client();

        assert_eq!(client.pane_metrics().unwrap(), None);
        assert_eq!(client.pane_metrics().unwrap(), None);
        assert_eq!(
            server.requests().len(),
            1,
            "a host that will never answer must not be asked every resize",
        );
    }

    #[test]
    fn a_refusal_that_is_not_a_missing_verb_is_still_an_error() {
        let server = PipeServer::always(r#"{"ok":false,"error":"no session"}"#);
        let mut client = server.client();

        let err = client.pane_metrics().expect_err("the pane is gone");
        assert!(err.to_string().contains("no session"), "{err}");
    }

    #[test]
    fn metrics_without_a_usable_cell_size_are_no_metrics_at_all() {
        for useless in [
            r#"{"ok":true,"result":{"cols":132,"rows":37}}"#,
            r#"{"ok":true,"result":{"cellWidth":0,"cellHeight":19}}"#,
            r#"{"ok":true,"result":{"cellWidth":9,"cellHeight":0}}"#,
        ] {
            let server = PipeServer::always(useless);
            assert_eq!(
                server.client().pane_metrics().unwrap(),
                None,
                "{useless} carries no cell size",
            );
        }
    }

    #[test]
    fn the_host_verb_supplies_the_cell_size() {
        let server = PipeServer::always(r#"{"ok":true,"result":{"cellWidth":9,"cellHeight":19}}"#);
        let mut client = server.client();

        assert_eq!(cell_size(Some(&mut client), &pane_env()), (9, 19));
    }

    #[test]
    fn an_explicit_override_wins_over_the_host_and_is_not_even_asked_about() {
        let server = PipeServer::always(r#"{"ok":true,"result":{"cellWidth":9,"cellHeight":19}}"#);
        let mut client = server.client();
        let env = env_of(&[
            (ENABLED_VAR, "1"),
            (SESSION_VAR, "s3"),
            (CELL_PX_VAR, "10x21"),
        ]);

        assert_eq!(cell_size(Some(&mut client), &env), (10, 21));
        assert!(
            server.requests().is_empty(),
            "an override that still round-trips is not an override",
        );
    }

    #[test]
    fn a_malformed_override_is_ignored_rather_than_obeyed() {
        for bad in ["", "9", "9*21", "0x21", "9x0", "widthxheight", "-9x21"] {
            assert_eq!(parse_cell_px(bad), None, "{bad:?} is not a cell size");
        }
        for (good, expected) in [
            ("9x19", (9, 19)),
            ("10X21", (10, 21)),
            (" 8 x 16 ", (8, 16)),
        ] {
            assert_eq!(parse_cell_px(good), Some(expected), "{good:?}");
        }

        // A typo falls through to the next source rather than to a wrong number.
        let env = env_of(&[(CELL_PX_VAR, "nonsense")]);
        assert_eq!(cell_size(None, &env), FALLBACK_CELL);
    }

    #[test]
    fn with_no_source_at_all_the_answer_is_the_number_the_engine_would_have_guessed() {
        // The property that matters is not the value: it is that the backend and
        // `engine/mod.rs:347`'s `unwrap_or((16, 32))` reach the *same* value, so
        // the canvas is drawn and the pointer is mapped in one coordinate space.
        // A `None` here is what would move click targets.
        assert_eq!(cell_size(None, &env_of(&[])), (16, 32));
        assert_eq!(cell_size(None, &env_of(&[])), FALLBACK_CELL);
    }

    #[test]
    fn a_host_that_cannot_be_reached_still_yields_a_usable_cell_size() {
        let mut client = ControlClient::to(HostTarget {
            pipe: format!("pixel-core-absent-{}", std::process::id()),
            session: "s3".to_owned(),
            window: None,
        });
        assert_eq!(cell_size(Some(&mut client), &env_of(&[])), FALLBACK_CELL);
    }

    // -- the fixture itself -----------------------------------------------

    #[test]
    fn the_fixture_is_a_real_pipe_and_not_an_agreement_with_itself() {
        // If `accept` silently failed, every pipe test above would pass by
        // never connecting. This one reads the bytes off the wire by hand.
        let server = PipeServer::scripted(vec![Turn::Reply("pong".to_owned())]);
        let mut raw = OpenOptions::new()
            .read(true)
            .write(true)
            .open(format!(r"\\.\pipe\{}", server.name))
            .expect("the fixture is serving");
        raw.write_all(b"ping\n").unwrap();
        let mut back = [0u8; 5];
        raw.read_exact(&mut back).unwrap();
        assert_eq!(&back, b"pong\n");
        assert_eq!(server.requests(), ["ping".to_owned()]);
    }
}
