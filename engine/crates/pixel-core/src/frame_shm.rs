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

    /// One slot's descriptor: the 16 bytes at [`Layout::descriptor`], and the four
    /// numbers the request repeats so the host can hold them against the mapping
    /// before it copies (spec § JSON args: a non-zero field "must agree with the
    /// slot descriptor").
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) struct Descriptor {
        pub(crate) width: u32,
        pub(crate) height: u32,
        /// Bytes per row: `width * 4` for this producer, since the canvas has no
        /// padding.
        pub(crate) stride: u32,
        /// [`FORMAT_RGBA`], the canvas's own byte order.
        pub(crate) format: u32,
    }

    impl Descriptor {
        /// The descriptor every frame published at `layout`'s size carries.
        pub(crate) fn for_layout(layout: &Layout) -> Self {
            Self {
                width: layout.width(),
                height: layout.height(),
                stride: layout.stride(),
                format: FORMAT_RGBA,
            }
        }

        /// Writes the four fields, little-endian, into a slot's 16 descriptor bytes
        /// (spec § Slot descriptor: `width` at +0, `height` at +4, `stride` at +8,
        /// `format` at +12).
        pub(crate) fn write(&self, descriptor: &mut [u8]) {
            assert_eq!(
                descriptor.len(),
                DESCRIPTOR_LEN,
                "a slot descriptor is exactly {DESCRIPTOR_LEN} bytes"
            );
            put_u32(descriptor, 0, self.width);
            put_u32(descriptor, 4, self.height);
            put_u32(descriptor, 8, self.stride);
            put_u32(descriptor, 12, self.format);
        }
    }

    /// What one publish put in the mapping: the slot the frame landed in, the
    /// sequence that names it, and the descriptor written for it. That is
    /// everything the `image.frameshm` request has to repeat, so the request is
    /// built from this value and cannot disagree with the bytes.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) struct Published {
        pub(crate) slot: u32,
        pub(crate) seq: u64,
        pub(crate) descriptor: Descriptor,
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

        // -- descriptors -------------------------------------------------------

        #[test]
        fn a_descriptor_is_written_in_the_specs_field_order() {
            // Spec § Slot descriptor: width at +0, height at +4, stride at +8,
            // format at +12, each four bytes.
            let layout = hd();
            let descriptor = Descriptor::for_layout(&layout);
            assert_eq!(
                descriptor,
                Descriptor {
                    width: 1920,
                    height: 1080,
                    stride: 7680,
                    format: 32,
                }
            );
            let mut view = vec![0xAA; layout.mapping_len()];
            layout.write_header(&mut view);
            descriptor.write(&mut view[layout.descriptor(1)]);
            let base = 64 + 16;
            assert_eq!(u32_at(&view, base), 1920, "width");
            assert_eq!(u32_at(&view, base + 4), 1080, "height");
            assert_eq!(u32_at(&view, base + 8), 7680, "stride");
            assert_eq!(u32_at(&view, base + 12), 32, "format: KittyFormat.Rgba");
            assert!(
                view[64..80].iter().all(|&b| b == 0),
                "slot 0's descriptor is untouched"
            );
            assert!(
                view[96..256].iter().all(|&b| b == 0),
                "and so is the rest of the header"
            );
        }

        #[test]
        fn a_descriptor_refuses_any_length_but_sixteen() {
            for len in [DESCRIPTOR_LEN - 1, DESCRIPTOR_LEN + 1] {
                let result = std::panic::catch_unwind(move || {
                    let mut bytes = vec![0; len];
                    Descriptor::for_layout(&hd()).write(&mut bytes);
                });
                assert!(result.is_err(), "{len} bytes");
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

/// The named shared-memory mapping a [`layout::Layout`] lives in, Windows only.
///
/// This is the Win32 half of the fast path: create the section under the
/// contract's name, map one view of exactly the layout's length, write the header,
/// publish frames into its slots ([`Mapping::publish`]), and tear both down once.
/// It never learns a length from the mapping — the length it maps is the one it
/// asked for — and the only header field it reads back is `ready`, its own atomic.
/// *When* a slot may be refilled, and which sequence a frame gets, is the
/// producer's business (Task 4).
///
/// Reachable only from its tests until the producer lands; the `dead_code` allowance
/// goes with the one on [`layout`].
#[cfg(windows)]
#[allow(
    dead_code,
    reason = "the producer that owns a mapping lands in a later task"
)]
pub(crate) mod mapping {
    use std::io;
    use std::sync::atomic::{AtomicU64, Ordering};

    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, HANDLE};
    use windows_sys::Win32::System::Memory::{
        CreateFileMappingW, FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile,
        PAGE_READWRITE, UnmapViewOfFile,
    };

    use super::layout::{
        Descriptor, Layout, MAX_NAME_SUFFIX, NAME_PREFIX, Published, READY_OFFSET, is_valid_name,
        slot_for,
    };
    use crate::canvas::Canvas;

    /// A page-file-backed section named `name`, with one read-write view over it.
    ///
    /// The view is exactly [`Layout::mapping_len`] bytes long: that is the size the
    /// section was created with and the length the view was mapped with, and it is
    /// held here rather than re-read from the header, so a reader that scribbles on
    /// the header cannot change how far this side believes it may write. The handle
    /// and the view are owned by this struct alone and released once, in [`Drop`],
    /// view first.
    pub(crate) struct Mapping {
        layout: Layout,
        name: String,
        handle: HANDLE,
        view: MEMORY_MAPPED_VIEW_ADDRESS,
    }

    impl Mapping {
        /// Creates the section and maps it, then writes the layout's header into it.
        ///
        /// A name [`is_valid_name`] rejects is refused before any Win32 call, so a
        /// bad name never becomes a kernel object. `ERROR_ALREADY_EXISTS` is an error
        /// too, not a reuse: `CreateFileMappingW` hands back the *existing* section
        /// in that case, and a producer that finds its own name taken has a stale
        /// incarnation still alive somewhere and must pick a fresh suffix rather than
        /// publish into whatever is there.
        #[allow(unsafe_code)]
        pub(crate) fn create(layout: &Layout, name: &str) -> io::Result<Self> {
            if !is_valid_name(name) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "image.frameshm mapping name `{name}` is not `{NAME_PREFIX}` followed by \
                         1..={MAX_NAME_SUFFIX} characters of [A-Za-z0-9._-]"
                    ),
                ));
            }
            let len = layout.mapping_len();
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            // `INVALID_HANDLE_VALUE` for the file means "backed by the page file";
            // the size is split into the two halves the call takes.
            let (size_high, size_low) = ((len as u64 >> 32) as u32, len as u32);
            // SAFETY: `wide` is a NUL-terminated wide string that outlives the call,
            // the attributes pointer is the documented "default security" null, and
            // the file handle is the documented page-file sentinel rather than a
            // handle we would have to own.
            let handle = unsafe {
                CreateFileMappingW(
                    windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE,
                    std::ptr::null(),
                    PAGE_READWRITE,
                    size_high,
                    size_low,
                    wide.as_ptr(),
                )
            };
            // `CreateFileMappingW` fails with a null handle, not `INVALID_HANDLE_VALUE`;
            // and `last_os_error` is read before anything else can overwrite it.
            let last = io::Error::last_os_error();
            if handle.is_null() {
                return Err(io::Error::new(
                    last.kind(),
                    format!("CreateFileMappingW({name}): {last}"),
                ));
            }
            if last.raw_os_error() == Some(ERROR_ALREADY_EXISTS as i32) {
                // The handle is real and refers to someone else's section; close it
                // without touching the section's contents.
                // SAFETY: `handle` was just returned by `CreateFileMappingW` and is
                // closed exactly once, here, before it can be stored anywhere.
                unsafe { CloseHandle(handle) };
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "image.frameshm mapping {name} already exists: a stale incarnation \
                         is still alive, so this one needs a fresh suffix"
                    ),
                ));
            }
            // SAFETY: `handle` is a live section handle we own, and `len` is the size
            // it was created with, so a view of `len` bytes lies inside the section.
            let view = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, len) };
            if view.Value.is_null() {
                let err = io::Error::last_os_error();
                // SAFETY: as above — a handle we own, closed once on this path.
                unsafe { CloseHandle(handle) };
                return Err(io::Error::new(
                    err.kind(),
                    format!("MapViewOfFile({name}, {len} bytes): {err}"),
                ));
            }
            let mut mapping = Self {
                layout: *layout,
                name: name.to_owned(),
                handle,
                view,
            };
            layout.write_header(mapping.view());
            Ok(mapping)
        }

        /// The whole mapping, [`Layout::mapping_len`] bytes, header first.
        #[allow(unsafe_code)]
        pub(crate) fn view(&mut self) -> &mut [u8] {
            // SAFETY: `view` is the base of a live view mapped with exactly
            // `mapping_len` bytes from a section created with that size; the length
            // comes from `self.layout`, never from the header, so no reader can
            // lengthen it. The view stays mapped until `Drop`, which needs `&mut
            // self` too, so the slice cannot outlive it; and `&mut self` is the only
            // way in, so no two slices alias.
            unsafe {
                std::slice::from_raw_parts_mut(
                    self.view.Value.cast::<u8>(),
                    self.layout.mapping_len(),
                )
            }
        }

        /// Publishes `canvas` as frame `seq`: the spec's recipe (§ Publishing a
        /// frame) minus the request. Picks `slot_for(seq)`, writes the slot's
        /// descriptor, copies the rows, then release-stores `seq` into `ready`, and
        /// returns what the request must repeat.
        ///
        /// Nothing is written unless everything will be. A canvas whose size is not
        /// this mapping's is refused whole: a mapping is sized for one frame size,
        /// and the caller's answer to a resize is a new mapping (Task 4), never a
        /// partial slot. A `seq` of `0` — the "nothing published" value — or one at
        /// or below the current `ready` is refused for the same reason: the reader
        /// rejects a sequence that goes backwards, and this side would rather say so
        /// than publish a frame the host will refuse.
        ///
        /// The slot-reuse rule (do not refill a slot before the reply for the frame
        /// that last used it has returned) is not enforced here. With one frame in
        /// flight it holds by construction, because the caller awaits every reply
        /// before calling this again; `frame_file.rs` pins that (Task 5).
        pub(crate) fn publish(&mut self, seq: u64, canvas: &Canvas) -> io::Result<Published> {
            let layout = self.layout;
            if (canvas.width, canvas.height) != (layout.width(), layout.height()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "image.frameshm mapping {} is sized for {}x{}, not the {}x{} canvas: \
                         a resize needs a new mapping",
                        self.name,
                        layout.width(),
                        layout.height(),
                        canvas.width,
                        canvas.height,
                    ),
                ));
            }
            let row = layout.stride() as usize;
            let frame = row * layout.height() as usize;
            if canvas.pixels.len() < frame {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "image.frameshm: a {}x{} canvas needs {frame} bytes, has {}",
                        canvas.width,
                        canvas.height,
                        canvas.pixels.len(),
                    ),
                ));
            }
            let ready = self.ready().load(Ordering::Acquire);
            if seq == 0 || seq <= ready {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "image.frameshm seq {seq} does not follow {ready}: sequences start at 1 \
                         and never go backwards"
                    ),
                ));
            }

            let slot = slot_for(seq);
            let descriptor = Descriptor::for_layout(&layout);
            let view = self.view();
            descriptor.write(&mut view[layout.descriptor(slot)]);
            // Row by row rather than one copy: the two strides agree today because
            // the canvas has no padding, but the spec lets the slot's be wider.
            let rows = canvas.pixels[..frame].chunks_exact(row);
            for (dst, src) in view[layout.pixels(slot)].chunks_exact_mut(row).zip(rows) {
                dst.copy_from_slice(src);
            }
            // The release is what makes the descriptor and the rows above visible
            // to a reader whose acquire load of `ready` sees `seq`.
            self.ready().store(seq, Ordering::Release);
            Ok(Published {
                slot,
                seq,
                descriptor,
            })
        }

        /// The header's `ready` field as the atomic the contract says it is.
        ///
        /// Addressed through the *mapped* field, as the reader addresses it, rather
        /// than through a copy: the store has to be the one the reader's acquire
        /// load pairs with.
        #[allow(unsafe_code)]
        pub(crate) fn ready(&self) -> &AtomicU64 {
            // SAFETY: the view base is allocation-granularity aligned (that is what
            // `MapViewOfFile` returns) and `READY_OFFSET` is 32, so the pointer is
            // 8-byte aligned; `READY_OFFSET + 8` is inside the 256-byte header, which
            // is inside the `mapping_len` bytes the view covers; the view stays
            // mapped for as long as `self` does, which bounds the returned borrow;
            // and no non-atomic access to these eight bytes can overlap the
            // returned reference, because the only other way at them is `view()`,
            // which needs `&mut self`.
            unsafe {
                AtomicU64::from_ptr(self.view.Value.cast::<u8>().add(READY_OFFSET).cast::<u64>())
            }
        }

        /// The name the section was created under: what the request carries.
        pub(crate) fn name(&self) -> &str {
            &self.name
        }

        /// The layout this mapping was sized for.
        pub(crate) fn layout(&self) -> &Layout {
            &self.layout
        }
    }

    impl std::fmt::Debug for Mapping {
        /// The name and the layout; the handle and the view address are not
        /// interesting and would only differ between runs.
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("Mapping")
                .field("name", &self.name)
                .field("layout", &self.layout)
                .finish_non_exhaustive()
        }
    }

    impl Drop for Mapping {
        /// Unmaps the view, then closes the handle. Once both are gone and no reader
        /// holds the section, the name is free and the host's next open of it fails
        /// with an ordinary error — the contract's expected end of a producer.
        #[allow(unsafe_code)]
        fn drop(&mut self) {
            // SAFETY: `view` is the base address `MapViewOfFile` returned and it is
            // unmapped exactly once, here; no slice from `view()` can be alive,
            // because `drop` holds the `&mut self` such a slice would borrow from.
            unsafe { UnmapViewOfFile(self.view) };
            // SAFETY: `handle` is the section handle `CreateFileMappingW` returned
            // and is closed exactly once, here, after the view that depended on it.
            unsafe { CloseHandle(self.handle) };
        }
    }

    #[cfg(test)]
    mod tests {
        //! The reader is not here, so these tests *are* the reader: they open the
        //! section by name with `OpenFileMappingW`, the call `ShmFrameLayout.cs`
        //! makes, and look at the bytes through that second view.

        use std::io;

        use windows_sys::Win32::Foundation::{
            CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, HANDLE,
        };
        use windows_sys::Win32::System::Memory::{
            FILE_MAP_READ, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile, OpenFileMappingW,
            UnmapViewOfFile,
        };

        use super::super::layout::{HEADER_LEN, NAME_PREFIX, PAGE};
        use super::*;
        use crate::canvas::Canvas;

        /// A name no other test, and no other test process, will create: the test's
        /// own tag plus this process's id.
        fn test_name(tag: &str) -> String {
            format!("{NAME_PREFIX}test-{}-{tag}", std::process::id())
        }

        fn hd() -> Layout {
            Layout::for_frame(1920, 1080).unwrap()
        }

        /// The reader's side: a read-only view opened by name.
        struct Reader {
            handle: HANDLE,
            view: MEMORY_MAPPED_VIEW_ADDRESS,
            len: usize,
        }

        impl Reader {
            #[allow(unsafe_code)]
            fn open(name: &str, len: usize) -> io::Result<Self> {
                let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
                // SAFETY: `wide` is NUL-terminated and outlives the call.
                let handle = unsafe { OpenFileMappingW(FILE_MAP_READ, 0, wide.as_ptr()) };
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                // SAFETY: a handle we own; `len` is what the producer created it with.
                let view = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, len) };
                if view.Value.is_null() {
                    let err = io::Error::last_os_error();
                    // SAFETY: closed once, on the failure path only.
                    unsafe { CloseHandle(handle) };
                    return Err(err);
                }
                Ok(Self { handle, view, len })
            }

            #[allow(unsafe_code)]
            fn bytes(&self) -> &[u8] {
                // SAFETY: a live read-only view of `len` bytes, unmapped only in
                // `Drop`, which cannot run while this borrow is alive.
                unsafe { std::slice::from_raw_parts(self.view.Value.cast::<u8>(), self.len) }
            }
        }

        impl std::fmt::Debug for Reader {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "Reader({} bytes)", self.len)
            }
        }

        impl Drop for Reader {
            #[allow(unsafe_code)]
            fn drop(&mut self) {
                // SAFETY: each released once, view before handle, as the producer does.
                unsafe {
                    UnmapViewOfFile(self.view);
                    CloseHandle(self.handle);
                }
            }
        }

        fn u32_at(view: &[u8], offset: usize) -> u32 {
            u32::from_le_bytes(view[offset..offset + 4].try_into().unwrap())
        }

        fn u64_at(view: &[u8], offset: usize) -> u64 {
            u64::from_le_bytes(view[offset..offset + 8].try_into().unwrap())
        }

        // -- the round trip ----------------------------------------------------

        #[test]
        fn a_reader_opening_the_name_sees_the_header_and_the_producers_writes() {
            let layout = hd();
            let name = test_name("roundtrip");
            let mut mapping = Mapping::create(&layout, &name).expect("create");
            assert_eq!(mapping.name(), name);
            assert_eq!(mapping.layout(), &layout);
            assert_eq!(mapping.view().len(), layout.mapping_len());

            let reader = Reader::open(&name, layout.mapping_len()).expect("open by name");
            let seen = reader.bytes();

            // The header, at the spec's offsets — the same assertions Task 1 makes
            // against a Vec, now against the bytes another handle to the section sees.
            assert_eq!(u32_at(seen, 0), 0x46534741, "magic");
            assert_eq!(u32_at(seen, 4), 1, "version");
            assert_eq!(u32_at(seen, 8), 2, "slotCount");
            assert_eq!(u32_at(seen, 12), 0, "flags");
            assert_eq!(u64_at(seen, 16), layout.slot_stride() as u64, "slotStride");
            assert_eq!(u64_at(seen, 24), 256, "pixelOffset");
            assert_eq!(u64_at(seen, 32), 0, "ready");
            assert!(
                seen[40..HEADER_LEN].iter().all(|&b| b == 0),
                "reserved and descriptors"
            );
            let mut expected = vec![0; HEADER_LEN];
            layout.write_header(&mut expected);
            assert_eq!(
                &seen[..HEADER_LEN],
                &expected[..],
                "byte for byte, Task 1's header"
            );
            assert!(
                seen[HEADER_LEN..].iter().all(|&b| b == 0),
                "a fresh section is zero-filled past the header",
            );

            // A byte written through the producer's view is the reader's byte.
            let probe = layout.pixels(1).start + 7;
            mapping.view()[probe] = 0xC3;
            assert_eq!(reader.bytes()[probe], 0xC3, "same pages, seen at once");
            let last = layout.mapping_len() - 1;
            mapping.view()[last] = 0x5A;
            assert_eq!(reader.bytes()[last], 0x5A, "the view reaches its last byte");
        }

        #[test]
        fn the_view_is_the_layouts_length_not_the_sections_page_rounding() {
            // 1x1 needs 256 + 2 * 4096 bytes; the section is 3 pages, and so is the
            // view — the length is the layout's, whatever the kernel rounds to.
            let layout = Layout::for_frame(1, 1).unwrap();
            let mut mapping = Mapping::create(&layout, &test_name("len")).unwrap();
            assert_eq!(mapping.view().len(), 256 + 2 * PAGE);
            assert_eq!(mapping.view().len(), layout.mapping_len());
        }

        // -- error paths ---------------------------------------------------------

        #[test]
        fn an_invalid_name_is_refused_before_it_can_become_an_object() {
            let layout = hd();
            for bad in [
                NAME_PREFIX.to_owned(),                  // empty suffix
                r"Local\winterm-browser-1-0".to_owned(), // the pre-contract spelling
                format!("{NAME_PREFIX}with space"),
                format!("{NAME_PREFIX}a\\b"),
                format!("{NAME_PREFIX}{}", "x".repeat(129)),
            ] {
                let err = Mapping::create(&layout, &bad).expect_err(&bad);
                assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{bad:?}");
                assert!(err.to_string().contains(&bad), "{err}");
                assert!(err.to_string().contains(NAME_PREFIX), "{err}");
                // Nothing was created: the name does not open. (The names with a
                // space or a second backslash are legal kernel names, so this is a
                // real check that no call was made, not a check that it would fail.)
                let open = Reader::open(&bad, layout.mapping_len()).expect_err("no object");
                // A second backslash makes the object manager look for a directory
                // that is not there, which reports as "path" rather than "file".
                assert!(
                    matches!(
                        open.raw_os_error(),
                        Some(code) if code == ERROR_FILE_NOT_FOUND as i32 || code == ERROR_PATH_NOT_FOUND as i32
                    ),
                    "{bad:?}: {open}"
                );
            }
        }

        #[test]
        fn creating_the_same_name_twice_is_a_stale_incarnation_not_a_reuse() {
            let layout = hd();
            let name = test_name("twice");
            let mut first = Mapping::create(&layout, &name).expect("first");
            first.view()[HEADER_LEN] = 0x77;

            let err = Mapping::create(&layout, &name).expect_err("the name is taken");
            assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
            assert!(err.to_string().contains(&name), "{err}");
            assert!(err.to_string().contains("fresh suffix"), "{err}");

            // The refusal touched nothing: the first mapping is intact and still open.
            let reader = Reader::open(&name, layout.mapping_len()).expect("still there");
            assert_eq!(u32_at(reader.bytes(), 0), 0x46534741);
            assert_eq!(
                reader.bytes()[HEADER_LEN],
                0x77,
                "the header was not rewritten"
            );
        }

        #[test]
        fn after_drop_the_name_no_longer_opens() {
            let layout = hd();
            let name = test_name("drop");
            let mapping = Mapping::create(&layout, &name).expect("create");
            // Prove it was there, then let go of *both* handles: a section lives as
            // long as any handle to it, so the reader's has to go too.
            drop(Reader::open(&name, layout.mapping_len()).expect("open while alive"));
            drop(mapping);

            let err = Reader::open(&name, layout.mapping_len()).expect_err("gone");
            assert_eq!(
                err.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND as i32),
                "{err}"
            );
        }

        // -- publishing ------------------------------------------------------------

        /// A canvas painted one colour through the canvas's byte-copying fill.
        fn flat(width: u32, height: u32, rgba: [u8; 4]) -> Canvas {
            let mut canvas = Canvas::new(width, height);
            canvas.fill(rgba);
            canvas
        }

        /// A canvas in which no two nearby pixels agree, so a row landing in the
        /// wrong place, or the wrong slot, is visible.
        fn gradient(width: u32, height: u32) -> Canvas {
            let mut canvas = Canvas::new(width, height);
            for (i, px) in canvas.pixels.chunks_exact_mut(4).enumerate() {
                px.copy_from_slice(&[(i % 251) as u8, (i / 251) as u8, (i % 7) as u8, 255]);
            }
            canvas
        }

        /// The reader's `ready`: the eight bytes at offset 32 through its own view.
        /// A read-only view cannot be handed to `AtomicU64::from_ptr`, which wants
        /// write access, and the producer and this reader are one thread, so a
        /// plain read races with nothing; the acquire side is exercised through
        /// the producer's own atomic.
        fn ready_seen_by(reader: &Reader) -> u64 {
            u64_at(reader.bytes(), 32)
        }

        #[test]
        fn a_publish_writes_the_descriptor_then_the_rows_then_ready() {
            let layout = Layout::for_frame(8, 4).unwrap();
            let name = test_name("publish");
            let mut mapping = Mapping::create(&layout, &name).unwrap();
            let reader = Reader::open(&name, layout.mapping_len()).unwrap();
            assert_eq!(ready_seen_by(&reader), 0, "nothing published yet");

            let first = gradient(8, 4);
            let published = mapping.publish(1, &first).expect("first frame");
            assert_eq!(
                published,
                Published {
                    slot: 1,
                    seq: 1,
                    descriptor: Descriptor {
                        width: 8,
                        height: 4,
                        stride: 32,
                        format: 32,
                    },
                },
                "sequences start at 1, which is slot 1"
            );

            let seen = reader.bytes();
            // Slot 1's descriptor at 64 + 16 * 1, in the spec's field order.
            assert_eq!(u32_at(seen, 80), 8, "width");
            assert_eq!(u32_at(seen, 84), 4, "height");
            assert_eq!(u32_at(seen, 88), 32, "stride");
            assert_eq!(u32_at(seen, 92), 32, "format");
            assert!(
                seen[64..80].iter().all(|&b| b == 0),
                "slot 0's descriptor is untouched"
            );
            assert_eq!(
                &seen[layout.pixels(1)],
                &first.pixels[..],
                "the rows, in order"
            );
            assert!(
                seen[layout.pixels(0)].iter().all(|&b| b == 0),
                "slot 0's pixels are untouched"
            );
            assert_eq!(ready_seen_by(&reader), 1, "ready names the frame");
            assert_eq!(
                mapping.ready().load(Ordering::Acquire),
                1,
                "and an acquire load of the atomic agrees"
            );

            // The next frame takes the other slot and leaves this one alone: the
            // host may still be copying it, and it is the reply, not this call,
            // that frees it.
            let second = flat(8, 4, [1, 2, 3, 255]);
            let published = mapping.publish(2, &second).expect("second frame");
            assert_eq!((published.slot, published.seq), (0, 2));
            let seen = reader.bytes();
            assert_eq!(u32_at(seen, 64), 8, "slot 0's descriptor now");
            assert_eq!(&seen[layout.pixels(0)], &second.pixels[..]);
            assert_eq!(
                &seen[layout.pixels(1)],
                &first.pixels[..],
                "slot 1 still holds frame 1"
            );
            assert_eq!(ready_seen_by(&reader), 2);
            assert_eq!(mapping.ready().load(Ordering::Acquire), 2);
        }

        #[test]
        fn the_slot_holds_the_canvass_bytes_in_the_canvass_order() {
            let layout = Layout::for_frame(3, 2).unwrap();
            let name = test_name("order");
            let mut mapping = Mapping::create(&layout, &name).unwrap();
            let reader = Reader::open(&name, layout.mapping_len()).unwrap();

            // Opaque: an RGBA colour lands as those four bytes, R first. The canvas
            // is tiny-skia RGBA and `format: 32` tells the host exactly that.
            mapping
                .publish(1, &flat(3, 2, [0x11, 0x22, 0x33, 0xFF]))
                .unwrap();
            let pixels = &reader.bytes()[layout.pixels(1)];
            assert_eq!(pixels.len(), 3 * 2 * 4);
            for px in pixels.chunks_exact(4) {
                assert_eq!(px, [0x11, 0x22, 0x33, 0xFF], "R, G, B, A in that order");
            }

            // Translucent: the plan says premultiplied storage is identical for
            // opaque pixels, and this is the case where it is *not*. Painted
            // through tiny-skia over a transparent canvas, (0, 200, 0, 128) is
            // stored premultiplied — green scaled by alpha, about 100 — and the
            // slot carries exactly those stored bytes. So a translucent pixel
            // reaches the host premultiplied; browser frames are opaque, so none
            // does.
            let mut translucent = Canvas::new(3, 2);
            let rect = tiny_skia::Rect::from_xywh(0.0, 0.0, 3.0, 2.0).unwrap();
            translucent.fill_path(&tiny_skia::PathBuilder::from_rect(rect), [0, 200, 0, 128]);
            let stored = tiny_skia::ColorU8::from_rgba(0, 200, 0, 128).premultiply();
            assert_eq!((stored.red(), stored.blue(), stored.alpha()), (0, 0, 128));
            assert!(
                (99..=101).contains(&stored.green()),
                "premultiplied green is 200 * 128 / 255, got {}",
                stored.green()
            );
            mapping.publish(2, &translucent).unwrap();
            let pixels = &reader.bytes()[layout.pixels(0)];
            assert_eq!(
                pixels,
                &translucent.pixels[..],
                "the slot is the canvas, byte for byte"
            );
            for px in pixels.chunks_exact(4) {
                assert_eq!((px[0], px[2], px[3]), (0, 0, 128), "{px:?}");
                assert!(
                    (i32::from(px[1]) - i32::from(stored.green())).abs() <= 1,
                    "green is premultiplied, not 200: {px:?}"
                );
            }
        }

        #[test]
        fn a_full_hd_frame_fills_its_slot_and_nothing_past_it() {
            // The size the budget was measured at: the copy lands whole and the page
            // padding after the last row stays zero.
            let layout = hd();
            let name = test_name("hd");
            let mut mapping = Mapping::create(&layout, &name).unwrap();
            let reader = Reader::open(&name, layout.mapping_len()).unwrap();
            let canvas = gradient(1920, 1080);
            let published = mapping.publish(1, &canvas).unwrap();
            assert_eq!(published.descriptor.stride, 7680);
            let seen = reader.bytes();
            assert_eq!(&seen[layout.pixels(1)], &canvas.pixels[..]);
            let padding = layout.pixels(1).end..layout.mapping_len();
            assert!(
                seen[padding].iter().all(|&b| b == 0),
                "the copy stops at the last row"
            );
        }

        #[test]
        fn a_canvas_of_another_size_is_refused_and_nothing_moves() {
            let layout = Layout::for_frame(8, 4).unwrap();
            let name = test_name("mismatch");
            let mut mapping = Mapping::create(&layout, &name).unwrap();
            let reader = Reader::open(&name, layout.mapping_len()).unwrap();
            mapping.publish(1, &gradient(8, 4)).unwrap();
            let before = reader.bytes().to_vec();

            for (w, h) in [(9, 4), (8, 5), (4, 8), (1, 1), (16, 8)] {
                let err = mapping
                    .publish(2, &gradient(w, h))
                    .expect_err(&format!("{w}x{h}"));
                assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
                assert!(err.to_string().contains(&name), "{err}");
                assert!(err.to_string().contains("8x4"), "{err}");
                assert!(err.to_string().contains(&format!("{w}x{h}")), "{err}");
                assert!(err.to_string().contains("new mapping"), "{err}");
            }
            // A right-sized canvas that does not carry its own pixels: the check
            // `encode_png` makes, made here too.
            let mut short = gradient(8, 4);
            short.pixels.truncate(8);
            let err = mapping.publish(2, &short).expect_err("short");
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
            assert!(err.to_string().contains("128 bytes, has 8"), "{err}");

            assert_eq!(reader.bytes(), &before[..], "not a byte changed");
            assert_eq!(ready_seen_by(&reader), 1, "ready stays put");
            // The sequence was not consumed either: 2 still publishes.
            assert_eq!(mapping.publish(2, &gradient(8, 4)).unwrap().seq, 2);
        }

        #[test]
        fn a_sequence_that_does_not_advance_is_refused_before_the_host_can() {
            let layout = Layout::for_frame(2, 2).unwrap();
            let name = test_name("seq");
            let mut mapping = Mapping::create(&layout, &name).unwrap();
            let reader = Reader::open(&name, layout.mapping_len()).unwrap();
            let canvas = flat(2, 2, [9, 9, 9, 255]);

            let err = mapping
                .publish(0, &canvas)
                .expect_err("0 means nothing published");
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
            assert!(err.to_string().contains("start at 1"), "{err}");
            assert_eq!(ready_seen_by(&reader), 0);
            assert!(
                reader.bytes()[HEADER_LEN..].iter().all(|&b| b == 0),
                "no slot was touched"
            );

            mapping.publish(5, &canvas).unwrap();
            let before = reader.bytes().to_vec();
            for stale in [5, 4, 1] {
                let err = mapping.publish(stale, &canvas).expect_err("backwards");
                assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
                assert!(err.to_string().contains("does not follow 5"), "{err}");
            }
            assert_eq!(reader.bytes(), &before[..]);
            // Gaps are fine: the reader asks only that `seq` never go backwards.
            assert_eq!(mapping.publish(7, &canvas).unwrap().slot, 1);
            assert_eq!(ready_seen_by(&reader), 7);
        }

        #[test]
        fn ready_is_released_last_and_nothing_else_writes_it() {
            // One thread cannot observe the ordering, so this pins the construction
            // that gives it: `publish` writes the descriptor, then the rows, then
            // `ready` — once, with `Release` — and no other store to the atomic
            // exists in this file. A reader's acquire load that sees `seq` therefore
            // sees the descriptor and the rows written before it.
            let source = include_str!("frame_shm.rs");
            let publish = source
                .split("pub(crate) fn publish(")
                .nth(1)
                .expect("publish exists");
            let body = publish.split("pub(crate) fn ready(").next().unwrap();
            let descriptor = body
                .find("descriptor.write(")
                .expect("the descriptor is written");
            let rows = body
                .find("dst.copy_from_slice(src)")
                .expect("the rows are copied");
            let release = body
                .find(".store(seq, Ordering::Release)")
                .expect("ready is release-stored");
            assert!(
                descriptor < rows && rows < release,
                "descriptor, rows, then ready"
            );
            assert_eq!(
                body.matches("Ordering::Release").count(),
                1,
                "exactly one release store in publish"
            );
            // And everything in this file up to this test — every production
            // line, and the tests that come before it — stores to an atomic once.
            let before_this_test = &source[..source
                .find("fn ready_is_released_last_and_nothing_else_writes_it")
                .unwrap()];
            assert_eq!(
                before_this_test.matches(".store(").count(),
                1,
                "publish's is the only store to ready"
            );
        }

        #[test]
        fn a_reader_keeps_the_section_alive_but_the_producer_does_not_care() {
            // The contract: a vanished mapping between calls reports as an ordinary
            // failure. A reader that is mid-copy keeps the pages alive on its own
            // handle, so the producer dropping is safe for it too.
            let layout = Layout::for_frame(4, 4).unwrap();
            let name = test_name("outlive");
            let mut mapping = Mapping::create(&layout, &name).unwrap();
            let probe = layout.pixels(0).start;
            mapping.view()[probe] = 0x11;
            let reader = Reader::open(&name, layout.mapping_len()).unwrap();
            drop(mapping);
            assert_eq!(
                reader.bytes()[probe],
                0x11,
                "the reader's view survives the producer"
            );
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
