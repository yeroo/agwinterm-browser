//! Three programs in one console-subsystem binary.
//!
//! With `--middle <scenario> <gui-exe> <ready> <report> <record>` this is the
//! *middle* process: it stands in for the CLI running inside the pane. It records
//! the console it was given — proof that the harness pseudoconsole really reached
//! it — then spawns the grandchild with the subsystem and creation flags under
//! test, and waits for it. It deliberately never reads console input: a console
//! has one input buffer, and in the foreground model the CLI must leave it to the
//! engine.
//!
//! With `--probe <ready> <report>` it is the *console-subsystem grandchild*, the
//! control arm. It runs the same `child::run` body as `gui-child.exe`.
//!
//! With no arguments it is the *host*: it runs every scenario and prints the table
//! `docs/design/03-process-model.md` quotes. `cargo test` asserts the same facts.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::ptr;

use console_inherit_probe::console::attached_console_size;
use console_inherit_probe::{child, escape, measure, Observation, Scenario, PTY_COLS, PTY_ROWS};

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetCurrentProcessId, GetExitCodeProcess, TerminateProcess, WaitForSingleObject,
    PROCESS_INFORMATION, STARTUPINFOW,
};

/// The sequence written into the pane while the grandchild is reading. An SGR
/// mouse report, because that is the input the port's decoder most needs to reach
/// whichever process ends up owning the console.
const PANE_INPUT: &[u8] = b"\x1b[<0;12;5M";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 && args[1] == "--probe" {
        child::run(
            Path::new(&args[2]),
            Path::new(&args[3]),
            child::Attach::Parent,
        );
        return;
    }
    if args.len() >= 7 && args[1] == "--middle" {
        let Some(scenario) = Scenario::parse(&args[2]) else {
            eprintln!("unknown scenario {}", args[2]);
            std::process::exit(2);
        };
        middle(
            scenario,
            Path::new(&args[3]),
            Path::new(&args[4]),
            Path::new(&args[5]),
            Path::new(&args[6]),
        );
        return;
    }
    host();
}

/// The CLI's stand-in: record the console, spawn the grandchild, wait.
fn middle(scenario: Scenario, gui_exe: &Path, ready: &Path, report: &Path, record: &Path) {
    let (cols, rows) = attached_console_size();
    let _ = std::fs::write(record, format!("cols={cols} rows={rows}"));

    // Naming our own process id is what lets the grandchild attach to this pane's
    // console without being our direct child.
    // SAFETY: no arguments and no failure mode.
    let own_pid = unsafe { GetCurrentProcessId() };
    let command = if scenario.child_is_gui() {
        let named = if scenario.attaches_by_pid() {
            format!(" {own_pid}")
        } else {
            String::new()
        };
        format!(
            "\"{}\" \"{}\" \"{}\"{named}",
            gui_exe.display(),
            ready.display(),
            report.display()
        )
    } else {
        format!(
            "\"{}\" --probe \"{}\" \"{}\"",
            std::env::current_exe().expect("current exe").display(),
            ready.display(),
            report.display()
        )
    };
    let mut command_wide: Vec<u16> = command.encode_utf16().chain(std::iter::once(0)).collect();

    // SAFETY: plain C struct, zeroed before use.
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    // SAFETY: plain C struct, zeroed before use as an out-param.
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the command line is a live NUL-terminated buffer and `info` is a
    // valid out-param. Handle inheritance is off on purpose: console *attachment*
    // is a property of the process, not of the std handles it was handed, and the
    // point of the measurement is to see whether attachment happens anyway.
    let ok = unsafe {
        CreateProcessW(
            ptr::null(),
            command_wide.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            scenario.creation_flags(),
            ptr::null(),
            ptr::null(),
            &startup,
            &mut info,
        )
    };
    if ok == 0 {
        eprintln!("CreateProcessW failed: {}", std::io::Error::last_os_error());
        std::process::exit(3);
    }

    // SAFETY: `info.hProcess` is a live process handle owned by this function.
    unsafe { WaitForSingleObject(info.hProcess, 20_000) };
    let mut code: u32 = 0;
    // SAFETY: `code` is a valid out-param and the handle is still live.
    unsafe { GetExitCodeProcess(info.hProcess, &mut code) };
    if code == u32::MAX {
        // SAFETY: still a live process handle.
        unsafe { TerminateProcess(info.hProcess, 1) };
    }
    // SAFETY: both handles came from `CreateProcessW` and are closed once.
    unsafe {
        CloseHandle(info.hThread);
        CloseHandle(info.hProcess);
    }
}

fn gui_exe() -> PathBuf {
    std::env::current_exe()
        .expect("current exe")
        .with_file_name("gui-child.exe")
}

/// The host half: run every scenario and print the measurement table.
fn host() {
    let exe = std::env::current_exe().expect("current exe");
    let gui = gui_exe();
    let mut stdout = std::io::stdout().lock();
    writeln!(
        stdout,
        "pseudoconsole {PTY_COLS}x{PTY_ROWS} -> console-subsystem middle -> grandchild\n"
    )
    .unwrap();
    writeln!(
        stdout,
        "{:<18} {:<9} {:<10} {:<8} {:<9} {:<10} read from pane",
        "scenario", "attached", "console", "conin", "attach", "after"
    )
    .unwrap();
    for scenario in Scenario::all() {
        match measure(&exe, &gui, scenario, scenario.tag(), PANE_INPUT) {
            Ok(observation) => print_row(&mut stdout, scenario, &observation),
            Err(error) => writeln!(stdout, "{:<18} ERROR: {error}", scenario.tag()).unwrap(),
        }
    }
}

fn print_row(out: &mut impl Write, scenario: Scenario, observation: &Observation) {
    let size = |(cols, rows): (i16, i16)| format!("{cols}x{rows}");
    let read = if observation.received.is_empty() {
        "-".to_string()
    } else {
        escape(&observation.received)
    };
    writeln!(
        out,
        "{:<18} {:<9} {:<10} {:<8} {:<9} {:<10} {read}   [{}]",
        scenario.tag(),
        observation.attached,
        size(observation.console),
        observation.conin_err,
        observation.reattach_err,
        size(observation.reattached_console),
        observation.verdict(),
    )
    .unwrap();
    if !observation.topology_held() {
        writeln!(
            out,
            "  !! the middle process reported console {}, not the harness pseudoconsole",
            size(observation.middle_console)
        )
        .unwrap();
    }
}
