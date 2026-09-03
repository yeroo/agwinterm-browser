// The agwinterm control-pipe client: the output half's transport, and the only
// source of pane geometry there is. Windows-only because a named pipe is, and
// because the unix build reaches its host through `herdr` instead.
#[cfg(windows)]
mod agwinterm;
mod canvas;
pub mod clipboard_image;
mod desc;
mod engine;
// The file-based frame path: a canvas to a PNG on disk, and the `image.frame`
// request that points agwinterm at it. Windows-only for the same reason
// `agwinterm` is - it is the output half of the port, where unix has `herdr` and
// the Kitty escapes.
#[cfg(windows)]
mod frame_file;
// The fast frame path: the `image.frameshm` mapping layout, the mapping, and the
// producer that fills a slot per frame — plus which transport carries a frame, and
// how a host without the fast one announces itself. Windows-only alongside
// `frame_file`, for the same reason; the layout half compiles everywhere.
#[cfg(windows)]
mod frame_shm;
#[cfg(unix)]
pub mod ghostty;
// A second host protocol, and permanently disabled on Windows rather than pending.
// `herdr` is not a transport for the agwinterm path — it is a different host, found
// through `HERDR_SOCKET_PATH` and negotiated with `pane.graphics.info`, which must
// answer `file_frame_transport: "direct-kitty"` before the module will speak to it
// (`herdr.rs:56`). Kitty escapes are exactly what ConPTY strips, so a Windows port
// of the transport would produce a client that connects and then cannot draw. The
// host does not run on Windows either. Recorded in `docs/design/05-cli-and-endpoints.md`.
#[cfg(unix)]
mod herdr;
mod image_cache;
// Kitty-escape emitters. Their only caller was the tty backend in `terminal`, which
// is gated out on Windows, so the whole module reads as dead there. The agwinterm
// frame path (`frame_file`, `frame_shm`) reuses nothing from it.
#[cfg_attr(windows, allow(dead_code))]
mod kitty;
pub mod logging;
mod menu;
mod native;
mod paint;
pub(crate) mod parallel;
pub mod profiler;
mod shape;
mod scroll;
mod scrollbar;
mod selection;
mod style;
pub mod surfaces;
// The VT decoder inside `terminal` stays unconditional on purpose: 659 lines of
// portable parsing with 27 tests, which the Windows console backend feeds rather
// than writing a second one. Since Task 5 it has a caller on both platforms, so
// the dead-code suppression this declaration used to carry is gone.
mod terminal;
mod terminal_backend;
mod terminal_types;
#[cfg(windows)]
mod terminal_windows;
mod text_input;
mod throttle;
pub mod wrapper;
mod tree;
mod wrap;

pub use canvas::{Canvas, measure_text};
pub use desc::Desc;
pub use engine::{
    ChangeSource, DragPhase, Engine, EngineConfig, EngineEvent, FrameStats, HighlightArea, MarkRef,
    px_for_cell_height,
};
pub use kitty::kitty_transmit;
pub use logging::{LogEntry, LogLevel};
pub use menu::{CONTEXT_MENU_KEY, MenuEntry, MenuItem, MenuStyle, context_menu};
pub use native::{NativeEvent, NativeScroll};
pub use terminal::SessionEnv;
pub use paint::paint;
pub use profiler::{CounterRecord, ProfileData, Profiler, SpanRecord};
pub use shape::{LineCap, LineJoin, PathCmd, ShapeProps, ShapeStroke, build_path, parse_path_data, skia_stroke};
pub use scroll::profiles::{Glide, Smooth, Tui};
pub use scroll::{ScrollProfile, ScrollState};
pub use scrollbar::ScrollbarRects;
pub use selection::{DocPos, DocSelection};
pub use style::{
    Align, Border, BorderSide, Color, Dimension, Edges, FlexDirection, Inset, InsetValue, Justify,
    Overflow, Position, ScrollbarStyle, SelectionMode, Style,
};
pub use terminal::{
    Event, Key, KeyEvent, KeyKind, Mods, Mouse, MouseButton, MouseKind, Terminal, TerminalColors,
    Waker, WindowSize,
};
pub use terminal_backend::TerminalBackend;
pub use text_input::{
    Granularity, InputAction, InputGeometry, InputReply, MARK_CHAR, Mark, TextInput, line_height,
    offset_to_point, point_to_offset,
};
pub use throttle::CpuThrottle;
pub use tree::{
    BoxMetrics, Gutter, HitTarget, ImageProps, InputProps, NodeId, Props, PxRect, ScrollArea,
    SlotKind, TextSpan, Tree,
};
pub use wrap::{line_of_offset, wrap_lines};

pub use fontdue;
