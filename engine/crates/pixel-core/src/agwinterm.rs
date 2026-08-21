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
//! `docs/design/04-cell-metrics.md`; [`cell_size`] is it in code. In short: the
//! host is asked for [`METRICS_CMD`], an explicit [`CELL_PX_VAR`] overrides it, and
//! the last resort is [`FALLBACK_CELL`] with a warning that names the fix. What
//! matters more than the number is that *one* number reaches both the canvas and
//! the pointer, which is why this returns a value rather than an `Option`.

use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::time::Duration;

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
/// `<width>x<height>` in pixels, overriding whatever the host says (or does not).
pub(crate) const CELL_PX_VAR: &str = "TERMINAL_BROWSER_CELL_PX";

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

const OPEN_ATTEMPTS: u32 = 20;
const BUSY_WAIT: Duration = Duration::from_millis(25);

// ---------------------------------------------------------------------------
// Where to send, and whether there is anywhere to send to
// ---------------------------------------------------------------------------

/// The pane this process draws into, and the pipe that reaches it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HostTarget {
    pipe: String,
    session: String,
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
        Ok(Self {
            pipe: nonempty(env, PIPE_VAR).unwrap_or_else(|| DEFAULT_PIPE.to_owned()),
            session,
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

/// Whether this process is inside an agwinterm pane at all.
fn hosted(env: &SessionEnv) -> bool {
    match nonempty(env, ENABLED_VAR) {
        Some(value) => value != "0",
        None => false,
    }
}

fn nonempty(env: &SessionEnv, key: &str) -> Option<String> {
    env.var(key).filter(|value| !value.is_empty())
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

/// One dialled pipe. A named-pipe client is an ordinary file on Windows, so this
/// needs no Win32 of its own — only the retry that `CreateFile` on a pipe requires.
struct Connection {
    /// Read and write travel over the same handle; `get_mut` is the write end.
    reader: BufReader<File>,
}

impl Connection {
    fn open(path: &str) -> io::Result<Self> {
        let mut attempt = 1;
        loop {
            match OpenOptions::new().read(true).write(true).open(path) {
                Ok(file) => {
                    return Ok(Self {
                        reader: BufReader::new(file),
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

    /// One request line out, one reply line back. The server is strictly
    /// request/response per connection (`ControlServer.cs:76-82`), so nothing else
    /// can arrive in between.
    fn exchange(&mut self, request: &str) -> io::Result<String> {
        let pipe = self.reader.get_mut();
        pipe.write_all(request.as_bytes())?;
        pipe.write_all(b"\n")?;
        pipe.flush()?;

        let mut line = String::new();
        if self.reader.read_line(&mut line)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "agwinterm closed the control pipe before answering",
            ));
        }
        Ok(line)
    }
}

/// Whether a failed exchange is worth re-dialling for, as opposed to reporting.
///
/// The distinction that matters: "the host went away mid-conversation" is
/// recoverable, "there is no host" is not — otherwise a missing agwinterm would be
/// retried forever instead of explained once.
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

    /// Builds `{"cmd":…,"target":…,"args":…}` and sends it.
    ///
    /// `args` is raw JSON — an object literal the caller composed — because the
    /// frame verb's `images` array is built once per frame and a generic value
    /// type would allocate its way through the frame budget for nothing.
    pub(crate) fn send(&mut self, cmd: &str, args: Option<&str>) -> io::Result<Reply> {
        let mut line = String::from("{\"cmd\":");
        push_quoted(&mut line, cmd);
        line.push_str(",\"target\":");
        push_quoted(&mut line, &self.target.session);
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
            reason = "the bring-up path's liveness check; Task 7 and Task 10 call it"
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
    /// `None` when the cell size is missing or zero — the only two fields anything
    /// downstream cannot do without. `cols`/`rows` default to zero rather than
    /// failing the whole reply, since the console screen buffer supplies those too.
    fn parse(raw: &str) -> Option<Self> {
        let cell_width = field_u32(raw, "cellWidth").filter(|width| *width > 0)?;
        let cell_height = field_u32(raw, "cellHeight").filter(|height| *height > 0)?;
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
    (cell.0 > 0 && cell.1 > 0).then_some(cell)
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
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::sync::atomic::{AtomicU32, Ordering};
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
    }

    /// A real named-pipe server, scripted turn by turn.
    ///
    /// It re-accepts after every hangup, so a script of `[Hangup, Reply(..)]` is
    /// exactly "the connection died and the client reconnected". Requests are
    /// recorded before the reply goes out, so an assertion that sees the reply can
    /// rely on seeing the request.
    pub(crate) struct PipeServer {
        pub(crate) name: String,
        requests: Arc<Mutex<Vec<String>>>,
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
            // The constructor does not return until the first instance exists.
            // Without this the client races the server thread and every pipe test
            // below fails as "no such pipe", which is a different test.
            let (ready, listening) = std::sync::mpsc::sync_channel(0);
            let thread = std::thread::spawn({
                let name = name.clone();
                let requests = Arc::clone(&requests);
                move || serve(&name, turns, &requests, &ready)
            });
            listening
                .recv()
                .expect("the server thread announces its first instance")
                .expect("a private pipe name is free");
            Self {
                name,
                requests,
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
            })
        }

        pub(crate) fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("no test panics here").clone()
        }
    }

    impl Drop for PipeServer {
        fn drop(&mut self) {
            // Deliberately not joined: a script the test did not exhaust leaves the
            // thread parked in `ConnectNamedPipe`, and joining it would hang the
            // suite. The handle is dropped, the thread ends with the process.
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
    use std::io::Read;

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
        });

        let err = client.ping().expect_err("there is no server");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(
            err.to_string().contains("pixel-core-absent"),
            "the message should say which pipe: {err}",
        );
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
