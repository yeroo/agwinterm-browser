//! Measures whether a **GUI-subsystem** grandchild inherits the pseudoconsole that
//! its parent is attached to — the single Win32 fact the Windows process model
//! rests on.
//!
//! Upstream reaches the user's terminal by opening a path (`/dev/tty`) from a
//! detached daemon. Windows has no such path, so the port has two shapes to choose
//! between (port plan Task 2): run the engine in a process that *is* attached to
//! the pane's console, or keep the daemon and proxy the terminal across IPC. The
//! first shape is only available if `electron.exe` — a `/SUBSYSTEM:WINDOWS` image —
//! actually gets the console when the CLI spawns it, and the folklore that GUI
//! programs "have no console" makes that worth measuring rather than assuming.
//!
//! The harness reproduces the deployment topology exactly:
//!
//! ```text
//! host (this crate) ── CreatePseudoConsole ──► middle (console subsystem, = the CLI in the pane)
//!                                                  └── CreateProcessW ──► gui-child (= electron.exe)
//! ```
//!
//! and varies two things: the grandchild's PE subsystem, and its creation flags —
//! `0` (what a normal spawn does) versus `DETACHED_PROCESS` (what
//! `spawn(..., { detached: true })` maps to, and therefore what the daemon is
//! created with today). A console-subsystem arm runs the identical child body as
//! the control, so a negative GUI result cannot be blamed on the harness. The
//! middle process records its own console size so the host can prove the topology
//! held; the grandchild records whether it could reach a console at all, whether
//! `AttachConsole` would give it one, and what it read from the pane.

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Console::{ClosePseudoConsole, CreatePseudoConsole, COORD, HPCON};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, DETACHED_PROCESS, EXTENDED_STARTUPINFO_PRESENT,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, STARTUPINFOEXW, STARTUPINFOW,
};

pub mod child;
pub mod console;

pub use conpty_probe::{escape, parse_hex, to_hex, SENTINEL};

/// `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, spelled out for the same reason the
/// sibling probe spells it out: it moves between `windows-sys` modules.
const ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;

/// The harness pseudoconsole's size. Deliberately *not* the sibling probe's
/// 200x40: a child reporting these dimensions is provably in this harness's pty
/// and not in some other console the test runner happens to have.
pub const PTY_COLS: i16 = 132;
pub const PTY_ROWS: i16 = 37;

/// `ERROR_ACCESS_DENIED`, which is what `AttachConsole` returns to a process that
/// already has one. It is the enforcement point of "one console per process", and
/// therefore of "one pane per engine process".
pub const ERROR_ACCESS_DENIED: u32 = 5;

/// What the middle process spawns, and how.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scenario {
    /// The control: a *console-subsystem* grandchild with ordinary creation flags.
    /// This is what "a child inherits its parent's console" is supposed to mean,
    /// and it is here so a negative result in the GUI arm can be attributed to the
    /// subsystem rather than to a mistake in this harness.
    ConsoleInherit,
    /// A GUI-subsystem grandchild with `dwCreationFlags = 0` — what a foreground
    /// launcher spawning `electron.exe` does.
    GuiInherit,
    /// A GUI-subsystem grandchild with `DETACHED_PROCESS` — what
    /// `child_process.spawn(..., { detached: true })` maps to on Windows, and so
    /// what the daemon is created with today.
    GuiDetached,
    /// A GUI-subsystem grandchild that attaches to an explicitly named process id
    /// rather than to `ATTACH_PARENT_PROCESS`. This is the shape the launcher
    /// should use: it does not require the console owner to be the *direct*
    /// parent, so a wrapper process between the CLI and Electron cannot break it.
    GuiAttachByPid,
}

impl Scenario {
    pub fn tag(self) -> &'static str {
        match self {
            Scenario::ConsoleInherit => "console-inherit",
            Scenario::GuiInherit => "gui-inherit",
            Scenario::GuiDetached => "gui-detached",
            Scenario::GuiAttachByPid => "gui-attach-by-pid",
        }
    }

    pub fn parse(tag: &str) -> Option<Self> {
        Self::all()
            .into_iter()
            .find(|scenario| scenario.tag() == tag)
    }

    pub fn creation_flags(self) -> u32 {
        match self {
            Scenario::ConsoleInherit | Scenario::GuiInherit | Scenario::GuiAttachByPid => 0,
            Scenario::GuiDetached => DETACHED_PROCESS,
        }
    }

    /// Whether the grandchild is the `/SUBSYSTEM:WINDOWS` image.
    pub fn child_is_gui(self) -> bool {
        !matches!(self, Scenario::ConsoleInherit)
    }

    /// Whether the grandchild attaches to a process id the middle names, rather
    /// than to whatever `ATTACH_PARENT_PROCESS` resolves to.
    pub fn attaches_by_pid(self) -> bool {
        matches!(self, Scenario::GuiAttachByPid)
    }

    pub fn all() -> [Scenario; 4] {
        [
            Scenario::ConsoleInherit,
            Scenario::GuiInherit,
            Scenario::GuiDetached,
            Scenario::GuiAttachByPid,
        ]
    }
}

/// One measurement of the three-process topology.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Observation {
    /// Whether the grandchild could open `CONIN$`/`CONOUT$` at all.
    pub attached: bool,
    /// The console the grandchild found, as `(cols, rows)`.
    pub console: (i16, i16),
    /// `GetLastError` from the grandchild's `CONIN$` open; `0` when it succeeded.
    pub conin_err: u32,
    /// `GetLastError` from `AttachConsole(ATTACH_PARENT_PROCESS)`; `0` on success.
    pub reattach_err: u32,
    /// The console size seen after that attach attempt.
    pub reattached_console: (i16, i16),
    /// The console the *middle* process was in — proof the topology held.
    pub middle_console: (i16, i16),
    /// What the grandchild read from the console, if it had one.
    pub received: Vec<u8>,
}

impl Observation {
    /// True when the middle process really was inside the harness pseudoconsole.
    /// Every other field is meaningless without this.
    pub fn topology_held(&self) -> bool {
        self.middle_console == (PTY_COLS, PTY_ROWS)
    }

    /// True when the grandchild ended up owning the *pane's* console — the whole
    /// question for the foreground process model.
    pub fn owns_pane_console(&self) -> bool {
        self.attached && self.console == (PTY_COLS, PTY_ROWS)
    }

    pub fn verdict(&self) -> &'static str {
        if !self.attached {
            "no console"
        } else if !self.owns_pane_console() {
            "SOME OTHER CONSOLE"
        } else {
            "pane console"
        }
    }
}

/// Reads one whitespace-separated `name=<integer>` field, or `0` when absent.
///
/// Tokens are matched from their start, so `cols=` does not also match `recols=`.
pub fn field(text: &str, name: &str) -> i64 {
    let key = format!("{name}=");
    text.split_whitespace()
        .find_map(|token| token.strip_prefix(key.as_str()))
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

/// Parses the record the grandchild writes once it knows what console it has.
pub fn parse_child_record(text: &str) -> Observation {
    Observation {
        attached: field(text, "attached") == 1,
        console: (field(text, "cols") as i16, field(text, "rows") as i16),
        conin_err: field(text, "conin_err") as u32,
        reattach_err: field(text, "reattach_err") as u32,
        reattached_console: (field(text, "recols") as i16, field(text, "rerows") as i16),
        ..Observation::default()
    }
}

/// Parses the record the middle process writes before it spawns the grandchild.
pub fn parse_middle_record(text: &str) -> (i16, i16) {
    (field(text, "cols") as i16, field(text, "rows") as i16)
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

/// Owns a Win32 handle so every early return still closes it.
struct Handle(HANDLE);

impl Handle {
    fn get(&self) -> HANDLE {
        self.0
    }

    /// Hands the handle to someone else; `Drop` no longer closes it.
    fn leak(mut self) -> HANDLE {
        std::mem::replace(&mut self.0, INVALID_HANDLE_VALUE)
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            // SAFETY: `self.0` is a handle this type owns and has not been leaked.
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn create_pipe() -> io::Result<(Handle, Handle)> {
    let mut read: HANDLE = ptr::null_mut();
    let mut write: HANDLE = ptr::null_mut();
    let attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 0,
    };
    // SAFETY: both out-params are valid writable pointers, and `attrs` outlives the call.
    let ok = unsafe { CreatePipe(&mut read, &mut write, &attrs, 0) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((Handle(read), Handle(write)))
}

fn write_all(handle: HANDLE, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let mut written: u32 = 0;
        // SAFETY: `bytes` is a live slice and `written` is a valid out-param.
        let ok = unsafe {
            WriteFile(
                handle,
                bytes.as_ptr(),
                bytes.len() as u32,
                &mut written,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        if written == 0 {
            return Err(io::Error::other("pty input pipe accepted no bytes"));
        }
        bytes = &bytes[written as usize..];
    }
    Ok(())
}

/// Drains the pseudoconsole's output pipe so conhost never blocks on a full pipe.
fn drain(handle: HANDLE) {
    let mut buf = [0u8; 4096];
    loop {
        let mut read: u32 = 0;
        // SAFETY: `buf` and `read` are live for the duration of the call.
        let ok = unsafe {
            ReadFile(
                handle,
                buf.as_mut_ptr(),
                buf.len() as u32,
                &mut read,
                ptr::null_mut(),
            )
        };
        if ok == 0 || read == 0 {
            return;
        }
    }
}

fn wait_for_file(path: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

/// Where the two child processes write their records. Unique per process and per
/// tag so concurrent test threads cannot collide.
fn record_paths(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
    let dir = std::env::temp_dir();
    let pid = std::process::id();
    (
        dir.join(format!("console-inherit-{pid}-{tag}.ready")),
        dir.join(format!("console-inherit-{pid}-{tag}.hex")),
        dir.join(format!("console-inherit-{pid}-{tag}.middle")),
    )
}

/// Runs one measurement: a pseudoconsole, a console-subsystem middle process
/// inside it, and a GUI-subsystem grandchild spawned by that middle process with
/// `spawn`'s creation flags. `sequence` goes into the pty afterwards, to see
/// whether the grandchild can actually read the pane's input.
pub fn measure(
    host_exe: &Path,
    gui_exe: &Path,
    scenario: Scenario,
    tag: &str,
    sequence: &[u8],
) -> io::Result<Observation> {
    let (ready_path, report_path, middle_path) = record_paths(tag);
    for path in [&ready_path, &report_path, &middle_path] {
        let _ = std::fs::remove_file(path);
    }

    let (input_read, input_write) = create_pipe()?;
    let (output_read, output_write) = create_pipe()?;

    let mut hpc: HPCON = 0;
    let size = COORD {
        X: PTY_COLS,
        Y: PTY_ROWS,
    };
    // SAFETY: both pipe ends are live handles and `hpc` is a valid out-param.
    let hr =
        unsafe { CreatePseudoConsole(size, input_read.get(), output_write.get(), 0, &mut hpc) };
    if hr != 0 {
        return Err(io::Error::other(format!(
            "CreatePseudoConsole failed: 0x{hr:08x}"
        )));
    }

    // ConPTY duplicated the ends it needs; our copies must go before the child is
    // created, or EOF never propagates and the drain never finishes.
    drop(input_read);
    drop(output_write);

    let command = format!(
        "\"{}\" --middle {} \"{}\" \"{}\" \"{}\" \"{}\"",
        host_exe.display(),
        scenario.tag(),
        gui_exe.display(),
        ready_path.display(),
        report_path.display(),
        middle_path.display(),
    );

    let result = spawn_and_observe(
        &command,
        &ready_path,
        &report_path,
        &middle_path,
        hpc,
        input_write,
        output_read,
        sequence,
    );

    // SAFETY: `hpc` came from `CreatePseudoConsole` above and is closed once.
    unsafe { ClosePseudoConsole(hpc) };

    let observation = result?;
    for path in [&ready_path, &report_path, &middle_path] {
        let _ = std::fs::remove_file(path);
    }
    Ok(observation)
}

#[allow(clippy::too_many_arguments)]
fn spawn_and_observe(
    command: &str,
    ready_path: &Path,
    report_path: &Path,
    middle_path: &Path,
    hpc: HPCON,
    input_write: Handle,
    output_read: Handle,
    sequence: &[u8],
) -> io::Result<Observation> {
    let mut attr_size: usize = 0;
    // SAFETY: the first call is the documented size query; it is expected to fail.
    unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut attr_size) };
    // Backed by `usize`, not `u8`: an attribute list holds pointers.
    let mut attr_buf = vec![0usize; attr_size.div_ceil(std::mem::size_of::<usize>()).max(1)];
    let attr_list = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    // SAFETY: `attr_buf` is sized by the query above and outlives the attribute list.
    let ok = unsafe { InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `hpc` is live for the whole call and the attribute list was initialised.
    let ok = unsafe {
        UpdateProcThreadAttribute(
            attr_list,
            0,
            ATTRIBUTE_PSEUDOCONSOLE,
            hpc as *const std::ffi::c_void,
            std::mem::size_of::<HPCON>(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        let err = io::Error::last_os_error();
        // SAFETY: initialised above, deleted exactly once on this path.
        unsafe { DeleteProcThreadAttributeList(attr_list) };
        return Err(err);
    }

    // SAFETY: `STARTUPINFOEXW` is a plain C struct; all-zero is its documented
    // "nothing requested" state.
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attr_list;

    let mut command_wide = wide(OsStr::new(command));
    // SAFETY: plain C struct, zeroed before use as an out-param.
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the command line is a live NUL-terminated buffer, the attribute list
    // is initialised, and `info` is a valid out-param.
    let ok = unsafe {
        CreateProcessW(
            ptr::null(),
            command_wide.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT,
            ptr::null(),
            ptr::null(),
            &startup as *const STARTUPINFOEXW as *const STARTUPINFOW,
            &mut info,
        )
    };
    let spawn_err = if ok == 0 {
        Some(io::Error::last_os_error())
    } else {
        None
    };
    // SAFETY: initialised above, deleted exactly once.
    unsafe { DeleteProcThreadAttributeList(attr_list) };
    if let Some(err) = spawn_err {
        return Err(err);
    }

    let process = Handle(info.hProcess);
    let _thread = Handle(info.hThread);

    // `HANDLE` is a raw pointer and therefore `!Send`; move it across as an
    // integer, which is all a Win32 handle is.
    let drain_handle = output_read.leak() as usize;
    let drainer = std::thread::spawn(move || {
        let handle = drain_handle as HANDLE;
        drain(handle);
        // SAFETY: the drain thread is the sole owner of this handle.
        unsafe { CloseHandle(handle) };
    });

    if !wait_for_file(ready_path, Duration::from_secs(20)) {
        // SAFETY: `process` is a live process handle owned here.
        unsafe { TerminateProcess(process.get(), 1) };
        drop(input_write);
        let _ = drainer.join();
        return Err(io::Error::other(
            "the GUI-subsystem grandchild never wrote its readiness record",
        ));
    }

    let mut observation = parse_child_record(&std::fs::read_to_string(ready_path)?);
    observation.middle_console = std::fs::read_to_string(middle_path)
        .map(|text| parse_middle_record(&text))
        .unwrap_or((0, 0));

    // Only a grandchild with a console can read the pane's input; writing the
    // sequence regardless keeps both arms of the measurement identical.
    write_all(input_write.get(), sequence)?;
    write_all(input_write.get(), &[SENTINEL])?;

    // SAFETY: `process` is a live process handle.
    unsafe { WaitForSingleObject(process.get(), 20_000) };
    let mut code: u32 = 0;
    // SAFETY: `code` is a valid out-param.
    unsafe { GetExitCodeProcess(process.get(), &mut code) };
    if code == u32::MAX {
        // STILL_ACTIVE: the middle hung rather than reaping the grandchild.
        // SAFETY: still a live process handle.
        unsafe { TerminateProcess(process.get(), 1) };
    }
    drop(input_write);
    let _ = drainer.join();

    observation.received = std::fs::read_to_string(report_path)
        .map(|hex| parse_hex(hex.trim()))
        .unwrap_or_default();
    Ok(observation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenario_tags_round_trip_and_carry_the_creation_flags() {
        for scenario in Scenario::all() {
            assert_eq!(Scenario::parse(scenario.tag()), Some(scenario));
        }
        assert_eq!(Scenario::ConsoleInherit.creation_flags(), 0);
        assert_eq!(Scenario::GuiInherit.creation_flags(), 0);
        assert_eq!(Scenario::GuiDetached.creation_flags(), DETACHED_PROCESS);
        assert!(!Scenario::ConsoleInherit.child_is_gui());
        assert!(Scenario::GuiInherit.child_is_gui());
        assert!(Scenario::GuiAttachByPid.attaches_by_pid());
        assert!(!Scenario::GuiInherit.attaches_by_pid());
        assert_eq!(Scenario::parse("daemon"), None);
    }

    #[test]
    fn fields_are_matched_whole_so_prefixes_do_not_collide() {
        let record = "attached=1 cols=132 rows=37 conin_err=0 recols=9 rerows=8";
        assert_eq!(field(record, "cols"), 132);
        assert_eq!(field(record, "recols"), 9);
        assert_eq!(field(record, "missing"), 0);
    }

    #[test]
    fn a_child_record_parses_into_an_observation() {
        let parsed = parse_child_record(
            "attached=1 cols=132 rows=37 conin_err=0 reattach_err=5 recols=132 rerows=37",
        );
        assert!(parsed.attached);
        assert_eq!(parsed.console, (PTY_COLS, PTY_ROWS));
        assert_eq!(parsed.conin_err, 0);
        assert_eq!(parsed.reattach_err, ERROR_ACCESS_DENIED);
        assert_eq!(parsed.reattached_console, (PTY_COLS, PTY_ROWS));
    }

    #[test]
    fn a_console_less_child_record_parses_as_unattached() {
        let parsed = parse_child_record("attached=0 cols=0 rows=0 conin_err=6");
        assert!(!parsed.attached);
        assert_eq!(parsed.verdict(), "no console");
        assert!(!parsed.owns_pane_console());
    }

    #[test]
    fn a_child_in_the_wrong_console_is_not_the_pane() {
        let observation = Observation {
            attached: true,
            console: (80, 25),
            middle_console: (PTY_COLS, PTY_ROWS),
            ..Observation::default()
        };
        assert!(observation.topology_held());
        assert!(!observation.owns_pane_console());
        assert_eq!(observation.verdict(), "SOME OTHER CONSOLE");
    }

    #[test]
    fn a_measurement_whose_middle_missed_the_pty_is_not_trusted() {
        let observation = Observation {
            attached: true,
            console: (PTY_COLS, PTY_ROWS),
            middle_console: (80, 25),
            ..Observation::default()
        };
        assert!(!observation.topology_held());
    }

    #[test]
    fn the_middle_record_parses_its_console_size() {
        assert_eq!(
            parse_middle_record("cols=132 rows=37"),
            (PTY_COLS, PTY_ROWS)
        );
        assert_eq!(parse_middle_record("nothing here"), (0, 0));
    }
}
