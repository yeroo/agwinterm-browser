//! The body both grandchildren run.
//!
//! `gui-child.exe` is a `/SUBSYSTEM:WINDOWS` image and the host binary is a
//! console-subsystem one; they call this same function so that the only difference
//! between the two arms of the measurement is the PE subsystem field. If the code
//! differed at all, "GUI programs do not get the console" and "this probe's spawn
//! is wrong" would be indistinguishable.
//!
//! It reports through files because a GUI-subsystem process has no stdout to
//! report on — which is exactly the situation being measured.
//!
//! Order of business: probe for a console *before* touching `AttachConsole`, so the
//! record says what the process was given rather than what it could claw back; then
//! try to attach and record the result, because that call decides whether the
//! foreground model needs an explicit attach step; then, if a console is reachable,
//! put it in the raw VT mode the Windows backend will use and read the pane's input
//! until the sentinel.

use std::path::Path;
use std::ptr;

use windows_sys::Win32::Storage::FileSystem::ReadFile;
use windows_sys::Win32::System::Console::{
    AttachConsole, GetConsoleMode, SetConsoleMode, ATTACH_PARENT_PROCESS,
    DISABLE_NEWLINE_AUTO_RETURN, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT,
    ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
};

use crate::console::{Console, CONIN, CONOUT};
use crate::{to_hex, SENTINEL};

/// Which console the child asks for when it has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attach {
    /// `ATTACH_PARENT_PROCESS` — whatever the direct parent happens to own.
    Parent,
    /// A process id the launcher named. Survives an intermediate process between
    /// the console owner and the engine, which `Parent` does not.
    Pid(u32),
}

impl Attach {
    fn target(self) -> u32 {
        match self {
            Attach::Parent => ATTACH_PARENT_PROCESS,
            Attach::Pid(pid) => pid,
        }
    }
}

pub fn run(ready: &Path, report: &Path, attach: Attach) {
    // What this process was *given*.
    let mut conin = Console::open(CONIN);
    let mut conout = Console::open(CONOUT);
    let conin_err = conin.as_ref().err().copied().unwrap_or(0);
    let attached = conin.is_ok() && conout.is_ok();
    let (cols, rows) = conout.as_ref().map_or((0, 0), Console::size);

    // What it could *take*. On an already-attached process this is expected to
    // fail with `ERROR_ACCESS_DENIED`; on a console-less one it may well succeed,
    // and either answer is worth recording rather than assuming.
    // SAFETY: the argument is a process id or the documented sentinel; the call is
    // safe to make in any state.
    let attach_ok = unsafe { AttachConsole(attach.target()) };
    let reattach_err = if attach_ok == 0 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(-1) as u32
    } else {
        0
    };
    if !attached && attach_ok != 0 {
        // The attach only means something if the console devices open now.
        conin = Console::open(CONIN);
        conout = Console::open(CONOUT);
    }
    let (recols, rerows) = conout.as_ref().map_or((0, 0), Console::size);

    let usable = conin.as_ref().ok().zip(conout.as_ref().ok());
    let restore = usable.map(|(conin, conout)| enter_raw_vt_mode(conin, conout));

    let _ = std::fs::write(
        ready,
        format!(
            "attached={} cols={cols} rows={rows} conin_err={conin_err} \
             reattach_err={reattach_err} recols={recols} rerows={rerows}",
            u8::from(attached)
        ),
    );

    let captured = match conin.as_ref() {
        Ok(conin) if restore.is_some() => read_until_sentinel(conin),
        _ => Vec::new(),
    };

    if let (Some(mode), Ok(conin)) = (restore, conin.as_ref()) {
        // SAFETY: `conin` is a live console handle; restoring the mode we found.
        unsafe { SetConsoleMode(conin.raw(), mode) };
    }
    let _ = std::fs::write(report, to_hex(&captured));
}

/// Puts the console in the mode the Windows backend will use, and returns the
/// input mode that was there before.
fn enter_raw_vt_mode(conin: &Console, conout: &Console) -> u32 {
    let mut mode: u32 = 0;
    // SAFETY: `mode` is a valid out-param and `conin` a console handle we opened.
    unsafe { GetConsoleMode(conin.raw(), &mut mode) };
    let raw = (mode & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT))
        | ENABLE_VIRTUAL_TERMINAL_INPUT;
    // SAFETY: `conin` is a live console handle.
    unsafe { SetConsoleMode(conin.raw(), raw) };

    let mut out_mode: u32 = 0;
    // SAFETY: `out_mode` is a valid out-param.
    unsafe { GetConsoleMode(conout.raw(), &mut out_mode) };
    // SAFETY: `conout` is a live console handle.
    unsafe {
        SetConsoleMode(
            conout.raw(),
            out_mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN,
        )
    };
    // conhost only forwards mouse input to a client that asked for it, and only in
    // SGR form once `?1006` is set.
    conout.write(b"\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");
    mode
}

fn read_until_sentinel(conin: &Console) -> Vec<u8> {
    let mut captured: Vec<u8> = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        let mut read: u32 = 0;
        // SAFETY: `buf` and `read` are live for the call; `conin` is a live handle.
        let ok = unsafe {
            ReadFile(
                conin.raw(),
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
    captured
}
