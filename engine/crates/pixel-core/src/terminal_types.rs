//! The crate's terminal type vocabulary, kept apart from the tty backend.
//!
//! These types are imported by eleven modules that never touch a tty — the engine,
//! the menu, the native-event bridge, the text input — and `lib.rs` re-exports them
//! at the crate root. `terminal` re-exports every one of them, so those importers
//! and the crate root are unaffected by this split.
//!
//! The split exists so the tty backend in `terminal` can be `#[cfg(unix)]`-gated
//! without carrying the vocabulary out of reach on Windows.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Key(KeyEvent),
    Mouse(Mouse),
    Paste(String),
    Focus(bool),
    WindowSize(WindowSize),
    ClipboardData {
        items: Vec<(String, Vec<u8>)>,
        ok: bool,
    },
    ColorSchemeChanged,
    Colors(TerminalColors),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEvent {
    pub key: Key,
    pub mods: Mods,
    pub kind: KeyKind,
    pub text: Option<String>,
}

impl KeyEvent {
    pub(crate) fn plain(key: Key) -> Self {
        let text = match key {
            Key::Char(c) => Some(c.to_string()),
            _ => None,
        };
        Self {
            key,
            mods: Mods::default(),
            kind: KeyKind::Press,
            text,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KeyKind {
    #[default]
    Press,
    Repeat,
    Release,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods {
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
    pub sup: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    Insert,
    PageUp,
    PageDown,
    Function(u8),
    LeftShift,
    LeftControl,
    LeftAlt,
    LeftSuper,
    RightShift,
    RightControl,
    RightAlt,
    RightSuper,
    Enter,
    Backspace,
    Delete,
    Escape,
    Tab,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mouse {
    pub kind: MouseKind,
    pub button: MouseButton,
    pub mods: Mods,
    pub x: u32,
    pub y: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseKind {
    Down,
    Up,
    Move,
    ScrollUp,
    ScrollDown,
    ScrollLeft,
    ScrollRight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    None,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TerminalColors {
    pub foreground: Option<[u8; 4]>,
    pub background: Option<[u8; 4]>,
    pub palette: [Option<[u8; 4]>; 16],
}

impl TerminalColors {
    pub(crate) fn set(&mut self, slot: ColorSlot, rgba: [u8; 4]) {
        match slot {
            ColorSlot::Foreground => self.foreground = Some(rgba),
            ColorSlot::Background => self.background = Some(rgba),
            ColorSlot::Palette(i) => self.palette[i as usize] = Some(rgba),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorSlot {
    Foreground,
    Background,
    Palette(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowSize {
    pub cols: u32,
    pub rows: u32,
    pub width_px: u32,
    pub height_px: u32,
}

impl WindowSize {
    // fixme: why is this an option? if this is not an invariant, we should define the terminals this is the case for
    pub fn cell_size(&self) -> Option<(u32, u32)> {
        if self.cols > 0 && self.rows > 0 && self.width_px > 0 && self.height_px > 0 {
            Some((self.width_px / self.cols, self.height_px / self.rows))
        } else {
            None
        }
    }
}

// Constructed by the terminal backend, and the one type in this vocabulary whose
// *body* is platform-specific: waking a blocked read is the thing the two platforms
// do least alike. The name and the `wake()` signature are what the eleven importers
// and `lib.rs`'s crate-root `pub use` depend on, and those are shared.
//
// On unix the payload is the write end of the tty backend's self-pipe, which
// `poll(2)` is already watching. On Windows there is no descriptor to poll: the
// console reader is a thread filling `terminal_windows::Inbox`, so waking is a
// flag on that inbox and a `Condvar` notify. Both are cheap, both are safe to call
// from another thread, and neither can fail — hence the `let _ =`/no-result shape
// the callers were already written against.
#[derive(Clone)]
pub struct Waker {
    #[cfg(unix)]
    pub(crate) fd: std::sync::Arc<rustix::fd::OwnedFd>,
    #[cfg(windows)]
    pub(crate) inbox: std::sync::Arc<crate::terminal_windows::Inbox>,
}

impl Waker {
    pub fn wake(&self) {
        #[cfg(unix)]
        let _ = rustix::io::write(&*self.fd, &[1]);
        #[cfg(windows)]
        self.inbox.wake();
    }
}

#[derive(Clone, Debug, Default)]
pub struct SessionEnv {
    session: Option<std::collections::HashMap<String, String>>,
}

impl SessionEnv {
    pub fn of_session(env: std::collections::HashMap<String, String>) -> Self {
        Self { session: Some(env) }
    }

    pub fn of_process() -> Self {
        Self { session: None }
    }

    pub(crate) fn var(&self, key: &str) -> Option<String> {
        match &self.session {
            Some(env) => env.get(key).cloned(),
            None => std::env::var(key).ok(),
        }
    }
}

#[cfg(test)]
mod tests {
    //! The split is only safe if every path that named these types before still
    //! names them. These tests are compile-level: they exercise the three ways the
    //! crate reaches the vocabulary — through `terminal`'s re-export, through the
    //! crate root, and through this module — and fail the build, not an assertion,
    //! if a path stops resolving.

    use super::*;

    /// Every name `terminal.rs` used to define, still reachable as `crate::terminal::_`.
    /// This is the shim the eleven keep-unchanged importers depend on.
    #[allow(unused_imports)]
    mod via_terminal {
        pub use crate::terminal::{
            ColorSlot, Event, Key, KeyEvent, KeyKind, Mods, Mouse, MouseButton, MouseKind,
            SessionEnv, TerminalColors, Waker, WindowSize,
        };
    }

    /// The crate root's `pub use`, which is what `pixel-react` and `pixel-node` see.
    /// `SessionEnv` is re-exported separately from the rest in `lib.rs`, so it is
    /// named separately here.
    #[allow(unused_imports)]
    mod via_crate_root {
        pub use crate::SessionEnv;
        pub use crate::{
            Event, Key, KeyEvent, KeyKind, Mods, Mouse, MouseButton, MouseKind, TerminalColors,
            Waker, WindowSize,
        };
    }

    /// The exact `use` lines of the eleven modules that import the vocabulary, so a
    /// path that only they name cannot rot unnoticed.
    #[allow(unused_imports, dead_code)]
    mod as_the_importers_name_them {
        // engine/{clipboard,doc,embed,input,keys,mod,pointer,scroll}.rs, menu.rs,
        // native.rs, text_input.rs — the union of what they reach for.
        use crate::terminal::{
            ColorSlot, Event, Key, KeyEvent, KeyKind, Mods, Mouse, MouseButton, MouseKind,
            SessionEnv, TerminalColors, WindowSize,
        };

        // text_input.rs's tests name these two directly (`crate::terminal::Mods`,
        // `crate::terminal::KeyKind`); they are the narrowest importer and the one
        // most likely to break silently.
        fn _text_input_test_paths(m: crate::terminal::Mods, k: crate::terminal::KeyKind) {
            let _ = (m, k);
        }

        /// Every moved type, named in a type position through the shim.
        type Vocabulary = (
            Event,
            KeyEvent,
            KeyKind,
            Mods,
            Key,
            Mouse,
            MouseKind,
            MouseButton,
            TerminalColors,
            ColorSlot,
            WindowSize,
            SessionEnv,
        );

        fn _named_in_signatures(_v: Vocabulary) {}
    }

    /// The re-export is an alias, not a copy: a value built through one path must be
    /// usable through another. A duplicate definition would fail to compile here.
    #[test]
    fn re_exported_paths_are_the_same_types() {
        let key: crate::terminal::KeyEvent = KeyEvent::plain(Key::Char('a'));
        let via_root: crate::KeyEvent = key.clone();
        let via_module: super::KeyEvent = via_root.clone();
        assert_eq!(key, via_module);

        let event: crate::terminal::Event = Event::Key(key);
        let _: crate::Event = event;

        let size: crate::WindowSize = WindowSize {
            cols: 80,
            rows: 24,
            width_px: 640,
            height_px: 480,
        };
        let _: crate::terminal::WindowSize = size;
    }

    #[test]
    fn key_event_plain_carries_text_for_chars_only() {
        assert_eq!(KeyEvent::plain(Key::Char('x')).text.as_deref(), Some("x"));
        assert_eq!(KeyEvent::plain(Key::Escape).text, None);
        assert_eq!(KeyEvent::plain(Key::Enter).kind, KeyKind::Press);
        assert_eq!(KeyEvent::plain(Key::Enter).mods, Mods::default());
    }

    #[test]
    fn terminal_colors_set_routes_each_slot() {
        let mut colors = TerminalColors::default();
        colors.set(ColorSlot::Foreground, [1, 2, 3, 4]);
        colors.set(ColorSlot::Background, [5, 6, 7, 8]);
        colors.set(ColorSlot::Palette(15), [9, 10, 11, 12]);
        assert_eq!(colors.foreground, Some([1, 2, 3, 4]));
        assert_eq!(colors.background, Some([5, 6, 7, 8]));
        assert_eq!(colors.palette[15], Some([9, 10, 11, 12]));
        assert_eq!(colors.palette[0], None);
    }

    #[test]
    fn window_size_cell_size_needs_every_dimension() {
        let full = WindowSize {
            cols: 80,
            rows: 24,
            width_px: 640,
            height_px: 480,
        };
        assert_eq!(full.cell_size(), Some((8, 20)));
        for zeroed in [
            WindowSize { cols: 0, ..full },
            WindowSize { rows: 0, ..full },
            WindowSize {
                width_px: 0,
                ..full
            },
            WindowSize {
                height_px: 0,
                ..full
            },
        ] {
            assert_eq!(zeroed.cell_size(), None);
        }
    }

    #[test]
    fn session_env_reads_the_session_map_before_the_process() {
        let key = "PIXEL_TERMINAL_TYPES_TEST_VAR";
        let mut map = std::collections::HashMap::new();
        map.insert(key.to_string(), "from-session".to_string());
        // The process has its own value for the same key, which is what makes this
        // a test of precedence rather than of lookup. Without it both sides answer
        // "from-session" and "before the process" is never exercised.
        //
        // SAFETY: `set_var` is unsound only against a concurrent *reader* of the
        // environment in another thread. This key is unique to this test, and the
        // value is removed before the test returns.
        // SAFETY: see above.
        #[allow(unsafe_code)]
        unsafe {
            std::env::set_var(key, "from-process")
        };
        assert_eq!(
            SessionEnv::of_process().var(key),
            Some("from-process".to_string()),
            "the process shape must read the process",
        );
        assert_eq!(
            SessionEnv::of_session(map).var(key),
            Some("from-session".to_string()),
            "the session map must win over the process it is running in",
        );
        // SAFETY: the same key, in the same single-threaded test, put back.
        #[allow(unsafe_code)]
        unsafe {
            std::env::remove_var(key)
        };
        // An absent key is None rather than an error, in both shapes.
        assert_eq!(SessionEnv::of_session(Default::default()).var(key), None);
        assert_eq!(SessionEnv::of_process().var(key), None);
    }
}
