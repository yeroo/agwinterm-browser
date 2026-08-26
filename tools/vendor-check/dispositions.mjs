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
 * real gap, not a category. Six entries carried one until Task 4 of
 * `docs/plans/20260826-vendor-check-gap.md` wrote them up as divergences 7-12;
 * `UNRECORDED_BUDGET` is 0 now, so the field is kept only to make the next one fail
 * loudly rather than to make room for it.
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
      "the `SurfaceSink` seam and `WATCH_RESIZE = cfg!(windows)` — 237 insertions across " +
      "two edits. Divergence 5 called this 'one line' until Task 4 of the vendor-check-gap " +
      "plan rewrote it; the constant was the one line, the trait was the other 200.",
  },
  "engine/crates/pixel-core/src/engine/mod.rs": {
    divergence: 6,
    reason:
      "one added `#[test]`, asserting something about upstream's code. No production line changed.",
  },
  "engine/crates/pixel-node/src/capture.rs": {
    divergence: 7,
    reason:
      "a `read_exact_at` shim: upstream reaches for `std::os::unix::fs::FileExt`, and " +
      "Windows' `seek_read` takes the offset but is a short read, so the loop supplies " +
      "the 'exact' half. Plus one `allow(dead_code)` on a path Windows does not call.",
  },
  "engine/crates/pixel-node/src/surface.rs": {
    divergence: 8,
    reason:
      "`cfg_attr(windows, allow(irrefutable_let_patterns))` on two recycling sites and " +
      "the test module — `SurfacePixels` has one variant on Windows. Scoped rather than " +
      "crate-wide so unix keeps warning if a variant becomes genuinely unreachable.",
  },
  "engine/packages/pixel-react/scripts/build-native.mjs": {
    divergence: 9,
    reason:
      "rewritten, including the `win32` branch of `libraryName` — the napi artifact is " +
      "`pixel_node.dll`, not a `.so`, and nothing else in the tree knew that.",
  },
  "engine/Cargo.toml": {
    divergence: 10,
    reason:
      "the `windows-sys` workspace dependency and the six feature gates the console " +
      "backend and the control-pipe test fixture need.",
  },
  "engine/crates/pixel-core/Cargo.toml": {
    divergence: 11,
    reason:
      "`windows-sys` as a `cfg(windows)` target dependency, kept to the smallest feature " +
      "set that compiles `terminal_windows.rs`.",
  },
  "engine/Cargo.lock": {
    divergence: 12,
    reason:
      "cargo's regeneration of the two manifest edits above — resolved, not authored. It " +
      "is listed rather than excluded because a lockfile that moved without a manifest " +
      "moving is a real event, and the only way to notice one is to require a reason.",
  },
});

/**
 * How many `INCIDENTAL` entries are allowed to have no `UPSTREAM.md` number.
 *
 * Zero, as of Task 4 of `docs/plans/20260826-vendor-check-gap.md`. It was 6 while the
 * document was behind the table — pinned debt, so the gap could not grow while it
 * waited — and it is kept at 0 rather than deleted because the constant is what makes
 * the *next* undocumented divergence a failure instead of a habit. An incidental edit
 * with no number is a re-vendor instruction nobody wrote down.
 */
export const UNRECORDED_BUDGET = 0;

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
  // 7-12 were written up by Task 4 of the vendor-check-gap plan. They were incidental
  // divergences the whole time; what they lacked was a number, which is what a
  // re-vendorer works from.
  7: {
    path: "engine/crates/pixel-node/src/capture.rs",
    appliedIn: "port",
    what: "a `read_exact_at` shim over `seek_read`, replacing `std::os::unix::fs::FileExt`",
  },
  8: {
    path: "engine/crates/pixel-node/src/surface.rs",
    appliedIn: "port",
    what: "three `cfg_attr(windows, allow(irrefutable_let_patterns))`",
  },
  9: {
    path: "engine/packages/pixel-react/scripts/build-native.mjs",
    appliedIn: "port",
    what: "rewritten around `libraryName(platform)`, whose `win32` branch is `pixel_node.dll`",
  },
  10: {
    path: "engine/Cargo.toml",
    appliedIn: "port",
    what: "the `windows-sys` workspace dependency and its six features",
  },
  11: {
    path: "engine/crates/pixel-core/Cargo.toml",
    appliedIn: "port",
    what: "`windows-sys` as a `cfg(windows)` target dependency",
  },
  12: {
    path: "engine/Cargo.lock",
    appliedIn: "port",
    what: "cargo's regeneration of divergences 10 and 11",
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
 *
 * `count` is injectable for one reason: a test needs to ask "what would this guard
 * have said about `pixel-node/src/surface.rs` before anyone declared it?", and the
 * honest answer requires the table to be missing that row. Simulating the row's
 * absence beats editing the working tree out from under the rest of the run.
 */
export function auditDispositions(
  { changed, deleted = [], untracked = [] },
  count = dispositionCount,
) {
  const gone = new Set(deleted);
  const live = new Set(changed);
  return {
    unclassified: changed.filter((file) => count(file) === 0).sort(),
    // `> 1`, not `!== 1`: zero is the bucket above, and the two failures want
    // different sentences. A path claimed twice is the quieter of the two, because
    // nothing about it looks empty — which is why it needs its own bucket rather
    // than a filter that drops it from the roster and reports nothing.
    conflicted: changed.filter((file) => count(file) > 1).sort(),
    stale: dispositionedPaths().filter((file) => !live.has(file) && !gone.has(file)),
    deleted: [...deleted].sort(),
    untracked: [...untracked].sort(),
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
  // `hasOwn` rather than a bare read for the reason every other table lookup in this
  // module uses it: `DIVERGENCES.constructor` is truthy, so a bare read answers for a
  // key nobody declared and the caller gets the wrong error about a real-looking entry.
  if (!Object.hasOwn(DIVERGENCES, number)) {
    throw new Error(`there is no divergence ${number} in UPSTREAM.md`);
  }
  const entry = DIVERGENCES[number];
  if (entry.appliedIn !== "vendoring-commit") {
    throw new Error(
      `divergence ${number} (${entry.path}) is applied by the port, so it is checked by ` +
        `diffing against ${BASELINE}, not by matching content.`,
    );
  }
  return entry.evidence.test(read(entry.path));
}

/**
 * One line of "what this path is and why it was expected to differ", for a path the
 * table dispositions.
 *
 * This is the output the old `SRC`-scoped guard had and that the derived scope must
 * not lose. Its failure named the file and the recorded reason; a check over 235
 * paths that answered "something changed" would be a wider guard and a worse one, so
 * the reason travels with every path the guard reports.
 *
 * `verdict` is injectable for the same reason `dispositionCount` is elsewhere here:
 * one branch below describes an incidental edit with no `UPSTREAM.md` number, and
 * since Task 4 of the vendor-check-gap plan numbered the last six, no real path is in
 * that state. The branch has to keep working — the next undocumented divergence is
 * exactly when this line gets read — so it is exercised against a fabricated verdict
 * rather than by leaving a real one unnumbered to have something to test with.
 */
export function describeDisposition(file, verdict = dispositionOf(file)) {
  // Because the injectable second argument makes `.map(describeDisposition)` wrong:
  // `map` passes the index there, and an index is not `"subject"` or `"incidental"`,
  // so every roster line came out as "not vendored: undefined" — a plausible-looking
  // sentence, which is the worst kind of wrong for a guard whose whole product is its
  // message. Loud here rather than legible-but-false three frames later.
  if (typeof verdict !== "object" || verdict === null || !verdict.kind) {
    throw new TypeError(
      `describeDisposition(${file}) was given ${JSON.stringify(verdict)} as a verdict. ` +
        `Pass a dispositionOf()-shaped object or nothing at all — a bare ` +
        `\`.map(describeDisposition)\` hands it the array index.`,
    );
  }
  if (verdict.kind === "subject") {
    return `${file} — subject matter, owned by ${verdict.task}: ${verdict.reason}`;
  }
  if (verdict.kind === "incidental") {
    // `null` is the declaration that no `UPSTREAM.md` number exists yet; a missing
    // field is not. `dispositionOf` spreads the table entry, so an `INCIDENTAL` row
    // written without a `divergence` at all used to reach the numbered branch and
    // print "divergence undefined in UPSTREAM.md" — a line that reads like a
    // reference to something and points at nothing, which is what the `TypeError`
    // above exists to keep out of the guard's product.
    if (verdict.divergence !== null && !Number.isInteger(verdict.divergence)) {
      throw new TypeError(
        `${file} is INCIDENTAL with divergence ${JSON.stringify(verdict.divergence)}. It ` +
          `is either a number in docs/design/UPSTREAM.md or an explicit \`null\` saying ` +
          `nobody has written it up yet. Anything else describes a divergence a ` +
          `re-vendorer cannot look up.`,
      );
    }
    const where =
      verdict.divergence === null
        ? "not yet numbered in UPSTREAM.md"
        : `divergence ${verdict.divergence} in UPSTREAM.md`;
    return `${file} — incidental divergence, ${where}: ${verdict.reason}`;
  }
  if (verdict.kind === "excluded") {
    return `${file} — not vendored: ${verdict.reason}`;
  }
  // Explicit rather than a fall-through, for the reason the TypeError above exists:
  // "not vendored" is the most reassuring line this function can print, so anything
  // unrecognised landing there by default would be the one wrong answer that reads
  // as fine. A fourth kind is a change to this function, not to its default.
  throw new TypeError(
    `describeDisposition(${file}) got kind ${JSON.stringify(verdict.kind)}, which is ` +
      `none of subject, incidental or excluded. Give the new kind a line here rather ` +
      `than letting it describe itself as not vendored.`,
  );
}

/**
 * What to tell someone whose vendored file is gone.
 *
 * The failure this directory exists to catch and the one nothing detected until now:
 * a file that is missing has no diff to inspect, so every diff-based check stays
 * green while the tree is short a module.
 */
export function deletedMessage(file) {
  return (
    `${file} was vendored by ${BASELINE} and is not in the working tree. A re-vendor ` +
    `that drops a file entirely is the failure this guard exists to catch, and a ` +
    `missing file has no diff to inspect — so nothing else in the suite will say so. ` +
    `Restore it (\`git checkout ${BASELINE} -- ${file}\`), or, if removing it is the ` +
    `intent, make that a decision on the record rather than an absence.`
  );
}

/**
 * What to tell someone whose vendored tree has a file in it that git never heard of.
 *
 * The third failure, and the one the derived scope cannot reach on its own: every
 * other check here asks a question about a path `45b5e43` introduced, and an
 * untracked file is by definition not one of those. So a re-vendor that brings in a
 * new upstream module leaves it sitting in the tree, uncommitted, uncompiled by
 * anything that reads the manifest, and invisible to a guard whose scope is the
 * commit.
 *
 * Two answers, both of them a decision on the record — which is the whole ask.
 *
 * The wording of the first answer matters, and an earlier draft got it wrong by
 * saying "commit it — and it probably wants a disposition too". Committing a *new
 * upstream* file under `45b5e43` tracks it without putting it in the universe:
 * nothing diffs it ever again, and a disposition for it would then fail as stale.
 * So the two cases are named apart — this repo's own file, or a re-vendor.
 */
export function untrackedMessage(file) {
  return (
    `${file} is inside a vendored tree and git does not track it. Every other check ` +
    `here asks about a path ${BASELINE} introduced, so an untracked file is the one ` +
    `divergence the derived scope cannot see: nothing diffs it, nothing misses it, ` +
    `and a re-vendor that dropped in a new upstream module looks exactly like this. ` +
    `If it is this repo's own file, commit it. If it is upstream code, committing it ` +
    `here only hides it — the universe is one commit's contents, so it belongs to a ` +
    `re-vendor that moves BASELINE in tools/vendor-check/universe.mjs and rewrites ` +
    `the tables with it. Otherwise name it in .gitignore, which is where this repo's ` +
    `build output and scratch directories already go. What it may not do is sit ` +
    `there undecided.`
  );
}

/**
 * What to tell someone whose path is claimed by two of the three tables.
 *
 * The failure with no visible symptom. `dispositionOf` answers with whichever table
 * it checks first, so the path reads as classified everywhere; without this it passed
 * the guard *and* dropped out of the `expected` roster, so the guard's whole product
 * quietly lost a line. Two rows for one path are also a disagreement about substance
 * — one says a plan task owns the edit, the other says a re-vendorer must re-apply it
 * by hand — and only a person can say which.
 */
export function conflictedMessage(file) {
  return (
    `${file} is claimed by more than one disposition table in ` +
    `tools/vendor-check/dispositions.mjs. Exactly one is the only right answer: ` +
    `SUBJECT means the port rewrote it and a plan task owns it, INCIDENTAL means a ` +
    `re-vendorer re-applies it by hand from docs/design/UPSTREAM.md, and EXCLUSIONS ` +
    `in universe.mjs means it was never upstream source. Those are three different ` +
    `instructions to three different readers. Delete the rows that are wrong.`
  );
}

/**
 * What to tell someone holding a disposition whose subject reverted or moved.
 *
 * The quieter of the two failures: a row that describes nothing still reads as a
 * considered decision about a live edit, which is how the table starts lying.
 */
export function staleMessage(file) {
  return (
    `${file} has a disposition in tools/vendor-check/dispositions.mjs and no longer ` +
    `differs from ${BASELINE}. Either the edit was reverted — delete the entry — or ` +
    `the file moved, in which case re-key it at the new path. An entry whose subject ` +
    `is gone keeps its authority and covers nothing.`
  );
}

/**
 * The line the roster prints under.
 *
 * Exported because `UPSTREAM.md`'s checklist tells a re-vendorer that the roster is in
 * the same output as the failure, and `upstream-doc.test.mjs` holds the document to
 * this string rather than to a paraphrase of it.
 */
export const ROSTER_HEADING = `Every path that is supposed to differ from ${BASELINE}, and why:`;

/**
 * The guard's whole verdict on a survey: `{ ok, message, expected }`.
 *
 * Pure, and the reason it is pure is that the interesting cases are all things a test
 * must not do to the working tree — edit a vendored file, delete one, or un-declare
 * one — while the rest of the run is reading it.
 *
 * `count` is passed to `auditDispositions` so a caller can ask what the guard would
 * have said before a given row existed. `expected` is the named-reason roster: one
 * line per diverged path, in the same shape the old check's `EXPECTED_DIFFS` gave for
 * `pixel-core` alone.
 *
 * A failing `message` ends with that roster, because the roster is the guard's product
 * and it was reaching nobody. `unchanged.test.mjs` asserts with `message`, so a stale
 * entry printed one line about the path that stopped differing and not a word about the
 * forty-three a re-vendorer still has to re-apply — while the `UPSTREAM.md` checklist
 * sent them to exactly that list, "in the same output". A field only the tests
 * destructure is not output.
 */
export function guardVerdict(
  { changed, deleted = [], untracked = [] },
  count = dispositionCount,
) {
  const audit = auditDispositions({ changed, deleted, untracked }, count);
  const problems = [
    ...audit.deleted.map(deletedMessage),
    ...audit.unclassified.map(unclassifiedMessage),
    ...audit.conflicted.map(conflictedMessage),
    ...audit.untracked.map(untrackedMessage),
    ...audit.stale.map(staleMessage),
  ];
  const gone = new Set(audit.deleted);
  const expected = changed
    .filter((file) => !gone.has(file) && count(file) === 1)
    .sort()
    // Not point-free: `describeDisposition` takes an optional verdict as its second
    // argument, and `map` hands every callback the index there.
    .map((file) => describeDisposition(file));
  // Indented, so the roster reads as one block under its heading rather than as more
  // findings. Empty only when every diverged path was itself a finding, in which case
  // a heading over nothing is the misleading half.
  const roster =
    expected.length === 0 ? [] : [`${ROSTER_HEADING}\n  ${expected.join("\n  ")}`];
  return {
    ok: problems.length === 0,
    message: problems.length === 0 ? "" : [...problems, ...roster].join("\n\n"),
    expected,
  };
}
