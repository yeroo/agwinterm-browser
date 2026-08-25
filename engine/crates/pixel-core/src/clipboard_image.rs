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
        Some(rest) => file_url_path(rest),
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

/// The local path inside a `file://` URL.
///
/// `file:///C:/pics/a.png` is how a browser, an editor and the Windows shell all
/// spell a local file, and stripping `file://` leaves the empty authority's slash
/// on the front of it. `/C:/pics/a.png` still reads as absolute to
/// [`looks_absolute`] — it starts with `/` — so the paste is accepted and then fails
/// the `is_file` probe, silently, on the one spelling that is actually produced.
///
/// Only the empty-authority form is unwrapped. `file://host/share/a.png` names a
/// network location, and [`looks_absolute`] declines those for the reasons given
/// there, so it is left as written and rejected as prose.
fn file_url_path(rest: &str) -> String {
    let decoded = percent_decode(rest);
    if !cfg!(windows) {
        return decoded;
    }
    let Some(after) = decoded.strip_prefix('/') else {
        return decoded;
    };
    if drive_qualified(after.as_bytes()) {
        return after.to_owned();
    }
    decoded
}

/// Whether a pasted string is claiming to be an absolute *local* path at all. A
/// paste that is merely prose must not be probed against the filesystem, so this is
/// the gate.
///
/// Unix spells absolute one way and Windows spells it two: a leading `/` or `~`, or
/// a drive-qualified path (`C:\pics\a.png`, `C:/pics/a.png`). Without the second,
/// every Windows paste reads as prose.
///
/// A UNC share (`\\host\share\a.png`, and its forward-slash and `\\?\UNC\` spellings)
/// is refused, and that is the point of the word *local*. `is_file` on one is not a
/// filesystem question: it is an outbound SMB or WebDAV connection with implicit
/// authentication, made synchronously on the thread that runs `handle_event`. A page
/// that puts `\\attacker.example\s\a.png` on the clipboard would get a credential
/// handshake out of this machine on the next Ctrl+V, and a host that does not route
/// would freeze the UI for the whole connect timeout. Neither is worth the one paste
/// it would resolve.
///
/// `\\?\C:\pics\a.png` is *not* one of those, and is admitted. It is the
/// extended-length spelling of an ordinary drive path — no host, no connection, the
/// same local file `C:\pics\a.png` names — and refusing it as collateral of the
/// two-separator test would be a regression with nothing behind it. What that prefix
/// must not admit is `\\?\UNC\host\share\…`, which is a share wearing it, and which
/// fails the drive test underneath like any other non-drive.
fn looks_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    let separator = |b: Option<&u8>| matches!(b, Some(b'\\') | Some(b'/'));
    if cfg!(windows) && separator(bytes.first()) && separator(bytes.get(1)) {
        // The only local shape behind two separators: `\\?\` and then a drive.
        let extended = bytes.get(2) == Some(&b'?') && separator(bytes.get(3));
        return extended && drive_qualified(bytes.get(4..).unwrap_or_default());
    }
    if path.starts_with('/') || path.starts_with('~') {
        return true;
    }
    if !cfg!(windows) {
        return false;
    }
    drive_qualified(bytes)
}

/// `C:\…` or `C:/…` — a path rooted at a named drive, which is how Windows spells
/// absolute when it is not spelling it with a leading separator.
fn drive_qualified(bytes: &[u8]) -> bool {
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
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
        // Read the two digits as *bytes*. Slicing `&s[i + 1..i + 3]` instead panics
        // on any `%` that a multi-byte character follows — `%€` is a three-byte char
        // starting at `i + 1`, so `i + 3` lands inside it and is not a char boundary
        // — and this runs on arbitrary clipboard text, on the thread that handles the
        // paste. A non-ASCII byte is not a hex digit, so it declines the same way a
        // `%z` does.
        let decoded = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| {
                let hi = char::from(bytes[i + 1]).to_digit(16)?;
                let lo = char::from(bytes[i + 2]).to_digit(16)?;
                u8::try_from(hi * 16 + lo).ok()
            })
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

    /// The spelling that is actually pasted. `file://` + a drive path is two
    /// slashes and names an authority; every real producer writes three.
    #[cfg(windows)]
    #[test]
    fn a_file_url_with_an_empty_authority_resolves() {
        let path = temp_png("url authority.png");
        let url = format!(
            "file:///{}",
            path.to_string_lossy()
                .replace('\\', "/")
                .replace(' ', "%20"),
        );
        assert!(
            url.starts_with("file:///"),
            "the test built the wrong shape"
        );
        assert!(image_path_from_paste(&url).is_some());
    }

    /// Not "does this file exist" — the probe is what must not happen. A UNC path
    /// reaches the network, with this user's credentials, from the event-loop
    /// thread, so it is refused before `is_file` is ever asked.
    ///
    /// Asserted on the *gate* rather than on the result, because the result cannot
    /// tell the two apart: `is_file` on an unreachable share is `false` too, so an
    /// `is_none()` check passes whether the guard is there or not — and the only
    /// symptom of its removal would be a suite that got slower.
    #[cfg(windows)]
    #[test]
    fn a_unc_share_is_never_probed() {
        for paste in [
            r"\\attacker.example\s\a.png",
            "//attacker.example/s/a.png",
            r"\\?\UNC\attacker.example\s\a.png",
        ] {
            assert!(
                !looks_absolute(paste),
                "{paste} was admitted as a local path"
            );
            assert!(image_path_from_paste(paste).is_none(), "{paste} resolved");
        }
        // The URL spelling reaches the gate through `file_url_path`, which leaves a
        // named authority alone precisely so this happens.
        assert!(
            !looks_absolute(&file_url_path("attacker.example/s/a.png")),
            "a file:// URL with a host was unwrapped into a local path",
        );
        assert!(image_path_from_paste("file://attacker.example/s/a.png").is_none());
    }

    /// The extended-length prefix on an ordinary local path. Refusing it would be
    /// collateral of the UNC guard: there is no host in it and no connection to make.
    #[cfg(windows)]
    #[test]
    fn an_extended_length_local_path_is_still_local() {
        assert!(looks_absolute(r"\\?\C:\pics\a.png"));
        assert!(looks_absolute(r"\\?\c:/pics/a.png"));
        // The share wearing the same prefix is not, and that is the whole distinction.
        assert!(!looks_absolute(r"\\?\UNC\host\share\a.png"));
        assert!(!looks_absolute(r"\\?\"));
        assert!(!looks_absolute(r"\\?"));
    }

    /// `percent_decode` reads the two digits after a `%` as bytes rather than
    /// slicing the string, because clipboard text is arbitrary and a multi-byte
    /// character after a `%` puts `i + 3` inside it. Slicing there panics, on the
    /// thread that handles the paste.
    #[test]
    fn a_percent_before_a_multibyte_character_does_not_panic() {
        assert_eq!(percent_decode("/a%€b.png"), "/a%€b.png");
        assert_eq!(percent_decode("%"), "%");
        assert_eq!(percent_decode("%2"), "%2");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("/a%20b.png"), "/a b.png");
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
