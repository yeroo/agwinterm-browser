//! Measures ConPTY input fidelity: what a console child *actually* reads when the
//! host writes a given VT sequence into the pseudoconsole's input pipe.
//!
//! This exists because the Windows port decodes input with upstream's VT decoder
//! (`pixel-core/src/terminal.rs:1251-1909`), which expects SGR mouse reports and
//! kitty-keyboard CSI-u reports to arrive byte-for-byte. Under ConPTY they need
//! not: the host writes VT into the pty input pipe, conhost's input thread parses
//! it, and conhost then hands bytes to a client that has set
//! `ENABLE_VIRTUAL_TERMINAL_INPUT`. Anything lost in between is invisible to the
//! decoder, and Task 11 would be the first thing to notice.
//!
//! The harness drives a real ConPTY rather than modelling one, because the whole
//! question is what conhost does, and a mock would only encode our guess.

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
    WaitForSingleObject, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROCESS_INFORMATION, STARTUPINFOEXW, STARTUPINFOW,
};

/// `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`. Spelled out rather than imported so the
/// crate does not depend on which `windows-sys` module happens to re-export it.
const ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;

/// The byte that tells the child probe to stop reading and write its capture out.
/// `EOT`; with `ENABLE_PROCESSED_INPUT` cleared it carries no other meaning.
pub const SENTINEL: u8 = 0x04;

/// The size of the pseudoconsole the harness creates. Fixed so the child can be
/// checked against it — a child reporting these dimensions is provably attached to
/// *our* pty and not to whatever console the test runner happens to have.
pub const PTY_COLS: i16 = 200;
pub const PTY_ROWS: i16 = 40;

/// Whether the child asks conhost for mouse reports before reading.
///
/// conhost only forwards mouse input to a client that enabled it, so a mouse case
/// run without this could measure "we never turned mouse reporting on" rather than
/// "ConPTY dropped the report".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseMode {
    /// Send `?1000h ?1002h ?1003h ?1006h` before reading.
    Request,
    /// Send nothing — the control for whether requesting is actually required.
    Skip,
}

/// One probe case: a name, the bytes to write, and how to set the console up.
#[derive(Debug, Clone)]
pub struct Case {
    pub tag: &'static str,
    pub sequence: Vec<u8>,
    pub mouse: MouseMode,
}

/// One measurement: the bytes the host wrote, and the bytes the child read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capture {
    pub sent: Vec<u8>,
    pub received: Vec<u8>,
    /// The console size the child saw, as `(cols, rows)`. Proof of attachment.
    pub child_console: (i16, i16),
}

impl Capture {
    /// True when the sequence survived the pty unchanged.
    pub fn is_verbatim(&self) -> bool {
        self.received == self.sent
    }

    /// True when nothing at all came through — the sequence was swallowed.
    pub fn is_dropped(&self) -> bool {
        self.received.is_empty()
    }

    /// True when the child ran inside the harness's pseudoconsole rather than
    /// inheriting the test runner's console.
    pub fn ran_under_pty(&self) -> bool {
        self.child_console == (PTY_COLS, PTY_ROWS)
    }

    pub fn verdict(&self) -> &'static str {
        if self.is_verbatim() {
            "verbatim"
        } else if self.is_dropped() {
            "DROPPED"
        } else {
            "REWRITTEN"
        }
    }
}

/// Renders bytes the way the port's logs and design docs quote them: printable
/// ASCII as-is, `ESC` as `\e`, everything else hex-escaped.
pub fn escape(bytes: &[u8]) -> String {
    let mut out = String::new();
    for &b in bytes {
        match b {
            0x1b => out.push_str("\\e"),
            0x20..=0x7e => out.push(b as char),
            _ => out.push_str(&format!("\\x{b:02x}")),
        }
    }
    out
}

/// Parses the child's capture format: whitespace-separated two-digit hex bytes.
pub fn parse_hex(text: &str) -> Vec<u8> {
    text.split_whitespace()
        .filter_map(|token| u8::from_str_radix(token, 16).ok())
        .collect()
}

/// Formats bytes the way the child writes them.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The sequences the port cares about, named for the design record.
pub fn probe_cases() -> Vec<Case> {
    let case = |tag, sequence: &[u8], mouse| Case {
        tag,
        sequence: sequence.to_vec(),
        mouse,
    };
    vec![
        // The control: plain text has to survive, or the harness is broken.
        case("plain-ascii", b"abc", MouseMode::Request),
        // A legacy cursor key: the shape conhost was built to translate.
        case("arrow-up", b"\x1b[A", MouseMode::Request),
        // SGR mouse press/release at column 12, row 5 (`?1006` encoding).
        case("sgr-mouse-press", b"\x1b[<0;12;5M", MouseMode::Request),
        case("sgr-mouse-release", b"\x1b[<0;12;5m", MouseMode::Request),
        // SGR motion with button 32 (drag) — the form Task 11 needs for selection.
        case("sgr-mouse-drag", b"\x1b[<32;13;5M", MouseMode::Request),
        // The same press with mouse reporting never requested, to establish
        // whether the DECSET handshake is load-bearing on this path.
        case("sgr-mouse-no-decset", b"\x1b[<0;12;5M", MouseMode::Skip),
        // Kitty keyboard CSI-u: `a` with no mods, and ctrl+shift+a.
        case("csi-u-plain", b"\x1b[97u", MouseMode::Request),
        case("csi-u-mods", b"\x1b[97;6u", MouseMode::Request),
        // Modified legacy form, for contrast with the CSI-u form above.
        case("csi-modified-arrow", b"\x1b[1;5A", MouseMode::Request),
    ]
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

/// Drains the pseudoconsole's output pipe. Nothing reads the child's rendered
/// screen, but something must keep the pipe from filling and blocking conhost.
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

/// Waits for `path` to appear, polling. Returns false on timeout.
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

/// Where the child probe writes its capture, and where it signals readiness.
/// Unique per process and per tag so concurrent test threads cannot collide.
fn capture_paths(tag: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir();
    let pid = std::process::id();
    let out = dir.join(format!("conpty-probe-{pid}-{tag}.hex"));
    let ready = dir.join(format!("conpty-probe-{pid}-{tag}.ready"));
    (out, ready)
}

/// Runs one measurement: spawns `probe_exe --dump <out> <ready>` attached to a
/// fresh ConPTY, writes the case's sequence into that ConPTY's input, and returns
/// what the child read.
pub fn measure(probe_exe: &Path, case: &Case) -> io::Result<Capture> {
    let (out_path, ready_path) = capture_paths(case.tag);
    let _ = std::fs::remove_file(&out_path);
    let _ = std::fs::remove_file(&ready_path);

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

    // ConPTY duplicated the ends it needs. Our copies have to go before the child
    // is created, or EOF never propagates and the drain never finishes.
    drop(input_read);
    drop(output_write);

    let result = spawn_and_capture(
        probe_exe,
        &out_path,
        &ready_path,
        hpc,
        input_write,
        output_read,
        case,
    );

    // SAFETY: `hpc` was produced by `CreatePseudoConsole` above and is closed once.
    unsafe { ClosePseudoConsole(hpc) };

    let capture = result?;
    let _ = std::fs::remove_file(&out_path);
    let _ = std::fs::remove_file(&ready_path);
    Ok(capture)
}

fn spawn_and_capture(
    probe_exe: &Path,
    out_path: &Path,
    ready_path: &Path,
    hpc: HPCON,
    input_write: Handle,
    output_read: Handle,
    case: &Case,
) -> io::Result<Capture> {
    let mut attr_size: usize = 0;
    // SAFETY: the first call is the documented size query; it is expected to fail.
    unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut attr_size) };
    // Backed by `usize`, not `u8`: an attribute list holds pointers, and a
    // `Vec<u8>` is only byte-aligned.
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

    let mut command = format!(
        "\"{}\" --dump \"{}\" \"{}\"",
        probe_exe.display(),
        out_path.display(),
        ready_path.display()
    );
    if case.mouse == MouseMode::Skip {
        command.push_str(" --no-mouse");
    }
    let mut command_wide = wide(OsStr::new(&command));

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

    if !wait_for_file(ready_path, Duration::from_secs(15)) {
        // SAFETY: `process` is a live process handle owned here.
        unsafe { TerminateProcess(process.get(), 1) };
        drop(input_write);
        let _ = drainer.join();
        return Err(io::Error::other(
            "child probe never signalled readiness under the pseudoconsole",
        ));
    }
    let child_console = parse_console_size(&std::fs::read_to_string(ready_path)?);

    write_all(input_write.get(), &case.sequence)?;
    write_all(input_write.get(), &[SENTINEL])?;

    // SAFETY: `process` is a live process handle.
    unsafe { WaitForSingleObject(process.get(), 15_000) };
    let mut code: u32 = 0;
    // SAFETY: `code` is a valid out-param.
    unsafe { GetExitCodeProcess(process.get(), &mut code) };
    if code == u32::MAX {
        // STILL_ACTIVE: the child hung rather than seeing the sentinel.
        // SAFETY: still a live process handle.
        unsafe { TerminateProcess(process.get(), 1) };
    }

    drop(input_write);
    let _ = drainer.join();

    let hex = std::fs::read_to_string(out_path)?;
    Ok(Capture {
        sent: case.sequence.clone(),
        received: parse_hex(hex.trim()),
        child_console,
    })
}

/// Reads the `cols=<n> rows=<n>` readiness record the child writes.
pub fn parse_console_size(text: &str) -> (i16, i16) {
    let field = |name: &str| -> i16 {
        text.split_whitespace()
            .find_map(|token| token.strip_prefix(name))
            .and_then(|value| value.parse().ok())
            .unwrap_or(0)
    };
    (field("cols="), field("rows="))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_quotes_control_bytes_and_leaves_ascii_alone() {
        assert_eq!(escape(b"abc"), "abc");
        assert_eq!(escape(b"\x1b[<0;12;5M"), "\\e[<0;12;5M");
        assert_eq!(escape(&[0x00, 0x04, 0xff]), "\\x00\\x04\\xff");
    }

    #[test]
    fn hex_round_trips_through_the_childs_capture_format() {
        let bytes = b"\x1b[97;6u".to_vec();
        assert_eq!(parse_hex(&to_hex(&bytes)), bytes);
        assert_eq!(to_hex(&[]), "");
        assert_eq!(parse_hex(""), Vec::<u8>::new());
    }

    #[test]
    fn parse_hex_ignores_tokens_that_are_not_bytes() {
        assert_eq!(parse_hex("1b 5b zz 41"), vec![0x1b, 0x5b, 0x41]);
    }

    #[test]
    fn verdicts_distinguish_verbatim_dropped_and_rewritten() {
        let make = |sent: &[u8], received: &[u8]| Capture {
            sent: sent.to_vec(),
            received: received.to_vec(),
            child_console: (PTY_COLS, PTY_ROWS),
        };
        assert_eq!(make(b"\x1b[A", b"\x1b[A").verdict(), "verbatim");
        assert_eq!(make(b"\x1b[A", b"").verdict(), "DROPPED");
        assert_eq!(make(b"\x1b[97u", b"a").verdict(), "REWRITTEN");
        assert!(make(b"x", b"").is_dropped());
        assert!(make(b"x", b"x").ran_under_pty());
    }

    #[test]
    fn a_capture_from_the_wrong_console_is_not_trusted() {
        let capture = Capture {
            sent: b"abc".to_vec(),
            received: b"abc".to_vec(),
            child_console: (80, 25),
        };
        assert!(!capture.ran_under_pty());
    }

    #[test]
    fn console_size_parses_from_the_readiness_record() {
        assert_eq!(parse_console_size("cols=200 rows=40 mode=0x1f7"), (200, 40));
        assert_eq!(parse_console_size("garbage"), (0, 0));
    }

    #[test]
    fn every_probe_case_has_a_distinct_tag() {
        let cases = probe_cases();
        let mut tags: Vec<_> = cases.iter().map(|c| c.tag).collect();
        tags.sort_unstable();
        let before = tags.len();
        tags.dedup();
        // Tags name temp files; a collision would silently cross two measurements.
        assert_eq!(tags.len(), before);
    }
}
