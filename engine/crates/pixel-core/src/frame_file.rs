//! The file-based frame path: how a composited canvas reaches an agwinterm pane.
//!
//! This is the output half of the port. There is no Kitty escape route on Windows
//! — ConPTY strips the APC sequences upstream writes to stdout — so a frame is
//! written to a file and the host is *told* about it over the control pipe
//! ([`crate::agwinterm`]), with the `image.frame` verb agwinterm already ships
//! (`ControlServer.cs:426`). One request per frame, one image in it, placed at the
//! pane's origin and spanning the whole pane.
//!
//! It is deliberately the plain path: PNG on disk, one round trip, no shared
//! memory. Task 12 adds `image.frameshm` on top, and **this path stays** — as the
//! fallback for a host that lacks the verb, and as the baseline the fast path is
//! diffed against. So the two must produce the same picture from the same canvas;
//! everything picture-shaped lives in [`cell_span`] and [`encode_png`], which the
//! shm path reuses rather than reimplements.
//!
//! ## Why every frame gets its own path
//!
//! The obvious design — one file, rewritten per frame — is broken here, and the
//! two ways it breaks are independent.
//!
//! **The read races the write.** `HandleImageFrame`'s phase 1 does
//! `File.ReadAllBytes(path)` synchronously, off the render lock, while a
//! free-running producer is already writing the next frame into that same path.
//! The read either hits a sharing violation — swallowed by the bare
//! `catch { data = null; }` at `ControlServer.cs:458`, which silently re-places the
//! *stale* image — or returns a truncated PNG that the decoder then rejects. Both
//! present as "the browser stopped updating", with nothing in any log.
//!
//! **The staleness check is not a content check.** `ContentSignature`
//! (`ControlServer.cs:487-496`) is `mtime ^ (length << 1) ^ hash(path)` and never
//! reads a byte. Rotating image ids to exploit it — the "reuse the id so the host
//! caches" idea — buys nothing, because every browser frame differs and the cache
//! therefore never skips. Worse, it *loses*: two consecutive frames of the same
//! PNG length written within the filesystem's timestamp granularity produce the
//! same signature at the same path, and the second is silently dropped.
//!
//! A fresh path per frame fixes both at once. The path is part of the signature,
//! so consecutive frames can never collide however fast they arrive; and the host
//! only learns a path *after* its bytes are complete and the file is closed, so
//! there is nothing to race. The image **id** stays fixed at [`FRAME_IMAGE_ID`]
//! for the opposite reason: it is what keeps the emulator's image table at one
//! entry instead of growing by one per frame.
//!
//! ## The churn that buys
//!
//! One file per frame is a lot of files, so they are reaped: [`RETAINED`] frames
//! stay (the current one, plus enough history that the client's one reconnect
//! replay still finds its file), the rest are deleted as the next frame goes out.
//! [`FrameDir`] removes the whole directory on drop, and a fresh publisher sweeps
//! the leftovers of processes that died before they could — see [`sweep_stale`].

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use crate::agwinterm::{ControlClient, Reply, push_quoted};
use crate::canvas::Canvas;

/// The verb. Shipped agwinterm, no host change required — which is what makes this
/// the bring-up path rather than something that waits on the agwinterm plan.
pub(crate) const FRAME_CMD: &str = "image.frame";

/// The one image id this path ever transmits under.
///
/// Fixed, not rotated. Placement is replaced wholesale by every `image.frame`
/// (`em.ClearPlacements()`), so nothing is gained by a second id, and a rotating
/// one would leave the emulator holding a texture per frame.
const FRAME_IMAGE_ID: u32 = 1;

/// How many recent frame files survive. One is the frame in flight; the rest cover
/// [`ControlClient::request`]'s single replay, which re-sends the same path on a
/// fresh connection after the host dropped the first one.
const RETAINED: usize = 3;

/// Directories older than this belonged to a process that is gone. A live
/// publisher creates a file inside its directory every frame, which keeps the
/// directory's own timestamp fresh, so nothing in use is ever this old.
const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

/// Shared by every publisher's directory, so [`sweep_stale`] can recognise one.
const DIR_PREFIX: &str = "terminal-browser-frames-";

/// Names a file to append one line per frame to, breaking the cost down by stage.
///
/// Off unless set, and it names a path rather than being a boolean because the
/// consumer is a person reading a file afterwards, not the running browser. This
/// is what [`docs/design/02-frame-budget.md`] was measured with, and what Task 12
/// diffs `image.frameshm` against — a fast path with no baseline to beat is a
/// claim, not a measurement.
pub(crate) const BUDGET_ENV: &str = "TERMINAL_BROWSER_FRAME_BUDGET";

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// The pane is too small to place a frame into, or the canvas has no area.
///
/// Separated from the io errors because it is not a failure of anything — a pane
/// dragged down to nothing is a legitimate state, and the caller's response is to
/// skip the frame rather than to report a broken pipe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TooSmall;

impl From<TooSmall> for io::Error {
    fn from(_: TooSmall) -> Self {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "there is no room in the pane to place a frame",
        )
    }
}

/// How many cells the frame covers: `cols`/`rows` for the `image.frame` request.
///
/// agwinterm draws the placement into exactly `cols * cellWidth` by
/// `rows * cellHeight` pixels with `BitmapInterpolationMode.Linear`
/// (`Program.Render.cs:77-87`), so this number decides the picture's size on
/// screen and the resampling ratio — not its position, which is always the pane's
/// origin.
///
/// `cell` is the size the *engine* sized the canvas with (see
/// `crate::agwinterm::cell_size` on why there is only ever one such number), so in
/// the steady state the span comes out exactly equal to the pane. It is clamped to
/// the pane anyway: a resize that lands between the canvas being composited and
/// the frame being published would otherwise place an image that runs off the
/// bottom of the pane, and a frame squashed for one frame is the better of the two.
pub(crate) fn cell_span(
    canvas: (u32, u32),
    cell: (u32, u32),
    pane: Option<(u32, u32)>,
) -> Result<(u32, u32), TooSmall> {
    if canvas.0 == 0 || canvas.1 == 0 {
        return Err(TooSmall);
    }
    // `cell_size` never answers zero, but this is division and the cost of being
    // sure is one `max`.
    let (cw, ch) = (cell.0.max(1), cell.1.max(1));
    let mut span = (canvas.0.div_ceil(cw).max(1), canvas.1.div_ceil(ch).max(1));
    if let Some((cols, rows)) = pane {
        if cols == 0 || rows == 0 {
            return Err(TooSmall);
        }
        span = (span.0.min(cols), span.1.min(rows));
    }
    Ok(span)
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/// The canvas as a PNG, into a caller-owned buffer.
///
/// `CompressionType::Fast` with no filtering on purpose: this runs once per frame
/// inside the frame budget, and the file is read back by a process on the same
/// machine microseconds later. Bytes on disk are the cheap resource here; the
/// encode is not.
pub(crate) fn encode_png(canvas: &Canvas, out: &mut Vec<u8>) -> io::Result<()> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::{ExtendedColorType, ImageEncoder};

    out.clear();
    let expected = (canvas.width as usize) * (canvas.height as usize) * 4;
    if canvas.pixels.len() < expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "the canvas says {}x{} but carries {} bytes, not {expected}",
                canvas.width,
                canvas.height,
                canvas.pixels.len()
            ),
        ));
    }
    PngEncoder::new_with_quality(&mut *out, CompressionType::Fast, FilterType::NoFilter)
        .write_image(
            &canvas.pixels[..expected],
            canvas.width,
            canvas.height,
            ExtendedColorType::Rgba8,
        )
        .map_err(|err| io::Error::other(format!("encoding the frame as PNG failed: {err}")))
}

// ---------------------------------------------------------------------------
// Where the files go
// ---------------------------------------------------------------------------

/// A private directory under the temp dir, removed when the publisher goes.
struct FrameDir {
    path: PathBuf,
}

impl FrameDir {
    /// One per publisher. The pid keeps two browsers apart; the counter keeps two
    /// publishers inside one process apart, which is a thing tests do.
    fn create() -> io::Result<Self> {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);

        let root = std::env::temp_dir();
        sweep_stale(&root, STALE_AFTER);
        let path = root.join(format!(
            "{DIR_PREFIX}{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path)?;
        Ok(Self { path })
    }
}

impl Drop for FrameDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Removes the frame directories of processes that did not get to run their `Drop`.
///
/// By age, not by liveness: asking whether a pid is still alive is both racy (pids
/// are reused) and more Win32 than this needs. A directory in use gains a file
/// every frame, so its timestamp is never [`STALE_AFTER`] old. Every error is
/// ignored — a directory another live browser is holding open is exactly the case
/// where failing to delete it is correct.
///
/// `older_than` is a parameter rather than [`STALE_AFTER`] read directly so the
/// tests can drive both sides of the threshold in their own root, instead of
/// backdating a directory — which on Windows needs a handle a plain `File::open`
/// does not give.
fn sweep_stale(root: &Path, older_than: Duration) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(DIR_PREFIX) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|age| age >= older_than);
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

// ---------------------------------------------------------------------------
// The frame budget
// ---------------------------------------------------------------------------

/// What one frame cost, split by the stage that spent it.
///
/// The three stages are the three the browser can see. `publish` is the whole
/// `image.frame` round trip — agwinterm's `File.ReadAllBytes` plus its brief
/// placement lock plus the pipe — and the host's own PNG decode is *not* in it,
/// because that happens later on another thread (`Program.Render.cs:196`). Anyone
/// reading these numbers needs to know that, so [`FrameCost::line`] says it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct FrameCost {
    pub(crate) seq: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) cols: u32,
    pub(crate) rows: u32,
    pub(crate) bytes: usize,
    pub(crate) encode: Duration,
    pub(crate) write: Duration,
    pub(crate) publish: Duration,
}

impl FrameCost {
    /// One tab-separated line. Not JSON: the file is read by a person and by
    /// whatever one-liner they reach for, and every field is a number.
    fn line(&self) -> String {
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        format!(
            "{}\t{}x{}\t{}x{}\t{}\t{:.2}\t{:.2}\t{:.2}\n",
            self.seq,
            self.width,
            self.height,
            self.cols,
            self.rows,
            self.bytes,
            ms(self.encode),
            ms(self.write),
            ms(self.publish),
        )
    }

    /// The header, so the file explains itself without this source file.
    fn header() -> &'static str {
        "# seq\tcanvas\tspan\tbytes\tencode_ms\twrite_ms\tpublish_ms\n\
         # publish_ms is the image.frame round trip: agwinterm's read + its brief\n\
         # placement lock + the pipe. Its PNG decode is async and is not in here.\n"
    }
}

/// Appends [`FrameCost`]s to the file [`BUDGET_ENV`] named, if it named one.
///
/// A logging failure is dropped rather than reported: a measurement that could
/// break the thing being measured is worse than no measurement.
struct BudgetLog {
    file: Option<fs::File>,
}

impl BudgetLog {
    fn open(env: &crate::terminal::SessionEnv) -> Self {
        let Some(path) = env.var(BUDGET_ENV).filter(|path| !path.is_empty()) else {
            return Self { file: None };
        };
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        let mut log = Self { file };
        if let Some(file) = log.file.as_mut() {
            let _ = file.write_all(FrameCost::header().as_bytes());
        }
        log
    }

    fn record(&mut self, cost: &FrameCost) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.write_all(cost.line().as_bytes());
        }
    }
}

// ---------------------------------------------------------------------------
// The publisher
// ---------------------------------------------------------------------------

/// Writes frames to disk and points agwinterm at them.
///
/// Owns nothing about *when* to draw — the engine decides that — and nothing about
/// the pipe, which it borrows per frame. What it owns is the directory, the
/// sequence that makes paths unique, and the retention that stops them piling up.
pub(crate) struct FramePublisher {
    dir: FrameDir,
    /// Monotonic, and never rewound by a failed frame: a path that has been handed
    /// to the host must never be written to again.
    seq: u64,
    /// Reused across frames so the PNG encode does not allocate a fresh megabyte
    /// per frame.
    scratch: Vec<u8>,
    /// Most recent last. Anything past [`RETAINED`] is deleted.
    written: Vec<PathBuf>,
    /// Latched after the first frame the host declined to read, so a host that
    /// keeps declining is complained about once.
    warned_untransmitted: bool,
    /// Where the per-frame cost breakdown goes, when [`BUDGET_ENV`] asked for one.
    budget: BudgetLog,
}

impl FramePublisher {
    pub(crate) fn new(env: &crate::terminal::SessionEnv) -> io::Result<Self> {
        Ok(Self {
            dir: FrameDir::create()?,
            seq: 0,
            scratch: Vec::new(),
            written: Vec::new(),
            warned_untransmitted: false,
            budget: BudgetLog::open(env),
        })
    }

    /// Where this publisher's files live. Exposed for the tests that count them.
    #[cfg(test)]
    pub(crate) fn dir(&self) -> &Path {
        &self.dir.path
    }

    /// The path frame `seq` goes to.
    fn path_for(&self, seq: u64) -> PathBuf {
        self.dir.path.join(format!("frame-{seq:08}.png"))
    }

    /// The next path, which no frame has used and none will use again.
    fn next_path(&mut self) -> PathBuf {
        let path = self.path_for(self.seq);
        self.seq += 1;
        path
    }

    /// The path the *next* frame will take, without taking it.
    #[cfg(test)]
    pub(crate) fn peek_path(&self) -> PathBuf {
        self.path_for(self.seq)
    }

    /// Encodes, writes and publishes one frame. Returns the bytes written, which is
    /// what the frame budget is measured in.
    ///
    /// `span` is [`cell_span`]'s answer, passed in rather than computed here
    /// because the caller is the one holding the cell size and the pane size.
    pub(crate) fn publish(
        &mut self,
        client: &mut ControlClient,
        canvas: &Canvas,
        span: (u32, u32),
    ) -> io::Result<usize> {
        let mut scratch = std::mem::take(&mut self.scratch);
        let started = Instant::now();
        let encoded = crate::profiler::span("frame.png", || encode_png(canvas, &mut scratch));
        let mut cost = FrameCost {
            width: canvas.width,
            height: canvas.height,
            cols: span.0,
            rows: span.1,
            encode: started.elapsed(),
            ..FrameCost::default()
        };
        let result = encoded.and_then(|()| self.publish_encoded(client, &scratch, span, &mut cost));
        self.scratch = scratch;
        result
    }

    fn publish_encoded(
        &mut self,
        client: &mut ControlClient,
        png: &[u8],
        span: (u32, u32),
        cost: &mut FrameCost,
    ) -> io::Result<usize> {
        let path = self.next_path();
        cost.seq = self.seq - 1;
        cost.bytes = png.len();
        let started = Instant::now();
        crate::profiler::span("frame.write", || self.write_frame(&path, png))?;
        cost.write = started.elapsed();
        let started = Instant::now();
        // Only now does the host learn the path, and by now the bytes are all
        // there and the handle is closed.
        // A refusal counts as a failed frame exactly as a dead pipe does: in both
        // cases nothing is on screen, and the file is litter rather than history.
        // Reaping it through the retention list would keep it alive for three more
        // frames for no reason.
        match client
            .send(FRAME_CMD, Some(&frame_args(&path, span)))
            .and_then(Reply::result)
        {
            Ok(result) => {
                cost.publish = started.elapsed();
                self.budget.record(cost);
                self.written.push(path);
                self.reap();
                self.check_transmitted(result);
                Ok(png.len())
            }
            Err(err) => {
                let _ = fs::remove_file(&path);
                Err(err)
            }
        }
    }

    /// One frame to one file, recreating the directory if something removed it.
    ///
    /// The retry is worth having because the directory lives in the temp dir, which
    /// is swept by the OS, by cleaners, and by [`sweep_stale`] in another browser
    /// whose clock disagrees. Any other failure is reported and leaves the
    /// publisher usable: the sequence has already moved on, so the next frame picks
    /// a path of its own rather than retrying into a file that may be half-written.
    fn write_frame(&self, path: &Path, png: &[u8]) -> io::Result<()> {
        match write_all_new(path, png) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(&self.dir.path)?;
                write_all_new(path, png)
            }
            other => other,
        }
    }

    /// Deletes everything past [`RETAINED`].
    ///
    /// A file that will not delete is dropped from the list rather than retried
    /// forever; [`FrameDir`]'s `Drop` and [`sweep_stale`] are the backstop, so the
    /// worst case is a file that outlives the frame instead of one that outlives
    /// the process.
    fn reap(&mut self) {
        while self.written.len() > RETAINED {
            let path = self.written.remove(0);
            let _ = fs::remove_file(path);
        }
    }

    /// `image.frame` answers `frame:<placed>/<transmitted>`.
    ///
    /// Transmitted below placed means the host decided our bytes were the ones it
    /// already had, or could not read them — the two silent failures unique paths
    /// exist to prevent. If it ever happens the picture is frozen, so it is said
    /// out loud rather than inferred from a still screen.
    fn check_transmitted(&mut self, result: String) {
        let Some((placed, transmitted)) = frame_counts(&result) else {
            return;
        };
        if transmitted < placed && !self.warned_untransmitted {
            self.warned_untransmitted = true;
            crate::logging::warn(
                "agwinterm",
                format!(
                    "agwinterm placed {placed} image(s) but read {transmitted} of them \
                     ({result:?}): the pane is showing a stale frame. Every frame is \
                     written to a path of its own, so this means the file could not be \
                     read rather than that it looked unchanged"
                ),
            );
        }
    }
}

/// Creates the file, refusing to touch one that exists.
///
/// `create_new` rather than `create`: a path collision would mean the sequence
/// went backwards, and silently overwriting a file the host may be reading is the
/// exact failure this module is built to avoid. Better to fail the frame.
fn write_all_new(path: &Path, png: &[u8]) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(png)?;
    file.flush()
}

/// `{"images":[{…}]}` — the `args` of one `image.frame` request.
///
/// Hand-built for the same reason the client's envelope parser is: it runs once
/// per frame, and the path is the only part that needs escaping (Windows paths are
/// full of backslashes, which JSON spells `\\`).
fn frame_args(path: &Path, span: (u32, u32)) -> String {
    let mut args = String::from("{\"images\":[{\"id\":");
    args.push_str(&FRAME_IMAGE_ID.to_string());
    args.push_str(",\"path\":");
    push_quoted(&mut args, &path.to_string_lossy());
    // The pane's origin: the frame is the pane's whole content, and `cols`/`rows`
    // are what scale it there.
    args.push_str(",\"row\":0,\"col\":0,\"cols\":");
    args.push_str(&span.0.to_string());
    args.push_str(",\"rows\":");
    args.push_str(&span.1.to_string());
    args.push_str("}]}");
    args
}

/// Reads `frame:<placed>/<transmitted>` back out of the reply.
fn frame_counts(result: &str) -> Option<(u32, u32)> {
    let counts = result.trim().trim_matches('"').strip_prefix("frame:")?;
    let (placed, transmitted) = counts.split_once('/')?;
    Some((
        placed.trim().parse().ok()?,
        transmitted.trim().parse().ok()?,
    ))
}

#[cfg(test)]
mod tests {
    //! The pipe half is driven against the same real `CreateNamedPipeW` server
    //! Task 6 built ([`crate::agwinterm::fixture`]) — a frame reaching agwinterm is
    //! a claim about bytes on a wire, and the fixture is what makes it checkable
    //! without a live host. The file half is driven against the real filesystem for
    //! the same reason: "a unique path per frame" is a claim about what is on disk.

    use super::*;
    use crate::agwinterm::fixture::{PipeServer, Turn};

    /// An empty environment, which is deliberately not `of_process()`: the suite
    /// may itself be running in an agwinterm pane whose `TERMINAL_BROWSER_*` is
    /// set, and a test that appended to the developer's budget file would be
    /// measuring itself.
    fn no_budget() -> crate::terminal::SessionEnv {
        crate::terminal::SessionEnv::of_session(Default::default())
    }

    /// The same, plus a budget file at `path`.
    fn budget_to(path: &Path) -> crate::terminal::SessionEnv {
        crate::terminal::SessionEnv::of_session(
            [(BUDGET_ENV.to_string(), path.display().to_string())]
                .into_iter()
                .collect(),
        )
    }

    fn canvas(width: u32, height: u32) -> Canvas {
        let mut canvas = Canvas::new(width, height);
        // Not a flat colour: a PNG of a constant image compresses to the same
        // length every time, which is precisely the collision the unique paths
        // exist to make impossible, and a test that never varies could not tell.
        for (i, px) in canvas.pixels.chunks_exact_mut(4).enumerate() {
            px.copy_from_slice(&[(i % 251) as u8, (i % 253) as u8, 0x40, 255]);
        }
        canvas
    }

    fn ok_frame() -> String {
        r#"{"ok":true,"result":"frame:1/1"}"#.to_owned()
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("the publisher's directory exists")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    // -- the cell span ----------------------------------------------------

    #[test]
    fn the_span_is_the_canvas_measured_in_cells() {
        // The steady state: the engine sized the canvas at cols*cw by rows*ch, so
        // the span comes back out as exactly the pane.
        assert_eq!(
            cell_span((80 * 9, 24 * 19), (9, 19), Some((80, 24))),
            Ok((80, 24)),
        );
    }

    #[test]
    fn a_partial_cell_still_gets_a_whole_one() {
        // Rounding down would place the frame short and let the pane's own text
        // show through the last row.
        assert_eq!(cell_span((100, 100), (16, 32), None), Ok((7, 4)));
        assert_eq!(cell_span((1, 1), (16, 32), None), Ok((1, 1)));
    }

    #[test]
    fn a_canvas_wider_than_the_pane_is_clamped_rather_than_overflowing() {
        // A resize that lands between compositing and publishing. Squashed for one
        // frame beats an image running off the bottom of the pane.
        assert_eq!(
            cell_span((80 * 9, 24 * 19), (9, 19), Some((40, 10))),
            Ok((40, 10))
        );
    }

    #[test]
    fn a_pane_with_no_cells_is_too_small_to_place_into() {
        assert_eq!(
            cell_span((640, 480), (16, 32), Some((0, 24))),
            Err(TooSmall)
        );
        assert_eq!(
            cell_span((640, 480), (16, 32), Some((80, 0))),
            Err(TooSmall)
        );
        // And a canvas with no area is nothing to place, whatever the pane says.
        assert_eq!(cell_span((0, 480), (16, 32), Some((80, 24))), Err(TooSmall));
        assert_eq!(cell_span((640, 0), (16, 32), None), Err(TooSmall));

        // It is a skip, not a broken pipe: the caller has to be able to tell.
        let err = io::Error::from(TooSmall);
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn a_zero_cell_size_cannot_divide_by_zero() {
        // `cell_size` never answers zero. This is the guard that says so out loud
        // rather than panicking three frames into a bad host reply.
        assert_eq!(cell_span((64, 64), (0, 0), None), Ok((64, 64)));
    }

    // -- encoding ---------------------------------------------------------

    #[test]
    fn a_canvas_encodes_to_a_png_of_the_same_size() {
        let mut png = Vec::new();
        encode_png(&canvas(37, 11), &mut png).expect("a canvas encodes");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "not a PNG");

        let decoded = image::load_from_memory(&png)
            .expect("agwinterm has to decode this")
            .to_rgba8();
        assert_eq!(decoded.dimensions(), (37, 11));
        assert_eq!(
            decoded.as_raw().as_slice(),
            canvas(37, 11).pixels.as_slice()
        );
    }

    #[test]
    fn a_canvas_that_does_not_carry_its_own_pixels_is_refused() {
        let mut canvas = Canvas::new(4, 4);
        canvas.pixels.truncate(8);
        let err = encode_png(&canvas, &mut Vec::new()).expect_err("8 bytes is not 4x4");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(
            err.to_string().contains("64"),
            "the message names the shortfall: {err}"
        );
    }

    // -- unique paths and the churn they make -----------------------------

    #[test]
    fn every_frame_gets_a_path_no_other_frame_has_had() {
        // Comfortably more than `RETAINED`, so the reaping is exercised rather
        // than merely reached.
        const FRAMES: usize = 12;
        let server = PipeServer::answering(&ok_frame(), FRAMES);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&no_budget()).expect("a temp directory");
        let dir = publisher.dir().to_owned();

        let mut seen = std::collections::HashSet::new();
        for _ in 0..FRAMES {
            publisher
                .publish(&mut client, &canvas(24, 8), (2, 1))
                .expect("the fixture accepts every frame");
            let path = last_path(&server);
            assert!(seen.insert(path.clone()), "{path} was published twice");
        }

        // Sustained production does not accumulate: the directory holds the
        // retention window and nothing else.
        assert_eq!(files_in(&dir).len(), RETAINED);
        assert_eq!(seen.len(), FRAMES, "one path per frame, and no path twice");
    }

    /// The `path` out of the request the fixture last recorded — which is the only
    /// place the path is asserted from, because the host's copy is the one that
    /// matters.
    fn last_path(server: &PipeServer) -> String {
        let request = server
            .requests()
            .last()
            .expect("a request was sent")
            .clone();
        let at = request
            .find("\"path\":\"")
            .expect("the request carries a path")
            + 8;
        let rest = &request[at..];
        let end = rest.find('"').expect("the path literal closes");
        rest[..end].replace("\\\\", "\\")
    }

    #[test]
    fn the_directory_goes_when_the_publisher_does() {
        let server = PipeServer::always(&ok_frame());
        let mut client = server.client();
        let publisher = {
            let mut publisher = FramePublisher::new(&no_budget()).expect("a temp directory");
            publisher
                .publish(&mut client, &canvas(16, 16), (1, 1))
                .expect("one frame");
            publisher
        };
        let dir = publisher.dir().to_owned();
        assert!(dir.is_dir());
        drop(publisher);
        assert!(!dir.exists(), "the frame directory outlived its publisher");
    }

    #[test]
    fn a_directory_a_dead_process_left_behind_is_swept_up() {
        // In a root of its own: the real sweep runs over the shared temp dir, and
        // a test that swept *that* with a zero threshold would delete the frame
        // directories of every other test running beside it.
        let root = std::env::temp_dir().join(format!("frame-sweep-{}", std::process::id()));
        fs::create_dir_all(&root).expect("a root to sweep");
        let ours = root.join(format!("{DIR_PREFIX}17-0"));
        let unrelated = root.join("not-a-frame-dir");
        for dir in [&ours, &unrelated] {
            fs::create_dir_all(dir).expect("a directory");
            fs::write(dir.join("frame-00000000.png"), b"x").expect("a file in it");
        }

        // Fresh: nothing an hour past its last frame, so nothing goes.
        sweep_stale(&root, STALE_AFTER);
        assert!(ours.is_dir(), "a directory in use was swept");

        // Past the threshold, which is what "the process that owned it is gone"
        // means here — see `sweep_stale` on why liveness is not asked directly.
        sweep_stale(&root, Duration::ZERO);
        assert!(!ours.exists(), "a stale frame directory survived the sweep");
        assert!(
            unrelated.is_dir(),
            "the sweep deleted something that was never ours",
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_new_publisher_sweeps_before_it_writes() {
        // The sweep is on the construction path, which is the only place it runs.
        let publisher = FramePublisher::new(&no_budget()).expect("a temp directory");
        assert!(
            publisher.dir().starts_with(std::env::temp_dir()),
            "frames go somewhere other than the temp dir, where the sweep looks",
        );
        assert!(
            publisher
                .dir()
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(DIR_PREFIX)),
            "the directory is not named the way the sweep recognises",
        );
    }

    #[test]
    fn a_frame_the_directory_cannot_hold_is_reported_and_the_next_one_still_goes() {
        let server = PipeServer::always(&ok_frame());
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&no_budget()).expect("a temp directory");
        let dir = publisher.dir().to_owned();

        // The temp dir gets swept by the OS, by cleaners, and by another browser's
        // `sweep_stale`. Losing it must cost one frame at most.
        fs::remove_dir_all(&dir).expect("removing it under the publisher");
        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the directory is recreated rather than the frame lost");
        assert!(dir.is_dir());

        // And a write that fails for a reason retrying cannot fix leaves the
        // publisher usable: the sequence moved on, so the next frame is a new path.
        let blocked = publisher.peek_path();
        fs::create_dir_all(&blocked).expect("a directory where a file should go");
        let err = publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect_err("a directory is not a file");
        assert!(err.raw_os_error().is_some(), "an OS error, reported: {err}");
        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the publisher survives a failed frame");
        let _ = fs::remove_dir_all(&blocked);
    }

    // -- the publish path, against a real pipe -----------------------------

    #[test]
    fn a_frame_reaches_the_host_as_one_addressed_image_frame_request() {
        let server = PipeServer::always(&ok_frame());
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&no_budget()).expect("a temp directory");

        let written = publisher
            .publish(&mut client, &canvas(80 * 9, 24 * 19), (80, 24))
            .expect("the fixture answers");
        assert!(written > 8, "the byte count is the PNG's, got {written}");

        let request = server.requests().last().expect("one request").clone();
        assert!(
            request.starts_with(r#"{"cmd":"image.frame","target":"s3","args":"#),
            "{request}"
        );
        assert!(request.contains(r#""id":1"#), "{request}");
        assert!(
            request.contains(r#""row":0,"col":0,"cols":80,"rows":24"#),
            "{request}"
        );

        // The file the host was pointed at is on disk, is the frame, and is
        // complete — which is the whole point of publishing only after the close.
        let path = PathBuf::from(last_path(&server));
        let bytes = fs::read(&path).expect("the host can read what it was told about");
        assert_eq!(bytes.len(), written);
        assert_eq!(
            image::load_from_memory(&bytes)
                .expect("a whole PNG")
                .to_rgba8()
                .dimensions(),
            (80 * 9, 24 * 19),
        );
    }

    #[test]
    fn a_windows_path_survives_the_json_it_travels_in() {
        // Every path here is full of backslashes, and JSON spells one `\\`. An
        // unescaped path is not a syntax error on the wire — it is a *different
        // path*, and agwinterm answers "sixel file not found" for it.
        let args = frame_args(
            Path::new(r"C:\Users\b\AppData\Local\Temp\f\frame-00000001.png"),
            (3, 2),
        );
        assert!(
            args.contains(r#""path":"C:\\Users\\b\\AppData\\Local\\Temp\\f\\frame-00000001.png""#),
            "{args}",
        );
        assert!(args.starts_with(r#"{"images":[{"id":1,"path":"#), "{args}");
        assert!(
            args.ends_with(r#","row":0,"col":0,"cols":3,"rows":2}]}"#),
            "{args}"
        );
    }

    #[test]
    fn a_refused_frame_is_an_error_and_leaves_no_file_behind() {
        let server = PipeServer::always(r#"{"ok":false,"error":"sixel file not found"}"#);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&no_budget()).expect("a temp directory");

        let err = publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect_err("a refusal is a failed frame");
        assert!(err.to_string().contains("sixel file not found"), "{err}");
        assert_eq!(
            files_in(publisher.dir()),
            Vec::<String>::new(),
            "a frame nobody read is litter, not history",
        );
    }

    #[test]
    fn a_host_that_dropped_the_pipe_still_gets_the_frame() {
        // The client replays once on a dropped connection, re-sending the same
        // path — which is why the retention window is more than one frame deep.
        let server = PipeServer::scripted(vec![Turn::Hangup, Turn::Reply(ok_frame())]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&no_budget()).expect("a temp directory");

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the reconnect carries the frame");
        let requests = server.requests();
        assert_eq!(requests.len(), 2, "the request was replayed once");
        assert_eq!(
            requests[0], requests[1],
            "the replay named a different path"
        );
        assert!(
            fs::read(last_path(&server)).is_ok(),
            "the replayed path no longer exists",
        );
    }

    #[test]
    fn a_frame_the_host_placed_but_did_not_read_is_complained_about_once() {
        // `frame:1/0` is the silent-stale-image failure: the host placed an image
        // but never read our bytes. It cannot happen through a unique path unless
        // the read itself failed, so it is worth saying out loud.
        let server = PipeServer::always(r#"{"ok":true,"result":"frame:1/0"}"#);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&no_budget()).expect("a temp directory");

        for _ in 0..3 {
            publisher
                .publish(&mut client, &canvas(16, 16), (1, 1))
                .expect("a placed frame is still a delivered frame");
        }
        assert!(
            publisher.warned_untransmitted,
            "nothing noticed the stale frame"
        );

        assert_eq!(frame_counts("frame:1/1"), Some((1, 1)));
        assert_eq!(frame_counts("\"frame:2/0\""), Some((2, 0)));
        assert_eq!(
            frame_counts("shown"),
            None,
            "another verb's reply is not counts"
        );
    }

    #[test]
    fn the_reply_a_frame_gets_is_the_hosts_own() {
        // Guards the assumption `check_transmitted` reads: agwinterm answers
        // `image.frame` with a *string*, not an object.
        let server = PipeServer::always(&ok_frame());
        let mut client = server.client();
        let raw = client
            .send(FRAME_CMD, Some(&frame_args(Path::new("x.png"), (1, 1))))
            .and_then(Reply::result)
            .expect("the fixture answers");
        // Quoted, because `result` hands back the raw JSON — which is how
        // `check_transmitted` knows to trim the quotes off before parsing.
        assert_eq!(raw, "\"frame:1/1\"");
    }

    // -- the frame budget -------------------------------------------------
    //
    // Task 10 had to measure this path before Task 12 could argue against it, and
    // `docs/design/02-frame-budget.md` is what it measured. These pin the
    // instrumentation that produced those numbers, because a budget file that
    // silently stopped being written would read as "nothing to see here".

    #[test]
    fn a_budget_file_gets_one_line_per_frame_that_reached_the_host() {
        const FRAMES: usize = 4;
        let scratch = scratch_dir("budget-lines");
        let path = scratch.join("frames.tsv");
        let server = PipeServer::answering(&ok_frame(), FRAMES);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&budget_to(&path)).expect("a temp directory");

        for _ in 0..FRAMES {
            publisher
                .publish(&mut client, &canvas(24, 8), (2, 1))
                .expect("the fixture accepts every frame");
        }
        drop(publisher);

        let text = fs::read_to_string(&path).expect("the budget file was written");
        let rows: Vec<&str> = text
            .lines()
            .filter(|line| !line.starts_with('#') && !line.is_empty())
            .collect();
        assert_eq!(rows.len(), FRAMES, "one line per frame:\n{text}");
        assert!(
            text.starts_with("# seq"),
            "the file has to explain itself:\n{text}"
        );
        assert!(
            text.contains("is not in here"),
            "the header has to say the host's decode is *not* counted, or every \
             reader will assume publish_ms is the whole cost:\n{text}"
        );

        // The columns, on the first row: seq, canvas, span, bytes, and three times.
        let first: Vec<&str> = rows[0].split('\t').collect();
        assert_eq!(first.len(), 7, "{:?}", rows[0]);
        assert_eq!(first[0], "0", "the sequence starts where the paths do");
        assert_eq!(first[1], "24x8", "the canvas, in pixels");
        assert_eq!(first[2], "2x1", "the span, in cells");
        assert!(
            first[3].parse::<usize>().expect("bytes is a number") > 0,
            "a PNG of nothing is not a frame: {:?}",
            rows[0]
        );
        for column in first[4..].iter() {
            assert!(
                column.parse::<f64>().expect("a duration in ms") >= 0.0,
                "{column:?} is not a duration",
            );
        }
        // The sequence is the publisher's own, so a reader can line a budget row
        // up with the file that produced it.
        let seqs: Vec<&str> = rows
            .iter()
            .map(|row| row.split('\t').next().unwrap())
            .collect();
        assert_eq!(seqs, ["0", "1", "2", "3"]);

        fs::remove_dir_all(&scratch).ok();
    }

    #[test]
    fn no_variable_means_no_file_and_no_cost() {
        // The default has to be genuinely off: this runs in every browser, and a
        // measurement that is always on is a write per frame nobody asked for.
        let scratch = scratch_dir("budget-off");
        let path = scratch.join("frames.tsv");
        let server = PipeServer::always(&ok_frame());
        let mut client = server.client();

        // Empty, and also explicitly empty-valued — `FOO=` is how a shell unsets a
        // variable it cannot remove, and it must not name a file called "".
        for env in [
            crate::terminal::SessionEnv::of_session(Default::default()),
            crate::terminal::SessionEnv::of_session(
                [(BUDGET_ENV.to_string(), String::new())]
                    .into_iter()
                    .collect(),
            ),
        ] {
            let mut publisher = FramePublisher::new(&env).expect("a temp directory");
            publisher
                .publish(&mut client, &canvas(16, 16), (1, 1))
                .expect("one frame");
        }
        assert!(
            !path.exists(),
            "a budget file appeared with nothing asking for one"
        );

        fs::remove_dir_all(&scratch).ok();
    }

    #[test]
    fn a_frame_the_host_refused_is_not_in_the_budget() {
        // It never reached the pane, so counting it would make the file report a
        // frame rate the user did not get.
        let scratch = scratch_dir("budget-refused");
        let path = scratch.join("frames.tsv");
        let server = PipeServer::always(r#"{"ok":false,"error":"no such pane"}"#);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&budget_to(&path)).expect("a temp directory");

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect_err("a refusal is a failed frame");
        drop(publisher);

        let text = fs::read_to_string(&path).expect("the header is written on open");
        assert!(
            text.lines()
                .all(|line| line.starts_with('#') || line.is_empty()),
            "a refused frame was counted:\n{text}"
        );

        fs::remove_dir_all(&scratch).ok();
    }

    #[test]
    fn a_budget_file_that_cannot_be_opened_costs_no_frames() {
        // The measurement must never be the thing that breaks the run. A directory
        // is not a file, so this is a real open failure rather than a simulated one.
        let scratch = scratch_dir("budget-unopenable");
        let server = PipeServer::always(&ok_frame());
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&budget_to(&scratch)).expect("a temp directory");

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the frame goes out regardless of the budget file");

        fs::remove_dir_all(&scratch).ok();
    }

    /// A directory of this test's own, under the temp dir.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("winterm-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }
}
