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
//! memory. Task 12 was to add `image.frameshm` on top, and **this path stays** — as
//! the fallback for a host that lacks the verb, and as the baseline the fast path is
//! diffed against. So the two must produce the same picture from the same canvas;
//! everything picture-shaped lives in [`cell_span`] and [`encode_png`], which the
//! shm path reuses rather than reimplements.
//!
//! ⚠️ As of Task 12 that fast path does not exist: its mapping layout is still
//! unpublished, so there is nothing to write BGRA into. See [`crate::frame_shm`],
//! which holds the transport selection and the capability probe that survive the
//! blocker. This module is therefore not the fallback but the only path, and
//! [`FramePublisher::explain_transport`] is what stops that being a silent fact.
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
use crate::frame_shm::layout::Published;
use crate::frame_shm::producer::Producer;
use crate::frame_shm::{FRAMESHM_CMD, Transport, is_unknown_command};

/// The verb. Shipped agwinterm, no host change required — which is what makes this
/// the bring-up path rather than something that waits on the agwinterm plan.
pub(crate) const FRAME_CMD: &str = "image.frame";

/// The verb that takes the picture back off the pane.
///
/// A frame is a *placement*: agwinterm holds it until something replaces it, which
/// is what makes switching sessions free (Task 10) and what makes an exiting
/// browser a problem. The last frame outlives the process that drew it, and the
/// shell underneath goes on running with a page painted over it — the pane is a
/// working terminal that cannot be read. Every exit path owes the host this verb:
/// [`Terminal`](crate::terminal::Terminal)'s `Drop` for an ordinary quit or an
/// unwind, and the CLI's foreground wait for the exits `Drop` cannot see —
/// `TerminalProcess` killed, a crash, a `taskkill /F`.
pub(crate) const CLEAR_CMD: &str = "image.clear";

/// The one image id this path ever transmits under.
///
/// Fixed, not rotated. Placement is replaced wholesale by every `image.frame`
/// (`em.ClearPlacements()`), so nothing is gained by a second id, and a rotating
/// one would leave the emulator holding a texture per frame.
const FRAME_IMAGE_ID: u32 = 1;

/// How many `image.frameshm` refusals in a row take the fast path down for the
/// session — for any reason other than `unknown command`, which takes it down on
/// the first. A host that rejects the mapping is telling this producer something is
/// wrong with it, and a producer that keeps re-sending a rejected frame at 26 fps
/// is the failure mode this bound exists to avoid; an accepted frame resets it.
const MAX_REFUSALS: usize = 3;

/// How many recent frame files survive. One is the frame in flight; the rest cover
/// [`ControlClient::request`]'s single replay, which re-sends the same path on a
/// fresh connection after the host dropped the first one.
const RETAINED: usize = 3;

/// How old a directory has to be before [`sweep_stale`] reclaims it.
///
/// A publisher that is *painting* refreshes its directory's timestamp for free:
/// every frame creates a file inside it. An idle one does not — a browser sitting
/// on a static page writes nothing, so age is a bound on the last frame, not on
/// liveness, and an hour of it does not mean the process is gone. That is why
/// [`FramePublisher::write_frame`] recreates a directory swept out from under it and
/// [`FrameDir::remark`] puts the pane marker back; without those, a live browser's
/// next frame would fail and its wreck would stop being attributable to `pane-clear`.
///
/// Both of those run *on the next frame*, which leaves one window they do not cover:
/// an idle publisher swept out, then killed before it repaints, has no directory and
/// so no wreck for `pane-clear` to attribute — its placement stays on the pane and
/// the recovery verb reports nothing owned. Closing that would mean sweeping on
/// liveness rather than age, and [`sweep_stale`] says why this does not: a pid is
/// reused, so a liveness test would strand real wrecks for as long as some unrelated
/// process holds the number, which is the commoner failure and the unbounded one. An
/// hour is chosen to make the window rare rather than to make it impossible — and
/// [`MARKED_STALE_AFTER`] narrows it further still, because an idle publisher that
/// ever had a frame accepted is a *marked* directory and is not held to this
/// threshold at all. What is left here is the publisher that has placed nothing, and
/// a publisher that has placed nothing has no placement to strand.
///
/// This is the threshold for a directory that names no pane. One that does is kept
/// for [`MARKED_STALE_AFTER`] instead — see there.
const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

/// How old a directory that *names a pane* has to be before [`sweep_stale`] reclaims
/// it.
///
/// [`PANE_FILE`] is the whole of `pane-clear`'s evidence: a wreck with frames in it
/// and a marker naming this pane is the only thing that authorises an `image.clear`,
/// and the recovery verb has no override for its absence — by design, because
/// clearing without evidence is clearing a placement someone else owns. Sweeping a
/// marked wreck therefore does not just reclaim disk, it destroys the one route back
/// for a pane that is still painted. [`STALE_AFTER`] is far too short for that: the
/// run this verb was written for found its wreck roughly eighteen hours later, and
/// any unrelated browser launched in the meantime would have swept it — the sweep
/// runs over the whole temp root, so a browser started in *another* pane retires this
/// one's evidence.
///
/// A week, rather than never: a marked wreck is retired the moment it is recovered
/// (`retire`, `cli/src/pane.ts`) or exited cleanly (`FrameDir`'s `Drop`), so what
/// this retains is only panes that were wrecked and never repaired, at [`RETAINED`]
/// frames each. Keeping those for ever would be an unbounded leak on a machine that
/// force-kills browsers; keeping them for a week outlives every plausible "I came
/// back to it the next day" without becoming one.
///
/// The cost is the converse hazard, and it is the smaller one: evidence this old can
/// authorise a clear against a placement some other producer has since made on the
/// same pane. That clear only ever goes to the pane the user is *standing in*, only
/// when a marker names that same pane, and only because they ran a repair command at
/// a pane they judged to be wrecked — none of which is true of the frame this is
/// protecting, which is stranded with no command that can reach it at all.
const MARKED_STALE_AFTER: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Shared by every publisher's directory, so [`sweep_stale`] can recognise one.
const DIR_PREFIX: &str = "terminal-browser-frames-";

/// Names the pane this publisher's frames were placed on: the pipe on the first
/// line, the session id on the second.
///
/// The directory name carries a pid and a sequence and nothing else, so a wreck on
/// disk says *that* a browser drew and never says *where*. `terminal-browser
/// pane-clear` runs with no pid to go on — the process it would name is gone, and
/// often so is the CLI that spawned it — so without this it can only take the newest
/// directory on the machine and hope. Two panes wrecked at once is then a pane
/// repaired on another pane's evidence, which is the clear-what-you-did-not-place
/// rule (see [`FramePublisher::clear`]) broken from the other side.
///
/// Written once, after the first frame the host accepted, for the same reason
/// `written` is the test there: a publisher that never placed anything has no pane
/// to name. The name has no `frame-` prefix, so `ownedFrames` never counts it as a
/// frame.
const PANE_FILE: &str = "pane";

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
    /// Set when the clear this directory authorises did not happen, so `Drop` leaves
    /// it standing. See [`FramePublisher::clear`].
    keep: bool,
    /// What [`PANE_FILE`] holds, remembered so [`FramePublisher::write_frame`] can
    /// put it back on a directory it had to recreate. `None` until the host has
    /// accepted a frame, which is the only point at which there is a pane to name.
    mark: Option<String>,
}

impl FrameDir {
    /// One per publisher. The pid keeps two browsers apart; the counter keeps two
    /// publishers inside one process apart, which is a thing tests do.
    ///
    /// `create_dir` rather than `create_dir_all`, and a counter that keeps moving
    /// until it lands on a name nobody has: a pid is unique among *live* processes
    /// and nothing more. Only a clean `Drop` removes a directory and [`sweep_stale`]
    /// leaves anything younger than an hour alone — a week, once it names a pane — so
    /// a browser that was killed leaves its frames behind, and Windows recycles pids
    /// freely. Adopting that
    /// directory would put `frame-00000000.png` in the path of a file that already
    /// exists, and [`write_all_new`] refuses to touch one (rightly: overwriting a
    /// file the host may be reading is what this module is built to avoid). Its
    /// `AlreadyExists` is not the `NotFound` [`FramePublisher::write_frame`] retries,
    /// so it reached `Terminal::draw`, and an error there ends the browser. The
    /// first frame after an unlucky pid reuse would have been the last.
    fn create() -> io::Result<Self> {
        let root = std::env::temp_dir();
        sweep_stale(&root, STALE_AFTER, MARKED_STALE_AFTER);
        Self::create_in(&root)
    }

    /// The half that does not read the environment, so a test can hand it a root of
    /// its own and leave one of the names already taken.
    fn create_in(root: &Path) -> io::Result<Self> {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);

        // Bounded: each turn burns a counter value no other publisher will use
        // again, so this ends whether or not the collisions are ours.
        let mut last = None;
        for _ in 0..ATTEMPTS {
            let path = root.join(format!(
                "{DIR_PREFIX}{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    return Ok(Self {
                        path,
                        keep: false,
                        mark: None,
                    });
                }
                // A directory that already exists is a dead browser's, not ours.
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => last = Some(err),
                // The temp directory itself may not exist yet on a fresh profile.
                Err(err) if err.kind() == io::ErrorKind::NotFound => {
                    fs::create_dir_all(root)?;
                    last = Some(err);
                }
                Err(err) => return Err(err),
            }
        }
        Err(last.unwrap_or_else(|| {
            io::Error::new(
                io::ErrorKind::AlreadyExists,
                "no free frame directory under the temp directory",
            )
        }))
    }
}

/// How many names [`FrameDir::create`] will try before giving up.
const ATTEMPTS: u32 = 64;

impl FrameDir {
    /// Records which pane the frames in here went to. Best-effort: a marker that
    /// could not be written costs `pane-clear` a recovery it would otherwise make,
    /// which is not worth failing a frame over.
    ///
    /// The text is kept rather than only written, because the directory it goes in
    /// is one [`FramePublisher::write_frame`] recreates — see [`FrameDir::remark`].
    fn mark_pane(&mut self, target: &crate::agwinterm::HostTarget) {
        let mark = format!("{}\n{}\n", target.pipe(), target.session());
        let _ = fs::write(self.path.join(PANE_FILE), &mark);
        self.mark = Some(mark);
    }

    /// Puts the marker back after the directory has been recreated under a live
    /// publisher.
    ///
    /// Without this, the sweep that [`FramePublisher::write_frame`] recovers from
    /// takes `pane-clear` with it: the recovery verb refuses to adopt a directory
    /// that holds frames and names no pane (`ownedFrames`, `cli/src/pane.ts`), so a
    /// browser whose directory was reclaimed while it sat idle — a real case, since
    /// [`sweep_stale`] reads age, not liveness, and an idle publisher writes no
    /// frames to keep its timestamp fresh — would go on publishing frames nothing
    /// could ever attribute, and its wreck would be unrecoverable. Best-effort for
    /// the same reason [`FrameDir::mark_pane`] is.
    fn remark(&self) {
        let Some(mark) = self.mark.as_ref() else {
            return;
        };
        let _ = fs::write(self.path.join(PANE_FILE), mark);
    }
}

impl Drop for FrameDir {
    /// Removes the directory — unless a clear was attempted here and failed.
    ///
    /// The directory's *survival* is what the CLI reads as "a browser published on
    /// this pane and never took the picture back" (`ownedFrames`, `cli/src/pane.ts`),
    /// and that is exactly true of a browser whose own clear did not land. Removing
    /// it on the way out of a failed clear would delete the evidence the second half
    /// of the recovery runs on, leaving the page painted with nothing left that knows
    /// it is there — the two-layer guarantee collapsed to one layer precisely in the
    /// case where the first layer failed. [`sweep_stale`] reclaims what is left.
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Removes the frame directories of processes that did not get to run their `Drop`.
///
/// By age, not by liveness: asking whether a pid is still alive is both racy (pids
/// are reused) and more Win32 than this needs. The trade is that age only tracks
/// *painting* — a directory gains a file every frame, so a browser drawing anything
/// at all stays fresh, but an idle one goes quiet and can pass [`STALE_AFTER`] while
/// still holding its pane. [`FramePublisher::write_frame`] and [`FrameDir::remark`]
/// are what make that survivable rather than fatal. Every error is ignored — a
/// directory another live browser is holding open is exactly the case where failing
/// to delete it is correct.
///
/// A directory that names a pane is held to `marked_older_than` instead, because it
/// is `pane-clear`'s only evidence — see [`MARKED_STALE_AFTER`].
///
/// The thresholds are parameters rather than [`STALE_AFTER`] and
/// [`MARKED_STALE_AFTER`] read directly so the tests can drive both sides of each in
/// their own root, instead of backdating a directory — which on Windows needs a
/// handle a plain `File::open` does not give.
fn sweep_stale(root: &Path, older_than: Duration, marked_older_than: Duration) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(DIR_PREFIX) {
            continue;
        }
        let path = entry.path();
        // `max`, not the marked threshold as given: a marked wreck is worth *more*
        // than an unmarked one, so no pair of arguments should make it go sooner.
        let limit = if path.join(PANE_FILE).exists() {
            marked_older_than.max(older_than)
        } else {
            older_than
        };
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|age| age >= limit);
        if stale {
            let _ = fs::remove_dir_all(path);
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

/// The fast path's standing for this session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Latched {
    /// Nothing has ruled it out: the next frame under [`Transport::Auto`] or
    /// [`Transport::Shm`] goes out as an `image.frameshm`.
    Open,
    /// Ruled out for the rest of the session — by `unknown command`, or by
    /// [`MAX_REFUSALS`] refusals in a row — and not asked about again.
    Unavailable,
}

/// Gets frames to agwinterm: over shared memory when the host has the verb, and as
/// files it is pointed at otherwise.
///
/// Owns nothing about *when* to draw — the engine decides that — and nothing about
/// the pipe, which it borrows per frame. What it owns is the fast path's producer
/// and its standing, the directory, the sequence that makes paths unique, and the
/// retention that stops them piling up.
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
    /// Which transport was asked for. `File` never constructs a [`Producer`];
    /// `Auto` and `Shm` try the fast path until [`Self::fast_path`] latches. See
    /// [`crate::frame_shm`].
    transport: Transport,
    /// The fast path's standing for this session. See [`Latched`].
    fast_path: Latched,
    /// The fast path's producer: `None` until the first frame tries it, and `None`
    /// again once the fast path is latched off, so a mapping no host will read is
    /// not kept alive for the session.
    producer: Option<Producer>,
    /// The reason for every `image.frameshm` refusal since the last frame the host
    /// accepted over it; [`MAX_REFUSALS`] of them latch the fast path off.
    refusals: Vec<String>,
    /// Whether the host has placed at least one frame from this publisher, by
    /// either route. What [`Self::clear`] consults.
    placed: bool,
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
            transport: Transport::from_env(env),
            fast_path: Latched::Open,
            producer: None,
            refusals: Vec::new(),
            placed: false,
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

    /// Takes the last frame back off the pane, so what is underneath can be read.
    ///
    /// Sent on the way out and nowhere else. It is deliberately not a `Drop` on this
    /// type: the publisher is taken out of the terminal and put back on every frame
    /// (see [`Terminal::draw`](crate::terminal::Terminal::draw)), so a `Drop` here
    /// would clear the pane in the middle of drawing to it.
    ///
    /// A publisher that never published has nothing to take back, and asking anyway
    /// would clear a placement some *other* process owns.
    ///
    /// The test is `placed`, not `seq`: [`next_path`](Self::next_path) bumps `seq`
    /// for every frame *attempted*, so a first frame the host refused — `no session`,
    /// an unreadable frame directory, a write that failed — would leave `seq` at 1
    /// with nothing ever placed, and the clear that follows it out of
    /// [`Terminal::drop`](crate::terminal::Terminal) would take down whatever the
    /// pane was already showing. `placed` is set only in the accepted arm of each
    /// route — [`publish_encoded`](Self::publish_encoded) for the file,
    /// [`publish_shm`](Self::publish_shm) for the mapping — and only past the
    /// `frame:0/0` guard, so it is false exactly when nothing was placed. It is not
    /// `written`, because a frame that went over shared memory wrote nothing and is
    /// a placement all the same.
    ///
    /// A clear that did not land keeps the directory alive past [`FrameDir`]'s
    /// `Drop`. `Terminal::clear_frame` swallows this error on purpose — nothing on an
    /// exit path is worth a message — and the CLI's own clear is what covers it, but
    /// the CLI decides whether to send one by looking for this directory. Deleting it
    /// here would answer "nothing was ever placed" to a pane that is still holding a
    /// page.
    pub(crate) fn clear(&mut self, client: &mut ControlClient) -> io::Result<()> {
        if !self.placed {
            return Ok(());
        }
        match client.send(CLEAR_CMD, None).and_then(Reply::result) {
            Ok(_) => Ok(()),
            Err(err) => {
                self.dir.keep = true;
                Err(err)
            }
        }
    }

    /// Gets one frame to the host: over `image.frameshm` while the fast path is
    /// open, and otherwise — or for a frame the fast path did not carry — encoded,
    /// written and published as an `image.frame`. Returns the bytes that carried
    /// the frame, the PNG's on the file path and the pixels' on the fast one, which
    /// is what the frame budget is measured in.
    ///
    /// `span` is [`cell_span`]'s answer, passed in rather than computed here
    /// because the caller is the one holding the cell size and the pane size.
    pub(crate) fn publish(
        &mut self,
        client: &mut ControlClient,
        canvas: &Canvas,
        span: (u32, u32),
    ) -> io::Result<usize> {
        if self.fast_path_open()
            && let Some(bytes) = self.publish_shm(client, canvas, span)?
        {
            return Ok(bytes);
        }
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

    /// Whether the next frame is tried over `image.frameshm`.
    fn fast_path_open(&self) -> bool {
        self.transport != Transport::File && self.fast_path == Latched::Open
    }

    /// The fast path: the canvas into a slot of the mapping, then one
    /// `image.frameshm` telling the host which slot.
    ///
    /// `Ok(Some(bytes))` is a placed frame. `Ok(None)` means this same frame must
    /// go out over the file path instead — the host refused it, placed none of it,
    /// or this side could not publish it — so that nothing is dropped; what the
    /// refusal does to the fast path's standing is [`refused`](Self::refused)'s and
    /// [`latch_unavailable`](Self::latch_unavailable)'s business. `Err` is the pipe
    /// failing, which is a failed frame whichever path it took.
    fn publish_shm(
        &mut self,
        client: &mut ControlClient,
        canvas: &Canvas,
        span: (u32, u32),
    ) -> io::Result<Option<usize>> {
        let producer = self.producer.get_or_insert_with(Producer::new);
        let published = match crate::profiler::span("frame.shm", || producer.publish(canvas)) {
            Ok(published) => published,
            Err(err) => {
                // Not the host's refusal but counted as one: a mapping this side
                // cannot make — a size the contract does not admit, every name
                // suffix taken — will not be made on the next frame either, and
                // three of those in a row are the same "stop asking".
                self.refused(format!("this side could not publish it ({err})"));
                return Ok(None);
            }
        };
        let name = producer
            .current_name()
            .expect("a publish that succeeded left its mapping in place")
            .to_owned();
        let bytes = canvas.pixels.len();
        let args = frameshm_args(&name, published, span);
        // This send returns only once the host has answered, and `publish` — this
        // function's only caller — returns only after it. That await *is* the
        // contract's one producer rule (spec § Producer obligations: a slot is not
        // refilled until the reply for the frame that last used it has returned).
        // With two slots, frame N+2 refills frame N's slot, and it cannot begin
        // before frame N+1 was published, which cannot begin before this returned
        // for frame N. There is no separate mechanism, and
        // `each_publish_returns_only_after_its_own_reply` pins that this one holds.
        // It is also what lets `Producer::publish` drop a resized-away mapping at
        // once: nothing is outstanding by the time it runs.
        match client.send(FRAMESHM_CMD, Some(&args))? {
            Reply::Ok(result) => {
                // `frame:0/0` is "nothing was placed" in an `ok:true` envelope,
                // exactly as on the file path — and, on this path, the answer of a
                // host that cannot open the mapping at all, on every frame. So it
                // is not a placement, this frame goes out over the file so the
                // pane is not left blank, and it counts with the refusals.
                if !self.check_transmitted(&result, Source::Mapping(&name)) {
                    self.refused(format!("the host placed none of it ({result})"));
                    return Ok(None);
                }
                self.refusals.clear();
                if !self.placed {
                    self.dir.mark_pane(client.target());
                    self.placed = true;
                }
                Ok(Some(bytes))
            }
            Reply::Err(message) if is_unknown_command(&message, FRAMESHM_CMD) => {
                self.latch_unavailable(&message);
                Ok(None)
            }
            Reply::Err(message) => {
                self.refused(format!("the host refused it ({message})"));
                Ok(None)
            }
        }
    }

    /// The host has never heard of the verb: the fast path is off for the session,
    /// and the host is not asked again.
    ///
    /// Said once, at the level the transport earns. Under `Auto` the file path is
    /// simply the path — every agwinterm release as of 2026-09 answers this, and
    /// agliteterm always will — so it is information. Under `Shm` the caller asked
    /// for something they are not getting, and silence would be the worse answer:
    /// `TERMINAL_BROWSER_FRAME_TRANSPORT=shm` followed by a working browser reads as
    /// "the fast path is on", which would make every measurement after it wrong.
    /// That is [`Transport::unavailable_reason`], and it is a warning.
    fn latch_unavailable(&mut self, message: &str) {
        self.fast_path = Latched::Unavailable;
        // The host has answered, so no request is outstanding and the mapping can
        // go: nothing will ever read it.
        self.producer = None;
        match self.transport.unavailable_reason() {
            Some(reason) => crate::logging::warn("agwinterm", reason),
            None => crate::logging::info(
                "agwinterm",
                format!(
                    "this agwinterm does not implement `{FRAMESHM_CMD}` ({message}); \
                     frames are going out over `{FRAME_CMD}` for the rest of the session"
                ),
            ),
        }
    }

    /// The fast path did not carry this frame, for a reason that may not repeat.
    ///
    /// Each one is said, since the host's message is the only evidence of what is
    /// wrong with the mapping. [`MAX_REFUSALS`] in a row latch the fast path off
    /// and say which three; an accepted frame resets the count
    /// ([`publish_shm`](Self::publish_shm)).
    fn refused(&mut self, why: String) {
        crate::logging::warn(
            "agwinterm",
            format!(
                "`{FRAMESHM_CMD}` did not carry this frame: {why}; it is going out over \
                 `{FRAME_CMD}` instead"
            ),
        );
        self.refusals.push(why);
        if self.refusals.len() < MAX_REFUSALS {
            return;
        }
        crate::logging::warn(
            "agwinterm",
            format!(
                "`{FRAMESHM_CMD}` was refused {MAX_REFUSALS} frames in a row ({}); frames \
                 are going out over `{FRAME_CMD}` for the rest of the session",
                self.refusals.join("; ")
            ),
        );
        self.fast_path = Latched::Unavailable;
        self.producer = None;
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
                // `frame:0/0` is "nothing was placed" wearing an `ok:true` envelope,
                // and ownership is a claim about placements rather than about
                // protocol success. Marking the directory would tell `pane-clear`
                // this browser left a picture on the pane, and pushing the path would
                // let [`clear`] send an `image.clear` at whatever *is* on it — both
                // of them the "clear a placement some other process owns" this
                // publisher declines to do when `written` is empty. So it is treated
                // exactly as a refusal is; `a_frame_the_host_refused_names_no_pane`
                // already pins that for the `ok:false` spelling of the same state.
                if !self.check_transmitted(&result, Source::File(&path)) {
                    let _ = fs::remove_file(&path);
                    return Ok(png.len());
                }
                // Below the guard, so the budget file agrees with the paragraph
                // above: a `frame:0/0` is treated exactly as a refusal is, and the
                // `Err` arm records nothing. Recording it here meant a pane that was
                // never painted — a host that cannot open the frame directory answers
                // `0/0` for every frame — produced a full-rate budget file, and
                // `docs/design/02-frame-budget.md`'s numbers are read off that file.
                self.budget.record(cost);
                // The first frame the host took, over either path, is what makes
                // this directory a placement on a named pane rather than a pid on
                // disk. See [`PANE_FILE`].
                if !self.placed {
                    self.dir.mark_pane(client.target());
                    self.placed = true;
                }
                self.written.push(path);
                self.reap();
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
    ///
    /// The recreated directory gets its marker back too: whatever removed it took
    /// [`PANE_FILE`] as well, and a directory with frames and no marker is one
    /// `pane-clear` will not touch. See [`FrameDir::remark`].
    fn write_frame(&self, path: &Path, png: &[u8]) -> io::Result<()> {
        match write_all_new(path, png) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(&self.dir.path)?;
                self.dir.remark();
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

    /// `image.frame` answers `frame:<placed>/<transmitted>`, and `image.frameshm`
    /// mirrors it (spec § JSON args), so one reading serves both.
    ///
    /// Transmitted below placed means the host decided our bytes were the ones it
    /// already had, or could not read them — the two silent failures unique paths
    /// exist to prevent. If it ever happens the picture is frozen, so it is said
    /// out loud rather than inferred from a still screen.
    /// A `placed` of zero is the case a `transmitted < placed` test cannot see,
    /// because `0 < 0` is false. It is what agwinterm answers when it cannot open
    /// the path at all: `HandleImageFrame` skips an image whose file it cannot find
    /// *before* it counts it, so an unreachable frame directory reports `frame:0/0`
    /// -- a success, on every frame, with the pane left blank because the clear
    /// phase has already run. A redirected `TEMP`, a pane hosted by another user or
    /// an antivirus quarantine all put the frame directory out of the host's reach,
    /// so this is a state rather than a hypothetical.
    ///
    /// Returns whether the host actually placed something, which is what the caller
    /// turns into ownership. A reply this build cannot parse counts as a placement:
    /// the alternative is a publisher that silently stops owning its frames the day
    /// the host's reply format grows a field.
    fn check_transmitted(&mut self, result: &str, source: Source<'_>) -> bool {
        let Some((placed, transmitted)) = frame_counts(result) else {
            return true;
        };
        if placed > 0 && transmitted >= placed {
            return true;
        }
        // Said once per publisher, but decided every frame — the warning is for the
        // user and the answer is for the caller, and latching the first must not
        // latch the second.
        if self.warned_untransmitted {
            return placed > 0;
        }
        self.warned_untransmitted = true;
        let why = if placed == 0 {
            format!(
                "agwinterm placed none of the frame ({result:?}): {}",
                source.unopenable()
            )
        } else {
            format!(
                "agwinterm placed {placed} image(s) but read {transmitted} of them \
                 ({result:?}): the pane is showing a stale frame. Every frame is \
                 written to a path of its own, so this means the file could not be \
                 read rather than that it looked unchanged"
            )
        };
        crate::logging::warn("agwinterm", why);
        placed > 0
    }
}

/// What a frame's request pointed the host at, for the complaint that it could not
/// open it. The two routes differ in nothing else about that reply.
enum Source<'a> {
    File(&'a Path),
    Mapping(&'a str),
}

impl Source<'_> {
    /// The half of the `frame:0/0` complaint that names what the host could not
    /// open, and what to check.
    fn unopenable(&self) -> String {
        match self {
            Self::File(path) => format!(
                "it could not open {}, so the pane has been left blank. Check that the \
                 process hosting the pane can read the frame directory",
                path.display()
            ),
            Self::Mapping(name) => format!(
                "it could not open the mapping {name}, so the pane has been left blank. \
                 The name is in the `Local\\` namespace, so the process hosting the \
                 pane must be in this logon session"
            ),
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
    // A write that fails part-way leaves a truncated file behind, and the caller's
    // `?` returns from `publish_encoded` before either of its `remove_file` cleanups
    // can run. The path never reaches `self.written`, so `reap` never sees it either
    // — it is litter no later frame can account for.
    //
    // Which matters because the CLI reads ownership off the filesystem. A browser
    // whose only write failed placed nothing and wrote no `PANE_FILE` marker; on the
    // pid path `allOwnedFrames` adopts exactly that shape — frames present, marker
    // absent — as "a browser left a picture here", and clearing on that evidence
    // takes down a placement some other producer owns. That is the very thing
    // `FramePublisher::clear`'s `written.is_empty()` guard exists to refuse.
    let written = file.write_all(png).and_then(|()| file.flush());
    discard_partial(path, file, written)
}

/// The cleanup half of [`write_all_new`], given the handle and what the write said.
///
/// Separate because the failure it exists for cannot be provoked through
/// `write_all_new` — a `File` that opened `create_new` writes a few kilobytes of PNG
/// or the volume is full — and an untested cleanup is a cleanup that quietly stops
/// happening. `Ok` is passed straight back, so the successful path is this function
/// too and the test that pins "a good write keeps its file" is pinning the real one.
fn discard_partial(path: &Path, file: fs::File, written: io::Result<()>) -> io::Result<()> {
    match written {
        Ok(()) => Ok(()),
        Err(err) => {
            // Closed first: Windows refuses to unlink a file with a live handle.
            drop(file);
            let _ = fs::remove_file(path);
            Err(err)
        }
    }
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
    push_placement(&mut args, span);
    args.push_str("}]}");
    args
}

/// `{"images":[{…}]}` — the `args` of one `image.frameshm` request (spec § JSON
/// args).
///
/// Every number is [`Published`]'s — the slot, the sequence and the descriptor the
/// mapping was actually written with — so the request cannot disagree with the
/// bytes. The placement is [`push_placement`]'s, the one `image.frame` sends: the
/// two verbs are siblings, and a frame must land in the same place whichever
/// carried it.
fn frameshm_args(name: &str, published: Published, span: (u32, u32)) -> String {
    let Published {
        slot,
        seq,
        descriptor,
    } = published;
    let mut args = String::from("{\"images\":[{\"id\":");
    args.push_str(&FRAME_IMAGE_ID.to_string());
    args.push_str(",\"name\":");
    push_quoted(&mut args, name);
    args.push_str(&format!(
        ",\"slot\":{slot},\"seq\":{seq},\"width\":{},\"height\":{},\"stride\":{},\"format\":{}",
        descriptor.width, descriptor.height, descriptor.stride, descriptor.format
    ));
    push_placement(&mut args, span);
    args.push_str("}]}");
    args
}

/// The placement both verbs share: the pane's origin, spanning `span` cells.
fn push_placement(args: &mut String, span: (u32, u32)) {
    // The pane's origin: the frame is the pane's whole content, and `cols`/`rows`
    // are what scale it there.
    args.push_str(",\"row\":0,\"col\":0,\"cols\":");
    args.push_str(&span.0.to_string());
    args.push_str(",\"rows\":");
    args.push_str(&span.1.to_string());
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
    use crate::frame_shm::TRANSPORT_VAR;
    use crate::frame_shm::layout::{Descriptor, HEADER_LEN};
    use crate::frame_shm::mapping::testing::Reader;

    /// `pairs` and nothing else, which is deliberately not `of_process()`: the
    /// suite may itself be running in an agwinterm pane whose `TERMINAL_BROWSER_*`
    /// is set, and a test that appended to the developer's budget file would be
    /// measuring itself.
    fn env_of(pairs: &[(&str, &str)]) -> crate::terminal::SessionEnv {
        crate::terminal::SessionEnv::of_session(
            pairs
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect(),
        )
    }

    /// The file path, asked for by name, and no budget file.
    ///
    /// The tests below drive a fixture that answers `ok` to anything, and under
    /// `auto` that fixture is a host with the fast path: the first request would
    /// be an `image.frameshm` and the frame would never reach disk. Forcing the
    /// file path is what `TERMINAL_BROWSER_FRAME_TRANSPORT=file` is for.
    fn file_only() -> crate::terminal::SessionEnv {
        env_of(&[(TRANSPORT_VAR, "file")])
    }

    /// The same, plus a budget file at `path`.
    fn budget_to(path: &Path) -> crate::terminal::SessionEnv {
        env_of(&[
            (TRANSPORT_VAR, "file"),
            (BUDGET_ENV, &path.display().to_string()),
        ])
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

    /// The *frames* in a publisher's directory, which is what retention is about.
    /// [`PANE_FILE`] sits beside them and is not one; the tests that care about the
    /// marker name it directly.
    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("the publisher's directory exists")
            .flatten()
            .filter(|entry| entry.file_name() != PANE_FILE)
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
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");
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
            let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");
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
    fn a_directory_a_killed_browser_left_behind_is_not_adopted() {
        // Windows recycles pids, only a clean `Drop` removes a frame directory, and
        // `sweep_stale` leaves anything younger than an hour alone. So a new browser
        // can be handed a dead one's name — and adopting it puts `frame-00000000.png`
        // on top of a file that exists, which `write_all_new` refuses and
        // `Terminal::draw` turns into the end of the browser.
        let root = std::env::temp_dir().join(format!("frame-collide-{}", std::process::id()));
        fs::create_dir_all(&root).expect("a root");

        // The counter never repeats inside one process, so the collision has to be
        // staged the way a dead browser stages it: by taking the name this process
        // is about to ask for next.
        let first = FrameDir::create_in(&root).expect("the first name is free");
        let name = first.path.file_name().expect("a name").to_string_lossy();
        let next = name
            .rsplit_once('-')
            .and_then(|(head, seq)| Some(format!("{head}-{}", seq.parse::<u32>().ok()? + 1)))
            .expect("the name ends in the counter");
        let squatted = root.join(&next);
        fs::create_dir(&squatted).expect("the name a dead browser holds");
        fs::write(squatted.join("frame-00000000.png"), b"x").expect("its leftover frame");

        let second = FrameDir::create_in(&root).expect("a name of its own");
        assert_ne!(
            second.path, squatted,
            "the publisher adopted a directory that was not empty",
        );
        assert!(
            !second.path.join("frame-00000000.png").exists(),
            "the first frame would have collided with a file already there",
        );

        drop(second);
        drop(first);
        fs::remove_dir_all(&root).ok();
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
        sweep_stale(&root, STALE_AFTER, MARKED_STALE_AFTER);
        assert!(ours.is_dir(), "a directory in use was swept");

        // Past the threshold, which is what "the process that owned it is gone"
        // means here — see `sweep_stale` on why liveness is not asked directly.
        sweep_stale(&root, Duration::ZERO, MARKED_STALE_AFTER);
        assert!(!ours.exists(), "a stale frame directory survived the sweep");
        assert!(
            unrelated.is_dir(),
            "the sweep deleted something that was never ours",
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_wreck_that_names_a_pane_outlives_the_ordinary_sweep() {
        // The unmarked half of this is `a_directory_a_dead_process_left_behind_is_
        // swept_up`; what is pinned here is that the marker changes the answer. A
        // wreck naming a pane is the whole of `pane-clear`'s evidence, and the run
        // this verb was written for came back to its pane eighteen hours later —
        // well past `STALE_AFTER`, and any browser launched in any *other* pane
        // meanwhile sweeps this root.
        let root = std::env::temp_dir().join(format!("frame-sweep-marked-{}", std::process::id()));
        fs::create_dir_all(&root).expect("a root to sweep");
        let marked = root.join(format!("{DIR_PREFIX}18-0"));
        let bare = root.join(format!("{DIR_PREFIX}19-0"));
        for dir in [&marked, &bare] {
            fs::create_dir_all(dir).expect("a directory");
            fs::write(dir.join("frame-00000000.png"), b"x").expect("a file in it");
        }
        fs::write(marked.join(PANE_FILE), "pipe\tsession").expect("a pane marker");

        // Long past the hour an unmarked wreck gets, and inside the week a marked
        // one does: the evidence survives exactly where the recovery needs it to.
        sweep_stale(&root, Duration::ZERO, MARKED_STALE_AFTER);
        assert!(
            marked.is_dir(),
            "the sweep took the only evidence `pane-clear` accepts",
        );
        assert!(!bare.exists(), "an unmarked stale wreck survived");

        // And it is retained, not exempt: past its own threshold it goes too, so a
        // pane wrecked and never repaired is not an unbounded leak.
        sweep_stale(&root, Duration::ZERO, Duration::ZERO);
        assert!(!marked.exists(), "a marked wreck is never reclaimed");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_new_publisher_sweeps_before_it_writes() {
        // The sweep is on the construction path, which is the only place it runs.
        let publisher = FramePublisher::new(&file_only()).expect("a temp directory");
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
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");
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
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");

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
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");

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
    fn a_write_that_failed_part_way_takes_its_file_with_it() {
        // The one litter a later frame cannot account for: `publish_encoded` returns
        // through `?` before either of its own `remove_file` cleanups, and the path
        // never reached `self.written`, so `reap` will never see it either. It
        // matters because the CLI reads ownership off the filesystem — frames present
        // with no `PANE_FILE` marker is exactly the shape `allOwnedFrames` adopts on
        // the pid path, and clearing on that evidence takes down a placement some
        // other producer owns.
        let dir = std::env::temp_dir().join(format!("pixel-partial-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("a temp directory");
        let path = dir.join("frame-00000000.png");

        let file = fs::File::create(&path).expect("a file to write into");
        assert!(
            path.exists(),
            "the test did not create what it is about to lose"
        );
        let err = discard_partial(
            &path,
            file,
            Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "the volume filled",
            )),
        )
        .expect_err("a failed write is a failed frame");
        assert_eq!(
            err.kind(),
            io::ErrorKind::WriteZero,
            "the error was swallowed"
        );
        assert!(
            !path.exists(),
            "a truncated frame was left for the CLI to adopt"
        );

        // And the successful path is the same function, so this pins the one that runs.
        let file = fs::File::create(&path).expect("a file to write into");
        discard_partial(&path, file, Ok(())).expect("a good write");
        assert!(
            path.exists(),
            "a frame that was written fine was removed anyway"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_host_that_dropped_the_pipe_still_gets_the_frame() {
        // The client replays once on a dropped connection, re-sending the same
        // path — which is why the retention window is more than one frame deep.
        let server = PipeServer::scripted(vec![Turn::Hangup, Turn::Reply(ok_frame())]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");

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
        // Reads the log, so it takes the lock like every other reader. See
        // [`SHARED_LOG`].
        let _alone = alone_with_the_log();
        // `frame:1/0` is the silent-stale-image failure: the host placed an image
        // but never read our bytes. It cannot happen through a unique path unless
        // the read itself failed, so it is worth saying out loud.
        let mark = log_mark();
        let server = PipeServer::always(r#"{"ok":true,"result":"frame:1/0"}"#);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");
        let marker = publisher.dir().join(PANE_FILE);

        for _ in 0..3 {
            publisher
                .publish(&mut client, &canvas(16, 16), (1, 1))
                .expect("a placed frame is still a delivered frame");
        }
        // Complained about, and still ours. `placed > 0` is a placement whatever the
        // host then read, so the pane is marked and the frames stay on disk — a
        // warning that also quietly dropped ownership would leave the stale picture
        // on the pane after this publisher exits, which is worse than the staleness
        // it is warning about.
        assert!(marker.exists(), "a placed frame claimed no pane");
        assert_eq!(
            frame_files(publisher.dir()),
            3,
            "the placed frames were deleted as litter",
        );
        // Counted, not latched. `warned_untransmitted == true` shows "at least
        // once", which is the half of the claim that was never in doubt; the half
        // worth testing is that three stale frames do not produce three lines in a
        // log the user is reading at 26 frames a second.
        let said = warnings_since(mark, "but read");
        assert_eq!(said.len(), 1, "said once, or not at all: {said:?}");

        assert_eq!(frame_counts("frame:1/1"), Some((1, 1)));
        assert_eq!(frame_counts("\"frame:2/0\""), Some((2, 0)));
        assert_eq!(
            frame_counts("shown"),
            None,
            "another verb's reply is not counts"
        );
    }

    #[test]
    fn a_reply_this_build_cannot_parse_still_counts_as_a_placement() {
        // The other end of the `frame:0/0` rule, and the reason `check_transmitted`
        // defaults to *yes*: a reply `frame_counts` cannot read is a host whose reply
        // format grew a field, not a host that placed nothing. Reading it as "nothing
        // was placed" would make this publisher silently stop owning its frames that
        // day — and a publisher that owns nothing sends no `image.clear`, so the page
        // it drew stays on the pane after it exits.
        //
        // Writes no warning and reads no log, so it needs no lock: the unparseable
        // arm returns before the complaint. See [`SHARED_LOG`].
        let server = PipeServer::always(r#"{"ok":true,"result":"shown"}"#);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");
        let marker = publisher.dir().join(PANE_FILE);

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the host answered");

        assert!(marker.exists(), "a placed frame claimed no pane");
        assert_eq!(
            frame_files(publisher.dir()),
            1,
            "the placed frame was deleted as litter",
        );

        publisher
            .clear(&mut client)
            .expect("the placement is ours to take back");
        let spoken = server.requests();
        assert_eq!(spoken.len(), 2, "one frame and one clear: {spoken:?}");
        assert!(
            spoken[1].contains(CLEAR_CMD),
            "the publisher left its own picture on the pane: {spoken:?}",
        );
    }

    /// The frames in a publisher's directory, which is everything in it but the
    /// marker — [`PANE_FILE`] is deliberately exempt from the retention reaping.
    fn frame_files(dir: &Path) -> usize {
        fs::read_dir(dir)
            .expect("the directory outlives the frames")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name() != PANE_FILE)
            .count()
    }

    #[test]
    fn a_frame_the_host_could_not_open_at_all_is_complained_about_too() {
        // Three other tests below publish to a host that places nothing, so they
        // write the very line this one counts. See [`SHARED_LOG`].
        let _alone = alone_with_the_log();
        // `frame:0/0` is the *other* silent failure, and the one a
        // `transmitted < placed` test steps straight over because `0 < 0` is false.
        // agwinterm skips an image whose file it cannot open before it counts it, so
        // a frame directory the host process cannot read answers success on every
        // frame while the pane stays blank -- the clear phase has already run.
        let mark = log_mark();
        let server = PipeServer::always(r#"{"ok":true,"result":"frame:0/0"}"#);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");

        for _ in 0..3 {
            publisher
                .publish(&mut client, &canvas(16, 16), (1, 1))
                .expect("the host answered, so the write itself succeeded");
        }
        let said = warnings_since(mark, "placed none of the frame");
        assert_eq!(said.len(), 1, "said once, or not at all: {said:?}");
        assert!(
            said[0].contains(".png"),
            "the complaint must name the path the host could not open: {}",
            said[0],
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

    // -- taking the frame back off the pane --------------------------------
    //
    // A frame is a placement the host holds, so an exiting browser leaves a page
    // painted over a pane that has gone back to being a shell. Task 14's acceptance
    // check — "a killed browser leaves the pane usable as a terminal" — is about
    // this, and found it: the shell underneath was running and answering, and none
    // of it was readable.

    #[test]
    fn the_way_out_takes_the_picture_with_it() {
        let server = PipeServer::answering(&ok_frame(), 2);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the frame goes out");
        publisher.clear(&mut client).expect("and comes back off");

        let requests = server.requests();
        assert!(
            requests.last().is_some_and(|last| last.contains(CLEAR_CMD)),
            "the last thing said was not {CLEAR_CMD}: {requests:?}",
        );
    }

    #[test]
    fn a_publisher_that_never_drew_clears_nothing() {
        // The placement on that pane belongs to whoever *did* draw it. A browser
        // that failed before its first frame must not take someone else's picture
        // down on its way out.
        let server = PipeServer::answering(&ok_frame(), 1);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");

        publisher.clear(&mut client).expect("nothing to do");

        assert!(
            server.requests().is_empty(),
            "it spoke anyway: {:?}",
            server.requests(),
        );
    }

    #[test]
    fn a_host_that_refuses_the_clear_is_still_an_exit() {
        // This runs from `Drop`, usually because something already went wrong. A
        // refusal is reported to the caller — which is what makes it testable — but
        // the caller is an exit path that has nothing left to do about it.
        //
        // The frame has to land first: a publisher whose every frame was refused has
        // placed nothing, and the test below is that it stays quiet.
        let server = PipeServer::scripted(vec![
            Turn::Reply(ok_frame()),
            Turn::Reply(r#"{"ok":false,"error":"no session"}"#.to_owned()),
        ]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the host takes the frame");
        publisher
            .clear(&mut client)
            .expect_err("and says so rather than pretending");
    }

    #[test]
    fn a_refused_clear_leaves_the_evidence_the_cli_recovers_from() {
        // The two layers of the guarantee, and the case where they overlap.
        // `Terminal::clear_frame` swallows the error above on purpose, and the CLI's
        // own `image.clear` is what covers it — but the CLI decides whether to send
        // one by looking for this directory (`ownedFrames`, `cli/src/pane.ts`).
        // Removing it here would answer "nothing was ever placed" about a pane that
        // is still holding a page, so the second layer would fail on exactly the exit
        // where the first one already had.
        let server = PipeServer::scripted(vec![
            Turn::Reply(ok_frame()),
            Turn::Reply(r#"{"ok":false,"error":"no session"}"#.to_owned()),
        ]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");
        let dir = publisher.dir().to_owned();

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the host takes the frame");
        publisher
            .clear(&mut client)
            .expect_err("the host will not take it back");
        drop(publisher);

        assert!(
            dir.is_dir(),
            "the only record that the pane is still painted was deleted on the way out",
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_ordinary_exit_still_takes_its_directory_with_it() {
        // The other side of the rule above: a clear the host answered leaves nothing
        // for `pane-clear` to find, which is what makes "nothing of ours to clear"
        // and "cleared" different reports rather than the same one twice.
        let server = PipeServer::answering(&ok_frame(), 2);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");
        let dir = publisher.dir().to_owned();

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the frame goes out");
        publisher.clear(&mut client).expect("and comes back off");
        drop(publisher);

        assert!(!dir.exists(), "a repaired pane left a wreck behind it");
    }

    #[test]
    fn the_first_accepted_frame_names_the_pane_it_landed_on() {
        // What `pane-clear` has instead of a pid. The verb runs when the process is
        // gone and the CLI that spawned it usually with it, so without this the only
        // question it can ask is "which frame directory on this machine is newest" —
        // and two panes wrecked at once means one of them repaired on the other's
        // evidence. See [`PANE_FILE`].
        let server = PipeServer::always(&ok_frame());
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");
        let marker = publisher.dir().join(PANE_FILE);
        let expected = format!(
            "{}\n{}\n",
            client.target().pipe(),
            client.target().session()
        );

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the host takes the frame");

        let written = fs::read_to_string(&marker).expect("a marker beside the first frame");
        assert_eq!(written, expected);
    }

    #[test]
    fn a_directory_recreated_under_the_publisher_names_its_pane_again() {
        // The two recoveries have to compose. `write_frame` recreates a directory
        // something removed under a live publisher — and what removes it, whether
        // that is a cleaner or another browser's `sweep_stale`, takes the marker
        // with it. An idle browser is the realistic case: `sweep_stale` reads age,
        // and a publisher that is not repainting writes nothing to keep its
        // timestamp fresh. Without the marker put back, every frame after that is
        // one `pane-clear` cannot attribute, so killing this browser would leave a
        // pane painted and unrecoverable.
        let server = PipeServer::always(&ok_frame());
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");
        let marker = publisher.dir().join(PANE_FILE);
        let expected = format!(
            "{}\n{}\n",
            client.target().pipe(),
            client.target().session()
        );

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the host takes the first frame");
        fs::remove_dir_all(publisher.dir()).expect("the sweep takes the whole directory");
        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the directory is recreated rather than the frame lost");

        let written = fs::read_to_string(&marker).expect("a marker beside the frame again");
        assert_eq!(written, expected);
    }

    #[test]
    fn a_frame_the_host_refused_names_no_pane() {
        // Same rule as `clear`'s `written.is_empty()`: nothing was placed, so there is
        // no pane to claim. A marker here would let `pane-clear` adopt — and delete —
        // a directory whose frames never reached a pane at all.
        let server = PipeServer::always(r#"{"ok":false,"error":"no session"}"#);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");
        let marker = publisher.dir().join(PANE_FILE);

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect_err("the host refuses the frame");

        assert!(!marker.exists(), "a refused frame claimed a pane anyway");
    }

    #[test]
    fn a_publisher_whose_first_frame_was_refused_clears_nothing_either() {
        // The seq-versus-written distinction. An attempted frame bumps the sequence
        // whether or not the host took it, so a browser that started in a pane
        // already holding someone else's image, failed its very first frame and
        // exited would have cleared that placement on the way out.
        let server = PipeServer::always(r#"{"ok":false,"error":"no session"}"#);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect_err("the host refuses the frame");
        publisher.clear(&mut client).expect("nothing to take back");

        let spoken = server.requests();
        assert_eq!(
            spoken.len(),
            1,
            "it asked for a clear it had never earned: {spoken:?}",
        );
        assert!(
            spoken[0].contains(FRAME_CMD),
            "the one request was not the refused frame: {spoken:?}",
        );
    }

    #[test]
    fn a_frame_the_host_placed_none_of_names_no_pane_either() {
        // This writes the warning the "complained about too" test above counts, so
        // the two do not run at once. See [`SHARED_LOG`].
        let _alone = alone_with_the_log();
        // `frame:0/0` is the same state as a refusal — nothing reached the pane —
        // wearing an `ok:true` envelope, which is exactly why it needs its own test:
        // the refusal path is an `Err` and this one is not. A marker here would let
        // `pane-clear` claim a pane this browser never painted, and delete the
        // directory of whoever did.
        let server = PipeServer::always(r#"{"ok":true,"result":"frame:0/0"}"#);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");
        let marker = publisher.dir().join(PANE_FILE);

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the host answered, so the write itself succeeded");

        assert!(!marker.exists(), "a frame nobody placed claimed a pane");
        let left: Vec<_> = fs::read_dir(publisher.dir())
            .expect("the directory outlives the frame")
            .map(|entry| entry.expect("a readable entry").file_name())
            .collect();
        assert!(
            left.is_empty(),
            "the unplaced frame is litter, not history: {left:?}",
        );
    }

    #[test]
    fn a_publisher_the_host_placed_nothing_for_clears_nothing() {
        // This writes the warning the "complained about too" test above counts, so
        // the two do not run at once. See [`SHARED_LOG`].
        let _alone = alone_with_the_log();
        // The `written` half of the same rule. Three `ok:true` replies that placed
        // nothing must leave the publisher as empty-handed as three refusals do, or
        // its exit takes down the placement whoever *can* reach the directory made.
        let server = PipeServer::always(r#"{"ok":true,"result":"frame:0/0"}"#);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&file_only()).expect("a temp directory");

        for _ in 0..3 {
            publisher
                .publish(&mut client, &canvas(16, 16), (1, 1))
                .expect("the host answered, so the write itself succeeded");
        }
        publisher.clear(&mut client).expect("nothing to take back");

        let spoken = server.requests();
        assert!(
            spoken.iter().all(|request| request.contains(FRAME_CMD)),
            "it asked for a clear it had never earned: {spoken:?}",
        );
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
    fn a_frame_the_host_placed_nowhere_is_not_in_the_budget_either() {
        // `frame:0/0` is the same state as a refusal wearing an `ok:true` envelope,
        // and `publish_encoded` says so in as many words. The budget has to agree, or
        // a pane that was never painted at all — which is what a host that cannot open
        // the frame directory answers, on every frame — produces a full-rate file, and
        // `docs/design/02-frame-budget.md` is read off that file.
        // This writes the warning the "complained about too" test counts, so the two
        // do not run at once. See [`SHARED_LOG`].
        let _alone = alone_with_the_log();
        let scratch = scratch_dir("budget-placed-nowhere");
        let path = scratch.join("frames.tsv");
        let server = PipeServer::always(r#"{"ok":true,"result":"frame:0/0"}"#);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&budget_to(&path)).expect("a temp directory");

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("nothing placed is not an error the engine can act on");
        drop(publisher);

        let text = fs::read_to_string(&path).expect("the header is written on open");
        assert!(
            text.lines()
                .all(|line| line.starts_with('#') || line.is_empty()),
            "a frame that reached no pane was counted:\n{text}"
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

    // -- the transport, and the host that lacks the fast one ----------------

    /// An empty environment plus a forced transport.
    fn transport_of(value: &str) -> crate::terminal::SessionEnv {
        env_of(&[(TRANSPORT_VAR, value)])
    }

    /// The log store is one per process and `cargo test` runs these in threads, so
    /// two tests reading it at once would each count the other's line. Held for the
    /// whole of each such test — the window being guarded is "publish, then read the
    /// log", not either half.
    ///
    /// Every test that *writes* a line one of these readers would match takes it too,
    /// reader or not: publishing is the half that writes, and a warning is a warning
    /// whichever test provoked it. That is the whole of the discipline — a new test
    /// that publishes under `shm`, or to a host that places nothing, and does not take
    /// this lock makes a *different* test flaky.
    static SHARED_LOG: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn alone_with_the_log() -> std::sync::MutexGuard<'static, ()> {
        SHARED_LOG.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// The next log sequence, so a test reads only its own lines.
    fn log_mark() -> u64 {
        crate::logging::entries_after(0)
            .last()
            .map_or(0, |entry| entry.seq + 1)
    }

    /// The *warnings* since `mark` that mention `needle`. Warnings only: a host
    /// without the fast path is the ordinary case under `auto`, and the line that
    /// records it is information, not an apology.
    fn warnings_since(mark: u64, needle: &str) -> Vec<String> {
        crate::logging::entries_after(mark)
            .into_iter()
            .filter(|entry| entry.level == crate::logging::LogLevel::Warn)
            .filter(|entry| entry.message.contains(needle))
            .map(|entry| entry.message)
            .collect()
    }

    /// The host's literal refusal of a verb it lacks, as `Reply::parse` receives
    /// it: .NET escapes the apostrophes (`agwinterm.rs` has the same literal for
    /// `session.metrics`).
    fn unknown_verb() -> &'static str {
        r#"{"ok":false,"error":"unknown command \u0027image.frameshm\u0027"}"#
    }

    fn refusal(why: &str) -> String {
        format!(r#"{{"ok":false,"error":"{why}"}}"#)
    }

    /// A fixture answering `lines`, one per request, in order.
    fn scripted(lines: &[&str]) -> PipeServer {
        PipeServer::scripted(
            lines
                .iter()
                .map(|line| Turn::Reply((*line).to_owned()))
                .collect(),
        )
    }

    /// The verb of every request the fixture saw, in order.
    fn verbs(server: &PipeServer) -> Vec<String> {
        server
            .requests()
            .iter()
            .map(|request| {
                let rest = request
                    .strip_prefix(r#"{"cmd":""#)
                    .expect("a request opens with its verb");
                rest[..rest.find('"').expect("the verb closes")].to_owned()
            })
            .collect()
    }

    /// The name of the mapping the publisher's last fast-path frame went into.
    fn mapping_of(publisher: &FramePublisher) -> String {
        publisher
            .producer
            .as_ref()
            .and_then(Producer::current_name)
            .expect("the fast path has a mapping")
            .to_owned()
    }

    #[test]
    fn asking_for_a_fast_path_the_host_lacks_still_publishes_over_the_file_one() {
        // Every agwinterm release as of 2026-09, and agliteterm for good: the first
        // request is answered `unknown command`, and from then on the frames go
        // out as `image.frame` — including the one that was refused. A request for
        // a transport the host lacks must never cost a frame.
        //
        // This one reads no log, but publishing under `shm` *writes* one, and a
        // reader holding the lock would otherwise count this line as its own.
        let _alone = alone_with_the_log();
        let server = scripted(&[unknown_verb(), &ok_frame(), &ok_frame(), &ok_frame()]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&transport_of("shm")).expect("a temp directory");

        for _ in 0..3 {
            publisher
                .publish(&mut client, &canvas(24, 8), (2, 1))
                .expect("the frame goes out on the path that exists");
        }
        assert_eq!(
            verbs(&server),
            [
                "image.frameshm",
                "image.frame",
                "image.frame",
                "image.frame"
            ],
            "asked once, then never again",
        );
        assert_eq!(
            files_in(publisher.dir()).len(),
            3,
            "every frame reached disk"
        );
    }

    #[test]
    fn the_unavailable_fast_path_is_said_once_and_not_per_frame() {
        // A frame loop that logs every frame is a frame loop measuring itself, and
        // the budget file would be measuring the logging.
        let _alone = alone_with_the_log();
        let mark = log_mark();
        let ok = ok_frame();
        let server = scripted(&[unknown_verb(), &ok, &ok, &ok, &ok, &ok]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&transport_of("shm")).expect("a temp directory");

        for _ in 0..5 {
            publisher
                .publish(&mut client, &canvas(16, 16), (1, 1))
                .expect("every frame");
        }

        let said = warnings_since(mark, FRAMESHM_CMD);
        assert_eq!(said.len(), 1, "said {} times: {said:?}", said.len());
        assert!(
            said[0].contains("unknown command"),
            "the reason is the host's answer, not a missing layout: {}",
            said[0]
        );
    }

    #[test]
    fn the_path_that_exists_is_never_apologised_for() {
        // `file` gets what it asked for, and `auto` asked for whichever works, so
        // neither may warn — not even on the host that lacks the fast path, where
        // the line that records the choice is information.
        let _alone = alone_with_the_log();
        for value in ["file", "auto", ""] {
            let mark = log_mark();
            let ok = ok_frame();
            let server = if value == "file" {
                scripted(&[&ok, &ok])
            } else {
                scripted(&[unknown_verb(), &ok, &ok, &ok])
            };
            let mut client = server.client();
            let mut publisher =
                FramePublisher::new(&transport_of(value)).expect("a temp directory");
            for _ in 0..2 {
                publisher
                    .publish(&mut client, &canvas(16, 16), (1, 1))
                    .expect("every frame");
            }
            let said = warnings_since(mark, FRAMESHM_CMD);
            assert!(said.is_empty(), "{value:?} was warned about: {said:?}");
        }
    }

    #[test]
    fn a_frame_that_fails_does_not_swallow_the_transport_explanation() {
        // The explanation is owed to the run, not to the first *successful* frame:
        // a host that refuses every frame is exactly when knowing which transport
        // is in play matters most.
        let _alone = alone_with_the_log();
        let mark = log_mark();
        let server = scripted(&[unknown_verb(), &refusal("no session")]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&transport_of("shm")).expect("a temp directory");

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect_err("the host refuses the file frame too");

        assert_eq!(warnings_since(mark, FRAMESHM_CMD).len(), 1);
    }

    // -- the fast path ---------------------------------------------------------

    #[test]
    fn a_frame_goes_out_as_one_image_frameshm_request_repeating_its_slot() {
        let server = PipeServer::always(&ok_frame());
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&transport_of("auto")).expect("a temp directory");

        let bytes = publisher
            .publish(&mut client, &canvas(1920, 1080), (120, 30))
            .expect("the host takes it");
        assert_eq!(
            bytes,
            1920 * 1080 * 4,
            "what carried the frame is the pixels copied"
        );

        let name = mapping_of(&publisher);
        assert!(
            name.starts_with(&format!(
                r"Local\agwinterm-frame-browser-{}-",
                std::process::id()
            )),
            "{name}"
        );
        let mut quoted = String::new();
        push_quoted(&mut quoted, &name);
        assert_eq!(
            server.requests(),
            vec![format!(
                r#"{{"cmd":"image.frameshm","target":"s3","args":{{"images":[{{"id":1,"name":{quoted},"slot":1,"seq":1,"width":1920,"height":1080,"stride":7680,"format":32,"row":0,"col":0,"cols":120,"rows":30}}]}}}}"#
            )],
        );
        // No encode and no file: the frame is in the mapping, published.
        assert_eq!(files_in(publisher.dir()), Vec::<String>::new());
        let reader = Reader::open(&name, HEADER_LEN).expect("the mapping is alive");
        assert_eq!(reader.ready(), 1, "and its header says the frame is there");
    }

    #[test]
    fn frameshm_args_is_the_specs_json_and_places_like_image_frame() {
        let published = Published {
            slot: 1,
            seq: 7,
            descriptor: Descriptor {
                width: 1920,
                height: 1080,
                stride: 7680,
                format: 32,
            },
        };
        let args = frameshm_args(
            r"Local\agwinterm-frame-browser-4812-0",
            published,
            (120, 30),
        );
        assert_eq!(
            args,
            r#"{"images":[{"id":1,"name":"Local\\agwinterm-frame-browser-4812-0","slot":1,"seq":7,"width":1920,"height":1080,"stride":7680,"format":32,"row":0,"col":0,"cols":120,"rows":30}]}"#
        );
        // The two verbs are siblings: the placement is one function, so a frame
        // lands in the same place whichever carried it.
        let placement = r#","row":0,"col":0,"cols":120,"rows":30}]}"#;
        assert!(args.ends_with(placement), "{args}");
        let file = frame_args(Path::new(r"C:\f\frame-00000001.png"), (120, 30));
        assert!(file.ends_with(placement), "{file}");
    }

    #[test]
    fn a_host_without_the_verb_latches_the_file_path_and_drops_no_frame() {
        let _alone = alone_with_the_log();
        let server = scripted(&[unknown_verb(), &ok_frame(), &ok_frame()]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&transport_of("auto")).expect("a temp directory");

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the same frame goes out over the file");
        assert_eq!(verbs(&server), ["image.frameshm", "image.frame"]);
        assert_eq!(
            files_in(publisher.dir()).len(),
            1,
            "the frame the host would not take over shm reached disk"
        );
        assert_eq!(publisher.fast_path, Latched::Unavailable);
        assert!(
            publisher.producer.is_none(),
            "a mapping no host will read is not kept alive"
        );

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the next frame");
        assert_eq!(
            verbs(&server),
            ["image.frameshm", "image.frame", "image.frame"],
            "the host is not asked again"
        );
    }

    #[test]
    fn a_refusal_for_any_other_reason_costs_no_frame_and_does_not_latch() {
        // `no such pane`, a bad slot, a mapping the host could not open: real
        // errors about this frame, said out loud, and the frame goes out over the
        // file — but one of them is not a capability gap, and the next frame asks
        // again.
        let _alone = alone_with_the_log();
        let mark = log_mark();
        let server = scripted(&[&refusal("no such pane"), &ok_frame(), &ok_frame()]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&transport_of("auto")).expect("a temp directory");

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("over the file");
        assert_eq!(verbs(&server), ["image.frameshm", "image.frame"]);
        assert_eq!(publisher.fast_path, Latched::Open);
        assert_eq!(publisher.refusals.len(), 1);

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("over the mapping");
        assert_eq!(
            verbs(&server),
            ["image.frameshm", "image.frame", "image.frameshm"],
            "the fast path is tried again"
        );
        assert!(
            publisher.refusals.is_empty(),
            "an accepted frame resets the count"
        );
        let said = warnings_since(mark, "no such pane");
        assert_eq!(said.len(), 1, "the host's message is logged: {said:?}");
    }

    #[test]
    fn three_refusals_in_a_row_latch_the_fast_path_off_and_say_which() {
        let _alone = alone_with_the_log();
        let mark = log_mark();
        let ok = ok_frame();
        let server = scripted(&[
            &refusal("no such pane"),
            &ok,
            &refusal("slot 0 overruns the view"),
            &ok,
            &refusal("bad magic"),
            &ok,
            &ok,
        ]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&transport_of("auto")).expect("a temp directory");

        for _ in 0..4 {
            publisher
                .publish(&mut client, &canvas(16, 16), (1, 1))
                .expect("every frame goes out");
        }
        assert_eq!(
            verbs(&server),
            [
                "image.frameshm",
                "image.frame",
                "image.frameshm",
                "image.frame",
                "image.frameshm",
                "image.frame",
                "image.frame",
            ],
            "three tries, then the file path without asking"
        );
        assert_eq!(publisher.fast_path, Latched::Unavailable);
        assert!(publisher.producer.is_none());
        let said = warnings_since(mark, "3 frames in a row");
        assert_eq!(said.len(), 1, "{said:?}");
        for why in ["no such pane", "slot 0 overruns the view", "bad magic"] {
            assert!(
                said[0].contains(why),
                "the line names all three: {}",
                said[0]
            );
        }
    }

    #[test]
    fn an_accepted_frame_resets_the_refusal_count() {
        let _alone = alone_with_the_log();
        let ok = ok_frame();
        let server = scripted(&[
            &refusal("a"),
            &ok,
            &refusal("b"),
            &ok,
            &ok,
            &refusal("c"),
            &ok,
            &refusal("d"),
            &ok,
            &ok,
        ]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&transport_of("auto")).expect("a temp directory");

        for _ in 0..6 {
            publisher
                .publish(&mut client, &canvas(16, 16), (1, 1))
                .expect("every frame goes out");
        }
        assert_eq!(
            verbs(&server),
            [
                "image.frameshm",
                "image.frame",
                "image.frameshm",
                "image.frame",
                "image.frameshm",
                "image.frameshm",
                "image.frame",
                "image.frameshm",
                "image.frame",
                "image.frameshm",
            ],
        );
        assert_eq!(
            publisher.fast_path,
            Latched::Open,
            "four refusals, never three in a row"
        );
    }

    #[test]
    fn the_file_transport_sends_only_image_frame_and_builds_no_mapping() {
        let server = PipeServer::always(&ok_frame());
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&transport_of("file")).expect("a temp directory");

        for _ in 0..3 {
            publisher
                .publish(&mut client, &canvas(16, 16), (1, 1))
                .expect("every frame");
        }
        assert_eq!(verbs(&server), ["image.frame"; 3]);
        assert!(
            publisher.producer.is_none(),
            "`file` never constructs a producer"
        );
        assert_eq!(files_in(publisher.dir()).len(), 3);
    }

    #[test]
    fn each_publish_returns_only_after_its_own_reply() {
        // The contract's one producer rule (spec § Producer obligations): a slot is
        // not refilled until the reply for the frame that last used it has
        // returned. With two slots, frame N+2 refills frame N's slot, and it cannot
        // begin before frame N+1 was published, which cannot begin before `publish`
        // returned for frame N — so the rule is exactly "publish does not return
        // before the host has answered". A host that takes its time makes that
        // visible: every publish lasts at least the host's delay, and the fixture
        // never holds a request it has not yet answered when the next one arrives.
        let delay = Duration::from_millis(40);
        let server = PipeServer::scripted(vec![Turn::ReplyAfter(delay, ok_frame()); 3]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&transport_of("auto")).expect("a temp directory");
        let frame = canvas(16, 16);

        for seq in 1..=3u64 {
            let started = Instant::now();
            publisher
                .publish(&mut client, &frame, (1, 1))
                .expect("the host answers, slowly");
            assert!(
                started.elapsed() >= delay,
                "frame {seq} returned before its reply"
            );
            let reader = Reader::open(&mapping_of(&publisher), HEADER_LEN).expect("alive");
            assert_eq!(reader.ready(), seq, "the mapping says frame {seq} is there");
            assert_eq!(
                server.requests().len() as u64,
                seq,
                "one request per frame, and none ahead of a reply"
            );
        }
        let requests = server.requests();
        for (request, slot_seq) in requests.iter().zip([
            r#""slot":1,"seq":1"#,
            r#""slot":0,"seq":2"#,
            r#""slot":1,"seq":3"#,
        ]) {
            assert!(request.contains(slot_seq), "{request}");
        }
    }

    #[test]
    fn a_frame_the_host_placed_none_of_over_shm_goes_out_over_the_file() {
        // `frame:0/0` on this path is a host that cannot open the mapping — which
        // it will answer on every frame — so beyond not being a placement, it is a
        // refusal: this frame goes out over the file, and it counts.
        let _alone = alone_with_the_log();
        let mark = log_mark();
        let server = scripted(&[r#"{"ok":true,"result":"frame:0/0"}"#, &ok_frame()]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&transport_of("auto")).expect("a temp directory");

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the frame goes out, over the file");
        assert_eq!(verbs(&server), ["image.frameshm", "image.frame"]);
        assert_eq!(publisher.refusals.len(), 1, "counted with the refusals");
        assert!(
            publisher.dir().join(PANE_FILE).exists(),
            "the file frame is the placement that names the pane"
        );
        let said = warnings_since(mark, "placed none of the frame");
        assert_eq!(said.len(), 1, "{said:?}");
        assert!(
            said[0].contains("mapping"),
            "the complaint names the mapping, not a path: {}",
            said[0]
        );
    }

    #[test]
    fn a_shm_placement_is_owned_exactly_as_a_file_one() {
        // `pane-clear` ownership is about placements, not files: a frame that went
        // over the mapping names the pane it landed on, and is taken back on the
        // way out.
        let server = scripted(&[&ok_frame(), r#"{"ok":true,"result":"ok"}"#]);
        let mut client = server.client();
        let mut publisher = FramePublisher::new(&transport_of("auto")).expect("a temp directory");
        let expected = format!(
            "{}\n{}\n",
            client.target().pipe(),
            client.target().session()
        );

        publisher
            .publish(&mut client, &canvas(16, 16), (1, 1))
            .expect("the host takes the frame");
        let marker = publisher.dir().join(PANE_FILE);
        assert_eq!(fs::read_to_string(&marker).expect("a marker"), expected);
        assert!(publisher.placed);

        publisher.clear(&mut client).expect("the clear lands");
        assert_eq!(verbs(&server), ["image.frameshm", "image.clear"]);
    }

    /// A directory of this test's own, under the temp dir.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("winterm-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }
}
