mod capture;
mod diff;
mod events;
mod highlight;
#[cfg(target_os = "macos")]
mod iosurface;
mod markdown;
mod mend;
mod ops;
mod record;
#[cfg(target_os = "linux")]
mod shm;
mod surface;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::JoinHandle;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{JsFunction, Result};
use napi_derive::napi;
use pixel_core::{Engine, EngineConfig, TerminalColors, Waker, fontdue};
use serde_json::json;

use crate::events::event_json;
use crate::ops::{IdMap, apply_ops};
use crate::surface::{SurfaceCommand, SurfaceMailbox, SurfacePixels};

pub struct EncodeRecordingTask {
    job_json: String,
    progress: Option<ThreadsafeFunction<f64>>,
}

impl Task for EncodeRecordingTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        let progress = self.progress.clone();
        record::run(&self.job_json, &move |percent: f64| {
            if let Some(callback) = &progress {
                callback.call(Ok(percent), ThreadsafeFunctionCallMode::NonBlocking);
            }
        })
        .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}

pub struct FilmstripTask {
    dir: String,
    frames: Vec<u32>,
    tile_width: u32,
    width: u32,
    height: u32,
}

impl Task for FilmstripTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Vec<u8>> {
        let mut segment = capture::Segment::open(std::path::Path::new(&self.dir))
            .map_err(|e| Error::from_reason(format!("{}: {e}", self.dir)))?;
        let mut strip = pixel_core::Canvas::new(self.width, self.height);
        strip.fill([24, 24, 26, 255]);
        for (slot, &index) in self.frames.iter().enumerate() {
            let (pixels, w, h) = segment.frame(index as usize).map_err(err)?;
            strip.blit_scaled_rgba(
                (slot as u32 * self.tile_width) as f32,
                0.0,
                self.tile_width as f32,
                self.height as f32,
                pixels,
                w,
                h,
            );
        }
        Ok(strip.pixels)
    }

    fn resolve(&mut self, _env: Env, output: Vec<u8>) -> Result<Buffer> {
        Ok(Buffer::from(output))
    }
}

#[napi(ts_return_type = "Promise<Buffer>")]
pub fn capture_filmstrip(
    dir: String,
    frames: Vec<u32>,
    tile_width: u32,
    width: u32,
    height: u32,
) -> AsyncTask<FilmstripTask> {
    AsyncTask::new(FilmstripTask {
        dir,
        frames,
        tile_width,
        width,
        height,
    })
}

#[napi(ts_return_type = "Promise<void>")]
pub fn encode_recording(
    job_json: String,
    on_progress: Option<JsFunction>,
) -> Result<AsyncTask<EncodeRecordingTask>> {
    let progress = on_progress
        .map(|callback| {
            callback.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<f64>| {
                ctx.env.create_double(ctx.value).map(|value| vec![value])
            })
        })
        .transpose()?;
    Ok(AsyncTask::new(EncodeRecordingTask { job_json, progress }))
}

struct Autoprofile {
    stop_at: Option<std::time::Instant>,
}

// useful for headless profiling
impl Autoprofile {
    fn from_env(engine: &mut Engine) -> Self {
        let stop_at = std::env::var("TERMINAL_BROWSER_AUTOPROFILE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(|ms| std::time::Instant::now() + std::time::Duration::from_millis(ms));
        if stop_at.is_some() {
            engine.profile_start();
        }
        Self { stop_at }
    }

    fn tick(&mut self, engine: &mut Engine) {
        if self
            .stop_at
            .is_some_and(|at| std::time::Instant::now() >= at)
        {
            self.stop_at = None;
            if let Ok(Some(path)) = engine.profiler.toggle() {
                pixel_core::logging::info(
                    "profiler",
                    format!("autoprofile written to {}", path.display()),
                );
            }
        }
    }
}

/// The single thing `draw_frame` asks of the engine.
///
/// `draw_frame` is where a submitted frame stops being platform-shaped: on macOS it
/// arrives as an IOSurface, on Linux as a shared-memory region, and on Windows only
/// ever as an owned buffer. Naming that one dependency lets the Windows arm — the only
/// arm that compiles here — be exercised without an `Engine`, which cannot be built in
/// a test because `Engine::new` opens a real console.
trait SurfaceSink {
    fn draw_surface(
        &mut self,
        surface: u32,
        width: u32,
        height: u32,
        bgra: &[u8],
        stride: usize,
        damage: Option<pixel_core::surfaces::Rect>,
    ) -> std::io::Result<usize>;
}

impl SurfaceSink for Engine {
    fn draw_surface(
        &mut self,
        surface: u32,
        width: u32,
        height: u32,
        bgra: &[u8],
        stride: usize,
        damage: Option<pixel_core::surfaces::Rect>,
    ) -> std::io::Result<usize> {
        Engine::draw_surface(self, surface, width, height, bgra, stride, damage)
    }
}

fn draw_frame<S: SurfaceSink>(
    engine: &mut S,
    frame: &surface::SurfaceFrame,
) -> std::result::Result<u32, String> {
    match &frame.pixels {
        #[cfg(target_os = "macos")]
        SurfacePixels::IoSurface(surface) => {
            let locked = surface.lock()?;
            let len = locked.stride * locked.height as usize;
            draw_pixels(
                engine,
                frame,
                locked.width,
                locked.height,
                &locked.pixels()[..len],
                locked.stride,
            )
        }
        #[cfg(target_os = "linux")]
        SurfacePixels::Shm(surface) => {
            let len = surface.stride * surface.height as usize;
            draw_pixels(
                engine,
                frame,
                surface.width,
                surface.height,
                &surface.pixels()[..len],
                surface.stride,
            )
        }
        SurfacePixels::Owned {
            bgra,
            width,
            height,
        } => draw_pixels(engine, frame, *width, *height, bgra, *width as usize * 4),
    }
}

fn draw_pixels<S: SurfaceSink>(
    engine: &mut S,
    frame: &surface::SurfaceFrame,
    width: u32,
    height: u32,
    pixels: &[u8],
    stride: usize,
) -> std::result::Result<u32, String> {
    engine
        .draw_surface(frame.id, width, height, pixels, stride, frame.damage)
        .map(|_| height)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
#[napi(object)]
pub struct SurfaceShm {
    pub fd: i32,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub size: u32,
}

#[napi(object)]
pub struct DamageRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl DamageRect {
    fn into_rect(self) -> pixel_core::surfaces::Rect {
        pixel_core::surfaces::Rect {
            x: self.x,
            y: self.y,
            w: self.width,
            h: self.height,
        }
    }
}

static UI_FONT_BYTES: &[u8] = include_bytes!("../../../assets/fonts/InterVariable.ttf");
static MONO_FONT_BYTES: &[u8] =
    include_bytes!("../../../assets/fonts/JetBrainsMono-Regular.ttf");

const SYSTEM_UI_FONTS: &[&str] = &[
    "/System/Library/Fonts/SFNSRounded.ttf",
    "/System/Library/Fonts/SFNS.ttf",
];
const SYSTEM_MONO_FONTS: &[&str] = &["/System/Library/Fonts/SFNSMono.ttf"];

/// Whether the engine polls the terminal for its size, rather than being told.
///
/// Windows only: see the comment at the `EngineConfig` that reads it. Named
/// rather than written inline so a test can assert the per-platform value
/// without constructing an `Engine`, which needs a real console.
pub(crate) const WATCH_RESIZE: bool = cfg!(windows);

fn load_font(candidates: &[&str], fallback: &'static [u8]) -> fontdue::Font {
    let parse = |bytes: &[u8]| fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default());
    if cfg!(target_os = "macos") {
        for path in candidates {
            if let Ok(bytes) = std::fs::read(path)
                && let Ok(font) = parse(&bytes)
            {
                return font;
            }
        }
    }
    parse(fallback).expect("bundled font parses")
}

fn err(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

struct SendEngine(Engine);

#[allow(unsafe_code)]
unsafe impl Send for SendEngine {}

pub(crate) fn colors_json(colors: &TerminalColors) -> serde_json::Value {
    json!({
        "foreground": colors.foreground,
        "background": colors.background,
        "palette": colors.palette,
    })
}


#[napi]
pub struct PixelEngine {
    engine: Option<Engine>,
    info: String,
    tx: Sender<String>,
    rx: Option<Receiver<String>>,
    waker: Waker,
    surfaces: Arc<SurfaceMailbox>,
    captures: capture::Registry,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

#[napi]
impl PixelEngine {
    #[napi(constructor)]
    pub fn new(
        tty: Option<String>,
        wrapper: Option<String>,
        session_env: Option<std::collections::HashMap<String, String>>,
    ) -> Result<Self> {
        let fonts = vec![
            load_font(SYSTEM_UI_FONTS, UI_FONT_BYTES),
            load_font(SYSTEM_MONO_FONTS, MONO_FONT_BYTES),
        ];
        let session_env = match session_env {
            Some(env) => pixel_core::SessionEnv::of_session(env),
            None => pixel_core::SessionEnv::of_process(),
        };
        let mut engine = Engine::new(EngineConfig {
            fonts,
            cell_metrics_font: 1,
            // Windows has no SIGWINCH, and the one thing that stood in for it here does
            // not fire: `pixel-react` nudges the engine from `process.stdout.on("resize")`
            // (index.ts:583) in the no-tty shape, but Electron's stdout on Windows is a
            // pipe, not a `tty.WriteStream`, so that event never arrives. Without this
            // the pane resizes and the browser goes on drawing the old size — found at
            // the Task 10 milestone, where the frame was simply clipped by the pane.
            // `watch_resize` is the Windows backend's own analogue: `poll_event` caps its
            // wait at `RESIZE_POLL` and re-reads the screen buffer. It stays `false` off
            // Windows, where upstream's signal handler is the better mechanism.
            watch_resize: WATCH_RESIZE,
            tty,
            wrapper: pixel_core::wrapper::Wrapper::named(wrapper.as_deref()),
            session_env,
        })
        .map_err(err)?;
        let waker = engine.term.waker().map_err(err)?;
        engine.cpu_throttle.register_current_thread();
        let (width, height) = engine.comp.window;
        let (cell_w, cell_h) = engine.cell;
        let info = json!({
            "width": width,
            "height": height,
            "cellWidth": cell_w,
            "cellHeight": cell_h,
            "basePx": engine.base_px,
            "kittyKeyboard": engine.term.kitty_keyboard(),
            "colors": colors_json(&engine.colors),
        })
        .to_string();
        let (tx, rx) = channel();
        Ok(Self {
            engine: Some(engine),
            info,
            tx,
            rx: Some(rx),
            waker,
            // who even uses you tho
            surfaces: Arc::new(SurfaceMailbox::default()),
            captures: capture::Registry::default(),
            stop: Arc::new(AtomicBool::new(false)),
            thread: None,
        })
    }

    #[napi]
    pub fn info(&self) -> String {
        self.info.clone()
    }

    /*
    this is the function node calls to send data to rust
     */
    #[napi]
    pub fn apply_ops(&self, ops: String) -> Result<()> {
        let _ = self.tx.send(ops);
        self.waker.wake();
        Ok(())
    }

    #[napi]
    pub fn update_surface(
        &self,
        id: u32,
        bgra: Buffer,
        width: u32,
        height: u32,
        damage: Option<DamageRect>,
    ) -> Result<()> {
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| Error::from_reason("surface dimensions overflow"))?;
        let source = bgra.as_ref();
        if expected == 0 || source.len() < expected {
            return Err(Error::from_reason(format!(
                "surface buffer has {} bytes, expected {expected}",
                source.len()
            )));
        }
        let damage = damage.map(DamageRect::into_rect);
        self.captures
            .capture(id, &source[..expected], width as usize * 4, width, height, damage);
        let mut owned = self.surfaces.take_spare(id);
        owned.clear();
        owned.extend_from_slice(&source[..expected]);
        self.surfaces.submit(
            id,
            SurfacePixels::Owned {
                bgra: owned,
                width,
                height,
            },
            damage,
        );
        self.waker.wake();
        Ok(())
    }

    #[napi]
    pub fn remove_surface(&self, id: u32) {
        self.surfaces.remove(id);
        self.waker.wake();
    }

    #[napi]
    pub fn surface_stats(&self) -> String {
        let (submitted, coalesced, presented, rows) = self.surfaces.stats();
        json!({
            "submitted": submitted,
            "coalesced": coalesced,
            "presented": presented,
            "rows": rows,
        })
        .to_string()
    }

    #[napi]
    pub fn start_surface_capture(&self, surface_id: u32, dir: String) -> Result<u32> {
        self.captures
            .start(surface_id, std::path::Path::new(&dir))
            .map_err(err)
    }

    #[napi]
    pub fn stop_surface_capture(&self, capture_id: u32) -> Result<String> {
        let stats  = self.captures.stop(capture_id).map_err(err)?;
        Ok(json!({
            "frames": stats.frames,
            "drops": stats.drops,
            "durationMs": stats.duration_us as f64 / 1000.0,
        })
        .to_string())
    }

    #[napi]
    pub fn capture_index(&self, capture_id: u32) -> Result<String> {
        self.captures
            .with_segment(capture_id, |segment| {
                let frames: Vec<serde_json::Value> = segment
                    .metas()
                    .iter()
                    .map(|meta| {
                        json!({
                            "tMs": meta.t_us as f64 / 1000.0,
                            "key": meta.key,
                            "width": meta.width,
                            "height": meta.height,
                            "dropsBefore": meta.drops_before,
                        })
                    })
                    .collect();
                Ok(json!({
                    "frames": frames,
                    "drops": segment.drops,
                    "durationMs": segment.duration_us as f64 / 1000.0,
                })
                .to_string())
            })
            .map_err(err)
    }

    #[napi]
    pub fn capture_frame(&self, capture_id: u32, index: u32) -> Result<Buffer> {
        self.captures
            .with_segment(capture_id, |segment| {
                let (pixels, _, _) = segment.frame(index as usize)?;
                Ok(Buffer::from(pixels))
            })
            .map_err(err)
    }

    #[napi]
    pub fn release_capture(&self, capture_id: u32) {
        self.captures.release(capture_id);
    }

    #[napi]
    pub fn set_key_event_types(&mut self, enabled: bool) -> Result<()> {
        let engine = self
            .engine
            .as_mut()
            .ok_or_else(|| Error::from_reason("key reporting must be configured before start"))?;
        engine.term.set_key_event_types(enabled).map_err(err)
    }

    #[napi]
    pub fn start(&mut self, callback: JsFunction) -> Result<()> {
        let dispatch_to_node: ThreadsafeFunction<String> = callback
            .create_threadsafe_function(0, |ctx: ThreadSafeCallContext<String>| {
                Ok(vec![ctx.value])
            })?;
        let engine = self
            .engine
            .take()
            .ok_or_else(|| Error::from_reason("engine already started"))?;
        let rx = self
            .rx
            .take()
            .ok_or_else(|| Error::from_reason("engine already started"))?;
        let stop = self.stop.clone();
        let surfaces = self.surfaces.clone();
        let cell = SendEngine(engine);
        self.thread = Some(std::thread::spawn(move || {
            let cell = cell;
            let mut engine = cell.0;
            engine.set_default_menu(true);
            engine.emit_logs = true;
            let mut ids: Vec<IdMap> = (0..engine.comp.views.len())
                .map(|view| IdMap::new(engine.comp.views[view].tree.root()))
                .collect();
            let mut autoprofile = Autoprofile::from_env(&mut engine);
            let exit_error = loop {
                let events = match engine.pump(None) {
                    Ok(events) => events,
                    Err(e) => break Some(e.to_string()),
                };
                autoprofile.tick(&mut engine);
                if stop.load(Ordering::Relaxed) {
                    break None;
                }
                while let Ok(cmd) = rx.try_recv() {
                    let outcome = apply_ops(&mut engine, &mut ids, &cmd);
                    if let Some(message) = outcome.error {
                        pixel_core::logging::error("bridge", message.clone());
                        let error = json!({ "type": "error", "message": message });
                        dispatch_to_node.call(
                            Ok(error.to_string()),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                    for reply in outcome.replies {
                        dispatch_to_node.call(Ok(reply), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
                for event in &events {
                    if let Some(json) = event_json(event, &engine, &ids) {
                        dispatch_to_node.call(Ok(json), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
                let mut surface_error = None;
                for command in surfaces.take() {
                    match command {
                        SurfaceCommand::Frame(frame) => {
                            let result = draw_frame(&mut engine, &frame);
                            match result {
                                Ok(rows) => surfaces.recycle(frame, rows),
                                Err(error) => {
                                    surface_error = Some(error);
                                    break;
                                }
                            }
                        }
                        SurfaceCommand::Remove(id) => {
                            if let Err(error) = engine.delete_surface(id) {
                                surface_error = Some(error.to_string());
                                break;
                            }
                        }
                    }
                }
                if surface_error.is_some() {
                    break surface_error;
                }
            };
            drop(engine);
            if !stop.load(Ordering::Relaxed) {
                let exit = json!({ "type": "exit", "error": exit_error });
                dispatch_to_node.call(
                    Ok(exit.to_string()),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            }
        }));
        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.waker.wake();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.engine = None;
    }
}

#[cfg(target_os = "macos")]
#[napi]
impl PixelEngine {
    #[napi]
    pub fn update_surface_texture(
        &self,
        id: u32,
        handle: Buffer,
        damage: Option<DamageRect>,
    ) -> Result<()> {
        let surface =
            iosurface::RetainedSurface::from_handle(handle.as_ref()).map_err(Error::from_reason)?;
        let damage = damage.map(DamageRect::into_rect);
        if self.captures.wants(id) {
            let locked = surface.lock().map_err(Error::from_reason)?;
            self.captures.capture(
                id,
                locked.pixels(),
                locked.stride,
                locked.width,
                locked.height,
                damage,
            );
        }
        self.surfaces
            .submit(id, SurfacePixels::IoSurface(surface), damage);
        self.waker.wake();
        Ok(())
    }
}

#[cfg(target_os = "linux")]
#[napi]
impl PixelEngine {
    #[napi]
    pub fn update_surface_shm(
        &self,
        id: u32,
        shm: SurfaceShm,
        damage: Option<DamageRect>,
        released: Option<ThreadsafeFunction<u32>>,
    ) -> Result<()> {
        let release_hook = released.map(|tsfn| {
            Box::new(move || {
                tsfn.call(Ok(0), ThreadsafeFunctionCallMode::NonBlocking);
            }) as Box<dyn FnOnce() + Send>
        });
        let mut surface =
            match shm::ShmSurface::from_region(shm.fd, shm.width, shm.height, shm.stride, shm.size)
            {
                Ok(surface) => surface,
                Err(error) => {
                    if let Some(hook) = release_hook {
                        hook();
                    }
                    return Err(Error::from_reason(error));
                }
            };
        if let Some(hook) = release_hook {
            surface.set_on_drop(hook);
        }
        let damage = damage.map(DamageRect::into_rect);
        if self.captures.wants(id) {
            self.captures.capture(
                id,
                surface.pixels(),
                surface.stride,
                surface.width,
                surface.height,
                damage,
            );
        }
        self.surfaces
            .submit(id, SurfacePixels::Shm(surface), damage);
        self.waker.wake();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use pixel_core::surfaces::Rect;

    use super::{SurfaceSink, draw_frame, draw_pixels};
    use crate::surface::{SurfaceFrame, SurfacePixels};

    /// What the engine would have been asked to draw.
    #[derive(Default)]
    struct Recording {
        calls: Vec<Call>,
        fail: bool,
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Call {
        surface: u32,
        width: u32,
        height: u32,
        bgra: Vec<u8>,
        stride: usize,
        damage: Option<Rect>,
    }

    impl SurfaceSink for Recording {
        fn draw_surface(
            &mut self,
            surface: u32,
            width: u32,
            height: u32,
            bgra: &[u8],
            stride: usize,
            damage: Option<Rect>,
        ) -> std::io::Result<usize> {
            if self.fail {
                // The message `Engine::draw_surface` produces when the buffer is too
                // small for the dimensions it was handed.
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "surface dimensions do not match its pixels",
                ));
            }
            self.calls.push(Call {
                surface,
                width,
                height,
                bgra: bgra.to_vec(),
                stride,
                damage,
            });
            Ok(width as usize * 4 * height as usize)
        }
    }

    fn rect(x: u32, y: u32, w: u32, h: u32) -> Option<Rect> {
        Some(Rect { x, y, w, h })
    }

    fn owned(id: u32, w: u32, h: u32, bgra: Vec<u8>, damage: Option<Rect>) -> SurfaceFrame {
        SurfaceFrame {
            id,
            pixels: SurfacePixels::Owned {
                bgra,
                width: w,
                height: h,
            },
            damage,
        }
    }

    /// `Owned` is the only variant that exists on Windows, so this is the whole of
    /// `draw_frame` there rather than one arm of three.
    #[test]
    fn an_owned_frame_reaches_the_engine_tightly_packed() {
        let mut sink = Recording::default();
        let bgra: Vec<u8> = (0..24u8).collect();
        let damage = rect(1, 0, 2, 2);
        let rows = draw_frame(&mut sink, &owned(7, 3, 2, bgra.clone(), damage)).expect("draws");

        assert_eq!(rows, 2, "draw_frame reports the rows it handed over");
        assert_eq!(
            sink.calls,
            vec![Call {
                surface: 7,
                width: 3,
                height: 2,
                bgra,
                stride: 12,
                damage,
            }],
        );
    }

    /// The seam carries a stride wider than the row — that is how the macOS and Linux
    /// zero-copy variants arrive, and how Task 12's shared-memory frames will. `Owned`
    /// itself has no stride field, so it can only ever declare `width * 4`: a padded
    /// buffer has to be repacked before it is submitted, not described on the way out.
    #[test]
    fn a_stride_wider_than_the_width_survives_the_seam_but_owned_never_declares_one() {
        let mut sink = Recording::default();
        let padded = vec![9u8; 2 * (3 * 4 + 8)];
        let frame = owned(1, 3, 2, Vec::new(), None);
        draw_pixels(&mut sink, &frame, 3, 2, &padded, 20).expect("draws");
        assert_eq!(sink.calls[0].stride, 20);

        let mut sink = Recording::default();
        draw_frame(&mut sink, &owned(1, 3, 2, padded, None)).expect("draws");
        assert_eq!(
            sink.calls[0].stride, 12,
            "an owned buffer with padded rows would be read as 12-byte rows, so the \
             padding has to be stripped at submit time",
        );
    }

    /// A zero-area damage rect is a legal frame, not an error: `surfaces::write`
    /// clamps it to nothing and returns early. `draw_frame` must forward it as it
    /// stands rather than widening it to a full repaint.
    #[test]
    fn a_zero_area_damage_rect_is_forwarded_rather_than_widened() {
        let mut sink = Recording::default();
        let damage = rect(4, 4, 0, 0);
        let rows = draw_frame(&mut sink, &owned(2, 2, 2, vec![0; 16], damage)).expect("draws");

        assert_eq!(rows, 2);
        assert_eq!(sink.calls[0].damage, damage);
    }

    /// Absent damage means "the whole surface", which is a different instruction from
    /// an empty rect and must not be confused with one.
    #[test]
    fn an_absent_damage_rect_stays_absent() {
        let mut sink = Recording::default();
        draw_frame(&mut sink, &owned(2, 2, 2, vec![0; 16], None)).expect("draws");
        assert_eq!(sink.calls[0].damage, None);
    }

    #[test]
    fn an_engine_refusal_comes_back_as_a_message_the_loop_can_report() {
        let mut sink = Recording {
            fail: true,
            ..Recording::default()
        };
        let error = draw_frame(&mut sink, &owned(3, 2, 2, vec![0; 4], None))
            .expect_err("a short buffer is refused");
        assert!(
            error.contains("surface dimensions do not match its pixels"),
            "got {error:?}",
        );
    }

    #[test]
    fn windows_asks_the_terminal_for_its_size_because_nothing_will_tell_it() {
        // Found at the Task 10 milestone: resize the pane and the browser went on
        // drawing the old size, so agwinterm placed a frame it then clipped.
        //
        // Upstream never needed this. On unix `watch_resize` installs a SIGWINCH
        // handler, and in the no-tty shape `pixel-react` also nudges the engine
        // from `process.stdout.on("resize")` (index.ts:583). Neither exists here:
        // Windows has no SIGWINCH, and Electron's stdout is a pipe rather than a
        // `tty.WriteStream`, so that event never fires. `poll_event` polling the
        // screen buffer is the only route left.
        // Asserted against the source rather than against the value. Comparing
        // `WATCH_RESIZE` with `cfg!(windows)` restates its own definition -- the
        // assertion cannot fail, and clippy says so -- while what a re-vendor
        // actually breaks is one of two lines of text: the definition, or the use.
        // `Engine::new` cannot be constructed in a unit test, so the use is pinned
        // where it is written. Reverting `watch_resize: WATCH_RESIZE` to
        // `watch_resize: false` compiles, passes every other test, and brings back
        // the Task 10 bug where a resized pane went on drawing the old size.
        //
        // Each needle is spelled in two pieces so it cannot satisfy itself: this
        // file *is* the haystack.
        let source = include_str!("lib.rs");
        assert!(
            source.contains(concat!("WATCH_RESIZE: bool = ", "cfg!(windows)")),
            "the constant no longer follows the platform",
        );
        assert!(
            source.contains(concat!("watch_resize: ", "WATCH_RESIZE,")),
            "EngineConfig no longer takes its watch_resize from the constant",
        );
    }
}
