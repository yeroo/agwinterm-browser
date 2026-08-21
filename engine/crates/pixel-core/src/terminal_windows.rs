//! The Windows console backend: the input half.
//!
//! `terminal.rs`'s tty backend is `#[cfg(unix)]`-gated — termios raw mode,
//! `/dev/tty`, `SIGWINCH`, `rustix::shm` and the Kitty-escape frame transport have
//! no Windows equivalent. What survives that gate is the 659-line VT decoder
//! further down the same file, and **this module feeds it rather than writing a
//! second one**: `parse_event_kitty` does all the parsing here too, so kitty CSI-u,
//! SGR mouse, bracketed paste, OSC colour replies and incomplete tails behave
//! byte-for-byte as they do on unix. The three things below it that are genuinely
//! new are the console handles, the read loop and resize.
//!
//! ## Attaching, and why it is not automatic
//!
//! Task 2 (`docs/design/03-process-model.md`) put the engine in the foreground
//! process, one per pane. That process is Electron, which is a GUI-subsystem image,
//! and `tools/console-inherit-probe` measured what that means: **a GUI-subsystem
//! child is not given its parent's console**, even on an ordinary inherit-handles
//! spawn. `CONIN$` fails with `ERROR_INVALID_HANDLE` and the process looks
//! terminal-less. It can *take* the console with `AttachConsole`, and then it reads
//! the pane's input verbatim.
//!
//! So [`Terminal::new`] attaches first, and:
//!
//! - treats `ERROR_ACCESS_DENIED` as success, because that is what an *already*
//!   attached process gets — one console per process, also measured;
//! - prefers a process id named by [`CONSOLE_PID_VAR`] over `ATTACH_PARENT_PROCESS`,
//!   so Task 9's launcher is free to put a wrapper between the pane and the engine,
//!   and falls back to the parent when the variable is absent or stale;
//! - opens `CONIN$`/`CONOUT$` **by name**, never through `GetStdHandle`. Task 1
//!   measured that a ConPTY child's std handles can be `NUL` — `FILE_TYPE_CHAR`, and
//!   then `ERROR_INVALID_HANDLE` from every console API. Opening by name always
//!   names the console the process is actually attached to, which is the analogue of
//!   upstream opening `/dev/tty` rather than using fd 0.
//!
//! ## Reading, and why there is a thread
//!
//! The obvious loop — wait on the console input handle, then `ReadFile` — is wrong,
//! and wrong on every keypress. The handle is signalled when an *input record* is
//! queued, but under `ENABLE_VIRTUAL_TERMINAL_INPUT` records that translate to no
//! bytes (key-up, focus, buffer-size) are consumed silently, so the following
//! `ReadFile` blocks past the caller's timeout waiting for a byte that will not
//! come. A single keypress queues a down record *and* an up record, so the second
//! wait would hang.
//!
//! `poll_event`'s contract is a deadline, so the blocking read is moved off the
//! calling thread: [`spawn_reader`] loops on `ReadFile` and pushes what it gets into
//! an [`Inbox`], and `poll_event` waits on that inbox's `Condvar` with the deadline
//! it was given. That also makes [`Waker`] trivial — it is a flag on the same inbox
//! — and makes the whole loop testable over an ordinary pipe.
//!
//! ## Resize, in place of `SIGWINCH`
//!
//! There is no signal. `watch_resize` remembers the console's size and `poll_event`
//! caps its wait at [`RESIZE_POLL`] so it can re-read the screen buffer and emit
//! `Event::WindowSize` when it changes. In-band reports (`CSI 48 ; rows ; cols t`,
//! mode 2048) are still decoded if the host ever sends them — the decoder already
//! handles them — and both routes share one "last size" so a host that does both
//! does not produce the event twice.
//!
//! ## Cell metrics, which the console cannot supply
//!
//! `GetConsoleScreenBufferInfo` reports cells, never pixels, and there is no
//! `ws_xpixel` here — so `size()` reports zero for both pixel fields and
//! `WindowSize::cell_size()` honestly answers `None`. [`Terminal::cell_size`] is
//! therefore answered by the *host* rather than by the console:
//! [`crate::agwinterm::cell_size`] asks the control pipe, honours an explicit
//! override, and falls back loudly. `docs/design/04-cell-metrics.md` is the
//! decision; what matters here is that it never answers `None`.
//!
//! ## Restoring the console
//!
//! The trait's contract is that raw mode is tied to the value's lifetime. [`ModeGuard`]
//! is that lifetime, and it also registers with a process-global panic hook, because
//! `Drop` alone does not cover a panic on another thread or a panic while the guard
//! is owned by something that leaks. Both routes restore the exact mode that was
//! read at entry, and both are idempotent.

use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Once, PoisonError};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_BROKEN_PIPE, ERROR_HANDLE_EOF, GENERIC_READ,
    GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, ReadFile, WriteFile,
};
use windows_sys::Win32::System::Console::{
    ATTACH_PARENT_PROCESS, AttachConsole, CONSOLE_SCREEN_BUFFER_INFO, DISABLE_NEWLINE_AUTO_RETURN,
    ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT, ENABLE_VIRTUAL_TERMINAL_INPUT,
    ENABLE_VIRTUAL_TERMINAL_PROCESSING, GetConsoleMode, GetConsoleScreenBufferInfo, SetConsoleMode,
};
use windows_sys::Win32::System::IO::CancelIoEx;

use crate::agwinterm::{self, ControlClient};
use crate::canvas::Canvas;
use crate::frame_file;
use crate::terminal::{
    ColorSlot, Event, Key, KeyEvent, RawEvent, SessionEnv, TerminalColors, Waker, WindowSize,
    parse_event_kitty, parse_osc_color,
};
use crate::wrapper::Wrapper;

/// The environment variable the launcher uses to name the process that owns the
/// pane's console. Read through [`SessionEnv`], so it works in the daemon shape too.
/// Task 9 sets it; absent, the backend attaches to its direct parent instead.
pub(crate) const CONSOLE_PID_VAR: &str = "TERMINAL_BROWSER_CONSOLE_PID";

/// How often `poll_event` re-reads the console's size while `watch_resize` is on.
/// There is no `SIGWINCH`, so this interval *is* the resize latency; it is also the
/// idle wakeup rate, which is why it is not smaller.
const RESIZE_POLL: Duration = Duration::from_millis(100);

/// How long `query_colors` waits for the palette, and how long it keeps waiting
/// after a reply has already arrived. Both match the unix backend, so a terminal
/// that answers at the same speed produces the same result on both platforms.
const COLOR_QUERY_DEADLINE: Duration = Duration::from_millis(300);
const COLOR_QUERY_IDLE: Duration = Duration::from_millis(60);

/// How long a lone `0x1b` waits for a second byte before it is reported as the
/// Escape key. The same 50 ms upstream's tty backend uses (`terminal.rs`), copied
/// rather than shared because that constant is `#[cfg(unix)]` and un-gating it
/// would be an edit to the file this port promises to leave alone.
const LONE_ESCAPE_WAIT: Duration = Duration::from_millis(50);

/// The 18 slots `query_colors` asks about: foreground, background, and 16 palette
/// entries.
const COLOR_SLOTS: usize = 18;

/// What the backend turns on once the console is in VT mode. This is upstream's set
/// (`terminal.rs:215`) minus the two things this host cannot honour — `?1016h`
/// pixel mouse, which agwinterm has no support for, and `\x1b[>1u` kitty keyboard,
/// which it does not implement and which the decoder must therefore not be told to
/// expect — plus `?1000h`/`?1002h`, which is the prefix
/// `tools/console-inherit-probe` measured working through a real ConPTY.
const ENABLE_REPORTING: &[u8] = b"\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1003h\
\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?2048h";

/// The mirror of [`ENABLE_REPORTING`], written on the way out.
const DISABLE_REPORTING: &[u8] = b"\x1b[?2048l\x1b[?2004l\x1b[?1004l\x1b[?1006l\x1b[?1003l\
\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l";

/// `CONIN$` as a NUL-terminated wide string.
const CONIN: &[u16] = &[
    b'C' as u16,
    b'O' as u16,
    b'N' as u16,
    b'I' as u16,
    b'N' as u16,
    b'$' as u16,
    0,
];

/// `CONOUT$` as a NUL-terminated wide string.
const CONOUT: &[u16] = &[
    b'C' as u16,
    b'O' as u16,
    b'N' as u16,
    b'O' as u16,
    b'U' as u16,
    b'T' as u16,
    b'$' as u16,
    0,
];

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

/// One owned kernel handle, closed once when the last reference goes.
///
/// Deliberately not specific to consoles: the reader loop and the mode calls are
/// written against this type, so the tests can point them at an ordinary pipe or a
/// private screen buffer instead of the developer's terminal.
pub(crate) struct ConsoleHandle(HANDLE);

// SAFETY: a Win32 handle is a process-wide kernel object id with no thread
// affinity — the reader thread and the engine thread may hold the same one. The
// only operation with an ordering requirement is `CloseHandle`, and that happens
// once, in `Drop`, when no reference is left.
#[allow(unsafe_code)]
unsafe impl Send for ConsoleHandle {}
// SAFETY: as above; every method takes `&self` and the underlying calls are
// documented as safe to issue concurrently.
#[allow(unsafe_code)]
unsafe impl Sync for ConsoleHandle {}

impl ConsoleHandle {
    /// Opens a console pseudo-device by name. Fails with `ERROR_INVALID_HANDLE`
    /// when the process has no console to open, which is the honest test for
    /// "not attached" — see the module docs on why `GetStdHandle` is not used.
    #[allow(unsafe_code)]
    fn open(name: &[u16]) -> io::Result<Self> {
        // SAFETY: `name` is a NUL-terminated wide string that outlives the call, and
        // the two pointer arguments are the documented "no security attributes, no
        // template" nulls.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }

    /// Takes ownership of a handle obtained elsewhere. The caller must not close it.
    /// Only the tests need this: they point the read loop and the mode calls at a
    /// pipe and at a private screen buffer rather than at the pane's console.
    #[cfg(test)]
    fn from_raw(handle: HANDLE) -> Self {
        Self(handle)
    }

    fn raw(&self) -> HANDLE {
        self.0
    }

    /// Blocks until at least one byte is available. `Ok(0)` is end of input.
    #[allow(unsafe_code)]
    fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut read: u32 = 0;
        // SAFETY: `buf` is a live slice for the duration of the call and `read` a
        // valid out-param; the last argument is the documented null for a
        // synchronous handle.
        let ok = unsafe {
            ReadFile(
                self.0,
                buf.as_mut_ptr(),
                buf.len() as u32,
                &mut read,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            // A pipe whose writer has gone reports `ERROR_BROKEN_PIPE` rather than
            // a zero-byte read; a console never does, but the tests drive this loop
            // over a real pipe and both mean the same thing to the caller.
            let err = io::Error::last_os_error();
            return match err.raw_os_error() {
                Some(code)
                    if code == ERROR_BROKEN_PIPE as i32 || code == ERROR_HANDLE_EOF as i32 =>
                {
                    Ok(0)
                }
                _ => Err(err),
            };
        }
        Ok(read as usize)
    }

    /// Writes every byte, looping over short writes.
    #[allow(unsafe_code)]
    fn write_all(&self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            let mut written: u32 = 0;
            // SAFETY: `bytes` is a live slice and `written` a valid out-param; the
            // last argument is the documented null for a synchronous handle.
            let ok = unsafe {
                WriteFile(
                    self.0,
                    bytes.as_ptr(),
                    bytes.len() as u32,
                    &mut written,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            if written == 0 {
                return Err(io::Error::from(io::ErrorKind::WriteZero));
            }
            bytes = &bytes[written as usize..];
        }
        Ok(())
    }

    #[allow(unsafe_code)]
    fn mode(&self) -> io::Result<u32> {
        let mut mode: u32 = 0;
        // SAFETY: `mode` is a valid out-param and `self.0` a handle we own.
        let ok = unsafe { GetConsoleMode(self.0, &mut mode) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(mode)
    }

    #[allow(unsafe_code)]
    fn set_mode(&self, mode: u32) -> io::Result<()> {
        // SAFETY: `self.0` is a handle we own; the mode is a plain bitfield.
        let ok = unsafe { SetConsoleMode(self.0, mode) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// The size of the *visible* window, in cells.
    ///
    /// `srWindow`, not `dwSize`: under a pseudoconsole the two are equal, but under
    /// a plain conhost `dwSize.Y` is the scrollback height, which would report tens
    /// of thousands of rows. `srWindow` is the analogue of `ws_row`/`ws_col`.
    ///
    /// Pixels are reported as zero. Windows has no `ws_xpixel` equivalent and
    /// agwinterm publishes no cell metrics, so `WindowSize::cell_size()` answers
    /// `None` here — deliberately, rather than guessing. Task 6 decides where the
    /// metrics come from.
    #[allow(unsafe_code)]
    fn window_size(&self) -> io::Result<WindowSize> {
        // SAFETY: a plain out-param struct, zeroed before the call fills it.
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is a valid out-param and `self.0` a handle we own.
        let ok = unsafe { GetConsoleScreenBufferInfo(self.0, &mut info) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let window = info.srWindow;
        Ok(WindowSize {
            cols: u32::try_from(i32::from(window.Right) - i32::from(window.Left) + 1).unwrap_or(0),
            rows: u32::try_from(i32::from(window.Bottom) - i32::from(window.Top) + 1).unwrap_or(0),
            width_px: 0,
            height_px: 0,
        })
    }
}

impl Drop for ConsoleHandle {
    #[allow(unsafe_code)]
    fn drop(&mut self) {
        // SAFETY: `self.0` came from `CreateFileW` or from a caller handing over
        // ownership, and this runs once because the handle is behind an `Arc`.
        unsafe { CloseHandle(self.0) };
    }
}

/// Attaches this process to the console it should be drawing into.
///
/// Returns `Ok(())` when the process ends up attached, whether or not this call is
/// what attached it: `ERROR_ACCESS_DENIED` means "already attached", which is the
/// normal answer for a console-subsystem process launched in the pane.
#[allow(unsafe_code)]
fn attach_console(env: &SessionEnv) -> io::Result<()> {
    for target in attach_targets(env) {
        // SAFETY: the argument is a process id or the documented sentinel, and the
        // call is safe to make in any attachment state.
        if unsafe { AttachConsole(target) } != 0 {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
            // One console per process, measured. Already having one is success.
            return Ok(());
        }
        if target != ATTACH_PARENT_PROCESS {
            crate::logging::warn(
                "terminal",
                format!(
                    "{CONSOLE_PID_VAR}={target} could not be attached to ({err}), \
                         falling back to the parent process"
                ),
            );
        }
    }
    Err(io::Error::last_os_error())
}

/// The consoles [`attach_console`] will try, in the order it will try them.
///
/// Split out from the attaching because it is the whole of the decision and the
/// only part a test can reach: `AttachConsole` can only be exercised by a process
/// that has no console, which a test suite is not.
///
/// The named pid comes **first**, which is the point of naming one: Task 9's
/// launcher may put a wrapper between the pane and the engine, and the parent of
/// that engine is then the wrapper rather than the pane. `trim` before `parse`
/// because a `.cmd` launcher setting the variable leaves the line ending on it, and
/// a pid with a trailing carriage return that silently failed to parse would
/// attach to the wrong console and present as a browser that never receives a key.
///
/// Anything unparseable falls through to the parent rather than failing, so a stale
/// or malformed value degrades to the pre-Task-9 behaviour instead of refusing to
/// start.
fn attach_targets(env: &SessionEnv) -> Vec<u32> {
    env.var(CONSOLE_PID_VAR)
        .and_then(|value| value.trim().parse::<u32>().ok())
        // Zero is the System Idle Process and owns no console. Trying it costs a
        // failed call and a warning that names a pid nobody set.
        .filter(|pid| *pid != 0)
        .into_iter()
        .chain([ATTACH_PARENT_PROCESS])
        .collect()
}

// ---------------------------------------------------------------------------
// Console modes
// ---------------------------------------------------------------------------

/// The input mode a VT client needs: line, echo and processed input off so that
/// keys arrive unbuffered and un-echoed, and `ENABLE_VIRTUAL_TERMINAL_INPUT` on so
/// that conhost hands over escape sequences instead of `INPUT_RECORD`s.
///
/// Every other bit of `previous` is preserved. This is exactly the set
/// `tools/console-inherit-probe` measured reading `\x1b[<0;12;5M` off a real
/// pseudoconsole; it is not widened on a guess.
pub(crate) fn raw_input_mode(previous: u32) -> u32 {
    (previous & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT))
        | ENABLE_VIRTUAL_TERMINAL_INPUT
}

/// The output mode that lets the escape sequences this backend writes through, and
/// stops conhost wrapping at the last column.
pub(crate) fn vt_output_mode(previous: u32) -> u32 {
    previous | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN
}

/// One handle's mode, what it was before, and what has to be written to it while
/// the old mode is still in force.
struct Restore {
    token: u64,
    handle: HANDLE,
    mode: u32,
    /// Written to `handle` *before* `mode` goes back.
    ///
    /// The reporting modes this backend turns on (`ENABLE_REPORTING`) are escape
    /// sequences, not console modes, so restoring `mode` does not undo them — and
    /// they are the visible half: the alternate screen, the hidden cursor, and
    /// any-motion mouse reporting. Registering the mirror sequence here is what
    /// lets the panic hook put those back too, in the one case the hook exists for
    /// (a panic on another thread, or a leaked guard) where no `Drop` will.
    ///
    /// It must go out before `SetConsoleMode`, because it needs the VT *output*
    /// mode this backend turned on; written after, it would be printed literally.
    farewell: Option<&'static [u8]>,
}

// SAFETY: the handle is stored only to be handed back to `SetConsoleMode`, which
// has no thread affinity. The registry never closes it.
#[allow(unsafe_code)]
unsafe impl Send for Restore {}

/// Every mode this process has changed and not yet put back, so the panic hook can
/// put them back even when no `Drop` will run.
static REGISTRY: Mutex<Vec<Restore>> = Mutex::new(Vec::new());
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);
static HOOK: Once = Once::new();

fn registry() -> MutexGuard<'static, Vec<Restore>> {
    REGISTRY.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Puts every registered console back the way it was found: the farewell sequences
/// first, while the modes that carry them are still in force, then the modes.
///
/// Called from the panic hook. It *drains* the registry rather than reading it, so
/// a `ModeGuard::drop` that runs afterwards (unwinding past the guard the hook
/// already cleaned up) finds its tokens gone and does nothing — which is what keeps
/// the farewell from being written a second time, with VT output already off, where
/// it would be printed as literal escape bytes rather than obeyed.
#[allow(unsafe_code)]
pub(crate) fn restore_registered_modes() {
    let entries = std::mem::take(&mut *registry());
    for entry in entries.iter() {
        if let Some(bytes) = entry.farewell {
            write_raw(entry.handle, bytes);
        }
    }
    for entry in entries.iter() {
        // SAFETY: the handle was live when registered and is only closed after the
        // guard that owns it has deregistered; the mode is a plain bitfield.
        unsafe { SetConsoleMode(entry.handle, entry.mode) };
    }
}

/// Best-effort `WriteFile` to a raw handle, for the restore paths that have a
/// `HANDLE` rather than the [`ConsoleHandle`] that owns it. Failure here means the
/// console has already gone, which is not something a restore can act on.
#[allow(unsafe_code)]
fn write_raw(handle: HANDLE, mut bytes: &[u8]) {
    while !bytes.is_empty() {
        let mut written: u32 = 0;
        // SAFETY: `bytes` is a live slice and `written` a valid out-param; the last
        // argument is the documented null for a synchronous handle.
        let ok = unsafe {
            WriteFile(
                handle,
                bytes.as_ptr(),
                bytes.len() as u32,
                &mut written,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 || written == 0 {
            return;
        }
        bytes = &bytes[written as usize..];
    }
}

/// Installs the panic hook, once per process. It runs before the previous hook, so
/// the console is already back to normal by the time the panic message is printed.
fn install_panic_hook() {
    HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore_registered_modes();
            previous(info);
        }));
    });
}

/// The lifetime raw mode is tied to.
///
/// Holds a strong reference to each handle it changed, so a handle cannot be closed
/// while its mode is still ours to restore, and deregisters on drop so the panic
/// hook does not touch a handle that has gone.
struct ModeGuard {
    entries: Vec<(Arc<ConsoleHandle>, u64)>,
}

impl ModeGuard {
    fn new() -> Self {
        install_panic_hook();
        Self {
            entries: Vec::new(),
        }
    }

    /// Reads `handle`'s current mode, applies `next` to it, and remembers the old
    /// one. A failure to read or set leaves nothing registered, so a construction
    /// that fails half way does not leave an entry that will never be paired.
    fn apply(
        &mut self,
        handle: &Arc<ConsoleHandle>,
        next: impl FnOnce(u32) -> u32,
    ) -> io::Result<()> {
        self.apply_with_farewell(handle, next, None)
    }

    /// [`ModeGuard::apply`], plus bytes to write to the handle before its mode goes
    /// back — see [`Restore::farewell`].
    fn apply_with_farewell(
        &mut self,
        handle: &Arc<ConsoleHandle>,
        next: impl FnOnce(u32) -> u32,
        farewell: Option<&'static [u8]>,
    ) -> io::Result<()> {
        let previous = handle.mode()?;
        handle.set_mode(next(previous))?;
        let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
        registry().push(Restore {
            token,
            handle: handle.raw(),
            mode: previous,
            farewell,
        });
        self.entries.push((Arc::clone(handle), token));
        Ok(())
    }
}

impl Drop for ModeGuard {
    /// In reverse, so that two guards overlapping on one handle unwind in the order
    /// they were taken: the inner one restores the mode the outer one set, and the
    /// outer one then restores the mode the console started in. Restoring in
    /// insertion order would leave the console in the *inner* guard's mode, which
    /// on this backend is raw.
    fn drop(&mut self) {
        let mut registry = registry();
        for (handle, token) in self.entries.drain(..).rev() {
            if let Some(at) = registry.iter().position(|entry| entry.token == token) {
                let entry = registry.remove(at);
                if let Some(bytes) = entry.farewell {
                    let _ = handle.write_all(bytes);
                }
                let _ = handle.set_mode(entry.mode);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The inbox, and the reader thread that fills it
// ---------------------------------------------------------------------------

/// What one wait on the inbox produced.
#[derive(Debug, PartialEq, Eq)]
enum Taken {
    /// Bytes were appended to the caller's buffer.
    Bytes,
    /// Someone called [`Inbox::wake`]; the caller should return control.
    Woken,
    /// The deadline passed with nothing to report.
    Timeout,
    /// The reader reached end of input.
    Eof,
}

#[derive(Default)]
struct Mailbox {
    bytes: Vec<u8>,
    woken: bool,
    /// `Some(None)` is end of input; `Some(Some(code))` is the error that ended it.
    closed: Option<Option<i32>>,
    /// Set when the `Terminal` goes, so the reader thread stops at its next byte.
    abandoned: bool,
}

/// The hand-off between the blocking console reader and `poll_event`.
///
/// This is also what [`Waker`] carries on Windows: waking a blocked read is setting
/// a flag here and notifying, which is why the `Waker` type is platform-split.
pub struct Inbox {
    mail: Mutex<Mailbox>,
    ready: Condvar,
}

impl Inbox {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            mail: Mutex::new(Mailbox::default()),
            ready: Condvar::new(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Mailbox> {
        self.mail.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Appends bytes. Returns `false` once the owning `Terminal` has gone, which is
    /// the reader thread's signal to stop.
    pub(crate) fn push(&self, chunk: &[u8]) -> bool {
        let mut mail = self.lock();
        if mail.abandoned {
            return false;
        }
        mail.bytes.extend_from_slice(chunk);
        self.ready.notify_all();
        true
    }

    /// Records that no more bytes will arrive.
    pub(crate) fn close(&self, error: Option<io::Error>) {
        let mut mail = self.lock();
        mail.closed = Some(error.and_then(|err| err.raw_os_error()));
        self.ready.notify_all();
    }

    /// Interrupts a wait in progress, and makes the *next* wait return immediately
    /// if none is in progress. Callable from any thread; this is `Waker::wake`.
    pub(crate) fn wake(&self) {
        let mut mail = self.lock();
        mail.woken = true;
        self.ready.notify_all();
    }

    fn abandon(&self) {
        let mut mail = self.lock();
        mail.abandoned = true;
        self.ready.notify_all();
    }

    /// Waits up to `wait` (forever, if `None`) for something to happen, appending
    /// any bytes to `out`.
    fn take(&self, out: &mut Vec<u8>, wait: Option<Duration>) -> io::Result<Taken> {
        let deadline = wait.map(|wait| Instant::now() + wait);
        let mut mail = self.lock();
        loop {
            if std::mem::take(&mut mail.woken) {
                return Ok(Taken::Woken);
            }
            if !mail.bytes.is_empty() {
                out.append(&mut mail.bytes);
                return Ok(Taken::Bytes);
            }
            match mail.closed {
                Some(Some(code)) => return Err(io::Error::from_raw_os_error(code)),
                Some(None) => return Ok(Taken::Eof),
                None => {}
            }
            mail = match deadline {
                None => self
                    .ready
                    .wait(mail)
                    .unwrap_or_else(PoisonError::into_inner),
                Some(deadline) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Ok(Taken::Timeout);
                    }
                    let (mail, timed_out) = self
                        .ready
                        .wait_timeout(mail, remaining)
                        .unwrap_or_else(PoisonError::into_inner);
                    if timed_out.timed_out() && mail.bytes.is_empty() && !mail.woken {
                        return Ok(Taken::Timeout);
                    }
                    mail
                }
            };
        }
    }
}

/// Runs the blocking `ReadFile` loop on its own thread. See the module docs for why
/// it cannot be done on the calling thread.
///
/// The thread owns a reference to the handle, so the handle outlives the `Terminal`
/// if the thread is still parked in `ReadFile` when the engine shuts down. That is
/// the accepted cost of a synchronous console read: there is one `Terminal` per
/// process and the thread ends with it.
pub(crate) fn spawn_reader(handle: Arc<ConsoleHandle>, inbox: Arc<Inbox>) {
    let spawned = std::thread::Builder::new()
        .name("console-input".to_owned())
        .spawn({
            let inbox = Arc::clone(&inbox);
            move || {
                let mut buf = [0u8; 1024];
                loop {
                    match handle.read(&mut buf) {
                        Ok(0) => return inbox.close(None),
                        Ok(read) => {
                            if !inbox.push(&buf[..read]) {
                                return;
                            }
                        }
                        Err(err) => return inbox.close(Some(err)),
                    }
                }
            }
        });
    if let Err(err) = spawned {
        inbox.close(Some(err));
    }
}

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

/// An in-flight `request_colors`, accumulating replies until the palette is whole.
struct ColorQuery {
    colors: TerminalColors,
    received: usize,
    started: Instant,
    last_reply: Option<Instant>,
}

impl ColorQuery {
    fn new() -> Self {
        Self {
            colors: TerminalColors::default(),
            received: 0,
            started: Instant::now(),
            last_reply: None,
        }
    }

    fn deadline(&self) -> Instant {
        match self.last_reply {
            Some(at) => (at + COLOR_QUERY_IDLE).min(self.started + COLOR_QUERY_DEADLINE),
            None => self.started + COLOR_QUERY_DEADLINE,
        }
    }
}

/// The Windows console backend.
pub struct Terminal {
    wrapper: Wrapper,
    /// The environment the pane was started with, which is where the `AGWINTERM_*`
    /// addressing lives. Kept rather than read once because [`Terminal::host`]
    /// dials lazily and [`Terminal::forget_cell_size`] can make it ask again.
    env: SessionEnv,
    inbox: Arc<Inbox>,
    /// Bytes read but not yet parsed into an event — the decoder's incomplete tail.
    pending: Vec<u8>,
    /// The console input handle the reader thread is blocked on. Kept only so that
    /// [`Terminal::drop`] can cancel that read; every byte comes through the inbox.
    conin: Option<Arc<ConsoleHandle>>,
    conout: Option<Arc<ConsoleHandle>>,
    /// Dropped last, after the disable sequences have gone out.
    modes: Option<ModeGuard>,
    #[allow(
        dead_code,
        reason = "tracked from the focus reports now; Task 11 places the pointer with it"
    )]
    focused: bool,
    watching_resize: bool,
    last_size: Option<WindowSize>,
    /// The resolved cell size, cached until [`Terminal::forget_cell_size`]. It is
    /// the *same* number the canvas is sized from and the pointer is mapped with —
    /// see [`Terminal::mouse_position_px`], where the two meet.
    cell: Option<(u32, u32)>,
    /// The control-pipe client, dialled on first use. `None` before that and after
    /// [`Terminal::host_absent`] has latched.
    host: Option<ControlClient>,
    /// Set once the environment has been found not to describe an agwinterm pane,
    /// so the explanation is logged once rather than per frame.
    host_absent: bool,
    /// The file-based frame path, created with the first frame. Lazily, because a
    /// terminal that never draws should not leave a directory behind, and because
    /// creating it is the one part of `draw` that can fail before any pixels move.
    frames: Option<frame_file::FramePublisher>,
    color_query: Option<ColorQuery>,
    /// Clipboard text read by [`Terminal::request_clipboard`] and not yet handed to
    /// the engine. The OS answers synchronously, so this is a one-slot queue rather
    /// than an in-flight request.
    clipboard_reply: Option<String>,
    /// When a lone `0x1b` first appeared at the head of [`Terminal::pending`], or
    /// `None` when the tail does not start with one. See
    /// [`Terminal::lone_escape_deadline`].
    lone_escape_since: Option<Instant>,
    waker: Option<Waker>,
}

/// One error, one message, one place to change when a task lands.
fn unimplemented<T>(what: &str, task: &str) -> io::Result<T> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!("{what} is not implemented on Windows yet ({task})"),
    ))
}

fn no_console<T>(what: &str) -> io::Result<T> {
    Err(io::Error::new(
        io::ErrorKind::NotConnected,
        format!("{what} needs the pane's console, and this terminal has none"),
    ))
}

/// Opens the OS clipboard. Separate from the two methods that use it so that both
/// report a locked or unavailable clipboard the same way.
fn clipboard() -> io::Result<arboard::Clipboard> {
    arboard::Clipboard::new().map_err(clipboard_error)
}

/// `arboard`'s error as an `io::Error`. Deliberately *not* `Unsupported`: the
/// callers that matter treat that kind as "this backend cannot do it" and some of
/// them propagate it out of the engine, while a clipboard another process is
/// holding open is a transient failure of a supported operation.
fn clipboard_error(err: arboard::Error) -> io::Error {
    io::Error::other(format!("the Windows clipboard: {err}"))
}

impl Terminal {
    /// Attaches to the pane's console, puts it in raw VT mode, turns on the
    /// reporting modes and starts reading.
    ///
    /// Failing here means the process has no console at all — see the module docs
    /// on `AttachConsole` — so the error names what was required rather than
    /// leaving the caller with a terminal that answers nothing.
    pub fn new(wrapper: Wrapper, env: SessionEnv) -> io::Result<Self> {
        attach_console(&env).map_err(|err| {
            io::Error::new(
                err.kind(),
                format!(
                    "could not attach to the pane's console ({err}). The engine has to run in \
                     a process launched from the pane; set {CONSOLE_PID_VAR} to the process \
                     that owns it if a wrapper stands in between",
                ),
            )
        })?;
        let conin = Arc::new(ConsoleHandle::open(CONIN)?);
        let conout = Arc::new(ConsoleHandle::open(CONOUT)?);

        let mut modes = ModeGuard::new();
        modes.apply(&conin, raw_input_mode)?;
        // The mirror of `ENABLE_REPORTING` rides with the output mode rather than
        // being written by `Terminal::drop`, so that the one place that puts the
        // console back is also the only place that can — including from the panic
        // hook, where no `Drop` runs. See `Restore::farewell`.
        modes.apply_with_farewell(&conout, vt_output_mode, Some(DISABLE_REPORTING))?;
        conout.write_all(ENABLE_REPORTING)?;

        let inbox = Inbox::new();
        spawn_reader(Arc::clone(&conin), Arc::clone(&inbox));

        Ok(Self {
            wrapper,
            env,
            inbox,
            pending: Vec::new(),
            conin: Some(conin),
            conout: Some(conout),
            modes: Some(modes),
            focused: true,
            watching_resize: false,
            last_size: None,
            cell: None,
            host: None,
            host_absent: false,
            frames: None,
            color_query: None,
            clipboard_reply: None,
            lone_escape_since: None,
            waker: None,
        })
    }

    /// Windows has no `/dev/tty`, so there is nothing to open by path: `CONIN$` and
    /// `CONOUT$` always name the *calling* process's console. Task 2 chose the
    /// foreground process model precisely because of that, so this degrades to
    /// [`Terminal::new`] rather than failing in a way callers would have to
    /// special-case.
    pub fn open(_tty_path: &str, wrapper: Wrapper, env: SessionEnv) -> io::Result<Self> {
        Self::new(wrapper, env)
    }

    /// A terminal with an inbox but no console, for tests and for the parts of the
    /// event loop that do not need one.
    #[cfg(test)]
    fn detached(inbox: Arc<Inbox>, conout: Option<Arc<ConsoleHandle>>) -> Self {
        Self {
            wrapper: Wrapper::named(None),
            // An *empty* session environment, not the process's. The suite may
            // itself be running in an agwinterm pane, and a test that dialled the
            // developer's live instance would be exactly what the port plan
            // forbids.
            env: SessionEnv::of_session(Default::default()),
            inbox,
            pending: Vec::new(),
            conin: None,
            conout,
            modes: None,
            focused: true,
            watching_resize: false,
            last_size: None,
            cell: None,
            host: None,
            host_absent: false,
            frames: None,
            color_query: None,
            clipboard_reply: None,
            lone_escape_since: None,
            waker: None,
        }
    }

    pub fn reports_color_scheme(&self) -> bool {
        false
    }

    pub fn relayed(&self) -> bool {
        self.wrapper.relayed()
    }

    /// agwinterm implements no kitty keyboard protocol, and [`ENABLE_REPORTING`]
    /// therefore never asks for it. Saying so is what keeps the decoder reading the
    /// bytes that actually arrive.
    pub fn kitty_keyboard(&self) -> bool {
        false
    }

    /// A no-op, because key-release and key-repeat events only exist under the kitty
    /// protocol, which [`Terminal::kitty_keyboard`] already reports as absent.
    /// Reporting `Unsupported` instead would turn a capability the host lacks into
    /// an error on a path (`pixel-node`'s `set_key_event_types`) that has no way to
    /// act on it.
    pub fn set_key_event_types(&mut self, _enabled: bool) -> io::Result<()> {
        Ok(())
    }

    /// Puts a frame on screen: PNG to a file of its own, then one `image.frame`
    /// request pointing the host at it. [`crate::frame_file`] documents why the
    /// path is never reused.
    ///
    /// Two of the failures here are not failures of anything. A pane with no room
    /// in it is a legitimate state — the frame is skipped and zero bytes are
    /// reported, exactly as if it had been coalesced away — and so is a resize
    /// arriving between the composite and the publish. Everything else is
    /// reported: a frame that silently did not appear is the failure mode this
    /// whole path is shaped around.
    pub fn draw(&mut self, canvas: &Canvas) -> io::Result<usize> {
        let cell = self.cell_size()?.unwrap_or(agwinterm::FALLBACK_CELL);
        // `size()` reads the console, which is the pane; `None` when there is no
        // console at all, in which case the canvas is the only geometry there is.
        let pane = self.size().ok().map(|window| (window.cols, window.rows));
        let span = match frame_file::cell_span((canvas.width, canvas.height), cell, pane) {
            Ok(span) => span,
            Err(frame_file::TooSmall) => return Ok(0),
        };

        // Taken out of `self` for the frame, because publishing borrows the host
        // client — which also lives in `self` — at the same time.
        let mut frames = match self.frames.take() {
            Some(frames) => frames,
            None => frame_file::FramePublisher::new(&self.env)?,
        };
        let published = match self.host() {
            Some(client) => frames.publish(client, canvas, span),
            None => Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "there is no agwinterm pane to draw into; see the earlier log line \
                 for which variable is missing",
            )),
        };
        self.frames = Some(frames);
        published
    }

    /// Takes the last frame back off the pane.
    ///
    /// A frame is a placement the host holds until something replaces it, so on unix
    /// there is nothing to undo — the Kitty escapes go through the terminal's own
    /// stream and the shell's next output scrolls them away. Here the picture would
    /// simply stay, over a pane that is otherwise a working terminal.
    ///
    /// Every failure is swallowed on purpose. This runs from `Drop`, on the way out,
    /// often *because* something already went wrong; a dead pipe or a host that has
    /// closed the pane are both "the placement is gone anyway", and neither is worth
    /// a message on an exit path. The publisher is put back afterwards so the field
    /// is left as it was found.
    fn clear_frame(&mut self) {
        let Some(mut frames) = self.frames.take() else {
            return;
        };
        if let Some(client) = self.host() {
            let _ = frames.clear(client);
        }
        self.frames = Some(frames);
    }

    pub fn read_event(&mut self) -> io::Result<Event> {
        match self.poll_event(None)? {
            Some(event) => Ok(event),
            None => Err(io::ErrorKind::UnexpectedEof.into()),
        }
    }

    /// One event per call, in arrival order, within `timeout`.
    ///
    /// The parsing is the inherited decoder's, unchanged. What is local to Windows
    /// is where the bytes come from (the reader thread's inbox), and the two things
    /// that arrive without bytes: a wake, and a resize noticed by re-reading the
    /// screen buffer.
    pub fn poll_event(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        let deadline = timeout.map(|timeout| Instant::now() + timeout);
        loop {
            if let Some(text) = self.clipboard_reply.take() {
                return Ok(Some(Event::Paste(text)));
            }
            if let Some((raw, used)) = parse_event_kitty(&self.pending, self.kitty_keyboard()) {
                self.pending.drain(..used);
                match self.lift(raw) {
                    Some(event) => return Ok(Some(event)),
                    None => continue,
                }
            }
            if let Some(size) = self.resize_since_last_look() {
                return Ok(Some(Event::WindowSize(size)));
            }
            let escape_deadline = self.lone_escape_deadline();
            let color_deadline = self.color_query.as_ref().map(ColorQuery::deadline);
            let resize_deadline = self.watching_resize.then(|| Instant::now() + RESIZE_POLL);
            let until = [deadline, escape_deadline, color_deadline, resize_deadline]
                .into_iter()
                .flatten()
                .min();
            let wait = until.map(|until| until.saturating_duration_since(Instant::now()));
            match self.inbox.take(&mut self.pending, wait)? {
                Taken::Bytes => continue,
                Taken::Woken => return Ok(None),
                Taken::Eof => return Err(io::ErrorKind::UnexpectedEof.into()),
                Taken::Timeout => {
                    if escape_deadline.is_some_and(|at| Instant::now() >= at) {
                        self.pending.drain(..1);
                        self.lone_escape_since = None;
                        return Ok(Some(Event::Key(KeyEvent::plain(Key::Escape))));
                    }
                    if color_deadline.is_some_and(|at| Instant::now() >= at) {
                        match self.take_settled_colors() {
                            Some(colors) => return Ok(Some(Event::Colors(colors))),
                            None => continue,
                        }
                    }
                    if deadline.is_none_or(|at| Instant::now() < at) {
                        continue;
                    }
                    return Ok(None);
                }
            }
        }
    }

    /// Unblocks the reader thread's parked `ReadFile`.
    ///
    /// `CancelIoEx` rather than `CancelIo`: the read was issued on the reader
    /// thread, and `CancelIo` only reaches operations the *calling* thread started.
    /// Best effort — `ERROR_NOT_FOUND` means the read had already returned, which is
    /// the outcome this is trying to produce.
    #[allow(unsafe_code)]
    fn cancel_pending_read(&self) {
        let Some(conin) = self.conin.as_ref() else {
            return;
        };
        // SAFETY: the handle is owned by this `Terminal` and by the reader thread,
        // both of which are still alive here; the null second argument is the
        // documented "every operation on this handle".
        unsafe { CancelIoEx(conin.raw(), std::ptr::null()) };
    }

    /// When a `0x1b` sitting alone at the head of the tail should be given up on and
    /// reported as the Escape key.
    ///
    /// Under `ENABLE_VIRTUAL_TERMINAL_INPUT` conhost delivers Escape as a bare
    /// `0x1b` and nothing more, and `parse_event_kitty` cannot decide a one-byte
    /// buffer — it needs `buf[1]` to tell `ESC [` from `ESC O` from Alt+key. So
    /// without a deadline the byte sits in `pending` for ever: Escape is never
    /// delivered *and* the stale byte turns the next keystroke into Alt+that-key.
    ///
    /// This is upstream's `lone_escape_deadline` (`terminal.rs`), with one
    /// difference: upstream applies it only under a relaying wrapper, because a
    /// direct tty read gets the whole sequence in one `read` and a lone escape can
    /// be trusted immediately. Here every byte arrives through the reader thread's
    /// inbox, one `ReadFile` at a time, so the wait is unconditional.
    fn lone_escape_deadline(&mut self) -> Option<Instant> {
        if self.pending.len() != 1 || self.pending.first() != Some(&0x1b) {
            self.lone_escape_since = None;
            return None;
        }
        Some(*self.lone_escape_since.get_or_insert_with(Instant::now) + LONE_ESCAPE_WAIT)
    }

    /// Turns one decoded [`RawEvent`] into the event the engine sees. `None` means
    /// the raw event was absorbed into backend state and produced nothing.
    fn lift(&mut self, raw: RawEvent) -> Option<Event> {
        Some(match raw {
            RawEvent::Key(key) => Event::Key(key),
            RawEvent::Paste(text) => Event::Paste(text),
            RawEvent::Focus(focused) => {
                self.focused = focused;
                Event::Focus(focused)
            }
            RawEvent::WindowSize(size) => {
                // An in-band report (mode 2048). Share the "last size" with the
                // screen-buffer poll so the same resize is not announced twice.
                self.last_size = Some(size);
                Event::WindowSize(size)
            }
            RawEvent::Mouse(kind, button, mods, x, y) => {
                let (x, y) = self.mouse_position_px(x, y);
                Event::Mouse(crate::terminal::Mouse {
                    kind,
                    button,
                    mods,
                    x,
                    y,
                })
            }
            RawEvent::ColorSchemeChanged => Event::ColorSchemeChanged,
            RawEvent::Color(slot, rgba) => {
                return self.collect_color(slot, rgba).map(Event::Colors);
            }
            // Clipboard replies cannot arrive: nothing on this backend sends the
            // OSC 52 or OSC 5522 requests that produce them, and
            // `clipboard_data_supported` says so. Task 11 owns the clipboard.
            RawEvent::Clip(_) => return None,
        })
    }

    /// SGR mouse reports address a cell, and there is no `?1016` here to make them
    /// address a pixel. Until Task 6 settles where cell metrics come from, this
    /// passes the zero-based cell through rather than multiplying by a guessed cell
    /// size — a wrong multiplier is a wrong click target, which is worse than a
    /// coarse one. Task 11 converts, using whatever Task 6 decides.
    fn mouse_position_px(&self, x: u32, y: u32) -> (u32, u32) {
        // `cell_size` is resolved during `Engine::new`, before anything is on
        // screen to click, so the cache is populated by the time a report arrives.
        // The fallback is the same constant `cell_size` would have returned rather
        // than a cell-unit coordinate, because a pointer mapped in different units
        // than the canvas was drawn in is precisely the wrong-click-target bug.
        let (width, height) = self.cell.unwrap_or(agwinterm::FALLBACK_CELL);
        // Saturating throughout. `x` and `y` come from `param()`, which parses
        // whatever digits an SGR mouse report carried without an upper bound, so a
        // malformed `\x1b[<0;4294967295;1M` reaches here as `u32::MAX`. The
        // multiply would then panic a debug build and wrap a release one into a
        // click somewhere near the origin; saturating clamps it to the far edge,
        // which is where the report claimed to be.
        (
            x.saturating_sub(1)
                .saturating_mul(width)
                .saturating_add(width / 2),
            y.saturating_sub(1)
                .saturating_mul(height)
                .saturating_add(height / 2),
        )
    }

    /// Re-reads the console's size and reports it if it changed. `None` when
    /// `watch_resize` was never called, when the size is unchanged, or when the
    /// console cannot be read — a transient query failure is not an event.
    fn resize_since_last_look(&mut self) -> Option<WindowSize> {
        if !self.watching_resize {
            return None;
        }
        let size = self.conout.as_ref()?.window_size().ok()?;
        if self.last_size == Some(size) {
            return None;
        }
        self.last_size = Some(size);
        Some(size)
    }

    pub fn waker(&mut self) -> io::Result<Waker> {
        let waker = self.waker.get_or_insert_with(|| Waker {
            inbox: Arc::clone(&self.inbox),
        });
        Ok(waker.clone())
    }

    /// There is no `SIGWINCH`. This records the size the pane has now, after which
    /// `poll_event` re-reads the screen buffer every [`RESIZE_POLL`] and reports
    /// what changed.
    pub fn watch_resize(&mut self) -> io::Result<()> {
        let Some(conout) = self.conout.as_ref() else {
            return no_console("watching for resize");
        };
        self.last_size = Some(conout.window_size()?);
        self.watching_resize = true;
        Ok(())
    }

    pub fn size(&self) -> io::Result<WindowSize> {
        match self.conout.as_ref() {
            Some(conout) => conout.window_size(),
            None => no_console("reading the console size"),
        }
    }

    /// agwinterm quantises the pointer to a character cell at the encode site and
    /// implements no `?1016`, so this is `false` and stays `false` until the host
    /// gains one. Recorded as an accepted ceiling in the port plan.
    pub fn reports_pixel_mouse(&self) -> bool {
        false
    }

    pub fn frames_are_inline(&self) -> bool {
        false
    }

    pub fn forget_cell_size(&mut self) {
        self.cell = None;
    }

    /// The size of one character cell in pixels.
    ///
    /// Never `None`, which is the one thing worth knowing about it. `engine/mod.rs`
    /// substitutes `(16, 32)` for a `None` and then sizes the canvas with it, while
    /// this backend would go on mapping the pointer with whatever *it* had — two
    /// coordinate spaces, and click targets that land in the wrong place. So the
    /// resolution happens here, once, and both sides read the cached result.
    /// [`crate::agwinterm::cell_size`] is where the three sources are ordered.
    pub fn cell_size(&mut self) -> io::Result<Option<(u32, u32)>> {
        if self.cell.is_none() {
            // The client borrows `self` mutably; the environment it is resolved
            // against is cheap to clone and immutable for the process's life.
            let env = self.env.clone();
            self.cell = Some(agwinterm::cell_size(self.host(), &env));
        }
        Ok(self.cell)
    }

    /// The control-pipe client, dialled on first use.
    ///
    /// Resolving the target is what fails informatively — the message names every
    /// `AGWINTERM_*` variable a pane sets — but it fails *once*: a browser started
    /// outside agwinterm should say so and carry on, not repeat itself per frame.
    /// Connecting is separate and happens on the first request.
    fn host(&mut self) -> Option<&mut ControlClient> {
        if self.host.is_none() && !self.host_absent {
            match ControlClient::from_env(&self.env) {
                Ok(client) => {
                    crate::logging::info(
                        "agwinterm",
                        format!("frames go to pane {}", client.target().session()),
                    );
                    self.host = Some(client);
                }
                Err(err) => {
                    self.host_absent = true;
                    crate::logging::warn("agwinterm", err.to_string());
                }
            }
        }
        self.host.as_mut()
    }

    /// Asks for the palette and waits for it, up to [`COLOR_QUERY_DEADLINE`].
    ///
    /// Bytes that arrive while waiting are consumed rather than queued, exactly as
    /// the unix backend does: this runs once, during engine construction, before
    /// anything is on screen to type at.
    pub fn query_colors(&mut self) -> io::Result<TerminalColors> {
        self.write_console(&color_queries())?;
        let mut buf = Vec::new();
        self.drain_color_replies(&mut buf)?;
        Ok(colors_from_replies(&buf))
    }

    fn drain_color_replies(&mut self, buf: &mut Vec<u8>) -> io::Result<()> {
        let deadline = Instant::now() + COLOR_QUERY_DEADLINE;
        loop {
            let replies = buf.windows(4).filter(|window| window == b"rgb:").count();
            if replies >= COLOR_SLOTS || buf.len() > 4096 {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait = if replies > 0 {
                remaining.min(COLOR_QUERY_IDLE)
            } else {
                remaining
            };
            if wait.is_zero() {
                return Ok(());
            }
            match self.inbox.take(buf, Some(wait))? {
                Taken::Bytes => continue,
                // A wake or an end of input during startup is not an error worth
                // failing construction over; the palette is simply whatever arrived.
                Taken::Woken | Taken::Timeout | Taken::Eof => return Ok(()),
            }
        }
    }

    /// Asks for the palette without waiting. Replies arrive through `poll_event` as
    /// `Event::Colors` once every slot has answered or the query goes idle.
    pub fn request_colors(&mut self) -> io::Result<()> {
        self.write_console(&color_queries())?;
        self.color_query = Some(ColorQuery::new());
        Ok(())
    }

    fn collect_color(&mut self, slot: ColorSlot, rgba: [u8; 4]) -> Option<TerminalColors> {
        let query = self.color_query.as_mut()?;
        query.colors.set(slot, rgba);
        query.received += 1;
        query.last_reply = Some(Instant::now());
        if query.received < COLOR_SLOTS {
            return None;
        }
        self.take_settled_colors()
    }

    fn take_settled_colors(&mut self) -> Option<TerminalColors> {
        let query = self.color_query.take()?;
        (query.received > 0).then_some(query.colors)
    }

    fn write_console(&mut self, bytes: &[u8]) -> io::Result<()> {
        match self.conout.as_ref() {
            Some(conout) => conout.write_all(bytes),
            None => no_console("writing to the terminal"),
        }
    }

    pub fn set_pointer_shape(&mut self, _shape: &str) -> io::Result<()> {
        unimplemented("setting the pointer shape", "Task 11")
    }

    /// The clipboard, through the OS rather than through the terminal.
    ///
    /// Upstream writes `OSC 52` and lets the terminal decide. agwinterm implements
    /// no `OSC 52`, and ConPTY would strip the reply the same way it strips Kitty
    /// graphics — so the escape route is closed here for the same reason the frame
    /// route was. Windows has a clipboard of its own, and `arboard` is already a
    /// dependency of this crate and already used on this platform
    /// ([`crate::clipboard_image::read_for_worker`]), so this is a capability the
    /// port has rather than one it refuses.
    ///
    /// Refusing it was not free. `set_clipboard` is reached through `?` from
    /// `engine/clipboard.rs`'s `begin_rich_capture` and `engine/doc.rs`'s
    /// `InputAction::Copy`, so an error unwinds out of `Engine::handle_event` →
    /// `Engine::pump`, which `pixel-node` treats as a fatal engine exit: Ctrl+C in
    /// the address bar closed the browser. A capability the host lacks must not be
    /// able to end the process.
    ///
    /// Which is why *no* failure here is returned. Answering `io::Error::other`
    /// instead of `Unsupported` changed the message and not the outcome: nothing on
    /// that path inspects the kind (`grep Unsupported engine/`), so any `Err` still
    /// ends the browser. And a failure is not hypothetical on Windows: the clipboard
    /// is a single global lock, `arboard` gives up on `OpenClipboard` after five
    /// tries at 5 ms, and a clipboard manager, RDP redirection or an Office
    /// application holding it for 25 ms is ordinary. Losing a copy is a nuisance;
    /// losing the browser because someone else was pasting is not a trade to make.
    /// The failure is logged, where it can be read without costing the session.
    pub fn set_clipboard(&mut self, text: &str) -> io::Result<()> {
        if let Err(err) = clipboard()
            .and_then(|mut board| board.set_text(text.to_owned()).map_err(clipboard_error))
        {
            crate::logging::warn(
                "clipboard",
                format!("the copy did not reach the Windows clipboard ({err})"),
            );
        }
        Ok(())
    }

    /// The read half. There is no reply to wait for — the OS answers now — so the
    /// text is parked and [`Terminal::poll_event`] hands it back as the
    /// `Event::Paste` the `OSC 52` reply would have decoded into. Same event, same
    /// engine path (`engine/clipboard.rs`'s `pending_pastes`), no protocol.
    pub fn request_clipboard(&mut self) -> io::Result<()> {
        let text = match clipboard()?.get_text() {
            Ok(text) => text,
            // A clipboard holding an image, or nothing at all, is not a failure:
            // it is a paste with nothing in it. A terminal that owned no selection
            // answered the same way, by never replying at all.
            Err(arboard::Error::ContentNotAvailable) => String::new(),
            Err(err) => return Err(clipboard_error(err)),
        };
        self.clipboard_reply = Some(text);
        Ok(())
    }

    pub fn clipboard_data_supported(&self) -> bool {
        false
    }

    pub fn request_clipboard_types(&mut self) -> io::Result<()> {
        unimplemented("listing clipboard types", "Task 11")
    }

    pub fn request_clipboard_data(&mut self, _mime: &str) -> io::Result<()> {
        unimplemented("reading typed clipboard data", "Task 11")
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.clear_frame();
        // Both before the modes go back. `abandon` stops the reader thread the next
        // time it has something to push; `CancelIoEx` is what gives it that next
        // time, because otherwise it is parked in a blocking `ReadFile` on `CONIN$`
        // and only a keystroke would return it — a keystroke typed at the shell
        // that has the pane back, read in the *line* mode the console has just been
        // restored to, and therefore swallowed whole.
        self.inbox.abandon();
        self.cancel_pending_read();
        // Last: `ModeGuard::drop` writes `DISABLE_REPORTING` before it restores the
        // mode, so the sequences still go out through the VT output mode this
        // backend turned on.
        drop(self.modes.take());
    }
}

/// `OSC 10`, `OSC 11` and the sixteen `OSC 4` queries, as one write.
fn color_queries() -> Vec<u8> {
    let mut query = b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\".to_vec();
    for slot in 0..16 {
        query.extend_from_slice(format!("\x1b]4;{slot};?\x1b\\").as_bytes());
    }
    query
}

/// Reads whatever the terminal answered out of a buffer of replies, using the
/// decoder's own `parse_osc_color`.
fn colors_from_replies(buf: &[u8]) -> TerminalColors {
    let mut colors = TerminalColors {
        foreground: parse_osc_color(buf, "10;"),
        background: parse_osc_color(buf, "11;"),
        ..TerminalColors::default()
    };
    for (slot, entry) in colors.palette.iter_mut().enumerate() {
        *entry = parse_osc_color(buf, &format!("4;{slot};"));
    }
    colors
}

#[cfg(test)]
mod tests {
    //! What is tested here is what this module adds — the read loop, the console
    //! mode pair, resize, and the raw-mode restore — not the decoder, which arrives
    //! with 25 tests of its own inside `terminal.rs`.
    //!
    //! Where the subject is a Win32 behaviour, the test drives the real API: a real
    //! anonymous pipe for the reader thread, and a real *private* console screen
    //! buffer (`CreateConsoleScreenBuffer`) for the mode and size calls. A private
    //! buffer is a genuine console object with genuine modes, and changing it cannot
    //! disturb the terminal the test suite is running in — which the active buffer
    //! would.

    use super::*;
    use crate::terminal::{Key, KeyEvent, MouseButton, MouseKind};
    use crate::terminal_backend::TerminalBackend;
    use std::os::windows::io::{IntoRawHandle, OwnedHandle};
    use windows_sys::Win32::System::Console::{
        CONSOLE_TEXTMODE_BUFFER, CreateConsoleScreenBuffer, SMALL_RECT, SetConsoleWindowInfo,
    };

    /// A console screen buffer of our own: real console handle, real modes, real
    /// `GetConsoleScreenBufferInfo`, attached to nothing the user can see.
    #[allow(unsafe_code)]
    fn private_screen_buffer() -> Arc<ConsoleHandle> {
        // SAFETY: the two pointer arguments are the documented "no security
        // attributes, no buffer data" nulls.
        let handle = unsafe {
            CreateConsoleScreenBuffer(
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                CONSOLE_TEXTMODE_BUFFER,
                std::ptr::null(),
            )
        };
        assert_ne!(
            handle,
            INVALID_HANDLE_VALUE,
            "could not create a private screen buffer: {}",
            io::Error::last_os_error(),
        );
        Arc::new(ConsoleHandle::from_raw(handle))
    }

    /// Two window sizes this console will actually accept, larger first.
    ///
    /// Not constants: `dwMaximumWindowSize` is bounded by the pane the test suite
    /// is running in, so a hard-coded 80x24 would fail on a narrow terminal and
    /// look like a resize bug.
    #[allow(unsafe_code)]
    fn two_sizes(handle: &ConsoleHandle) -> ((i16, i16), (i16, i16)) {
        // SAFETY: a plain out-param struct, zeroed before the call fills it.
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is a valid out-param and the handle is one we created.
        let ok = unsafe { GetConsoleScreenBufferInfo(handle.raw(), &mut info) };
        assert_ne!(ok, 0, "{}", io::Error::last_os_error());
        let cols = info.dwMaximumWindowSize.X.min(info.dwSize.X).clamp(8, 80);
        let rows = info.dwMaximumWindowSize.Y.min(info.dwSize.Y).clamp(8, 24);
        ((cols, rows), (cols / 2, rows / 2))
    }

    /// Resizes a private screen buffer's visible window, which is what
    /// [`ConsoleHandle::window_size`] reads.
    #[allow(unsafe_code)]
    fn set_window(handle: &ConsoleHandle, cols: i16, rows: i16) {
        let window = SMALL_RECT {
            Left: 0,
            Top: 0,
            Right: cols - 1,
            Bottom: rows - 1,
        };
        // SAFETY: `window` outlives the call and `handle` is a console output
        // handle we created.
        let ok = unsafe { SetConsoleWindowInfo(handle.raw(), 1, &window) };
        assert_ne!(
            ok,
            0,
            "could not resize the private screen buffer: {}",
            io::Error::last_os_error(),
        );
    }

    fn owned(handle: OwnedHandle) -> Arc<ConsoleHandle> {
        Arc::new(ConsoleHandle::from_raw(handle.into_raw_handle()))
    }

    // -- the read loop ----------------------------------------------------

    #[test]
    fn the_reader_thread_carries_real_pipe_bytes_into_the_inbox() {
        // The pump is written against a handle, not against a console, so a real
        // anonymous pipe exercises the same `ReadFile` loop the console uses —
        // including its end-of-input path, which a console never reaches.
        let (reader, mut writer) = std::io::pipe().expect("a pipe");
        let inbox = Inbox::new();
        spawn_reader(owned(reader.into()), Arc::clone(&inbox));

        let mut term = Terminal::detached(Arc::clone(&inbox), None);
        std::io::Write::write_all(&mut writer, b"hi").expect("write");

        assert_eq!(
            term.poll_event(Some(Duration::from_secs(5))).unwrap(),
            Some(Event::Key(KeyEvent::plain(Key::Char('h')))),
        );
        assert_eq!(
            term.poll_event(Some(Duration::from_secs(5))).unwrap(),
            Some(Event::Key(KeyEvent::plain(Key::Char('i')))),
            "one event per call, in arrival order, from one read",
        );

        drop(writer);
        assert_eq!(
            term.poll_event(Some(Duration::from_secs(5)))
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof,
            "the writer going is end of input, not a timeout",
        );
    }

    #[test]
    fn an_event_split_across_two_reads_is_held_until_it_is_whole() {
        // The decoder already reports incomplete tails; what is new is that the
        // loop keeps the tail and waits rather than treating "no event yet" as
        // "no event". Split an SGR mouse report mid-sequence.
        let inbox = Inbox::new();
        let mut term = Terminal::detached(Arc::clone(&inbox), None);

        inbox.push(b"\x1b[<0;12");
        assert_eq!(
            term.poll_event(Some(Duration::from_millis(50))).unwrap(),
            None,
            "half a mouse report is not an event",
        );

        inbox.push(b";5M");
        let event = term.poll_event(Some(Duration::from_secs(5))).unwrap();
        assert_eq!(
            event,
            Some(Event::Mouse(crate::terminal::Mouse {
                kind: MouseKind::Down,
                button: MouseButton::Left,
                mods: Default::default(),
                // The centre of cell (12, 5), in pixels. Since Task 6 the report
                // is scaled by the same cell size the canvas is drawn at — here
                // the fallback, because a detached terminal has no host to ask.
                x: 11 * agwinterm::FALLBACK_CELL.0 + agwinterm::FALLBACK_CELL.0 / 2,
                y: 4 * agwinterm::FALLBACK_CELL.1 + agwinterm::FALLBACK_CELL.1 / 2,
            })),
        );
    }

    #[test]
    fn a_wait_with_nothing_to_read_times_out_rather_than_blocking() {
        let inbox = Inbox::new();
        let mut term = Terminal::detached(inbox, None);
        let started = Instant::now();
        assert_eq!(
            term.poll_event(Some(Duration::from_millis(80))).unwrap(),
            None
        );
        assert!(
            started.elapsed() >= Duration::from_millis(70),
            "returned before the deadline it was given",
        );
    }

    #[test]
    fn the_waker_interrupts_a_wait_that_has_no_deadline() {
        // `poll_event(None)` blocks forever on unix until the self-pipe is written.
        // Here the equivalent is the inbox flag, and this is the test that a
        // deadline-less wait is genuinely interruptible from another thread.
        let inbox = Inbox::new();
        let mut term = Terminal::detached(Arc::clone(&inbox), None);
        let waker = term.waker().expect("a waker");

        let woken = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            waker.wake();
        });
        assert_eq!(
            term.poll_event(None).unwrap(),
            None,
            "a wake is not an event"
        );
        woken.join().expect("the waking thread");

        // And it is one-shot: the next wait is not still returning.
        assert_eq!(
            term.poll_event(Some(Duration::from_millis(30))).unwrap(),
            None
        );
        inbox.push(b"x");
        assert_eq!(
            term.poll_event(Some(Duration::from_secs(5))).unwrap(),
            Some(Event::Key(KeyEvent::plain(Key::Char('x')))),
            "the wake did not lose the bytes that came after it",
        );
    }

    #[test]
    fn waking_before_the_wait_is_not_lost() {
        // The engine wakes a terminal that is not yet blocked often enough that
        // dropping the flag would show up as a hang.
        let inbox = Inbox::new();
        let mut term = Terminal::detached(Arc::clone(&inbox), None);
        term.waker().expect("a waker").wake();
        assert_eq!(term.poll_event(None).unwrap(), None);
    }

    #[test]
    fn a_reader_error_surfaces_as_that_error_not_as_end_of_input() {
        let inbox = Inbox::new();
        let mut term = Terminal::detached(Arc::clone(&inbox), None);
        inbox.close(Some(io::Error::from_raw_os_error(
            ERROR_ACCESS_DENIED as i32,
        )));
        let err = term.poll_event(Some(Duration::from_secs(5))).unwrap_err();
        assert_eq!(err.raw_os_error(), Some(ERROR_ACCESS_DENIED as i32));
    }

    #[test]
    fn read_event_is_poll_event_with_no_deadline() {
        let inbox = Inbox::new();
        let mut term = Terminal::detached(Arc::clone(&inbox), None);
        let pusher = {
            let inbox = Arc::clone(&inbox);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(20));
                inbox.push(b"\r");
            })
        };
        assert_eq!(
            term.read_event().unwrap(),
            Event::Key(KeyEvent::plain(Key::Enter)),
        );
        pusher.join().expect("the pushing thread");
    }

    // -- resize -----------------------------------------------------------

    #[test]
    fn resize_is_read_off_a_real_console_screen_buffer() {
        // There is no SIGWINCH, so this is the whole mechanism: `watch_resize`
        // takes a baseline and `poll_event` notices the difference.
        let buffer = private_screen_buffer();
        let ((cols, rows), (half_cols, half_rows)) = two_sizes(&buffer);
        set_window(&buffer, cols, rows);
        let inbox = Inbox::new();
        let mut term = Terminal::detached(Arc::clone(&inbox), Some(Arc::clone(&buffer)));

        assert_eq!(term.size().unwrap().cols, u32::from(cols as u16));
        assert_eq!(term.size().unwrap().rows, u32::from(rows as u16));
        assert_eq!(
            term.size().unwrap().cell_size(),
            None,
            "Windows reports no pixel size, and guessing one is Task 6's to refuse",
        );

        term.watch_resize().expect("watching a real buffer");
        assert_eq!(
            term.poll_event(Some(Duration::from_millis(30))).unwrap(),
            None,
            "watching must not announce the size it started from",
        );

        set_window(&buffer, half_cols, half_rows);
        let event = term.poll_event(Some(Duration::from_secs(5))).unwrap();
        assert_eq!(
            event,
            Some(Event::WindowSize(WindowSize {
                cols: u32::from(half_cols as u16),
                rows: u32::from(half_rows as u16),
                width_px: 0,
                height_px: 0,
            })),
        );
        assert_eq!(
            term.poll_event(Some(Duration::from_millis(30))).unwrap(),
            None,
            "the same size must not be announced twice",
        );
    }

    #[test]
    fn a_resize_is_noticed_even_when_no_input_ever_arrives() {
        // The failure this guards against: capping the wait only when input is
        // pending, so an idle pane never learns it was resized.
        let buffer = private_screen_buffer();
        let ((cols, rows), (half_cols, half_rows)) = two_sizes(&buffer);
        set_window(&buffer, cols, rows);
        let mut term = Terminal::detached(Inbox::new(), Some(Arc::clone(&buffer)));
        term.watch_resize().expect("watching a real buffer");

        let resizer = {
            let buffer = Arc::clone(&buffer);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(40));
                set_window(&buffer, half_cols, half_rows);
            })
        };
        // No deadline at all: only the resize poll can end this wait.
        assert_eq!(
            term.read_event().unwrap(),
            Event::WindowSize(WindowSize {
                cols: u32::from(half_cols as u16),
                rows: u32::from(half_rows as u16),
                width_px: 0,
                height_px: 0,
            }),
        );
        resizer.join().expect("the resizing thread");
    }

    #[test]
    fn an_in_band_resize_report_and_the_screen_buffer_do_not_double_up() {
        // Mode 2048 is in ENABLE_REPORTING, so a host that implements it sends the
        // size in band. The decoder already parses it; what matters here is that
        // the two routes share one baseline.
        let buffer = private_screen_buffer();
        let ((cols, rows), _) = two_sizes(&buffer);
        set_window(&buffer, cols, rows);
        let inbox = Inbox::new();
        let mut term = Terminal::detached(Arc::clone(&inbox), Some(Arc::clone(&buffer)));
        term.watch_resize().expect("watching a real buffer");

        // The same size the buffer already has, so only the shared baseline can
        // keep the screen-buffer poll quiet afterwards.
        inbox.push(format!("\x1b[48;{rows};{cols};0;0t").as_bytes());
        assert_eq!(
            term.poll_event(Some(Duration::from_secs(5))).unwrap(),
            Some(Event::WindowSize(WindowSize {
                cols: u32::from(cols as u16),
                rows: u32::from(rows as u16),
                width_px: 0,
                height_px: 0,
            })),
        );
        assert_eq!(
            term.poll_event(Some(Duration::from_millis(150))).unwrap(),
            None,
            "the screen-buffer poll re-announced a size the in-band report already \
             delivered",
        );
    }

    #[test]
    fn resize_is_silent_until_it_is_asked_for() {
        let buffer = private_screen_buffer();
        let ((cols, rows), (half_cols, half_rows)) = two_sizes(&buffer);
        set_window(&buffer, cols, rows);
        let mut term = Terminal::detached(Inbox::new(), Some(Arc::clone(&buffer)));
        set_window(&buffer, half_cols, half_rows);
        assert_eq!(
            term.poll_event(Some(Duration::from_millis(50))).unwrap(),
            None,
            "`watch_resize` was never called, so nothing should be watching",
        );
    }

    #[test]
    fn a_terminal_with_no_console_says_so_rather_than_guessing() {
        let mut term = Terminal::detached(Inbox::new(), None);
        for err in [term.size().map(|_| ()), term.watch_resize()] {
            let err = err.expect_err("there is no console handle");
            assert_eq!(err.kind(), io::ErrorKind::NotConnected);
        }
    }

    // -- console modes ----------------------------------------------------

    /// The mode tests share two pieces of process-wide state — the restore
    /// registry, and the panic hook that walks it — so they run one at a time.
    /// Without this, one test's deliberate panic fires the hook while another
    /// test's mode is still registered, and restores it early.
    static MODE_TESTS: Mutex<()> = Mutex::new(());

    fn one_at_a_time() -> MutexGuard<'static, ()> {
        MODE_TESTS.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[test]
    fn the_raw_input_mode_is_the_measured_one_and_preserves_everything_else() {
        let previous = ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT | 0x4000;
        let raw = raw_input_mode(previous);
        assert_eq!(raw & ENABLE_LINE_INPUT, 0, "line input must be off");
        assert_eq!(raw & ENABLE_ECHO_INPUT, 0, "echo must be off");
        assert_eq!(
            raw & ENABLE_PROCESSED_INPUT,
            0,
            "processed input must be off"
        );
        assert_ne!(
            raw & ENABLE_VIRTUAL_TERMINAL_INPUT,
            0,
            "without VT input the console hands over INPUT_RECORDs, not escapes",
        );
        assert_ne!(raw & 0x4000, 0, "an unrelated bit was cleared");
    }

    #[test]
    fn the_output_mode_only_adds() {
        let vt = vt_output_mode(0x0001);
        assert_ne!(vt & ENABLE_VIRTUAL_TERMINAL_PROCESSING, 0);
        assert_ne!(vt & DISABLE_NEWLINE_AUTO_RETURN, 0);
        assert_ne!(vt & 0x0001, 0);
    }

    #[test]
    fn entering_and_leaving_a_mode_round_trips_a_real_console_handle() {
        // A private screen buffer is an *output* handle, so this exercises the
        // output half of the pair; `SetConsoleMode` rejects input flags on it with
        // `ERROR_INVALID_PARAMETER`. The input half's one platform-specific part is
        // the bitmask, which is unit-tested above — there is only one console input
        // buffer per process and it belongs to the terminal running these tests.
        let _serial = one_at_a_time();
        let buffer = private_screen_buffer();
        let before = buffer.mode().expect("a real console mode");
        {
            let mut guard = ModeGuard::new();
            guard.apply(&buffer, vt_output_mode).expect("apply");
            assert_eq!(
                buffer.mode().unwrap(),
                vt_output_mode(before),
                "the mode the guard set is not the one it computed",
            );
        }
        assert_eq!(
            buffer.mode().unwrap(),
            before,
            "dropping the guard must put back the exact mode it found",
        );
    }

    #[test]
    fn a_failed_apply_registers_nothing_it_will_never_pair() {
        let _serial = one_at_a_time();
        let registered = || registry().len();
        let before = registered();
        let mut guard = ModeGuard::new();
        // A handle that is not a console: `GetConsoleMode` fails, so there is
        // nothing to remember and nothing to restore.
        let (reader, _writer) = std::io::pipe().expect("a pipe");
        assert!(guard.apply(&owned(reader.into()), vt_output_mode).is_err());
        assert_eq!(registered(), before, "a failed apply left an entry behind");
        drop(guard);
        assert_eq!(registered(), before);
    }

    #[test]
    fn the_panic_hook_restores_a_mode_no_drop_would_reach() {
        // The guard's `Drop` covers an ordinary unwind. This covers what it cannot:
        // a mode still ours when nothing will run a destructor for it. The registry
        // is driven directly so the assertion is about the restore path, not about
        // panic timing.
        let _serial = one_at_a_time();
        let buffer = private_screen_buffer();
        let before = buffer.mode().expect("a real console mode");
        let mut guard = ModeGuard::new();
        guard.apply(&buffer, vt_output_mode).expect("apply");
        assert_ne!(buffer.mode().unwrap(), before);

        restore_registered_modes();
        assert_eq!(
            buffer.mode().unwrap(),
            before,
            "the panic hook's restore did not put the mode back",
        );
        drop(guard);
    }

    #[test]
    fn the_panic_hooks_restore_takes_the_registry_with_it() {
        // The double-write guard. The hook writes each handle's farewell -- for the
        // real terminal that is `DISABLE_REPORTING`, which pops the alternate
        // screen and puts the cursor and mouse reporting back -- and then restores
        // the mode that carried it. If a `ModeGuard::drop` unwinding past it found
        // its entry still registered, it would write those escape bytes a second
        // time with VT output already off, and the pane would show them as text.
        let _serial = one_at_a_time();
        let buffer = private_screen_buffer();
        let before = buffer.mode().expect("a real console mode");
        let mut guard = ModeGuard::new();
        guard
            .apply_with_farewell(&buffer, vt_output_mode, Some(b"[?25h"))
            .expect("apply");

        restore_registered_modes();
        assert!(
            registry().is_empty(),
            "the hook left entries behind for a later Drop to write again",
        );

        drop(guard);
        assert_eq!(
            buffer.mode().unwrap(),
            before,
            "the guard's Drop disturbed a console the hook had already restored",
        );
    }

    #[test]
    fn overlapping_mode_guards_unwind_in_the_order_they_were_taken() {
        // Two guards on one handle: the inner one must restore the mode the outer
        // one set, and the outer one the mode the console started in. Restoring in
        // insertion order instead leaves the console in the *inner* guard's mode,
        // which on this backend is raw -- a shell with no echo and no line editing.
        let _serial = one_at_a_time();
        let buffer = private_screen_buffer();
        let before = buffer.mode().expect("a real console mode");

        let mut outer = ModeGuard::new();
        outer.apply(&buffer, vt_output_mode).expect("outer");
        let middle = buffer.mode().unwrap();
        assert_ne!(middle, before);

        let mut inner = ModeGuard::new();
        inner
            .apply(&buffer, |mode| mode | DISABLE_NEWLINE_AUTO_RETURN)
            .expect("inner");

        drop(inner);
        assert_eq!(buffer.mode().unwrap(), middle, "the inner guard overshot");
        drop(outer);
        assert_eq!(
            buffer.mode().unwrap(),
            before,
            "the console was left in the inner guard's mode",
        );
    }

    #[test]
    fn the_reporting_sequences_are_registered_rather_than_written_by_drop() {
        // `Terminal::drop` used to write `DISABLE_REPORTING` itself, which meant the
        // panic hook -- the one path that exists *because* no Drop will run --
        // restored the modes and left the pane on the alternate screen with the
        // cursor hidden and any-motion mouse reporting on. Registering it as the
        // output handle's farewell is what puts both paths through one place.
        //
        // `Terminal::new` needs a real console, so the wiring is pinned where it is
        // written; the behaviour of the farewell itself is covered above.
        let source = include_str!("terminal_windows.rs");
        let registered = concat!(
            "apply_with_farewell(&conout, ",
            "vt_output_mode, Some(DISABLE_REPORTING))",
        );
        assert!(
            source.contains(registered),
            "the disable sequences are no longer registered with the output mode",
        );
        assert!(
            !source.contains(concat!("conout.write_all(", "DISABLE_REPORTING)")),
            "something writes DISABLE_REPORTING outside the guard again",
        );
    }

    #[test]
    fn a_panicking_exit_path_leaves_the_console_as_it_was_found() {
        let _serial = one_at_a_time();
        let buffer = private_screen_buffer();
        let before = buffer.mode().expect("a real console mode");
        // Recorded from inside, so a run where the mode was never changed at all
        // cannot pass the final assertion by doing nothing.
        let changed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let panicked = std::panic::catch_unwind({
            let buffer = Arc::clone(&buffer);
            let changed = Arc::clone(&changed);
            move || {
                let mut guard = ModeGuard::new();
                guard.apply(&buffer, vt_output_mode).expect("apply");
                changed.store(buffer.mode().unwrap() != before, Ordering::Relaxed);
                panic!("the engine fell over with the console in raw mode");
            }
        });
        assert!(panicked.is_err());
        assert!(
            changed.load(Ordering::Relaxed),
            "the guard never changed the mode, so restoring it proves nothing",
        );
        assert_eq!(
            buffer.mode().unwrap(),
            before,
            "a panic left the console in raw mode",
        );
    }

    // -- colours ----------------------------------------------------------

    #[test]
    fn the_palette_is_read_out_of_the_replies_the_decoder_parses() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"\x1b]10;rgb:ffff/eeee/dddd\x1b\\");
        buf.extend_from_slice(b"\x1b]11;rgb:1e1e/2a2a/3434\x1b\\");
        buf.extend_from_slice(b"\x1b]4;3;rgb:9f9f/8686/ebeb\x1b\\");
        let colors = colors_from_replies(&buf);
        assert_eq!(colors.foreground, Some([255, 238, 221, 255]));
        assert_eq!(colors.background, Some([30, 42, 52, 255]));
        assert_eq!(colors.palette[3], Some([159, 134, 235, 255]));
        assert_eq!(
            colors.palette[4], None,
            "a slot nobody answered stays unset"
        );
    }

    #[test]
    fn a_terminal_that_never_answers_yields_an_empty_palette_rather_than_hanging() {
        let mut term = Terminal::detached(Inbox::new(), None);
        let mut buf = Vec::new();
        let started = Instant::now();
        term.drain_color_replies(&mut buf).expect("draining");
        assert!(
            started.elapsed() < COLOR_QUERY_DEADLINE * 3,
            "the drain outran its own deadline",
        );
        assert_eq!(colors_from_replies(&buf), TerminalColors::default());
    }

    #[test]
    fn an_asynchronous_palette_reply_arrives_as_an_event() {
        let inbox = Inbox::new();
        let mut term = Terminal::detached(Arc::clone(&inbox), None);
        term.color_query = Some(ColorQuery::new());

        inbox.push(b"\x1b]11;rgb:1e1e/2a2a/3434\x1b\\");
        // One slot of eighteen: not enough to settle, so nothing is emitted until
        // the query goes idle.
        let event = term.poll_event(Some(Duration::from_secs(5))).unwrap();
        let Some(Event::Colors(colors)) = event else {
            panic!("expected the palette to settle, got {event:?}");
        };
        assert_eq!(colors.background, Some([30, 42, 52, 255]));
        assert!(term.color_query.is_none(), "the query was not taken");
    }

    // -- the seam ---------------------------------------------------------

    #[test]
    fn the_capabilities_this_host_lacks_are_reported_rather_than_errored() {
        let mut term = Terminal::detached(Inbox::new(), None);
        assert!(!term.reports_color_scheme());
        assert!(!term.kitty_keyboard());
        assert!(!term.reports_pixel_mouse());
        assert!(!term.frames_are_inline());
        assert!(!term.clipboard_data_supported());
        assert!(!term.relayed());
        assert!(
            term.set_key_event_types(true).is_ok(),
            "asking for key-release events on a host with no kitty protocol is a \
             no-op, not a failure",
        );
        term.forget_cell_size();
    }

    // -- cell metrics -----------------------------------------------------

    #[test]
    fn cell_size_always_answers_because_a_none_would_be_guessed_at_elsewhere() {
        let mut term = Terminal::detached(Inbox::new(), None);
        // No host and no override, which is the worst case. `engine/mod.rs:347`
        // would turn a `None` into `(16, 32)` and size the canvas with it; the
        // point is that the backend now names the same number instead of keeping
        // one of its own.
        assert_eq!(
            term.cell_size().unwrap(),
            Some(agwinterm::FALLBACK_CELL),
            "cell_size must never answer None on Windows",
        );
    }

    #[test]
    fn the_pointer_is_mapped_with_the_number_the_canvas_is_sized_from() {
        let mut term = Terminal::detached(Inbox::new(), None);
        let (width, height) = term
            .cell_size()
            .unwrap()
            .expect("cell_size always answers here");

        // A click on cell (1, 1) — the SGR report is one-based — lands in the
        // first cell of a canvas drawn `cols * width` pixels across, and a click
        // on (3, 2) lands in the third column of the second row. If the two used
        // different cell sizes this would drift by a cell per cell.
        assert_eq!(term.mouse_position_px(1, 1), (width / 2, height / 2));
        assert_eq!(
            term.mouse_position_px(3, 2),
            (2 * width + width / 2, height + height / 2),
        );
    }

    // -- the pointer, and the resolution it does not have ------------------

    #[test]
    fn the_edge_cells_of_a_pane_map_inside_the_canvas_that_pane_is_drawn_on() {
        let mut term = Terminal::detached(Inbox::new(), None);
        term.cell = Some((9, 19));
        let (cw, ch) = (9u32, 19u32);
        let (cols, rows) = (80u32, 24u32);

        // The engine draws `cols * cw` by `rows * ch` — `window_from` with a
        // `WindowSize` that carries no pixel extent, which is every size this
        // backend reports. So the *last* cell's centre has to be strictly inside
        // that canvas, or a click on the right edge lands off the page.
        let last = term.mouse_position_px(cols, rows);
        assert_eq!(last, ((cols - 1) * cw + cw / 2, (rows - 1) * ch + ch / 2));
        assert!(
            last.0 < cols * cw && last.1 < rows * ch,
            "the last cell's centre fell outside the canvas: {last:?}",
        );

        // And the first cell's must not wrap: the report is one-based, so the
        // subtraction is the one place a `u32` could go round the houses.
        assert_eq!(term.mouse_position_px(1, 1), (cw / 2, ch / 2));
        assert_eq!(
            term.mouse_position_px(0, 0),
            (cw / 2, ch / 2),
            "a zero coordinate is not a report `parse_sgr_mouse` accepts, but it \
             must not underflow if one ever arrives",
        );
    }

    #[test]
    fn the_pointer_quantises_to_a_cell_and_reports_pixel_mouse_is_what_says_so() {
        let mut term = Terminal::detached(Inbox::new(), None);
        term.cell = Some((10, 20));

        // Every position this backend can produce is a cell centre. agwinterm
        // discards the sub-cell offset where it encodes the report and implements
        // no `?1016` to ask for it back, so two clicks anywhere inside one cell
        // are the same event. That is the port's accepted ceiling, and
        // `reports_pixel_mouse` is the flag that declares it.
        assert!(!term.reports_pixel_mouse());
        for col in 1..=40u32 {
            let (x, y) = term.mouse_position_px(col, 1);
            assert_eq!(x % 10, 5, "column {col} did not land on a cell centre");
            assert_eq!(y, 10);
        }
    }

    #[test]
    fn a_drag_carries_its_position_across_press_move_and_release() {
        let inbox = Inbox::new();
        let mut term = Terminal::detached(Arc::clone(&inbox), None);
        term.cell = Some((10, 20));

        // Press at cell (3, 2), drag right two cells, release. `?1002` reports
        // motion with the button bit set (32 + 0), which is what makes the middle
        // report a `Move` rather than a hover.
        inbox.push(b"\x1b[<0;3;2M\x1b[<32;5;2M\x1b[<0;5;2m");
        let mut seen = Vec::new();
        while let Some(event) = term.poll_event(Some(Duration::from_secs(5))).unwrap() {
            let Event::Mouse(mouse) = event else {
                panic!("expected mouse events, got {event:?}");
            };
            seen.push((mouse.kind, mouse.x, mouse.y));
            if seen.len() == 3 {
                break;
            }
        }
        assert_eq!(
            seen,
            vec![
                (MouseKind::Down, 25, 30),
                (MouseKind::Move, 45, 30),
                (MouseKind::Up, 45, 30),
            ],
            "a drag must keep the same cell-to-pixel mapping at every phase",
        );
    }

    #[test]
    fn a_resolved_cell_size_is_cached_until_it_is_forgotten() {
        let mut term = Terminal::detached(Inbox::new(), None);
        assert_eq!(term.cell_size().unwrap(), Some(agwinterm::FALLBACK_CELL));

        // The cache is what `mouse_position_px` reads, so proving it holds is
        // proving the pointer does not re-resolve mid-drag.
        term.cell = Some((9, 19));
        assert_eq!(term.cell_size().unwrap(), Some((9, 19)));
        assert_eq!(term.mouse_position_px(1, 1), (4, 9));

        // A font change invalidates it, and the next call resolves again.
        term.forget_cell_size();
        assert_eq!(term.cell_size().unwrap(), Some(agwinterm::FALLBACK_CELL));
    }

    #[test]
    fn an_environment_that_is_not_a_pane_is_explained_once_and_not_retried() {
        let mut term = Terminal::detached(Inbox::new(), None);
        assert!(term.host().is_none(), "an empty environment is no host");
        assert!(
            term.host_absent,
            "the absence must latch, or every frame re-derives and re-logs it",
        );
    }

    #[test]
    fn a_pane_environment_resolves_a_target_without_dialling_anything() {
        let mut term = Terminal::detached(Inbox::new(), None);
        term.env = SessionEnv::of_session(
            [
                (agwinterm::ENABLED_VAR.to_owned(), "1".to_owned()),
                // A pipe name nothing is serving: construction must not need it.
                (
                    agwinterm::PIPE_VAR.to_owned(),
                    format!("terminal-windows-absent-{}", std::process::id()),
                ),
                (agwinterm::SESSION_VAR.to_owned(), "w1:p2".to_owned()),
            ]
            .into_iter()
            .collect(),
        );

        assert_eq!(
            term.host().expect("a pane is a host").target().session(),
            "w1:p2",
        );
        // And with the host unreachable, the metrics question still gets an answer.
        assert_eq!(term.cell_size().unwrap(), Some(agwinterm::FALLBACK_CELL));
    }

    #[test]
    fn an_explicit_override_reaches_the_backend_through_the_session_environment() {
        let mut term = Terminal::detached(Inbox::new(), None);
        term.env = SessionEnv::of_session(
            [(agwinterm::CELL_PX_VAR.to_owned(), "9x19".to_owned())]
                .into_iter()
                .collect(),
        );

        assert_eq!(term.cell_size().unwrap(), Some((9, 19)));
        assert_eq!(
            term.mouse_position_px(1, 1),
            (4, 9),
            "the pointer follows the override, not the fallback",
        );
    }

    // -- drawing ----------------------------------------------------------

    #[test]
    fn a_frame_with_no_pane_to_put_it_in_is_reported_rather_than_swallowed() {
        // The publisher and the pipe are exercised in `frame_file`, against a real
        // named-pipe server. What is checked here is the seam: that `draw` no
        // longer reports `Unsupported`, and that a browser running outside
        // agwinterm gets an error instead of a frame that goes nowhere.
        let mut term = Terminal::detached(Inbox::new(), None);
        let err = term
            .draw(&Canvas::new(16, 16))
            .expect_err("there is no pane in an empty environment");
        assert_eq!(err.kind(), io::ErrorKind::NotConnected);
        assert!(
            err.to_string().contains("agwinterm"),
            "the message does not name what is missing: {err}",
        );
    }

    #[test]
    fn a_pane_with_no_room_in_it_skips_the_frame_instead_of_failing() {
        // The third of Task 10's startup failure modes, at the seam rather than at
        // `cell_span`: a pane dragged to nothing is a state, not an error. The
        // engine sizes the canvas as `cols * cell`, so "no room" arrives here as a
        // canvas with no area.
        //
        // The stronger half of the assertion is `frames`: it stays `None`, which is
        // only possible if `draw` returned before it reached the publisher. A skip
        // that still created a frame directory — or worse, still burned a sequence
        // number — would be a skip with a cost.
        //
        // ➕ It does not stay *entirely* free: `draw` resolves the cell size first,
        // and that legitimately asks the host, so `host_absent` latches on the
        // first skip. That is a one-time resolution, not a per-frame dial, which is
        // why `cell_size` caches.
        let mut term = Terminal::detached(Inbox::new(), None);
        for canvas in [Canvas::new(0, 16), Canvas::new(16, 0), Canvas::new(0, 0)] {
            assert_eq!(
                term.draw(&canvas)
                    .expect("a pane with no room is not a failure"),
                0,
                "a skipped frame reports no bytes",
            );
        }
        assert!(
            term.frames.is_none(),
            "a skipped frame reached the publisher, so it cost a directory",
        );
    }

    #[test]
    fn a_frame_with_no_area_is_skipped_rather_than_failed() {
        // A pane dragged down to nothing is a legitimate state, and so is the
        // canvas that goes with it. Skipping costs zero bytes and no error; the
        // proof that it never reached the pipe is that there is no pipe here and
        // the previous test shows that would have failed.
        let mut term = Terminal::detached(Inbox::new(), None);
        assert_eq!(
            term.draw(&Canvas::new(0, 0))
                .expect("nothing to draw is not a failure"),
            0,
        );
    }

    #[test]
    fn what_later_tasks_own_still_names_the_task_that_will_implement_it() {
        let mut term = Terminal::detached(Inbox::new(), None);
        let fails = |result: io::Result<()>, what: &str| {
            let err = result.expect_err(what);
            assert_eq!(err.kind(), io::ErrorKind::Unsupported, "{what}");
            assert!(
                err.to_string().contains("Task"),
                "{what}: the message must name the task that will implement it, got {err}",
            );
        };
        fails(term.set_pointer_shape("pointer"), "set_pointer_shape");
        // The typed-clipboard pair stays unimplemented, and stays *unreachable*:
        // `engine/clipboard.rs` asks `clipboard_data_supported()` first, and both
        // of its call sites then take the answer through `is_ok()`. The plain text
        // pair below is the one that had to be real.
        assert!(!term.clipboard_data_supported());
        fails(term.request_clipboard_types(), "request_clipboard_types");
        fails(
            term.request_clipboard_data("text/html"),
            "request_clipboard_data",
        );
    }

    #[test]
    fn copying_reaches_the_os_clipboard_rather_than_ending_the_engine() {
        // The regression this replaces: `set_clipboard` answered `Unsupported`, and
        // `engine/clipboard.rs` and `engine/doc.rs` both take it through `?`, so the
        // error unwound out of `Engine::pump` and `pixel-node` treated that as a
        // fatal engine exit. Ctrl+C in the address bar closed the browser.
        //
        // What is asserted is the round trip, because "did not error" would also be
        // true of a `set_clipboard` that quietly did nothing — and it now *is* true
        // of one whose `OpenClipboard` lost a race, which is the whole point: the
        // write can fail, and the engine must not learn about it through an `Err`.
        let mut term = Terminal::detached(Inbox::new(), None);
        let text = "winterm-browser clipboard round trip";
        // The `expect` is the load-bearing assertion, and it bites hardest on the
        // machines where the write genuinely fails: `engine/doc.rs`'s
        // `InputAction::Copy` and `engine/clipboard.rs`'s `begin_rich_capture` take
        // this through `?`, and `pixel-node` ends the process on any error out of
        // `Engine::pump`. Nothing in between inspects the error *kind*, so "not
        // `Unsupported`" was never a protection — the only safe answer is that there
        // is no error to propagate at all.
        term.set_clipboard(text)
            .expect("a copy must never be able to end the engine");
        // A machine with no window station (a service, some CI images) has no
        // clipboard to reach, and the read is where that shows. Nothing was written
        // there, so there is no round trip to assert.
        if term.request_clipboard().is_err() {
            return;
        }
        assert_eq!(
            term.poll_event(Some(Duration::from_millis(0)))
                .expect("the parked reply needs no console"),
            Some(Event::Paste(text.to_owned())),
            "the clipboard read must arrive as the Paste event an OSC 52 reply would decode into",
        );
    }

    // -- attaching ---------------------------------------------------------

    #[test]
    fn the_named_console_is_tried_before_the_parent_process() {
        // The ordering is the point of the variable. Task 9's launcher may put a
        // wrapper between the pane and the engine, in which case the *parent* is
        // the wrapper and attaching to it takes the wrong console -- which presents
        // as a browser that starts, draws, and never receives a keystroke.
        let env = |value: &str| {
            let mut map = std::collections::HashMap::new();
            map.insert(CONSOLE_PID_VAR.to_string(), value.to_string());
            SessionEnv::of_session(map)
        };
        assert_eq!(
            attach_targets(&env("4242")),
            vec![4242, ATTACH_PARENT_PROCESS],
        );
    }

    #[test]
    fn a_console_pid_survives_the_whitespace_a_launcher_leaves_on_it() {
        // A `.cmd` wrapper setting the variable leaves the line ending attached. A
        // pid that silently failed to parse would fall through to the parent and
        // take the wrong console, with nothing said.
        let env = |value: &str| {
            let mut map = std::collections::HashMap::new();
            map.insert(CONSOLE_PID_VAR.to_string(), value.to_string());
            SessionEnv::of_session(map)
        };
        for spelling in ["4242", " 4242", "4242 ", "4242\r", "4242\r\n", "\t4242\n"] {
            assert_eq!(
                attach_targets(&env(spelling)),
                vec![4242, ATTACH_PARENT_PROCESS],
                "{spelling:?} did not resolve to a pid",
            );
        }
    }

    #[test]
    fn an_unusable_console_pid_falls_back_rather_than_failing() {
        // Degrading to the pre-Task-9 behaviour is right: the parent *is* the pane
        // in the ordinary case, so a stale or malformed value should cost a
        // fallback and not a refusal to start.
        let env = |value: &str| {
            let mut map = std::collections::HashMap::new();
            map.insert(CONSOLE_PID_VAR.to_string(), value.to_string());
            SessionEnv::of_session(map)
        };
        for junk in [
            "",
            "   ",
            "not-a-pid",
            "-1",
            "4242abc",
            // Beyond u32, which is what a pid is.
            "99999999999999999999",
            // The System Idle Process owns no console; trying it costs a failed
            // call and a warning naming a pid nobody set.
            "0",
        ] {
            assert_eq!(
                attach_targets(&env(junk)),
                vec![ATTACH_PARENT_PROCESS],
                "{junk:?} was treated as a console to attach to",
            );
        }
    }

    #[test]
    fn with_no_variable_at_all_the_parent_is_the_only_candidate() {
        assert_eq!(
            attach_targets(&SessionEnv::of_session(Default::default())),
            vec![ATTACH_PARENT_PROCESS],
        );
    }

    #[test]
    fn a_dropped_terminal_stops_its_reader_thread() {
        // The reader thread outlives the `Terminal` -- it is parked in a blocking
        // `ReadFile` and only a byte returns it. What `abandon` guarantees is that
        // the byte it eventually gets is the last thing it does: `push` answers
        // `false`, which is the thread's signal to return rather than to go on
        // holding the console handle open.
        let inbox = Inbox::new();
        let term = Terminal::detached(Arc::clone(&inbox), None);
        assert!(inbox.push(b"before"), "a live terminal accepts bytes");
        drop(term);
        assert!(
            !inbox.push(b"after"),
            "the reader was not told to stop, so it keeps the console open",
        );
    }

    #[test]
    fn a_lone_escape_is_reported_rather_than_left_to_poison_the_next_key() {
        // Under `ENABLE_VIRTUAL_TERMINAL_INPUT` conhost sends Escape as a bare
        // `0x1b` and nothing more. `parse_event_kitty` cannot decide a one-byte
        // buffer, so without the deadline the byte sat in `pending` for ever: every
        // Escape was lost (closing the url bar, the palette, the find bar), and the
        // *next* key arrived as Alt+that-key because the stale `0x1b` prefixed it.
        let inbox = Inbox::new();
        let mut term = Terminal::detached(Arc::clone(&inbox), None);
        inbox.push(b"\x1b");
        assert_eq!(
            term.poll_event(Some(LONE_ESCAPE_WAIT * 4))
                .expect("waiting out a lone escape is not an error"),
            Some(Event::Key(KeyEvent::plain(Key::Escape))),
        );
        // And the tail is clean, so the following key is itself.
        inbox.push(b"a");
        assert_eq!(
            term.poll_event(Some(Duration::from_millis(50)))
                .expect("the next key"),
            Some(Event::Key(KeyEvent::plain(Key::Char('a')))),
        );
    }

    #[test]
    fn an_escape_that_starts_a_sequence_is_not_flushed_as_escape() {
        // The other half: `ESC [ A` arrives in pieces through the reader thread, and
        // giving up on the head after 50 ms would turn every arrow key into Escape
        // followed by a stray `[A`. The deadline only ever applies to a tail that is
        // exactly one byte long.
        let inbox = Inbox::new();
        let mut term = Terminal::detached(Arc::clone(&inbox), None);
        inbox.push(b"\x1b[");
        assert_eq!(
            term.poll_event(Some(LONE_ESCAPE_WAIT * 2))
                .expect("an incomplete sequence is not an error"),
            None,
            "an incomplete CSI must wait for its tail, not be flushed as Escape",
        );
        inbox.push(b"A");
        assert_eq!(
            term.poll_event(Some(Duration::from_millis(50)))
                .expect("the completed sequence"),
            Some(Event::Key(KeyEvent::plain(Key::Up))),
        );
    }

    #[test]
    fn the_trait_delegates_to_the_inherent_methods_rather_than_itself() {
        // Inherent methods win method resolution; if they did not, these calls
        // would recurse until the stack ran out. Reaching the assertions is the
        // proof.
        let mut term = Terminal::detached(Inbox::new(), None);
        assert_eq!(
            TerminalBackend::size(&term).unwrap_err().kind(),
            io::ErrorKind::NotConnected,
        );
        assert_eq!(
            TerminalBackend::poll_event(&mut term, Some(Duration::from_millis(10))).unwrap(),
            None,
        );
        assert!(!TerminalBackend::kitty_keyboard(&term));
        TerminalBackend::forget_cell_size(&mut term);
    }

    #[test]
    fn the_reporting_modes_written_on_the_way_in_are_undone_on_the_way_out() {
        // Not a string comparison for its own sake: every mode turned on has to be
        // turned off, or the pane is left with mouse reporting and the alternate
        // screen after the browser exits.
        let modes = |bytes: &[u8], suffix: u8| {
            let mut found: Vec<String> = Vec::new();
            let text = String::from_utf8(bytes.to_vec()).expect("ascii");
            for part in text.split("\x1b[?").skip(1) {
                if part.as_bytes().last() == Some(&suffix) {
                    found.push(part[..part.len() - 1].to_owned());
                }
            }
            found.sort();
            found
        };
        assert_eq!(
            modes(ENABLE_REPORTING, b'h'),
            modes(DISABLE_REPORTING, b'l'),
            "a reporting mode is turned on and never turned off",
        );
        assert!(
            !ENABLE_REPORTING
                .windows(3)
                .any(|w| w == b"\x1b[>".as_slice()),
            "ENABLE_REPORTING asks for the kitty keyboard protocol, which \
             `kitty_keyboard()` reports as absent — the decoder would then be \
             reading bytes on the wrong assumption",
        );
        assert!(
            !ENABLE_REPORTING
                .windows(7)
                .any(|w| w == b"\x1b[?1016".as_slice()),
            "ENABLE_REPORTING asks for pixel mouse reports, which this host does \
             not implement and `reports_pixel_mouse()` denies",
        );
    }

    #[test]
    fn the_console_pid_variable_is_read_through_the_session_environment() {
        // Task 9's launcher sets it, and in the daemon shape it arrives in the
        // session environment rather than the process one — which is the whole
        // reason `SessionEnv` exists.
        let env = SessionEnv::of_session(
            [(CONSOLE_PID_VAR.to_owned(), "4321".to_owned())]
                .into_iter()
                .collect(),
        );
        assert_eq!(env.var(CONSOLE_PID_VAR).as_deref(), Some("4321"));
        assert_eq!(
            SessionEnv::of_session(Default::default()).var(CONSOLE_PID_VAR),
            None,
            "absent, the backend falls back to ATTACH_PARENT_PROCESS",
        );
    }
}
