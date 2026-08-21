//! Two programs in one binary.
//!
//! With `--dump <out> <ready> [--no-mouse]` this is the *child*: it runs under a
//! ConPTY, configures its console the way the Windows backend will (Task 5), reads
//! until the sentinel, and writes what it read to `<out>` as hex. It reports
//! through a file rather than stdout because stdout under a ConPTY is a rendered
//! screen, not a byte stream — the host would read back conhost's repaint of the
//! text, not the text.
//!
//! With no arguments it is the *host*: it runs every probe case and prints the
//! table that `docs/design/01-baseline-errors.md` quotes. `cargo test` asserts on the
//! same measurements.

use std::io::Write;
use std::path::PathBuf;
use std::ptr;

use conpty_probe::{escape, measure, probe_cases, to_hex, MouseMode, PTY_COLS, PTY_ROWS, SENTINEL};

use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{
    GetConsoleMode, GetConsoleScreenBufferInfo, SetConsoleMode, CONSOLE_SCREEN_BUFFER_INFO,
    DISABLE_NEWLINE_AUTO_RETURN, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT,
    ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
};

/// `CONIN$` and `CONOUT$` as NUL-terminated UTF-16, without pulling in a crate.
const CONIN: &[u16] = &[
    b'C' as u16,
    b'O' as u16,
    b'N' as u16,
    b'I' as u16,
    b'N' as u16,
    b'$' as u16,
    0,
];
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 && args[1] == "--dump" {
        let out = PathBuf::from(&args[2]);
        let ready = PathBuf::from(&args[3]);
        let mouse = if args.iter().any(|a| a == "--no-mouse") {
            MouseMode::Skip
        } else {
            MouseMode::Request
        };
        child(&out, &ready, mouse);
        return;
    }
    host();
}

/// Opens one of the console's pseudo-devices by name.
///
/// Deliberately *not* `GetStdHandle`. Under a pseudoconsole a child's inherited
/// std handles can be `NUL`: `GetFileType` still reports `FILE_TYPE_CHAR`, but
/// every console API then fails with `ERROR_INVALID_HANDLE`, so the process looks
/// console-less while actually being attached. `CONIN$`/`CONOUT$` always name the
/// console the process *is* attached to. This is the Windows analogue of upstream
/// opening `/dev/tty` rather than using fd 0, and it is load-bearing for Task 5.
fn open_console(name: &[u16], access: u32) -> HANDLE {
    // SAFETY: `name` is a NUL-terminated wide string that outlives the call.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        ptr::null_mut()
    } else {
        handle
    }
}

/// The child half: what a real Windows backend does to its console, minus the
/// decoding.
fn child(out: &std::path::Path, ready: &std::path::Path, mouse: MouseMode) {
    let conin = open_console(CONIN, GENERIC_READ | GENERIC_WRITE);
    let conout = open_console(CONOUT, GENERIC_READ | GENERIC_WRITE);

    let mut mode: u32 = 0;
    // SAFETY: `mode` is a valid out-param and `conin` a console handle we opened.
    unsafe { GetConsoleMode(conin, &mut mode) };
    // Raw VT input: no line assembly, no echo, no Ctrl-C interception, and ask
    // conhost to hand us VT bytes rather than `INPUT_RECORD`s.
    let raw = (mode & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT))
        | ENABLE_VIRTUAL_TERMINAL_INPUT;
    // SAFETY: `conin` is a live console handle.
    unsafe { SetConsoleMode(conin, raw) };

    let mut out_mode: u32 = 0;
    // SAFETY: `out_mode` is a valid out-param.
    unsafe { GetConsoleMode(conout, &mut out_mode) };
    // SAFETY: `conout` is a live console handle.
    unsafe {
        SetConsoleMode(
            conout,
            out_mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN,
        )
    };

    if mouse == MouseMode::Request {
        // conhost only forwards mouse input to a client that asked for it, and only
        // in SGR form once `?1006` is set.
        write_console(conout, b"\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");
    }

    // SAFETY: plain out-param struct for a console query.
    let mut screen: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: `screen` is a valid out-param and `conout` a live console handle.
    unsafe { GetConsoleScreenBufferInfo(conout, &mut screen) };
    // Readiness is a separate file so the host cannot race the console setup, and
    // it carries the console size so the host can prove which console this was.
    let _ = std::fs::write(
        ready,
        format!(
            "cols={} rows={} mode={mode:#x} raw={raw:#x}",
            screen.dwSize.X, screen.dwSize.Y
        ),
    );

    let mut captured: Vec<u8> = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        let mut read: u32 = 0;
        // SAFETY: `buf` and `read` are live for the call; `conin` is a live handle.
        let ok = unsafe {
            ReadFile(
                conin,
                buf.as_mut_ptr(),
                buf.len() as u32,
                &mut read,
                ptr::null_mut(),
            )
        };
        if ok == 0 || read == 0 {
            break;
        }
        let chunk = &buf[..read as usize];
        if let Some(at) = chunk.iter().position(|&b| b == SENTINEL) {
            captured.extend_from_slice(&chunk[..at]);
            break;
        }
        captured.extend_from_slice(chunk);
    }

    // SAFETY: `conin` is a live console handle; restoring the mode we found.
    unsafe { SetConsoleMode(conin, mode) };
    let _ = std::fs::write(out, to_hex(&captured));
}

fn write_console(handle: HANDLE, bytes: &[u8]) {
    let mut written: u32 = 0;
    // SAFETY: `bytes` is a live slice and `written` a valid out-param.
    unsafe {
        WriteFile(
            handle,
            bytes.as_ptr(),
            bytes.len() as u32,
            &mut written,
            ptr::null_mut(),
        )
    };
}

/// The host half: run every case and print the measurement table.
fn host() {
    let exe = std::env::current_exe().expect("current exe");
    let mut stdout = std::io::stdout().lock();
    writeln!(
        stdout,
        "pseudoconsole {PTY_COLS}x{PTY_ROWS}, child reads CONIN$ with ENABLE_VIRTUAL_TERMINAL_INPUT\n"
    )
    .unwrap();
    writeln!(
        stdout,
        "{:<22} {:<10} {:<28} {:<28} verdict",
        "case", "mouse", "sent", "received"
    )
    .unwrap();
    for case in probe_cases() {
        let mouse = match case.mouse {
            MouseMode::Request => "requested",
            MouseMode::Skip => "not set",
        };
        match measure(&exe, &case) {
            Ok(capture) => writeln!(
                stdout,
                "{:<22} {mouse:<10} {:<28} {:<28} {}",
                case.tag,
                escape(&capture.sent),
                escape(&capture.received),
                capture.verdict()
            )
            .unwrap(),
            Err(err) => writeln!(
                stdout,
                "{:<22} {mouse:<10} {:<28} {:<28} ERROR: {err}",
                case.tag,
                escape(&case.sequence),
                "-"
            )
            .unwrap(),
        }
    }
}
