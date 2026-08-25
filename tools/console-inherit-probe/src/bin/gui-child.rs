//! The `electron.exe` stand-in: a `/SUBSYSTEM:WINDOWS` image, which is the only
//! thing about Electron that matters to console attachment. The body is
//! `console_inherit_probe::child::run`, shared verbatim with the console-subsystem
//! control arm, so the subsystem field is the only variable.

#![windows_subsystem = "windows"]

use std::path::Path;

use console_inherit_probe::child::{run, Attach};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        std::process::exit(2);
    }
    // An optional fourth argument names the process whose console to attach to;
    // without it the child falls back to its direct parent.
    let attach = args
        .get(3)
        .and_then(|pid| pid.parse().ok())
        .map_or(Attach::Parent, Attach::Pid);
    run(Path::new(&args[1]), Path::new(&args[2]), attach);
}
