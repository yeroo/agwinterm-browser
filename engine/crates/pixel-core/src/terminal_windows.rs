//! The Windows backend, as a stub.
//!
//! `terminal.rs`'s tty backend is `#[cfg(unix)]`-gated: termios raw mode, `/dev/tty`,
//! `SIGWINCH`, `rustix::shm` and the Kitty-escape frame transport have no Windows
//! equivalent, and ConPTY strips the escapes the transport depends on anyway. What
//! survives that gate is the 659-line VT decoder further down the same file, which
//! is portable and which Task 5 reuses rather than rewriting.
//!
//! This module is what stands in the gap in the meantime, so the crate — all 43
//! unix-free modules of it, and the ~200 tests they carry — compiles and runs on
//! Windows today. It is deliberately thin:
//!
//! - **Construction succeeds.** `new` and `open` make no OS call; they record the
//!   wrapper and session env that Task 5 will need and hand back a value. That is
//!   what lets `engine/mod.rs` be exercised on Windows now.
//! - **Every operation fails, loudly and immediately**, with `ErrorKind::Unsupported`
//!   and a message naming the task that will implement it. Nothing here half-works.
//! - **Every capability getter answers `false`.** A backend that cannot do a thing
//!   says so up front rather than erroring at the point of use; see the contract in
//!   [`crate::terminal_backend`]. `relayed` is the one real answer, because it is a
//!   property of the wrapper, not of the terminal.
//!
//! ⚠️ Because construction makes no OS call, the trait's raw-mode contract — enter
//! while constructing, restore in `Drop` — is satisfied only vacuously here. Task 5
//! puts a real `SetConsoleMode` pair behind it, including on the panicking path.

use std::io;
use std::time::Duration;

use crate::canvas::Canvas;
use crate::terminal::{Event, SessionEnv, TerminalColors, Waker, WindowSize};
use crate::wrapper::Wrapper;

/// Where the Windows console backend will live. Its fields are the inputs Task 5
/// needs and Task 6 reads: the wrapper decides how output is framed for a relay, and
/// the session env is where `AGWINTERM_PIPE` and `AGWINTERM_SESSION_ID` come from.
pub struct Terminal {
    wrapper: Wrapper,
    #[allow(dead_code, reason = "Task 6 reads AGWINTERM_* out of this")]
    env: SessionEnv,
}

/// One error, one message, one place to change when a task lands.
fn unimplemented<T>(what: &str, task: &str) -> io::Result<T> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!("{what} is not implemented on Windows yet ({task})"),
    ))
}

impl Terminal {
    pub fn new(wrapper: Wrapper, env: SessionEnv) -> io::Result<Self> {
        Ok(Self { wrapper, env })
    }

    /// Windows has no `/dev/tty`, so there is nothing to open by path. Task 2 decided
    /// the engine runs in the foreground process and talks to its own console, which
    /// is what `new` is for; a path-named terminal has no meaning here.
    pub fn open(_tty_path: &str, wrapper: Wrapper, env: SessionEnv) -> io::Result<Self> {
        Self::new(wrapper, env)
    }

    pub fn reports_color_scheme(&self) -> bool {
        false
    }

    pub fn relayed(&self) -> bool {
        self.wrapper.relayed()
    }

    pub fn kitty_keyboard(&self) -> bool {
        false
    }

    pub fn set_key_event_types(&mut self, _enabled: bool) -> io::Result<()> {
        unimplemented("key event types", "Task 5")
    }

    pub fn draw(&mut self, _canvas: &Canvas) -> io::Result<usize> {
        unimplemented("drawing a frame", "Task 7")
    }

    pub fn read_event(&mut self) -> io::Result<Event> {
        unimplemented("reading console input", "Task 5")
    }

    pub fn poll_event(&mut self, _timeout: Option<Duration>) -> io::Result<Option<Event>> {
        unimplemented("polling console input", "Task 5")
    }

    pub fn waker(&mut self) -> io::Result<Waker> {
        unimplemented("waking a blocked read", "Task 5")
    }

    pub fn watch_resize(&mut self) -> io::Result<()> {
        unimplemented("watching for resize", "Task 5")
    }

    pub fn size(&self) -> io::Result<WindowSize> {
        unimplemented("reading the console size", "Task 5")
    }

    pub fn reports_pixel_mouse(&self) -> bool {
        false
    }

    pub fn frames_are_inline(&self) -> bool {
        false
    }

    pub fn forget_cell_size(&mut self) {}

    pub fn cell_size(&mut self) -> io::Result<Option<(u32, u32)>> {
        unimplemented("cell metrics", "Task 6")
    }

    pub fn query_colors(&mut self) -> io::Result<TerminalColors> {
        unimplemented("querying the palette", "Task 5")
    }

    pub fn request_colors(&mut self) -> io::Result<()> {
        unimplemented("requesting the palette", "Task 5")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_backend::TerminalBackend;

    fn built() -> Terminal {
        Terminal::new(Wrapper::named(None), SessionEnv::of_process())
            .expect("construction makes no OS call, so it cannot fail")
    }

    #[test]
    fn construction_succeeds_without_touching_the_console() {
        // Not a placeholder that always errors: the point of constructing is that
        // `engine/mod.rs`'s two constructors can be reached on Windows now, which is
        // what makes the inherited tests a live regression net from this task on.
        assert!(Terminal::new(Wrapper::named(None), SessionEnv::of_process()).is_ok());
        assert!(
            Terminal::open("/dev/tty", Wrapper::named(None), SessionEnv::of_process()).is_ok(),
            "there is no tty path on Windows, so `open` degrades to `new` rather than \
             failing in a way callers would have to special-case",
        );
    }

    #[test]
    fn every_operation_reports_unsupported_rather_than_half_working() {
        let mut term = built();
        let fails = |result: io::Result<()>, what: &str| {
            let err = result.expect_err(what);
            assert_eq!(err.kind(), io::ErrorKind::Unsupported, "{what}");
            assert!(
                err.to_string().contains("Task"),
                "{what}: the message must name the task that will implement it, got {err}",
            );
        };

        fails(term.set_key_event_types(true), "set_key_event_types");
        fails(term.draw(&Canvas::new(4, 4)).map(|_| ()), "draw");
        fails(term.read_event().map(|_| ()), "read_event");
        fails(term.poll_event(None).map(|_| ()), "poll_event");
        fails(term.waker().map(|_| ()), "waker");
        fails(term.watch_resize(), "watch_resize");
        fails(term.size().map(|_| ()), "size");
        fails(term.cell_size().map(|_| ()), "cell_size");
        fails(term.query_colors().map(|_| ()), "query_colors");
        fails(term.request_colors(), "request_colors");
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
    fn capabilities_are_all_denied_except_the_one_the_wrapper_owns() {
        let term = built();
        assert!(!term.reports_color_scheme());
        assert!(!term.kitty_keyboard());
        assert!(!term.reports_pixel_mouse());
        assert!(!term.frames_are_inline());
        assert!(!term.clipboard_data_supported());

        // `relayed` is a property of the wrapper, not of the console, so it is a real
        // answer even here — and Task 7's frame path depends on it being one.
        assert!(!term.relayed(), "no wrapper named, so nothing is relaying");
        let relayed =
            Terminal::new(Wrapper::named(Some("tmux")), SessionEnv::of_process()).unwrap();
        assert!(relayed.relayed());
    }

    #[test]
    fn forgetting_the_cell_size_is_a_no_op_that_does_not_panic() {
        // The one method that returns nothing, so a stub cannot signal through it.
        // It has to stay callable: `engine/` calls it on every font change.
        let mut term = built();
        term.forget_cell_size();
        term.forget_cell_size();
    }

    #[test]
    fn the_trait_delegates_to_the_inherent_methods_rather_than_itself() {
        // `impl TerminalBackend for Terminal` forwards each method to the inherent one
        // of the same name, relying on inherent methods winning method resolution. If
        // that were wrong, these calls would recurse until the stack ran out; reaching
        // the assertions at all is the proof.
        let mut term =
            <Terminal as TerminalBackend>::new(Wrapper::named(None), SessionEnv::of_process())
                .unwrap();

        assert_eq!(
            TerminalBackend::size(&term).unwrap_err().kind(),
            io::ErrorKind::Unsupported,
        );
        assert_eq!(
            TerminalBackend::poll_event(&mut term, None)
                .unwrap_err()
                .kind(),
            io::ErrorKind::Unsupported,
        );
        assert!(!TerminalBackend::kitty_keyboard(&term));
        TerminalBackend::forget_cell_size(&mut term);
    }
}
