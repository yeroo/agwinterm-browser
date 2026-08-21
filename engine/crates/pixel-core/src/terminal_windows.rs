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

use crate::agwinterm::{self, ControlClient};
use crate::canvas::Canvas;
use crate::frame_file;
use crate::terminal::{
    ColorSlot, Event, RawEvent, SessionEnv, TerminalColors, Waker, WindowSize, parse_event_kitty,
    parse_osc_color,
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
    let named = env
        .var(CONSOLE_PID_VAR)
        .and_then(|value| value.trim().parse::<u32>().ok());
    for target in named.into_iter().chain([ATTACH_PARENT_PROCESS]) {
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

/// One handle's mode, and what it was before.
struct Restore {
    token: u64,
    handle: HANDLE,
    mode: u32,
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

/// Puts every registered console mode back. Called from the panic hook, and safe to
/// call at any time: `SetConsoleMode` with the mode a handle already has is a no-op,
/// so it does not matter that `ModeGuard::drop` may also run.
#[allow(unsafe_code)]
pub(crate) fn restore_registered_modes() {
    for entry in registry().iter() {
        // SAFETY: the handle was live when registered and is only closed after the
        // guard that owns it has deregistered; the mode is a plain bitfield.
        unsafe { SetConsoleMode(entry.handle, entry.mode) };
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
        let previous = handle.mode()?;
        handle.set_mode(next(previous))?;
        let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
        registry().push(Restore {
            token,
            handle: handle.raw(),
            mode: previous,
        });
        self.entries.push((Arc::clone(handle), token));
        Ok(())
    }
}

impl Drop for ModeGuard {
    fn drop(&mut self) {
        let mut registry = registry();
        for (handle, token) in self.entries.drain(..) {
            if let Some(at) = registry.iter().position(|entry| entry.token == token) {
                let entry = registry.remove(at);
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
        modes.apply(&conout, vt_output_mode)?;
        conout.write_all(ENABLE_REPORTING)?;

        let inbox = Inbox::new();
        spawn_reader(Arc::clone(&conin), Arc::clone(&inbox));

        Ok(Self {
            wrapper,
            env,
            inbox,
            pending: Vec::new(),
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
            None => frame_file::FramePublisher::new()?,
        };
        let published = match self.host() {
            Some(client) => frames.publish(client, canvas, span),
            None => Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "there is no agwinterm pane to draw into; see the earlier log line                  for which variable is missing",
            )),
        };
        self.frames = Some(frames);
        published
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
            let color_deadline = self.color_query.as_ref().map(ColorQuery::deadline);
            let resize_deadline = self.watching_resize.then(|| Instant::now() + RESIZE_POLL);
            let until = [deadline, color_deadline, resize_deadline]
                .into_iter()
                .flatten()
                .min();
            let wait = until.map(|until| until.saturating_duration_since(Instant::now()));
            match self.inbox.take(&mut self.pending, wait)? {
                Taken::Bytes => continue,
                Taken::Woken => return Ok(None),
                Taken::Eof => return Err(io::ErrorKind::UnexpectedEof.into()),
                Taken::Timeout => {
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
        (
            x.saturating_sub(1) * width + width / 2,
            y.saturating_sub(1) * height + height / 2,
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

    pub fn set_clipboard(&mut self, _text: &str) -> io::Result<()> {
        unimplemented("writing the clipboard", "Task 11")
    }

    pub fn request_clipboard(&mut self) -> io::Result<()> {
        unimplemented("reading the clipboard", "Task 11")
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
        if let Some(conout) = self.conout.as_ref() {
            let _ = conout.write_all(DISABLE_REPORTING);
        }
        // Before the modes go back, so the sequences above still get through the VT
        // output mode this backend turned on.
        drop(self.modes.take());
        self.inbox.abandon();
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
        fails(term.set_clipboard("text"), "set_clipboard");
        fails(term.request_clipboard(), "request_clipboard");
        fails(term.request_clipboard_types(), "request_clipboard_types");
        fails(
            term.request_clipboard_data("text/html"),
            "request_clipboard_data",
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
