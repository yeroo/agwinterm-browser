use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PasteSource {
    Clipboard,
    Osc,
    File,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PastedImage {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub source: PasteSource,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

pub(crate) fn temp_path(ext: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("pixel-attachments");
    let _ = std::fs::create_dir_all(&dir);
    let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    dir.join(format!("paste-{}-{n}.{ext}", std::process::id()))
}

fn dims(path: &Path) -> Option<(u32, u32)> {
    image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

fn from_file(path: &Path, source: PasteSource) -> Option<PastedImage> {
    let (width, height) = dims(path)?;
    Some(PastedImage {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
        source,
    })
}

pub(crate) enum WorkerPaste {
    File(PastedImage),
    Bitmap {
        pasted: PastedImage,
        rgba: image::RgbaImage,
    },
}

pub(crate) fn read_for_worker() -> Option<WorkerPaste> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    if let Ok(files) = clipboard.get().file_list()
        && let Some(pasted) = files.iter().find_map(|f| from_file(f, PasteSource::Clipboard))
    {
        return Some(WorkerPaste::File(pasted));
    }
    let img = clipboard.get_image().ok()?;
    let rgba = image::RgbaImage::from_raw(
        img.width as u32,
        img.height as u32,
        img.bytes.into_owned(),
    )?;
    let (width, height) = rgba.dimensions();
    let pasted = PastedImage {
        path: temp_path("png").to_string_lossy().into_owned(),
        width,
        height,
        source: PasteSource::Clipboard,
    };
    Some(WorkerPaste::Bitmap { pasted, rgba })
}

pub fn image_path_from_paste(text: &str) -> Option<PastedImage> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.contains('\n') {
        return None;
    }
    let unquoted = trimmed.trim_matches(|c| c == '\'' || c == '"');
    let path = match unquoted.strip_prefix("file://") {
        Some(rest) => percent_decode(rest),
        None => unescape(unquoted),
    };
    if !looks_absolute(&path) {
        return None;
    }
    let path = match path.strip_prefix("~/") {
        Some(rest) => Path::new(&home_dir()?).join(rest),
        None => PathBuf::from(path),
    };
    if !path.is_file() {
        return None;
    }
    from_file(&path, PasteSource::File)
}

/// Whether a pasted string is claiming to be an absolute path at all. A paste that
/// is merely prose must not be probed against the filesystem, so this is the gate.
///
/// Unix spells absolute one way and Windows spells it three: a leading `/` or `~`,
/// a drive-qualified path (`C:\pics\a.png`, `C:/pics/a.png`), or a UNC share
/// (`\\host\share\a.png`). Without the last two, every Windows paste reads as prose.
fn looks_absolute(path: &str) -> bool {
    if path.starts_with('/') || path.starts_with('~') {
        return true;
    }
    if !cfg!(windows) {
        return false;
    }
    let bytes = path.as_bytes();
    let drive_qualified = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    drive_qualified || path.starts_with(r"\\")
}

/// Windows has no `HOME`; the same thing is spelled `USERPROFILE` there.
fn home_dir() -> Option<String> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(key).ok()
}

/// Shell-style escaping, where a backslash quotes the character after it. That is
/// how a dragged path arrives with its spaces escaped.
///
/// On Windows the backslash is also the path separator, so unescaping it wholesale
/// would turn `C:\Users\me\a.png` into `C:Usersmea.png`. There, only an escaped
/// space or tab counts as an escape — which is the case this function exists for —
/// and every other backslash is left standing as a separator.
fn unescape(s: &str) -> String {
    let separator_is_backslash = cfg!(windows);
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        if separator_is_backslash && !matches!(chars.peek(), Some(' ' | '\t')) {
            out.push(c);
            continue;
        }
        if let Some(next) = chars.next() {
            out.push(next);
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let decoded = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| u8::from_str_radix(&s[i + 1..i + 3], 16).ok())
            .flatten();
        match decoded {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_png(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("pixel-clipboard-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        image::RgbaImage::from_pixel(6, 4, image::Rgba([1, 2, 3, 255]))
            .save(&path)
            .unwrap();
        path
    }

    #[test]
    fn plain_path_paste_detects_an_image() {
        let path = temp_png("plain.png");
        let pasted = image_path_from_paste(&path.to_string_lossy()).unwrap();
        assert_eq!((pasted.width, pasted.height), (6, 4));
    }

    #[test]
    fn quoted_and_escaped_paths_normalize() {
        let path = temp_png("with space.png");
        let raw = path.to_string_lossy();
        assert!(image_path_from_paste(&format!("'{raw}'")).is_some());
        assert!(image_path_from_paste(&raw.replace(' ', "\\ ")).is_some());
    }

    #[test]
    fn file_urls_percent_decode() {
        let path = temp_png("url space.png");
        let url = format!("file://{}", path.to_string_lossy().replace(' ', "%20"));
        assert!(image_path_from_paste(&url).is_some());
    }

    #[test]
    fn ordinary_text_is_not_a_path() {
        assert!(image_path_from_paste("hello world").is_none());
        assert!(image_path_from_paste("/does/not/exist.png").is_none());
        assert!(image_path_from_paste("one\n/two.png").is_none());
    }

    #[test]
    fn non_image_files_are_rejected() {
        let dir = std::env::temp_dir().join("pixel-clipboard-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.txt");
        std::fs::write(&path, "just text").unwrap();
        assert!(image_path_from_paste(&path.to_string_lossy()).is_none());
    }
}
