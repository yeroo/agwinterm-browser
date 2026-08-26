// What every diverged vendored file *is*, on the record, one entry per path.
//
// `universe.mjs` answers "what is in scope"; this file answers the question that
// comes next and that the old guard never asked outside `pixel-core/src`: forty-four
// vendored paths differ from the baseline, so which of them is that supposed to be?
//
// Most of them are supposed to. `cli/src/main.ts`, `browser/src/page/controller.ts`
// and `engine/crates/pixel-core/src/terminal.rs` are what the port *is*, and a guard
// that demanded a divergence note for each would be demanding a note for the work.
// `docs/design/UPSTREAM.md` says so itself: its numbered list is for "edits to
// vendored files that are **not** the port's own subject matter". That distinction is
// real, and it is exactly what the old check dodged by retreating to the one tree
// where "keep these unchanged" had ever been claimed.
//
// So there are three dispositions and no fourth:
//
//   subject matter     the port rewrote this on purpose, and a plan task owns it.
//                      `SUBJECT`, keyed by path, valued by the task that owns it.
//   incidental         vendored code edited for a reason that is not the port's
//                      subject. `INCIDENTAL`, keyed by path, valued by its
//                      `UPSTREAM.md` number — which is what a re-vendorer re-applies.
//   not vendored       the vendoring commit carried it, but it is this repo's own
//                      project file. `EXCLUSIONS` in `universe.mjs`; it never reaches
//                      the survey at all.
//
// An unclassified path is a test failure, and the failure names the three choices
// rather than only the problem — the next person arrives asking "what do I do", and
// being told "something changed" is how a table starts getting silenced instead of
// filled in.
//
// **Keyed by path on purpose.** A vendored file that moves loses its entry at the old
// path (`auditDispositions` reports it stale, because the old path no longer differs)
// and arrives unclassified at the new one. Both halves are loud. Keyed by anything
// fuzzier — a directory, a glob — a move would land inside an existing rule and say
// nothing at all.

import fs from "node:fs";
import path from "node:path";

import { BASELINE, EXCLUSIONS, REPO } from "./universe.mjs";

/** The two plans whose tasks own subject-matter edits. */
const PORT = "20260821-windows-port";
const CORRECTIONS = "20260822-post-port-corrections";

/**
 * Vendored paths the port rewrote as its own subject matter, and the task that owns
 * each. The task is the point of the entry: "the port changed it" is not a
 * disposition, it is the observation that prompted the question.
 *
 * The owning task is the one whose work the *current* content of the file belongs
 * to, which is usually but not always the task that first touched it. Several of
 * these were finished in a later review round; where that matters the reason says so,
 * because "which task do I read to understand this diff" is what the field is for.
 */
export const SUBJECT = Object.freeze({
  // -- the process model: one browser per pane, in the foreground ---------------
  "browser/src/main.tsx": {
    task: `${PORT} Task 2`,
    reason:
      "the fork in the road: `entryMode(argv)` sends a Windows launch to " +
      "`runForeground` instead of `runDaemon`, which is the whole process-model " +
      "decision expressed in five lines.",
  },
  "browser/src/daemon.ts": {
    task: `${PORT} Task 13`,
    reason:
      "`DAEMON_SOCKET` becomes `DAEMON_ENDPOINT`, and the liveness probe grows a " +
      "third answer: a daemon that did not accept within the budget is not a daemon " +
      "whose name may be unlinked out from under it.",
  },
  "browser/src/registry.ts": {
    task: `${PORT} Task 13`,
    reason:
      "instance registration against the store's endpoint column rather than a unix " +
      "socket path, plus the reclaim rules a pipe name needs and a socket file does not.",
  },

  // -- interactive input: what a Windows console can and cannot deliver ---------
  "browser/src/page/controller.ts": {
    task: `${PORT} Task 11`,
    reason:
      "`reportsKeyReleases` threaded to every `PageInput` the controller owns — the " +
      "page's, devtools' and each popup's — because the answer belongs to the terminal " +
      "a session is attached to, and one daemon serves several.",
  },
  "browser/src/page/input.ts": {
    task: `${PORT} Task 11`,
    reason:
      "the synthetic key-up: a console that never reports a release would otherwise " +
      "leave a modifier held down forever, so the port supplies the half of the event " +
      "the host cannot.",
  },
  "browser/src/page/devtools.ts": {
    task: `${PORT} Task 11`,
    reason:
      "carries `reportsKeyReleases` and the CSS size into the devtools window's `PageInput`.",
  },
  "browser/src/page/popup.ts": {
    task: `${PORT} Task 11`,
    reason: "the same two arguments for a popup window, whose sizes are already CSS pixels.",
  },
  "browser/src/session/keybindings.ts": {
    task: `${PORT} Task 11`,
    reason:
      "Cmd is Ctrl on Windows, and the chords a console cannot encode at all — " +
      "Ctrl+Enter, Ctrl+`=`/`-`/`0` — get an Alt spelling that is deliverable.",
  },
  "browser/src/session/session.tsx": {
    task: `${PORT} Task 11`,
    reason:
      "the session's half of the same rebinding, and the release-reporting capability it feeds.",
  },
  "browser/src/record/session.ts": {
    task: `${PORT} Task 11`,
    reason:
      "the review canvas reads `isCompleteKey`/`zoomHeld` rather than `cmd` directly: " +
      "without it `complete()` was unreachable on Windows and the Alt zoom fell through " +
      "to the live page underneath. Found in a review round; the task is still Task 11's.",
  },
  "browser/src/ui/record-bar.tsx": {
    task: `${PORT} Task 11`,
    reason:
      "the toolbar prints `completeKeyLabel` rather than a hard-coded `ctrl+enter` that " +
      "is a lie on Windows.",
  },

  // -- paths, and what "absolute" means on a machine with drives ---------------
  "browser/src/url.ts": {
    task: `${PORT} Task 9`,
    reason:
      "`~\\` and `.\\` admitted as local-file spellings on Windows only. Without it the " +
      "spelling a Windows user types fell past `localFile` and `normalizeUrl` turned it " +
      "into a web search — the exact failure `CALLER_CWD_VAR` was added to end.",
  },
  "browser/src/record/paths.ts": {
    task: `${PORT} Task 13`,
    reason:
      "alt+r's output root under `DATA_DIR` on Windows. A leading slash there is " +
      "drive-*relative*, so `/tmp/recordings` landed outside everything an uninstall " +
      "removes. Unix keeps the inherited path byte-for-byte.",
  },

  // -- the CLI, and the two protocols that had to stop being unix sockets ------
  "cli/src/main.ts": {
    task: `${PORT} Tasks 9 and 13`,
    reason:
      "the launcher and the command surface: `CALLER_CWD_VAR`, no shell in the spawn " +
      "path, the endpoint vocabulary, and the verbs Windows refuses. The largest " +
      "subject-matter diff in the tree and the one the port is most about.",
  },
  "cli/src/action.ts": {
    task: `${PORT} Task 13`,
    reason:
      "`browser.socket` becomes `browser.endpoint`, and the default scope goes through `scopeHere`.",
  },
  "cli/src/control.ts": {
    task: `${PORT} Task 13`,
    reason:
      "the control client dials a pipe name or a socket path, and every exchange carries a deadline.",
  },
  "cli/src/instances.ts": {
    task: `${PORT} Task 13`,
    reason:
      "`scopeHere` and `noBrowserHere`: one browser per pane means `inCurrentTab` is " +
      "false for every browser on Windows, so filtering on it scoped every command to nothing.",
  },
  "cli/src/ls.ts": {
    task: `${PORT} Task 13`,
    reason: "the listed column is `endpoint`, and the default scope is `scopeHere`.",
  },
  "cli/src/help.ts": {
    task: `${PORT} Task 13`,
    reason:
      "platform notes appended rather than edited in, and a refused verb marked in the " +
      "list rather than removed from it. Also carries the `pane-clear` page added by " +
      `${CORRECTIONS} Task 1.`,
  },
  "cli/src/sandbox.ts": {
    task: `${PORT} Task 13`,
    reason:
      "`terminal-browser setup` says off Linux that there was nothing to configure, " +
      "rather than upstream's silent 0, which reads the same as success.",
  },
  "cli/src/ssh.ts": {
    task: `${PORT} Task 13`,
    reason: "`--ssh` refuses on the argument-parsing path, before anything is spawned.",
  },
  "cli/src/upgrade.ts": {
    task: `${PORT} Task 13`,
    reason:
      "`upgrade` refuses before the version lookup, so the message names the real " +
      "obstacle. The `https:`-only check and the `$1` argument that stopped a manifest " +
      "url being re-parsed by the shell came out of a later review round.",
  },

  // -- the store: an endpoint is not a socket ---------------------------------
  "store/src/schema.ts": {
    task: `${PORT} Task 13`,
    reason:
      "the column is `endpoint`: on Windows it holds a pipe name, which is neither a " +
      "socket nor a path.",
  },
  "store/src/index.ts": {
    task: `${PORT} Task 13`,
    reason: "re-exports the endpoint vocabulary and `appPaths` the rest of the port is written against.",
  },
  "store/src/paths.ts": {
    task: `${PORT} Task 13`,
    reason:
      "`%LOCALAPPDATA%` homes for the four data directories, and `instanceEndpoint` " +
      "producing a pipe name where unix produces a socket path.",
  },
  "store/src/instances.ts": {
    task: `${PORT} Task 13`,
    reason: "instance rows keyed by endpoint, with the liveness and reclaim rules a pipe name needs.",
  },
  "store/src/client.ts": {
    task: `${PORT} Task 13`,
    reason:
      "`busy_timeout` set *before* `journal_mode = WAL`, and the order is the fix: a " +
      "fresh connection has no timeout, and the WAL conversion is the statement that " +
      "wants the exclusive lock. Two panes opening at once is ordinary here.",
  },
  "store/src/migrate.ts": {
    task: `${PORT} Task 13`,
    reason:
      "`BEGIN IMMEDIATE`, and the applied-set re-read inside it. A deferred `BEGIN` let " +
      "two panes both pass the check and both run `0003`; the loser threw out of " +
      "`openStore` and took its browser with it.",
  },
  "store/src/migrations.gen.ts": {
    task: `${PORT} Task 13`,
    reason: "the generated embedding of migration `0003_windows_named_pipes`.",
  },
  "store/migrations/meta/_journal.json": {
    task: `${PORT} Task 13`,
    reason: "drizzle's journal entry for the same migration.",
  },
  "store/scripts/embed-migrations.ts": {
    task: `${PORT} Task 13`,
    reason:
      "CRLF normalised before embedding, so the generated file does not differ byte for " +
      "byte depending on which checkout ran the script.",
  },

  // -- pixel-core: the modules the port replaces -------------------------------
  "engine/crates/pixel-core/src/terminal.rs": {
    task: `${PORT} Tasks 3 and 4`,
    reason:
      "the tty code gated and the decoder kept — 194 lines out, 91 in. `UPSTREAM.md` " +
      "names this file as excluded from the divergence list for exactly this reason: " +
      "replacing it is what the port is.",
  },
  "engine/crates/pixel-core/src/lib.rs": {
    task: `${PORT} Tasks 3-7`,
    reason:
      "module declarations only: the port's six new modules, the `#[cfg]` gates on " +
      "ghostty/herdr, and the `TerminalBackend` re-export. Declaring a module lands " +
      "here, so every task that adds one touches it.",
  },

  // -- pixel-terminals ---------------------------------------------------------
  "terminals/src/shared.ts": {
    task: `${PORT} Task 13`,
    reason:
      "`callerTty` returns `{ path: null, denied: false }` on Windows. Walking the " +
      "process tree instead would throw on the first hop and report `denied: true`, " +
      "which callers print as advice about escalating permissions.",
  },

  // -- this directory's own first guard ---------------------------------------
  "tools/vendor-check/inventory.test.mjs": {
    task: `${PORT} Task 1`,
    reason:
      "the unix-API screen over `pixel-core/src`, written by the task that took the " +
      "baseline and grown by every task that dispositioned a module. It is this repo's " +
      "own tool that the vendoring commit happened to carry, so the port editing it is " +
      "the port doing its job.",
  },
});

/**
 * Vendored paths edited for a reason that is *not* the port's subject matter, and
 * the `UPSTREAM.md` divergence that records each.
 *
 * `divergence: null` means "incidental, and `UPSTREAM.md` does not say so yet" — a
 * real gap, not a category. It is tolerated only because Task 4 of
 * `docs/plans/20260826-vendor-check-gap.md` is what closes it, and it is bounded by
 * `UNRECORDED_BUDGET` below so it cannot quietly become the normal case while it waits.
 */
export const INCIDENTAL = Object.freeze({
  "engine/crates/pixel-core/src/clipboard_image.rs": {
    divergence: 4,
    reason:
      "four POSIX path assumptions widened behind `cfg!(windows)`, and UNC narrowed — " +
      "`is_file` on a share is an authenticated outbound connect on the event-loop thread.",
  },
  "engine/crates/pixel-node/src/lib.rs": {
    divergence: 5,
    reason:
      "the `SurfaceSink` seam and `WATCH_RESIZE = cfg!(windows)`. The recorded scope is " +
      "wrong today — divergence 5 calls this 'one line' and the diff is 237 insertions; " +
      "Task 4 of the vendor-check-gap plan corrects it.",
  },
  "engine/crates/pixel-core/src/engine/mod.rs": {
    divergence: 6,
    reason:
      "one added `#[test]`, asserting something about upstream's code. No production line changed.",
  },
  "engine/crates/pixel-node/src/capture.rs": {
    divergence: null,
    reason:
      "a `read_exact_at` shim: upstream reaches for `std::os::unix::fs::FileExt`, and " +
      "Windows' `seek_read` takes the offset but is a short read, so the loop supplies " +
      "the 'exact' half. Plus one `allow(dead_code)` on a path Windows does not call.",
  },
  "engine/crates/pixel-node/src/surface.rs": {
    divergence: null,
    reason:
      "`cfg_attr(windows, allow(irrefutable_let_patterns))` on two recycling sites and " +
      "the test module — `SurfacePixels` has one variant on Windows. Scoped rather than " +
      "crate-wide so unix keeps warning if a variant becomes genuinely unreachable.",
  },
  "engine/packages/pixel-react/scripts/build-native.mjs": {
    divergence: null,
    reason:
      "rewritten, including the `win32` branch of `libraryName` — the napi artifact is " +
      "`pixel_node.dll`, not a `.so`, and nothing else in the tree knew that.",
  },
  "engine/Cargo.toml": {
    divergence: null,
    reason:
      "the `windows-sys` workspace dependency and the six feature gates the console " +
      "backend and the control-pipe test fixture need.",
  },
  "engine/crates/pixel-core/Cargo.toml": {
    divergence: null,
    reason:
      "`windows-sys` as a `cfg(windows)` target dependency, kept to the smallest feature " +
      "set that compiles `terminal_windows.rs`.",
  },
  "engine/Cargo.lock": {
    divergence: null,
    reason:
      "cargo's regeneration of the two manifest edits above — resolved, not authored. It " +
      "is listed rather than excluded because a lockfile that moved without a manifest " +
      "moving is a real event, and the only way to notice one is to require a reason.",
  },
});

/**
 * How many `INCIDENTAL` entries are allowed to have no `UPSTREAM.md` number.
 *
 * Pinned debt. Six paths are incidental divergences the document does not record,
 * which is half of what this plan exists to fix; Task 4 writes them up and drops this
 * to 0. Pinning the count means the gap cannot grow while it waits.
 */
export const UNRECORDED_BUDGET = 6;

/**
 * The `UPSTREAM.md` divergence list, as paths this module can check.
 *
 * `appliedIn` is the field that stops the check being wrong. Divergences 1-3 were
 * applied *by the vendoring commit itself* — the port needed `pnpm install` to work
 * before it could write a line — so they have no diff against `BASELINE` and never
 * appear in the survey. That does not make them unreal; it makes "does it differ from
 * the baseline" the wrong question for them, and `evidence` the right one.
 */
export const DIVERGENCES = Object.freeze({
  1: {
    path: "browser/package.json",
    appliedIn: "vendoring-commit",
    evidence: /"postinstall":\s*"node node_modules\/electron\/install\.js"/,
    what: "`postinstall` runs Electron's own installer, not `bash ../scripts/fetch-electron.sh`",
  },
  2: {
    path: "pnpm-workspace.yaml",
    appliedIn: "vendoring-commit",
    evidence: /onlyBuiltDependencies:(?:\s*\n\s+-\s+\S+)*\s*\n\s+-\s+electron\b/,
    what: "`electron` added to `onlyBuiltDependencies`",
  },
  3: {
    path: "package.json",
    appliedIn: "vendoring-commit",
    evidence: /"test":\s*"node --test/,
    what: "a root `test` script running the vendor-check suite",
  },
  4: {
    path: "engine/crates/pixel-core/src/clipboard_image.rs",
    appliedIn: "port",
    what: "POSIX path assumptions widened, UNC deliberately refused",
  },
  5: {
    path: "engine/crates/pixel-node/src/lib.rs",
    appliedIn: "port",
    what: "the `SurfaceSink` seam and `WATCH_RESIZE = cfg!(windows)`",
  },
  6: {
    path: "engine/crates/pixel-core/src/engine/mod.rs",
    appliedIn: "port",
    what: "one added `#[test]`",
  },
});

/**
 * What a path is: `"subject"`, `"incidental"` or `"excluded"`, with its entry.
 *
 * Throws for anything with no disposition, and the message is the whole point — see
 * `unclassifiedMessage`.
 */
export function dispositionOf(candidate) {
  if (Object.hasOwn(SUBJECT, candidate)) return { kind: "subject", ...SUBJECT[candidate] };
  if (Object.hasOwn(INCIDENTAL, candidate)) return { kind: "incidental", ...INCIDENTAL[candidate] };
  if (Object.hasOwn(EXCLUSIONS, candidate)) {
    return { kind: "excluded", reason: EXCLUSIONS[candidate] };
  }
  throw new Error(unclassifiedMessage(candidate));
}

/** How many of the three tables claim `candidate`. Exactly one is the only right answer. */
export function dispositionCount(candidate) {
  return [SUBJECT, INCIDENTAL, EXCLUSIONS].filter((table) => Object.hasOwn(table, candidate))
    .length;
}

/**
 * What to tell someone whose new edit just failed the guard.
 *
 * "A vendored file changed" is the finding; it is not useful on its own, because the
 * reader's next question is which of the three things they just did. Naming the
 * choices, the files to edit, and the fact that there is no fourth answer is the
 * difference between a check that gets filled in and one that gets silenced.
 */
export function unclassifiedMessage(candidate) {
  return (
    `${candidate} differs from ${BASELINE} and has no disposition. It is one of three ` +
    `things, and tools/vendor-check/dispositions.mjs has to say which:\n` +
    `  - subject matter: the port rewrote it on purpose. Add it to SUBJECT with the ` +
    `plan task that owns it and a sentence on what the edit does.\n` +
    `  - incidental divergence: vendored code edited for a reason that is not the ` +
    `port's subject. Add it to INCIDENTAL and number it in docs/design/UPSTREAM.md, ` +
    `which is what a re-vendor re-applies.\n` +
    `  - not vendored: the vendoring commit carried it, but it is this repo's own ` +
    `project file. Add it to EXCLUSIONS in tools/vendor-check/universe.mjs with a reason.\n` +
    `There is no fourth answer and no silent one.`
  );
}

/**
 * Every path this table dispositions, sorted. `EXCLUSIONS` is not in it: those paths
 * are out of the vendored universe by construction and so never reach a survey.
 */
export function dispositionedPaths() {
  return [...Object.keys(SUBJECT), ...Object.keys(INCIDENTAL)].sort();
}

/**
 * The audit, as a pure function of a survey: what changed with no disposition, and
 * what has a disposition but no longer changes.
 *
 * Pure so that "an entry went stale" and "a vendored file went missing" are testable
 * without a test that edits or deletes a vendored file out from under the rest of the
 * run. `deleted` is passed through rather than folded into `stale`: a file that is
 * gone is one event, and reporting it twice under two names reads as two problems.
 */
export function auditDispositions({ changed, deleted = [] }) {
  const gone = new Set(deleted);
  const live = new Set(changed);
  return {
    unclassified: changed.filter((file) => dispositionCount(file) === 0).sort(),
    stale: dispositionedPaths().filter((file) => !live.has(file) && !gone.has(file)),
    deleted: [...deleted].sort(),
  };
}

/** Reads a repo-relative path. Separate so a test can point the divergence check at a fixture. */
export function readRepoFile(relative) {
  return fs.readFileSync(path.join(REPO, ...relative.split("/")), "utf8");
}

/**
 * Checks a `vendoring-commit` divergence by content rather than by diff: is the edit
 * `UPSTREAM.md` describes actually in the file today?
 *
 * This is the half of the divergence list no check has ever covered. Divergences 1-3
 * do not differ from the baseline — they *are* the baseline — so a re-vendor that
 * dropped one would leave every diff-based check green while `pnpm install` quietly
 * produced no Electron binary.
 */
export function divergenceEvidenceHolds(number, read = readRepoFile) {
  const entry = DIVERGENCES[number];
  if (!entry) throw new Error(`there is no divergence ${number} in UPSTREAM.md`);
  if (entry.appliedIn !== "vendoring-commit") {
    throw new Error(
      `divergence ${number} (${entry.path}) is applied by the port, so it is checked by ` +
        `diffing against ${BASELINE}, not by matching content.`,
    );
  }
  return entry.evidence.test(read(entry.path));
}
