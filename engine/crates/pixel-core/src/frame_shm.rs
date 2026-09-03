//! Which frame transport carries a frame, and the shape of a host that lacks one.
//!
//! ## Status: the fast path is blocked, and this module says so in code
//!
//! Task 12 opens with a precondition — `agwinterm/docs/specs/image-frameshm.md`
//! must exist *and* state the literal `Local\` mapping-name prefix and the producer
//! slot-reuse invariant. At the time of writing it does not exist at all. agwinterm
//! has a plan for the verb (`docs/plans/20260821-image-frameshm-command.md`) with
//! its Task 1 — the one that defines the header layout and publishes the spec —
//! still entirely unchecked, and `ControlServer.cs:249` still dispatches
//! `image.frame` and nothing else.
//!
//! So there is no mapping layout to write into. A producer built now would be
//! inventing a wire format and calling it a contract, and the first real consumer
//! would disagree with it in a way that shows up as a torn or rejected frame rather
//! than as a compile error. The producer is therefore **not** in this module, and
//! its absence is a recorded decision rather than an oversight.
//!
//! What *is* here is the half that does not depend on the layout, and is true
//! whatever the layout turns out to be:
//!
//! - [`Transport`] — the file path stays explicitly selectable, by
//!   [`TRANSPORT_VAR`], rather than becoming whatever the newest code prefers.
//! - [`is_unknown_command`] — the literal refusal a host gives for a verb it does
//!   not have (`{"ok":false,"error":"unknown command '…'"}`, `ControlServer.cs:250`).
//!   This is the fallback trigger, and it is shared with `pane_metrics`, which had
//!   the same test open-coded. One reading of that reply, used by every capability
//!   probe.
//!
//! When the spec lands, what this module gains is the producer and a support latch
//! on top of [`is_unknown_command`]; nothing here changes shape.

use crate::terminal::SessionEnv;

/// The verb the fast path will send. Named here — rather than only in the spec that
/// does not exist yet — because [`is_unknown_command`]'s whole job is recognising a
/// host that has never heard of it.
pub(crate) const FRAMESHM_CMD: &str = "image.frameshm";

/// Forces a transport, overriding what the host supports.
///
/// Read through [`SessionEnv`] like every other `TERMINAL_BROWSER_*` variable, so it
/// answers for the pane that asked rather than for the process that happened to
/// start. Unset means [`Transport::Auto`], which is what anyone not debugging a
/// transport wants.
pub(crate) const TRANSPORT_VAR: &str = "TERMINAL_BROWSER_FRAME_TRANSPORT";

/// Which way a frame reaches the pane.
///
/// `Auto` is not a third transport: it is "whichever works", and it exists so that
/// the default is not spelled as a preference. `File` is the one that ships today
/// ([`crate::frame_file`]); `Shm` is the one whose contract is still unpublished.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Transport {
    /// The fast path when the host has it, the file path otherwise.
    #[default]
    Auto,
    /// The file path, even on a host that offers the fast one. This is what makes
    /// the baseline in `docs/design/02-frame-budget.md` re-measurable after the
    /// fast path lands.
    File,
    /// The fast path, and complain rather than degrade silently if it is missing.
    Shm,
}

impl Transport {
    /// What [`TRANSPORT_VAR`] asked for.
    ///
    /// An unparseable value is a typo, not a request: it warns and falls back to
    /// [`Transport::Auto`], because failing a frame over a misspelled debug knob
    /// would be a worse answer than ignoring it.
    pub(crate) fn from_env(env: &SessionEnv) -> Self {
        let Some(raw) = env.var(TRANSPORT_VAR).filter(|raw| !raw.trim().is_empty()) else {
            return Self::Auto;
        };
        match Self::parse(&raw) {
            Some(transport) => transport,
            None => {
                crate::logging::warn(
                    "agwinterm",
                    format!(
                        "{TRANSPORT_VAR}={raw:?} names no transport; expected \
                         \"auto\", \"file\" or \"shm\". Using \"auto\""
                    ),
                );
                Self::Auto
            }
        }
    }

    /// Case- and whitespace-insensitive, because this is typed by a person into a
    /// shell rather than emitted by a program.
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "auto" | "default" => Some(Self::Auto),
            "file" | "png" | "image.frame" => Some(Self::File),
            "shm" | "frameshm" | "image.frameshm" => Some(Self::Shm),
            _ => None,
        }
    }

    /// Why the fast path is not carrying this frame, for a caller that asked for it.
    ///
    /// Returns `None` for [`Transport::Auto`] and [`Transport::File`]: neither asked
    /// for anything it did not get, and a line of log per frame about a transport
    /// nobody requested is noise. Only an explicit `shm` earns an explanation, and
    /// its caller is expected to say it once.
    pub(crate) fn unavailable_reason(self) -> Option<String> {
        match self {
            Self::Auto | Self::File => None,
            Self::Shm => Some(format!(
                "{TRANSPORT_VAR}=shm asked for `{FRAMESHM_CMD}`, which this build \
                 does not implement: its mapping layout is not published yet \
                 (agwinterm/docs/specs/image-frameshm.md does not exist, and \
                 agwinterm's own plan has not defined the header). Frames are going \
                 out over `image.frame` instead — the picture is the same, the cost \
                 is the one in docs/design/02-frame-budget.md"
            )),
        }
    }
}

/// Whether a refusal means "this host has never heard of that verb".
///
/// The exact string is `$"unknown command '{cmd}'"` (`ControlServer.cs:250`), which
/// arrives with the apostrophes escaped as `'` and is decoded by
/// `crate::agwinterm::Reply` before it gets here. Every capability probe in this
/// crate is this one test: a verb the host lacks is a capability gap and a reason to
/// take the other path, while any *other* refusal — no such pane, bad args — is a
/// real error and must not be swallowed as a missing feature.
///
/// The verb is checked too, not just the prefix. A reply naming a different command
/// than the one just sent means the host and this client disagree about what was
/// asked, which is not a capability gap.
pub(crate) fn is_unknown_command(message: &str, cmd: &str) -> bool {
    let Some(rest) = message.trim().strip_prefix("unknown command") else {
        return false;
    };
    let named = rest.trim().trim_matches('\'');
    // A host that answers the bare prefix without naming anything is still telling
    // us the verb is missing; only a *different* name is a disagreement.
    named.is_empty() || named == cmd
}

/// The `image.frameshm` mapping layout, contract version 1, as arithmetic.
///
/// Every number here is copied from the offset tables in agwinterm's
/// `docs/specs/image-frameshm.md` rather than chosen. The spec is normative: where
/// this module and the spec disagree, the spec wins and this module is corrected.
/// Nothing in here touches Win32, so the layout compiles and is tested on every
/// platform; the mapping that carries it is Windows-only and lives beside it.
///
/// Consumers arrive task by task (the mapping, then the producer, then the request
/// in `frame_file.rs`); until they do the module is reachable only from its tests.
#[allow(
    dead_code,
    reason = "the mapping, producer and request that use the layout land in later tasks"
)]
pub(crate) mod layout {
    use std::io;
    use std::ops::Range;

    /// The bytes `A` `G` `S` `F`, read little-endian from offset 0.
    pub(crate) const MAGIC: u32 = 0x4653_4741;
    /// The only layout version a reader accepts.
    pub(crate) const VERSION: u32 = 1;
    /// The fixed header, descriptors included; slot 0's pixels start here.
    pub(crate) const HEADER_LEN: usize = 256;
    /// Where `ready` lives: 8-byte aligned, so it can be a real atomic.
    pub(crate) const READY_OFFSET: usize = 32;
    /// Slot descriptors start here, one every [`DESCRIPTOR_LEN`] bytes.
    pub(crate) const DESCRIPTOR_OFFSET: usize = 64;
    /// `width`, `height`, `stride`, `format`, four bytes each.
    pub(crate) const DESCRIPTOR_LEN: usize = 16;
    /// The contract's minimum, and all a serialised producer needs: one frame in
    /// flight, one slot being filled, never the same slot.
    pub(crate) const SLOT_COUNT: u32 = 2;
    /// `KittyFormat.Rgba`. The canvas is tiny-skia RGBA, so rows are copied as they
    /// are; the spec accepts `32` beside its preferred `132` (BGRA).
    pub(crate) const FORMAT_RGBA: u32 = 32;
    /// The literal, case-sensitive prefix the reader enforces on every name.
    pub(crate) const NAME_PREFIX: &str = r"Local\agwinterm-frame-";
    /// The reader rejects a `width` or `height` outside `1..=16384`.
    pub(crate) const MAX_DIMENSION: u32 = 16384;
    /// What may follow [`NAME_PREFIX`]: 1..=128 characters of `[A-Za-z0-9._-]`.
    pub(crate) const MAX_NAME_SUFFIX: usize = 128;
    /// Slot strides are rounded up to this, so each slot starts on a page.
    pub(crate) const PAGE: usize = 4096;
    /// Every format the verb carries is 4 bpp; the bounds in the spec assume it.
    const BYTES_PER_PIXEL: u32 = 4;

    /// Where everything for one frame size lives in the mapping.
    ///
    /// Built by [`Layout::for_frame`]; a different frame size is a different
    /// `Layout` and, for the producer, a different mapping.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) struct Layout {
        width: u32,
        height: u32,
        /// Bytes per row: exactly `width * 4`, no padding.
        stride: u32,
        /// Bytes from one slot's pixels to the next: `height * stride`, page-rounded.
        slot_stride: usize,
        /// [`HEADER_LEN`] + [`SLOT_COUNT`] slots.
        mapping_len: usize,
    }

    impl Layout {
        /// The layout for a `width`×`height` RGBA frame.
        ///
        /// Rejects a dimension the reader would reject, so a mapping is never
        /// created for a frame no request could place.
        pub(crate) fn for_frame(width: u32, height: u32) -> io::Result<Self> {
            for (axis, value) in [("width", width), ("height", height)] {
                if !(1..=MAX_DIMENSION).contains(&value) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("image.frameshm {axis} {value} is outside 1..={MAX_DIMENSION}"),
                    ));
                }
            }
            let stride = width * BYTES_PER_PIXEL;
            let slot_bytes = height as usize * stride as usize;
            let slot_stride = slot_bytes.div_ceil(PAGE) * PAGE;
            Ok(Self {
                width,
                height,
                stride,
                slot_stride,
                mapping_len: HEADER_LEN + slot_stride * SLOT_COUNT as usize,
            })
        }

        pub(crate) fn width(&self) -> u32 {
            self.width
        }

        pub(crate) fn height(&self) -> u32 {
            self.height
        }

        /// Bytes per row, the value the descriptor and the request both carry.
        pub(crate) fn stride(&self) -> u32 {
            self.stride
        }

        /// The header's `slotStride`.
        pub(crate) fn slot_stride(&self) -> usize {
            self.slot_stride
        }

        /// The header's `pixelOffset`: always the end of the fixed header.
        pub(crate) fn pixel_offset(&self) -> usize {
            HEADER_LEN
        }

        /// The size to create the mapping with, and the length of its view.
        pub(crate) fn mapping_len(&self) -> usize {
            self.mapping_len
        }

        /// Writes the fixed header into the first [`HEADER_LEN`] bytes of `view`.
        ///
        /// `ready` is written as `0` — nothing published — and every reserved byte
        /// and every descriptor is zeroed; the descriptors are filled per frame when
        /// a slot is published.
        pub(crate) fn write_header(&self, view: &mut [u8]) {
            assert!(
                view.len() >= HEADER_LEN,
                "a {}-byte view cannot hold the {HEADER_LEN}-byte image.frameshm header",
                view.len()
            );
            let header = &mut view[..HEADER_LEN];
            header.fill(0);
            put_u32(header, 0, MAGIC);
            put_u32(header, 4, VERSION);
            put_u32(header, 8, SLOT_COUNT);
            put_u32(header, 12, 0); // flags: reserved
            put_u64(header, 16, self.slot_stride as u64);
            put_u64(header, 24, self.pixel_offset() as u64);
            put_u64(header, READY_OFFSET, 0);
        }

        /// The 16 bytes of `slot`'s descriptor: `64 + 16 * slot`.
        pub(crate) fn descriptor(&self, slot: u32) -> Range<usize> {
            assert_slot(slot);
            let start = DESCRIPTOR_OFFSET + DESCRIPTOR_LEN * slot as usize;
            start..start + DESCRIPTOR_LEN
        }

        /// The `height * stride` bytes of `slot`'s pixels:
        /// `pixelOffset + slot * slotStride`, the slot's own bytes only, not its
        /// page padding.
        pub(crate) fn pixels(&self, slot: u32) -> Range<usize> {
            assert_slot(slot);
            let start = self.pixel_offset() + self.slot_stride * slot as usize;
            start..start + self.height as usize * self.stride as usize
        }
    }

    fn assert_slot(slot: u32) {
        assert!(
            slot < SLOT_COUNT,
            "slot {slot} is outside this layout's {SLOT_COUNT} slots"
        );
    }

    fn put_u32(view: &mut [u8], offset: usize, value: u32) {
        view[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u64(view: &mut [u8], offset: usize, value: u64) {
        view[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    /// The slot sequence `seq` publishes into: `seq % slotCount`.
    ///
    /// Sequences start at 1, so the first frame lands in slot 1 and the reader's
    /// `slot == seq % slotCount` check holds for every positive `seq`.
    pub(crate) fn slot_for(seq: u64) -> u32 {
        // The remainder is below SLOT_COUNT, so it fits without truncation.
        (seq % u64::from(SLOT_COUNT)) as u32
    }

    /// `Local\agwinterm-frame-browser-<pid>-<incarnation>`.
    ///
    /// `incarnation` changes on every recreate (a resize), because the reader only
    /// accepts a recreated mapping under an old name when its sequence continues
    /// and the safe way to guarantee that is never to reuse a name.
    pub(crate) fn mapping_name(pid: u32, incarnation: u32) -> String {
        format!("{NAME_PREFIX}browser-{pid}-{incarnation}")
    }

    /// The reader's name rule: the exact prefix, then 1..=[`MAX_NAME_SUFFIX`]
    /// characters of `[A-Za-z0-9._-]`. No backslash, so a suffix cannot leave
    /// `Local\`; checked before any Win32 call so a bad name never becomes an object.
    pub(crate) fn is_valid_name(name: &str) -> bool {
        let Some(suffix) = name.strip_prefix(NAME_PREFIX) else {
            return false;
        };
        // The charset is ASCII, so once it passes, bytes and characters agree.
        (1..=MAX_NAME_SUFFIX).contains(&suffix.len())
            && suffix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    }

    #[cfg(test)]
    mod tests {
        //! Each header assertion quotes the spec's offset table
        //! (`docs/specs/image-frameshm.md` § Fixed header) rather than this module's
        //! constants, so a constant drifting from the spec fails here.

        use super::*;

        fn u32_at(view: &[u8], offset: usize) -> u32 {
            u32::from_le_bytes(view[offset..offset + 4].try_into().unwrap())
        }

        fn u64_at(view: &[u8], offset: usize) -> u64 {
            u64::from_le_bytes(view[offset..offset + 8].try_into().unwrap())
        }

        fn hd() -> Layout {
            Layout::for_frame(1920, 1080).expect("1920x1080 is a legal frame")
        }

        // -- the header, against the spec's table ------------------------------

        #[test]
        fn the_header_matches_the_specs_offset_table() {
            let layout = hd();
            let mut view = vec![0xAA; layout.mapping_len()];
            layout.write_header(&mut view);

            assert_eq!(u32_at(&view, 0), 0x46534741, "magic");
            assert_eq!(&view[0..4], b"AGSF", "the magic reads as its letters");
            assert_eq!(u32_at(&view, 4), 1, "version");
            assert_eq!(u32_at(&view, 8), 2, "slotCount");
            assert_eq!(u32_at(&view, 12), 0, "flags");
            assert_eq!(u64_at(&view, 16), layout.slot_stride() as u64, "slotStride");
            assert_eq!(u64_at(&view, 24), 256, "pixelOffset");
            assert_eq!(u64_at(&view, 32), 0, "ready: nothing published");
            assert!(
                view[40..64].iter().all(|&b| b == 0),
                "reserved bytes are zero"
            );
            assert!(
                view[64..256].iter().all(|&b| b == 0),
                "descriptors start zeroed and are filled per frame",
            );
            assert!(
                view[256..].iter().all(|&b| b == 0xAA),
                "write_header touches nothing past the header",
            );
        }

        #[test]
        fn descriptors_sit_sixteen_bytes_apart_from_sixty_four() {
            let layout = hd();
            for slot in 0..SLOT_COUNT {
                let want = 64 + 16 * slot as usize;
                assert_eq!(layout.descriptor(slot), want..want + 16, "slot {slot}");
            }
            assert!(
                layout.descriptor(SLOT_COUNT - 1).end <= HEADER_LEN,
                "every descriptor is inside the fixed header",
            );
        }

        #[test]
        fn a_short_view_is_refused_rather_than_half_written() {
            let result = std::panic::catch_unwind(|| {
                let mut view = vec![0; HEADER_LEN - 1];
                hd().write_header(&mut view);
            });
            assert!(result.is_err());
        }

        // -- for_frame ---------------------------------------------------------

        #[test]
        fn a_1080p_frame_has_the_specs_example_stride_and_two_disjoint_slots() {
            let layout = hd();
            assert_eq!(layout.width(), 1920);
            assert_eq!(layout.height(), 1080);
            assert_eq!(layout.stride(), 7680, "the stride the spec's example sends");
            assert_eq!(layout.pixel_offset(), 256);

            let bytes = 1080 * 7680;
            assert!(layout.slot_stride() >= bytes, "a slot holds its frame");
            assert_eq!(layout.slot_stride() % PAGE, 0, "slots start on a page");
            assert!(
                layout.slot_stride() - bytes < PAGE,
                "and no more than a page of padding"
            );

            let (s0, s1) = (layout.pixels(0), layout.pixels(1));
            assert_eq!(s0.start, 256, "slot 0 starts at pixelOffset");
            assert_eq!(s0.len(), bytes);
            assert_eq!(s1.start, 256 + layout.slot_stride());
            assert_eq!(s1.len(), bytes);
            assert!(s0.start >= HEADER_LEN, "slot 0 is clear of the header");
            assert!(s0.end <= s1.start, "slot 1 does not overlap slot 0");
            assert!(
                s1.end <= layout.mapping_len(),
                "both slots are inside the mapping"
            );
            assert_eq!(
                layout.mapping_len(),
                256 + 2 * layout.slot_stride(),
                "pixelOffset + slotStride * slotCount, the spec's minimum",
            );
        }

        #[test]
        fn a_frame_that_is_a_whole_number_of_pages_gets_no_padding() {
            // 1024 * 4 = 4096 per row: the exact case the rounding must not overshoot.
            let layout = Layout::for_frame(1024, 3).unwrap();
            assert_eq!(layout.slot_stride(), 3 * 4096);
        }

        #[test]
        fn the_smallest_frame_is_one_pixel() {
            let layout = Layout::for_frame(1, 1).unwrap();
            assert_eq!(layout.stride(), 4);
            assert_eq!(layout.slot_stride(), PAGE);
            assert_eq!(layout.pixels(0).len(), 4);
        }

        #[test]
        fn dimensions_the_reader_rejects_are_rejected_here_first() {
            for (w, h) in [(0, 1080), (1920, 0), (16385, 1080), (1920, 16385), (0, 0)] {
                let err = Layout::for_frame(w, h).expect_err(&format!("{w}x{h}"));
                assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
                assert!(err.to_string().contains("16384"), "{err}");
            }
            assert!(
                Layout::for_frame(16384, 16384).is_ok(),
                "the bound is inclusive"
            );
        }

        // -- names -------------------------------------------------------------

        #[test]
        fn the_producers_own_name_passes_the_readers_rule() {
            let name = mapping_name(1234, 0);
            assert_eq!(name, r"Local\agwinterm-frame-browser-1234-0");
            assert!(is_valid_name(&name));
            assert!(is_valid_name(&mapping_name(u32::MAX, u32::MAX)));
        }

        #[test]
        fn the_prefix_is_required_literally_and_case_sensitively() {
            assert!(is_valid_name(r"Local\agwinterm-frame-x"));
            assert!(!is_valid_name(r"local\agwinterm-frame-x"));
            assert!(!is_valid_name(r"LOCAL\agwinterm-frame-x"));
            assert!(!is_valid_name(r"Global\agwinterm-frame-x"));
            assert!(!is_valid_name(r"agwinterm-frame-x"));
            assert!(
                !is_valid_name(r"Local\winterm-browser-1-0"),
                "the pre-contract spelling"
            );
            assert!(!is_valid_name(""));
        }

        #[test]
        fn the_suffix_is_one_to_128_characters() {
            assert!(!is_valid_name(NAME_PREFIX), "an empty suffix");
            let okay = format!("{NAME_PREFIX}{}", "a".repeat(128));
            assert!(is_valid_name(&okay));
            let long = format!("{NAME_PREFIX}{}", "a".repeat(129));
            assert!(!is_valid_name(&long));
        }

        #[test]
        fn the_suffix_charset_is_the_readers() {
            for ok in ["browser-1", "a.b_c-d", "ABCxyz019", "..", "-"] {
                assert!(is_valid_name(&format!("{NAME_PREFIX}{ok}")), "{ok:?}");
            }
            for bad in [r"a\b", "a b", "é", "a/b", "a:b", "a\0", "日本"] {
                assert!(!is_valid_name(&format!("{NAME_PREFIX}{bad}")), "{bad:?}");
            }
        }

        // -- slots -------------------------------------------------------------

        #[test]
        fn sequences_start_at_one_and_alternate_slots() {
            let slots: Vec<u32> = (1..=8).map(slot_for).collect();
            assert_eq!(slots, [1, 0, 1, 0, 1, 0, 1, 0]);
            assert_eq!(slot_for(u64::MAX), 1);
        }
    }
}

#[cfg(test)]
mod tests {
    //! The refusal strings here are not invented: they are what `Reply::parse`
    //! produces from the literal envelope `ControlServer.cs:250` writes, which
    //! `crate::agwinterm`'s own tests pin at the JSON level.

    use super::*;

    fn env(pairs: &[(&str, &str)]) -> SessionEnv {
        SessionEnv::of_session(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        )
    }

    // -- selecting a transport --------------------------------------------

    #[test]
    fn nothing_set_means_auto() {
        assert_eq!(Transport::from_env(&env(&[])), Transport::Auto);
        assert_eq!(Transport::default(), Transport::Auto);
    }

    #[test]
    fn the_file_path_stays_selectable() {
        // The point of the knob: after the fast path lands, this is what re-measures
        // the baseline the fast path claims to beat.
        for raw in ["file", "FILE", "  file  ", "png", "image.frame"] {
            assert_eq!(
                Transport::from_env(&env(&[(TRANSPORT_VAR, raw)])),
                Transport::File,
                "{raw:?}",
            );
        }
    }

    #[test]
    fn the_fast_path_can_be_asked_for_by_name() {
        for raw in ["shm", "SHM", "frameshm", "image.frameshm"] {
            assert_eq!(
                Transport::from_env(&env(&[(TRANSPORT_VAR, raw)])),
                Transport::Shm,
                "{raw:?}",
            );
        }
    }

    #[test]
    fn an_empty_value_is_the_same_as_unset() {
        // `SET TERMINAL_BROWSER_FRAME_TRANSPORT=` is how a shell unsets it, and it
        // must not read as a typo.
        assert_eq!(
            Transport::from_env(&env(&[(TRANSPORT_VAR, "")])),
            Transport::Auto
        );
        assert_eq!(
            Transport::from_env(&env(&[(TRANSPORT_VAR, "   ")])),
            Transport::Auto
        );
    }

    #[test]
    fn a_typo_falls_back_to_auto_rather_than_failing_the_frame() {
        assert_eq!(
            Transport::from_env(&env(&[(TRANSPORT_VAR, "shmem")])),
            Transport::Auto,
        );
        assert_eq!(
            Transport::from_env(&env(&[(TRANSPORT_VAR, "1")])),
            Transport::Auto,
        );
    }

    #[test]
    fn only_an_explicit_shm_request_is_owed_an_explanation() {
        assert_eq!(Transport::Auto.unavailable_reason(), None);
        assert_eq!(Transport::File.unavailable_reason(), None);
        let reason = Transport::Shm
            .unavailable_reason()
            .expect("an explicit request that could not be honoured says why");
        // The message has to name both the verb and the reason it is missing, or it
        // is indistinguishable from a bug.
        assert!(reason.contains(FRAMESHM_CMD), "{reason}");
        assert!(reason.contains("image-frameshm.md"), "{reason}");
        assert!(reason.contains("image.frame"), "{reason}");
    }

    // -- recognising a host without the verb -------------------------------

    #[test]
    fn the_hosts_literal_refusal_reads_as_a_missing_verb() {
        // What `Reply::parse` hands back from
        // `{"ok":false,"error":"unknown command 'image.frameshm'"}`.
        assert!(is_unknown_command(
            "unknown command 'image.frameshm'",
            FRAMESHM_CMD
        ));
        assert!(is_unknown_command(
            "unknown command 'session.metrics'",
            "session.metrics"
        ));
    }

    #[test]
    fn a_refusal_for_any_other_reason_is_not_a_capability_gap() {
        // These must stay errors: swallowing them as "the host is old" would hide a
        // real failure behind a silent fallback.
        for message in [
            "no session",
            "image.frame requires args.images array",
            "session 'foo' not found",
            "",
        ] {
            assert!(
                !is_unknown_command(message, FRAMESHM_CMD),
                "{message:?} is a refusal, not a missing verb",
            );
        }
    }

    #[test]
    fn a_reply_naming_a_different_verb_is_not_our_answer() {
        // Host and client disagreeing about what was asked is a bug, not an old
        // host, and must not silently select the other transport.
        assert!(!is_unknown_command(
            "unknown command 'session.split'",
            FRAMESHM_CMD
        ));
    }

    #[test]
    fn an_unnamed_unknown_command_still_counts() {
        assert!(is_unknown_command("unknown command", FRAMESHM_CMD));
        assert!(is_unknown_command("  unknown command  ", FRAMESHM_CMD));
    }
}
