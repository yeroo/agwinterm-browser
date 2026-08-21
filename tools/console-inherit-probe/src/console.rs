//! An owning handle on one of the console pseudo-devices.
//!
//! `CONIN$`/`CONOUT$` are opened by name rather than taken from `GetStdHandle`,
//! for the reason the sibling probe recorded: under a pseudoconsole an inherited
//! std handle can be `NUL`, which reports `FILE_TYPE_CHAR` and then fails every
//! console API, so the process looks console-less while actually being attached.
//! Opening by name always names the console the process *is* attached to — and
//! failing to open it is therefore the honest test for "has no console at all".

use std::ptr;

use windows_sys::Win32::Foundation::{
    CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, WriteFile, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{GetConsoleScreenBufferInfo, CONSOLE_SCREEN_BUFFER_INFO};

/// `CONIN$` as NUL-terminated UTF-16, without pulling in a crate.
pub const CONIN: &[u16] = &[
    b'C' as u16,
    b'O' as u16,
    b'N' as u16,
    b'I' as u16,
    b'N' as u16,
    b'$' as u16,
    0,
];
/// `CONOUT$` as NUL-terminated UTF-16.
pub const CONOUT: &[u16] = &[
    b'C' as u16,
    b'O' as u16,
    b'N' as u16,
    b'O' as u16,
    b'U' as u16,
    b'T' as u16,
    b'$' as u16,
    0,
];

/// One console pseudo-device, closed on drop.
#[derive(Debug)]
pub struct Console(HANDLE);

impl Console {
    /// Opens `CONIN$` or `CONOUT$`. The error is `GetLastError`, which is
    /// `ERROR_INVALID_HANDLE` when the process has no console to open.
    pub fn open(name: &[u16]) -> Result<Self, u32> {
        // SAFETY: `name` is a NUL-terminated wide string that outlives the call.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null(),
                OPEN_EXISTING,
                0,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(-1) as u32)
        } else {
            Ok(Console(handle))
        }
    }

    /// The raw handle, for the console calls this type does not wrap.
    pub fn raw(&self) -> HANDLE {
        self.0
    }

    /// The console's size as `(cols, rows)`, or `(0, 0)` if the query fails.
    /// Reads `dwSize`, matching what the sibling probe records.
    pub fn size(&self) -> (i16, i16) {
        // SAFETY: plain out-param struct for a console query.
        let mut screen: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: `screen` is a valid out-param and `self.0` a live console handle.
        let ok = unsafe { GetConsoleScreenBufferInfo(self.0, &mut screen) };
        if ok == 0 {
            (0, 0)
        } else {
            (screen.dwSize.X, screen.dwSize.Y)
        }
    }

    /// Writes bytes to the console, ignoring short writes — the probe only ever
    /// sends a handful.
    pub fn write(&self, bytes: &[u8]) {
        let mut written: u32 = 0;
        // SAFETY: `bytes` is a live slice, `written` a valid out-param, and
        // `self.0` a live console handle.
        unsafe {
            WriteFile(
                self.0,
                bytes.as_ptr(),
                bytes.len() as u32,
                &mut written,
                ptr::null_mut(),
            )
        };
    }
}

impl Drop for Console {
    fn drop(&mut self) {
        // SAFETY: `self.0` came from `CreateFileW` in `open` and is closed once.
        unsafe { CloseHandle(self.0) };
    }
}

/// The size of the console this process is attached to, or `(0, 0)` if it has
/// none. A convenience for callers that only want to identify their console.
pub fn attached_console_size() -> (i16, i16) {
    Console::open(CONOUT).map_or((0, 0), |conout| conout.size())
}
