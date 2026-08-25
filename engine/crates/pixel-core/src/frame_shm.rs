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
