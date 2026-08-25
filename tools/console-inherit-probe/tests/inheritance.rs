//! Locks in the Win32 facts the Windows process model was chosen on
//! (`docs/design/03-process-model.md`). Each test drives a real pseudoconsole and
//! two real child processes; if any of this stops being true, the decision that
//! rests on it fails here rather than at the Task 10 milestone.

use std::path::PathBuf;

use console_inherit_probe::{escape, measure, Observation, Scenario, ERROR_ACCESS_DENIED};

/// `ERROR_INVALID_HANDLE` — what opening `CONIN$` returns to a process that has no
/// console at all.
const ERROR_INVALID_HANDLE: u32 = 6;

/// The pane input every scenario is fed: an SGR mouse report, the form the port's
/// decoder most needs to survive the trip.
const PANE_INPUT: &[u8] = b"\x1b[<0;12;5M";

fn host_exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_console-inherit-probe"))
}

fn gui_exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_gui-child"))
}

/// Runs one scenario and fails loudly if the middle process was not actually
/// inside the harness pseudoconsole — every other assertion is meaningless then.
fn observe(scenario: Scenario, tag: &str) -> Observation {
    let observation = measure(&host_exe(), &gui_exe(), scenario, tag, PANE_INPUT)
        .expect("pseudoconsole measurement");
    assert!(
        observation.topology_held(),
        "{tag}: the middle process reported console {:?}, not the harness pseudoconsole",
        observation.middle_console
    );
    observation
}

/// The control. A console-subsystem child of a process in the pane gets the pane's
/// console for free, and can read its input. If this ever fails, the harness is
/// broken and the GUI results below say nothing.
#[test]
fn a_console_subsystem_child_inherits_the_pane_console() {
    let observation = observe(Scenario::ConsoleInherit, "t-console-inherit");
    assert!(observation.owns_pane_console(), "{observation:?}");
    assert_eq!(observation.conin_err, 0);
    assert_eq!(
        observation.received,
        PANE_INPUT,
        "read {} from the pane",
        escape(&observation.received)
    );
}

/// The finding the process model turns on: subsystem, not creation flags, decides
/// whether the console comes for free. Electron is a `/SUBSYSTEM:WINDOWS` image, so
/// spawning it from the pane is *not* by itself enough to give it the pane.
#[test]
fn a_gui_subsystem_child_is_not_given_the_console_even_on_an_ordinary_spawn() {
    let observation = observe(Scenario::GuiInherit, "t-gui-inherit");
    assert!(!observation.attached, "{observation:?}");
    assert_eq!(
        observation.conin_err, ERROR_INVALID_HANDLE,
        "expected CONIN$ to be unopenable for want of a console"
    );
}

/// ...and the second half of that finding: it can take the console explicitly, and
/// once it has, the pane's input reaches it byte for byte. This is what makes the
/// foreground model viable, and it is why Task 5's `open` needs an attach step.
#[test]
fn a_gui_subsystem_child_can_attach_to_the_pane_and_then_read_it() {
    for (scenario, tag) in [
        (Scenario::GuiInherit, "t-gui-attach-parent"),
        (Scenario::GuiAttachByPid, "t-gui-attach-pid"),
    ] {
        let observation = observe(scenario, tag);
        assert_eq!(
            observation.reattach_err, 0,
            "{tag}: AttachConsole failed: {observation:?}"
        );
        assert_eq!(
            observation.reattached_console,
            (
                console_inherit_probe::PTY_COLS,
                console_inherit_probe::PTY_ROWS
            ),
            "{tag}: attached to some console other than the pane's"
        );
        assert_eq!(
            observation.received,
            PANE_INPUT,
            "{tag}: read {} from the pane",
            escape(&observation.received)
        );
    }
}

/// Naming the console owner's process id works as well as `ATTACH_PARENT_PROCESS`,
/// which is what lets the launcher put a wrapper process in between if it ever has
/// to. Asserted separately from the shared loop above so the launcher's option is
/// visible as its own guarantee.
#[test]
fn attaching_by_named_process_id_reaches_the_same_console() {
    let by_pid = observe(Scenario::GuiAttachByPid, "t-by-pid");
    let by_parent = observe(Scenario::GuiInherit, "t-by-parent");
    assert_eq!(by_pid.reattached_console, by_parent.reattached_console);
    assert_eq!(by_pid.received, by_parent.received);
}

/// A process that already has a console cannot take a second one:
/// `AttachConsole` refuses with `ERROR_ACCESS_DENIED`. This is the measured reason
/// one daemon process can never serve N panes, and therefore the reason the
/// daemon's tty-by-path architecture has no Windows equivalent.
#[test]
fn a_process_that_has_a_console_cannot_attach_to_another() {
    let observation = observe(Scenario::ConsoleInherit, "t-one-console");
    assert!(observation.attached);
    assert_eq!(
        observation.reattach_err, ERROR_ACCESS_DENIED,
        "a second AttachConsole should have been refused: {observation:?}"
    );
}

/// `DETACHED_PROCESS` is not what stands between the daemon and the pane — a
/// detached child can still attach to its parent's console. Recorded so that
/// "just drop `detached: true`" is not mistaken for a fix: what actually rules the
/// daemon out is that it outlives its spawning pane and serves panes it is not a
/// child of, plus the one-console-per-process limit above.
#[test]
fn detaching_does_not_by_itself_prevent_reaching_the_pane() {
    let observation = observe(Scenario::GuiDetached, "t-detached");
    assert!(!observation.attached);
    assert_eq!(observation.reattach_err, 0, "{observation:?}");
    assert_eq!(observation.received, PANE_INPUT);
}

/// The table `docs/design/03-process-model.md` quotes, asserted in one place.
#[test]
fn every_scenario_still_measures_what_the_decision_recorded() {
    for scenario in Scenario::all() {
        let tag = format!("t-all-{}", scenario.tag());
        let observation = observe(scenario, &tag);
        let expected_attached = !scenario.child_is_gui();
        assert_eq!(
            observation.attached,
            expected_attached,
            "{}: attachment changed: {observation:?}",
            scenario.tag()
        );
        // Whether given or taken, every arm ends up reading the pane.
        assert_eq!(
            observation.received,
            PANE_INPUT,
            "{}: read {}",
            scenario.tag(),
            escape(&observation.received)
        );
    }
}
