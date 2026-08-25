//! Locks in what a real ConPTY does to the input sequences the port's decoder
//! depends on. These drive an actual pseudoconsole; if conhost's behaviour ever
//! changes, Task 5 and Task 11 find out here rather than in a browser session.

use std::path::PathBuf;

use conpty_probe::{escape, measure, probe_cases, Case, MouseMode};

fn probe_exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_conpty-probe"))
}

/// Runs one case and fails loudly if the child was not actually under our pty —
/// a capture from the wrong console would make every other assertion meaningless.
fn capture(tag: &'static str, sequence: &[u8], mouse: MouseMode) -> conpty_probe::Capture {
    let case = Case {
        tag,
        sequence: sequence.to_vec(),
        mouse,
    };
    let capture = measure(&probe_exe(), &case).expect("pseudoconsole measurement");
    assert!(
        capture.ran_under_pty(),
        "{tag}: child reported console {:?}, not the harness pseudoconsole",
        capture.child_console
    );
    capture
}

fn assert_verbatim(tag: &'static str, sequence: &[u8], mouse: MouseMode) {
    let capture = capture(tag, sequence, mouse);
    assert_eq!(
        capture.received,
        capture.sent,
        "{tag}: sent {} but read {}",
        escape(&capture.sent),
        escape(&capture.received)
    );
}

/// The control. If plain text does not survive, nothing below means anything.
#[test]
fn plain_text_reaches_the_child() {
    assert_verbatim("t-plain", b"hello", MouseMode::Request);
}

/// The shape conhost was built to translate — the floor for the decoder.
#[test]
fn legacy_cursor_keys_reach_the_child() {
    assert_verbatim("t-arrow", b"\x1b[A", MouseMode::Request);
    assert_verbatim("t-arrow-mod", b"\x1b[1;5A", MouseMode::Request);
}

/// SGR mouse reports are what agwinterm synthesises and what `parse_sgr_mouse`
/// consumes. Press, release and drag all matter to Task 11.
#[test]
fn sgr_mouse_reports_survive_the_pty() {
    assert_verbatim("t-mouse-press", b"\x1b[<0;12;5M", MouseMode::Request);
    assert_verbatim("t-mouse-release", b"\x1b[<0;12;5m", MouseMode::Request);
    assert_verbatim("t-mouse-drag", b"\x1b[<32;13;5M", MouseMode::Request);
}

/// Three-digit coordinates exercise the wide-pane case; a truncating translation
/// layer would show up here and nowhere else.
#[test]
fn sgr_mouse_reports_survive_large_coordinates() {
    assert_verbatim("t-mouse-wide", b"\x1b[<0;198;39M", MouseMode::Request);
}

/// Kitty-keyboard CSI-u is the exotic form the brief flagged as most at risk.
#[test]
fn kitty_csi_u_reports_survive_the_pty() {
    assert_verbatim("t-csi-u", b"\x1b[97u", MouseMode::Request);
    assert_verbatim("t-csi-u-mods", b"\x1b[97;6u", MouseMode::Request);
}

/// The DECSET handshake turns out not to gate delivery on this path: mouse bytes
/// arrive even when the client never asked for mouse reporting. Recorded as a
/// measurement, not a licence to skip the handshake — a real host still needs it
/// to decide whether to send anything.
#[test]
fn mouse_bytes_arrive_even_without_the_decset_handshake() {
    assert_verbatim("t-mouse-nodecset", b"\x1b[<0;12;5M", MouseMode::Skip);
}

/// A run of sequences in one write must not be coalesced, reordered or split in a
/// way that loses bytes — the decoder is fed whatever a single read returns.
#[test]
fn a_burst_of_sequences_arrives_intact_and_in_order() {
    assert_verbatim(
        "t-burst",
        b"\x1b[<0;12;5M\x1b[<0;12;5m\x1b[97;6u\x1b[A",
        MouseMode::Request,
    );
}

/// The table the design record quotes, asserted in one place so a regression in
/// any single case fails the suite.
#[test]
fn every_documented_probe_case_still_holds() {
    for case in probe_cases() {
        let measured = measure(&probe_exe(), &case).expect("pseudoconsole measurement");
        assert!(
            measured.ran_under_pty(),
            "{}: child reported console {:?}",
            case.tag,
            measured.child_console
        );
        assert_eq!(
            measured.verdict(),
            "verbatim",
            "{}: sent {} but read {}",
            case.tag,
            escape(&measured.sent),
            escape(&measured.received)
        );
    }
}
