//! The seam between the engine and whatever is driving the terminal underneath it.
//!
//! `TerminalBackend` is derived from the callers, not designed fresh: every method
//! here is one of the 24 `pub fn`s on the unix `impl Terminal`, with the signature
//! it already had. Twenty-one of them are reached from `engine/`, `engine/clipboard.rs`
//! and `pixel-node`; `new` and `open` are the two constructors `engine/mod.rs:339-340`
//! picks between; `read_event` is the blocking sibling of `poll_event` that the crate
//! exports but does not itself call.
//!
//! The engine keeps calling the concrete `crate::terminal::Terminal` — which is the
//! tty backend on unix and `terminal_windows::Terminal` on Windows — so none of the
//! 43 keep-unchanged modules had to be touched to introduce this. What the trait buys
//! is a *checkable* seam: the single `impl TerminalBackend for Terminal` at the bottom
//! of this file compiles on both platforms, so the two backends cannot drift apart in
//! signature, and a fake backend can be written against the contract in tests.
//!
//! ## The contract, beyond the signatures
//!
//! - **Raw mode is tied to the value's lifetime.** A backend enters raw mode (or its
//!   platform equivalent) while constructing, and restores the terminal in `Drop`.
//!   There is no `enter`/`leave` pair to get wrong, and no method to forget.
//! - **`poll_event` returns at most one event per call**, so a caller draining input
//!   sees events in arrival order and can interleave its own work between them.
//!   `read_event` is `poll_event(None)` that treats "no event" as `UnexpectedEof`.
//! - **Clipboard reads are request/response, not blocking calls.** `request_clipboard`,
//!   `request_clipboard_types` and `request_clipboard_data` return as soon as the
//!   request is on the wire; the answer arrives later as an `Event::Paste` or an
//!   `Event::ClipboardData` out of the same event stream.
//! - **Capability getters are cheap and infallible.** `relayed`, `kitty_keyboard`,
//!   `reports_pixel_mouse`, `reports_color_scheme`, `frames_are_inline` and
//!   `clipboard_data_supported` answer from state settled during construction, so
//!   callers may consult them per frame. A backend that cannot do the thing says so
//!   with `false` rather than erroring later.

use std::io;
use std::time::Duration;

use crate::canvas::Canvas;
// Spelled through `terminal`, the way every other module in the crate spells it —
// `terminal_types` is an implementation detail of the split, not a public path.
use crate::terminal::{Event, SessionEnv, Terminal, TerminalColors, Waker, WindowSize};
use crate::wrapper::Wrapper;

/// What the engine needs from a terminal.
///
/// Not object-safe, and deliberately so: `new` and `open` are constructors, and the
/// engine holds one concrete backend chosen at compile time rather than a `dyn` one
/// chosen at runtime.
pub trait TerminalBackend: Sized {
    /// Take over the process's own terminal.
    fn new(wrapper: Wrapper, env: SessionEnv) -> io::Result<Self>;

    /// Take over a terminal named by path, for the case where the engine's stdio is
    /// not the terminal it is drawing to.
    fn open(tty_path: &str, wrapper: Wrapper, env: SessionEnv) -> io::Result<Self>;

    /// Whether the terminal reports light/dark palette changes as they happen, rather
    /// than only answering when asked.
    fn reports_color_scheme(&self) -> bool;

    /// Whether frames travel through a relay (a multiplexer) rather than straight to
    /// the terminal, which constrains image ids and transport.
    fn relayed(&self) -> bool;

    /// Whether the richer key protocol is active, which decides how the decoder reads
    /// the bytes coming back.
    fn kitty_keyboard(&self) -> bool;

    /// Ask for (or stop asking for) key-release and key-repeat events as well as presses.
    fn set_key_event_types(&mut self, enabled: bool) -> io::Result<()>;

    /// Put a rendered canvas on screen. Returns the number of bytes written, which is
    /// what the frame budget is measured in.
    fn draw(&mut self, canvas: &Canvas) -> io::Result<usize>;

    /// Block until one event is available.
    fn read_event(&mut self) -> io::Result<Event>;

    /// Wait up to `timeout` (forever, if `None`) for one event.
    fn poll_event(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>>;

    /// A handle another thread can use to interrupt a `poll_event` in progress.
    fn waker(&mut self) -> io::Result<Waker>;

    /// Start delivering terminal-resize notifications into the event stream.
    fn watch_resize(&mut self) -> io::Result<()>;

    /// The terminal's current size, in cells and — where the platform reports it —
    /// in pixels.
    fn size(&self) -> io::Result<WindowSize>;

    /// Whether mouse positions arrive in pixels rather than quantised to a cell.
    fn reports_pixel_mouse(&self) -> bool;

    /// Whether `draw` inlines the frame in the output stream, as opposed to handing
    /// over a file or a shared-memory name.
    fn frames_are_inline(&self) -> bool;

    /// Drop the cached cell size, so the next `cell_size` measures again. Called after
    /// anything that could have changed the font.
    fn forget_cell_size(&mut self);

    /// The size of one character cell in pixels, if the terminal will say.
    fn cell_size(&mut self) -> io::Result<Option<(u32, u32)>>;

    /// Ask for the palette and wait for the answer.
    fn query_colors(&mut self) -> io::Result<TerminalColors>;

    /// Ask for the palette without waiting; the answer arrives as `Event::Colors`.
    fn request_colors(&mut self) -> io::Result<()>;

    /// Set the mouse cursor shape over the pane.
    fn set_pointer_shape(&mut self, shape: &str) -> io::Result<()>;

    /// Put text on the system clipboard.
    fn set_clipboard(&mut self, text: &str) -> io::Result<()>;

    /// Ask for the clipboard's text. The answer arrives as `Event::Paste`.
    fn request_clipboard(&mut self) -> io::Result<()>;

    /// Whether the terminal can hand over typed clipboard data, not just plain text.
    fn clipboard_data_supported(&self) -> bool;

    /// Ask which mime types the clipboard holds. The answer arrives as an
    /// `Event::ClipboardData` whose `"."` item lists them, which is how
    /// `engine/clipboard.rs`'s `OscPasteStage::Types` reads it.
    fn request_clipboard_types(&mut self) -> io::Result<()>;

    /// Ask for the clipboard's contents in a given mime type. The answer arrives as
    /// `Event::ClipboardData`.
    fn request_clipboard_data(&mut self, mime: &str) -> io::Result<()>;
}

// One impl, both platforms. Each body forwards to the inherent method of the same
// name — inherent methods win method resolution over trait methods, so this delegates
// rather than recursing, and `windows_backend_reports_unimplemented_through_the_trait`
// in `terminal_windows.rs` calls through the trait to prove it.
impl TerminalBackend for Terminal {
    fn new(wrapper: Wrapper, env: SessionEnv) -> io::Result<Self> {
        Terminal::new(wrapper, env)
    }

    fn open(tty_path: &str, wrapper: Wrapper, env: SessionEnv) -> io::Result<Self> {
        Terminal::open(tty_path, wrapper, env)
    }

    fn reports_color_scheme(&self) -> bool {
        Terminal::reports_color_scheme(self)
    }

    fn relayed(&self) -> bool {
        Terminal::relayed(self)
    }

    fn kitty_keyboard(&self) -> bool {
        Terminal::kitty_keyboard(self)
    }

    fn set_key_event_types(&mut self, enabled: bool) -> io::Result<()> {
        Terminal::set_key_event_types(self, enabled)
    }

    fn draw(&mut self, canvas: &Canvas) -> io::Result<usize> {
        Terminal::draw(self, canvas)
    }

    fn read_event(&mut self) -> io::Result<Event> {
        Terminal::read_event(self)
    }

    fn poll_event(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        Terminal::poll_event(self, timeout)
    }

    fn waker(&mut self) -> io::Result<Waker> {
        Terminal::waker(self)
    }

    fn watch_resize(&mut self) -> io::Result<()> {
        Terminal::watch_resize(self)
    }

    fn size(&self) -> io::Result<WindowSize> {
        Terminal::size(self)
    }

    fn reports_pixel_mouse(&self) -> bool {
        Terminal::reports_pixel_mouse(self)
    }

    fn frames_are_inline(&self) -> bool {
        Terminal::frames_are_inline(self)
    }

    fn forget_cell_size(&mut self) {
        Terminal::forget_cell_size(self)
    }

    fn cell_size(&mut self) -> io::Result<Option<(u32, u32)>> {
        Terminal::cell_size(self)
    }

    fn query_colors(&mut self) -> io::Result<TerminalColors> {
        Terminal::query_colors(self)
    }

    fn request_colors(&mut self) -> io::Result<()> {
        Terminal::request_colors(self)
    }

    fn set_pointer_shape(&mut self, shape: &str) -> io::Result<()> {
        Terminal::set_pointer_shape(self, shape)
    }

    fn set_clipboard(&mut self, text: &str) -> io::Result<()> {
        Terminal::set_clipboard(self, text)
    }

    fn request_clipboard(&mut self) -> io::Result<()> {
        Terminal::request_clipboard(self)
    }

    fn clipboard_data_supported(&self) -> bool {
        Terminal::clipboard_data_supported(self)
    }

    fn request_clipboard_types(&mut self) -> io::Result<()> {
        Terminal::request_clipboard_types(self)
    }

    fn request_clipboard_data(&mut self, mime: &str) -> io::Result<()> {
        Terminal::request_clipboard_data(self, mime)
    }
}

#[cfg(test)]
mod tests {
    //! The contract, exercised against a fake backend.
    //!
    //! A fake is the right instrument here: the properties under test — that events
    //! come out one at a time in arrival order, that raw mode is entered exactly once
    //! and left exactly once, that a clipboard read is a request followed by a later
    //! event — are properties of the *seam*, not of any one platform's syscalls. The
    //! real backends are tested where they touch the OS (`tty_tests` on unix, Task 5
    //! on Windows); this is what both of them have to agree on.

    use super::*;
    use crate::terminal::{Key, KeyEvent, Mouse, MouseButton, MouseKind};
    use std::cell::RefCell;
    use std::rc::Rc;

    /// What the fake did, in the order it did it. Log with the test so it outlives
    /// the backend and can be inspected after the drop that restores raw mode.
    type Log = Rc<RefCell<Vec<String>>>;

    struct FakeBackend {
        log: Log,
        /// Events the terminal will hand over, oldest first.
        inbox: Vec<Event>,
        size: WindowSize,
        cell: Option<(u32, u32)>,
        cell_measurements: usize,
        clipboard_data: bool,
        colors: TerminalColors,
    }

    /// Queued answers for the next `FakeBackend::new`, so a test can make construction
    /// fail without a separate constructor.
    thread_local! {
        static NEXT_NEW_FAILS: RefCell<bool> = const { RefCell::new(false) };
        static LOG: RefCell<Log> = RefCell::new(Rc::new(RefCell::new(Vec::new())));
    }

    fn log_handle() -> Log {
        LOG.with(|l| l.borrow().clone())
    }

    fn fresh_log() -> Log {
        let handle: Log = Rc::new(RefCell::new(Vec::new()));
        LOG.with(|l| *l.borrow_mut() = handle.clone());
        handle
    }

    fn record(log: &Log, what: impl Into<String>) {
        log.borrow_mut().push(what.into());
    }

    impl FakeBackend {
        fn with_events(events: Vec<Event>) -> Self {
            let mut fake = Self::built();
            fake.inbox = events;
            fake
        }

        fn built() -> Self {
            <Self as TerminalBackend>::new(Wrapper::named(None), SessionEnv::of_process())
                .expect("the fake enters raw mode without touching the OS")
        }
    }

    impl Drop for FakeBackend {
        fn drop(&mut self) {
            record(&self.log, "leave-raw-mode");
        }
    }

    impl TerminalBackend for FakeBackend {
        fn new(wrapper: Wrapper, _env: SessionEnv) -> io::Result<Self> {
            if NEXT_NEW_FAILS.with(|f| std::mem::replace(&mut *f.borrow_mut(), false)) {
                // The contract: a construction that fails leaves nothing to restore,
                // so it must not have entered raw mode.
                return Err(io::Error::new(io::ErrorKind::NotFound, "no terminal"));
            }
            let log = log_handle();
            record(&log, "enter-raw-mode");
            let _ = wrapper;
            Ok(Self {
                log,
                inbox: Vec::new(),
                size: WindowSize {
                    cols: 80,
                    rows: 24,
                    width_px: 640,
                    height_px: 384,
                },
                cell: None,
                cell_measurements: 0,
                clipboard_data: true,
                colors: TerminalColors::default(),
            })
        }

        fn open(_tty_path: &str, wrapper: Wrapper, env: SessionEnv) -> io::Result<Self> {
            <Self as TerminalBackend>::new(wrapper, env)
        }

        fn reports_color_scheme(&self) -> bool {
            true
        }

        fn relayed(&self) -> bool {
            false
        }

        fn kitty_keyboard(&self) -> bool {
            true
        }

        fn set_key_event_types(&mut self, enabled: bool) -> io::Result<()> {
            record(&self.log, format!("key-event-types={enabled}"));
            Ok(())
        }

        fn draw(&mut self, canvas: &Canvas) -> io::Result<usize> {
            let bytes = (canvas.width * canvas.height) as usize;
            record(&self.log, format!("draw={bytes}"));
            Ok(bytes)
        }

        fn read_event(&mut self) -> io::Result<Event> {
            // Exactly upstream's relationship between the two: block, and treat "no
            // event" as end of input.
            match self.poll_event(None)? {
                Some(event) => Ok(event),
                None => Err(io::ErrorKind::UnexpectedEof.into()),
            }
        }

        fn poll_event(&mut self, _timeout: Option<Duration>) -> io::Result<Option<Event>> {
            if self.inbox.is_empty() {
                return Ok(None);
            }
            Ok(Some(self.inbox.remove(0)))
        }

        fn waker(&mut self) -> io::Result<Waker> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "fake has no waker",
            ))
        }

        fn watch_resize(&mut self) -> io::Result<()> {
            record(&self.log, "watch-resize");
            Ok(())
        }

        fn size(&self) -> io::Result<WindowSize> {
            Ok(self.size)
        }

        fn reports_pixel_mouse(&self) -> bool {
            false
        }

        fn frames_are_inline(&self) -> bool {
            true
        }

        fn forget_cell_size(&mut self) {
            self.cell = None;
        }

        fn cell_size(&mut self) -> io::Result<Option<(u32, u32)>> {
            if self.cell.is_none() {
                self.cell_measurements += 1;
                self.cell = self.size.cell_size();
            }
            Ok(self.cell)
        }

        fn query_colors(&mut self) -> io::Result<TerminalColors> {
            record(&self.log, "query-colors");
            Ok(self.colors)
        }

        fn request_colors(&mut self) -> io::Result<()> {
            record(&self.log, "request-colors");
            self.inbox.push(Event::Colors(self.colors));
            Ok(())
        }

        fn set_pointer_shape(&mut self, shape: &str) -> io::Result<()> {
            record(&self.log, format!("pointer={shape}"));
            Ok(())
        }

        fn set_clipboard(&mut self, text: &str) -> io::Result<()> {
            record(&self.log, format!("set-clipboard={text}"));
            Ok(())
        }

        fn request_clipboard(&mut self) -> io::Result<()> {
            record(&self.log, "request-clipboard");
            self.inbox.push(Event::Paste("from-clipboard".into()));
            Ok(())
        }

        fn clipboard_data_supported(&self) -> bool {
            self.clipboard_data
        }

        fn request_clipboard_types(&mut self) -> io::Result<()> {
            record(&self.log, "request-clipboard-types");
            self.inbox.push(Event::ClipboardData {
                items: vec![(".".to_string(), b"text/plain text/html".to_vec())],
                ok: true,
            });
            Ok(())
        }

        fn request_clipboard_data(&mut self, mime: &str) -> io::Result<()> {
            record(&self.log, format!("request-clipboard-data={mime}"));
            self.inbox.push(Event::ClipboardData {
                items: vec![(mime.to_string(), b"<p>hi</p>".to_vec())],
                ok: true,
            });
            Ok(())
        }
    }

    fn key(k: Key) -> Event {
        Event::Key(KeyEvent::plain(k))
    }

    #[test]
    fn events_come_out_one_at_a_time_in_arrival_order() {
        fresh_log();
        let mut term = FakeBackend::with_events(vec![
            key(Key::Char('a')),
            Event::Mouse(Mouse {
                kind: MouseKind::Down,
                button: MouseButton::Left,
                mods: Default::default(),
                x: 3,
                y: 4,
            }),
            key(Key::Char('b')),
        ]);

        // One call, one event: a caller draining input can interleave its own work.
        assert_eq!(term.poll_event(None).unwrap(), Some(key(Key::Char('a'))));
        assert!(matches!(
            term.poll_event(None).unwrap(),
            Some(Event::Mouse(_))
        ));
        assert_eq!(term.poll_event(None).unwrap(), Some(key(Key::Char('b'))));
        assert_eq!(term.poll_event(None).unwrap(), None, "drained");
    }

    #[test]
    fn read_event_is_poll_event_that_treats_no_event_as_eof() {
        fresh_log();
        let mut term = FakeBackend::with_events(vec![key(Key::Char('z'))]);
        assert_eq!(term.read_event().unwrap(), key(Key::Char('z')));
        assert_eq!(
            term.read_event().unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof,
        );
    }

    #[test]
    fn raw_mode_is_entered_on_construction_and_left_exactly_once_on_drop() {
        let log = fresh_log();
        {
            let mut term = FakeBackend::built();
            term.watch_resize().unwrap();
            assert_eq!(
                log.borrow().as_slice(),
                ["enter-raw-mode", "watch-resize"],
                "nothing restores the terminal while the backend is alive",
            );
        }
        assert_eq!(
            log.borrow().as_slice(),
            ["enter-raw-mode", "watch-resize", "leave-raw-mode"],
            "drop restores the terminal, exactly once",
        );
    }

    #[test]
    fn a_failed_construction_never_entered_raw_mode() {
        let log = fresh_log();
        NEXT_NEW_FAILS.with(|f| *f.borrow_mut() = true);
        let err = match <FakeBackend as TerminalBackend>::new(
            Wrapper::named(None),
            SessionEnv::of_process(),
        ) {
            Err(err) => err,
            Ok(_) => panic!("construction was primed to fail"),
        };
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(
            log.borrow().is_empty(),
            "a backend that failed to construct has nothing to restore, and must not \
             have logged an enter it will never pair with a leave",
        );
    }

    #[test]
    fn size_is_reported_in_cells_and_pixels_and_cell_size_is_cached() {
        fresh_log();
        let mut term = FakeBackend::built();

        let size = term.size().unwrap();
        assert_eq!((size.cols, size.rows), (80, 24));
        assert_eq!((size.width_px, size.height_px), (640, 384));

        assert_eq!(term.cell_size().unwrap(), Some((8, 16)));
        assert_eq!(term.cell_size().unwrap(), Some((8, 16)));
        assert_eq!(term.cell_measurements, 1, "the second call used the cache");

        // The reason `forget_cell_size` exists: after a font change the cache is a lie.
        term.forget_cell_size();
        assert_eq!(term.cell_size().unwrap(), Some((8, 16)));
        assert_eq!(term.cell_measurements, 2, "forgetting forces a re-measure");
    }

    #[test]
    fn clipboard_reads_are_a_request_answered_by_a_later_event() {
        let log = fresh_log();
        let mut term = FakeBackend::built();
        assert!(term.clipboard_data_supported());

        // Text: request returns immediately, the answer arrives out of the event stream.
        term.request_clipboard().unwrap();
        assert_eq!(
            term.poll_event(None).unwrap(),
            Some(Event::Paste("from-clipboard".into())),
        );

        // Typed data: types first, then the bytes for a chosen type. This is the exact
        // sequence `engine/clipboard.rs` drives through `&mut Terminal`.
        term.request_clipboard_types().unwrap();
        let offered = match term.poll_event(None).unwrap() {
            Some(Event::ClipboardData { items, ok: true }) => items
                .iter()
                .find(|(mime, _)| mime == ".")
                .map(|(_, data)| String::from_utf8_lossy(data).into_owned())
                .expect("the type list arrives under the \".\" mime"),
            other => panic!("expected clipboard types, got {other:?}"),
        };
        assert!(offered.split_whitespace().any(|m| m == "text/html"));

        term.request_clipboard_data("text/html").unwrap();
        match term.poll_event(None).unwrap() {
            Some(Event::ClipboardData { items, ok }) => {
                assert!(ok);
                assert_eq!(
                    items,
                    vec![("text/html".to_string(), b"<p>hi</p>".to_vec())]
                );
            }
            other => panic!("expected clipboard data, got {other:?}"),
        }

        // A write is not a request and produces no event.
        term.set_clipboard("outgoing").unwrap();
        assert_eq!(term.poll_event(None).unwrap(), None);

        assert_eq!(
            log.borrow().as_slice(),
            [
                "enter-raw-mode",
                "request-clipboard",
                "request-clipboard-types",
                "request-clipboard-data=text/html",
                "set-clipboard=outgoing",
            ],
        );
    }

    #[test]
    fn colors_can_be_asked_for_synchronously_or_answered_by_an_event() {
        fresh_log();
        let mut term = FakeBackend::built();
        assert!(term.reports_color_scheme());

        let synchronous = term.query_colors().unwrap();

        term.request_colors().unwrap();
        match term.poll_event(None).unwrap() {
            Some(Event::Colors(colors)) => assert_eq!(colors.foreground, synchronous.foreground),
            other => panic!("expected colors, got {other:?}"),
        }
    }

    #[test]
    fn capability_getters_answer_without_touching_the_terminal() {
        let log = fresh_log();
        let term = FakeBackend::built();

        assert!(!term.relayed());
        assert!(term.kitty_keyboard());
        assert!(!term.reports_pixel_mouse());
        assert!(term.frames_are_inline());
        assert!(term.clipboard_data_supported());
        assert!(term.reports_color_scheme());

        assert_eq!(
            log.borrow().as_slice(),
            ["enter-raw-mode"],
            "consulting a capability must be cheap enough to do every frame",
        );
    }

    #[test]
    fn draw_reports_the_bytes_it_wrote() {
        fresh_log();
        let mut term = FakeBackend::built();
        let canvas = Canvas::new(4, 3);
        assert_eq!(term.draw(&canvas).unwrap(), 12);
    }
}
