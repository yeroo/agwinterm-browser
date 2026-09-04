// The documentation, checked against the tree it describes.
//
// Task 15 wrote four things down — install and usage, the two frame transports, what
// was dropped, and the accepted ceilings — and every one of them is a claim about code
// that will move. Prose does not fail when the code moves; it just stops being true,
// silently, which is the same failure mode this project spent Task 14 designing out of
// its lint scoping and its unchanged-file check.
//
// So the checks here are deliberately narrow. They do not read for sense: they assert
// that the *names* the docs promise a reader still exist — a link that resolves, an
// environment variable something reads, a transport value the parser accepts, a refusal
// the CLI can produce. A rename that silently invalidates a paragraph fails here.
//
// Import-free of the project's own source on purpose: this reads files as text, so it
// runs without a build, a database or a terminal.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

/**
 * Every markdown file this project maintains. Not `.reference/`, not `node_modules/`.
 *
 * Recursive, and that is the whole point: `docs/plans/completed/` is where a finished
 * plan is filed, and being filed is exactly when a plan's relative links break, because
 * they were written one directory further up. A flat `readdirSync` skipped that
 * directory entirely — so the guard got quietly narrower each time a plan was completed,
 * and on 2026-09-01, when the last three were moved, `docs/plans` began contributing
 * nothing at all while the suite stayed green.
 */
function docFiles() {
  const docs = ["README.md"];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
      else if (entry.name.endsWith(".md")) docs.push(`${dir}/${entry.name}`);
    }
  };
  for (const dir of ["docs/design", "docs/plans"]) walk(dir);
  return docs;
}

/**
 * GitHub's heading slug, for the subset of punctuation these docs use: lower-case,
 * drop everything that is not a letter, digit, underscore, space or hyphen (so
 * backticks, dots, em dashes and `⚠️` all go), then spaces become hyphens.
 *
 * The doubled hyphens that leaves are not a bug — `## 1. Rust — \`cargo check\`` really
 * does anchor at `1-rust--cargo-check`, because the dropped em dash leaves its two
 * spaces behind.
 *
 * The underscore is kept because github-slugger keeps it: `_` sits between the `[-^`
 * and `` ` `` ranges of the class it strips, so it is matched by neither.
 * `### \`TERMINAL_BROWSER_ALLOW_PIPE\` — …` really does anchor at
 * `terminal_browser_allow_pipe--…`. Stripping it here was stricter than GitHub in
 * the one direction that matters: this test computed the same slug for the heading
 * and for a link that spelled the anchor without the underscores, and certified a
 * link that lands at the top of the file.
 */
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_ -]/gu, "")
    .replace(/ /g, "-");
}

function headingsOf(relative) {
  return read(relative)
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => slug(line.replace(/^#{1,6} /, "")));
}

/** `[text](target)`, skipping the ones that leave this repository. */
function linksOf(relative) {
  const links = [];
  for (const match of read(relative).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?|file|mailto):/.test(target)) continue;
    links.push(target);
  }
  return links;
}

test("the completed plans are inside the set the link tests walk", () => {
  // The two tests below are only worth what `docFiles()` reaches, and it reached one
  // directory less than it looked like it did. Pin the subdirectory rather than the
  // count: a plan gets filed here whenever one finishes.
  const covered = docFiles();
  const completed = fs
    .readdirSync(path.join(ROOT, "docs/plans/completed"))
    .filter((n) => n.endsWith(".md"))
    .map((n) => `docs/plans/completed/${n}`);

  assert.ok(completed.length > 0, "no completed plans found — is the directory still there?");
  assert.deepEqual(
    completed.filter((p) => !covered.includes(p)),
    [],
    "a completed plan is not being link-checked",
  );
});

test("every relative link in the documentation resolves to a file that exists", () => {
  const broken = [];
  for (const doc of docFiles()) {
    for (const link of linksOf(doc)) {
      const [target] = link.split("#");
      if (!target) continue; // a bare anchor, checked below
      const resolved = path.resolve(path.dirname(path.join(ROOT, doc)), target);
      if (!fs.existsSync(resolved)) broken.push(`${doc} -> ${link}`);
    }
  }
  assert.deepEqual(broken, [], "documentation links to files that are not there");
});

test("the slug this file computes is the one GitHub computes", () => {
  // The anchor test below is only as good as this function, and a slugger *stricter*
  // than GitHub's does not fail loudly — it agrees with a broken link, because it
  // strips the same character out of the heading and out of the anchor. That is how
  // `05-cli-and-endpoints.md`'s link to the `TERMINAL_BROWSER_ALLOW_PIPE` section
  // passed while landing at the top of the file.
  assert.equal(
    slug("`TERMINAL_BROWSER_ALLOW_PIPE` — a dev build refuses an instance"),
    "terminal_browser_allow_pipe--a-dev-build-refuses-an-instance",
    "github-slugger keeps underscores; this must too",
  );
  assert.equal(slug("1. Rust — `cargo check`"), "1-rust--cargo-check");
});

test("every anchor in the documentation names a heading that exists", () => {
  const broken = [];
  for (const doc of docFiles()) {
    for (const link of linksOf(doc)) {
      const [target, anchor] = link.split("#");
      if (!anchor) continue;
      const inFile = target
        ? path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, doc)), target))
        : doc;
      if (!inFile.endsWith(".md")) continue; // an image with a fragment: not our business
      if (!headingsOf(inFile.split(path.sep).join("/")).includes(anchor)) {
        broken.push(`${doc} -> ${link}`);
      }
    }
  }
  assert.deepEqual(broken, [], "documentation links to headings that are not there");
});

// ---------------------------------------------------------------------------
// The knobs the README and the as-built doc tell a user to set
// ---------------------------------------------------------------------------

/**
 * A documented environment variable that nothing reads is worse than an undocumented
 * one: the user sets it, sees no effect, and has no way to tell a typo from a lie.
 */
test("every TERMINAL_BROWSER_* variable the docs name is read somewhere in the source", () => {
  const documented = new Set();
  for (const doc of ["README.md", "docs/design/07-as-built.md"]) {
    for (const match of read(doc).matchAll(/TERMINAL_BROWSER_[A-Z_]+/g)) documented.add(match[0]);
  }
  assert.ok(documented.size >= 3, "the docs should still be naming the knobs");

  const source = [
    "engine/crates/pixel-core/src/frame_file.rs",
    "engine/crates/pixel-core/src/frame_shm.rs",
    "engine/crates/pixel-core/src/agwinterm.rs",
    "engine/crates/pixel-core/src/terminal_windows.rs",
    "cli/src/main.ts",
  ]
    .map(read)
    .join("\n");

  for (const name of documented) {
    assert.ok(source.includes(name), `${name} is documented and nothing reads it`);
  }
});

/**
 * `TERMINAL_BROWSER_FRAME_TRANSPORT`'s documented values, against the parser. Both
 * directions matter: a value the docs promise must be accepted, and a value the parser
 * accepts must be documented, or the doc's table quietly becomes a subset.
 */
test("the documented frame transports are exactly the ones the parser accepts", () => {
  const parse = read("engine/crates/pixel-core/src/frame_shm.rs")
    .split("fn parse(raw: &str)")[1]
    .split("\n    }")[0];
  const accepted = new Set([...parse.matchAll(/"([a-z.]+)"/g)].map((match) => match[1]));
  assert.ok(accepted.has("auto") && accepted.has("file") && accepted.has("shm"));

  const table = read("docs/design/07-as-built.md")
    .split("### How to force either")[1]
    .split("###")[0];
  for (const value of accepted) {
    assert.ok(
      table.includes(`\`${value}\``),
      `frame_shm.rs accepts ${value} and the transports table does not mention it`,
    );
  }
});

/**
 * The frame budget's comparison table names both transports, and the agwinterm
 * build its `shm` rows were taken on is a commit rather than a description.
 *
 * The table is the one place the fast path's number lives beside the baseline's,
 * and it is read by people deciding whether the verb is worth a host upgrade. A
 * table with one transport in it has quietly become the baseline again; a build
 * cited as "main" or "a dev build" cannot be checked out and re-run. `git ls-remote`
 * is not available here, so the check is the shape of a short hash, not its
 * existence — enough to catch the citation going missing or going vague.
 */
test("the frame budget's comparison names both transports and a real agwinterm commit", () => {
  const doc = read("docs/design/02-frame-budget.md");
  const comparison = doc.split("### The comparison")[1]?.split("\n## ")[0];
  assert.ok(comparison, "02-frame-budget.md no longer has a '### The comparison' section");

  const rows = comparison.split("\n").filter((line) => line.startsWith("|"));
  for (const transport of ["file", "shm"]) {
    assert.ok(
      rows.some((row) => row.includes(`\`${transport}\``)),
      `the comparison table has no ${transport} row`,
    );
  }

  // The heading cites the build; the raw rows cite it too, so the same regex on
  // the section as a whole finds it wherever it moved to.
  assert.match(
    comparison,
    /Release host at `[0-9a-f]{7,40}`/,
    "the comparison does not say which agwinterm commit the shm rows were taken on",
  );
  // And the doc still names the commit the verb landed in, so a reader can place
  // the cited build against it. Only that: whether the build is a descendant of
  // that commit would take the agwinterm repository, which this test does not have.
  assert.ok(doc.includes("`8230d0e`"), "the doc no longer names the commit the verb landed in");
});

// ---------------------------------------------------------------------------
// The absences
// ---------------------------------------------------------------------------

/**
 * Every command the as-built doc says is refused has a refusal in the CLI, and every
 * refusal the CLI can produce is written down. The second half is the one that rots:
 * a new refusal is easy to add and easy not to document, and an undocumented refusal
 * is exactly the "absence that reads as an oversight" this doc exists to prevent.
 */
test("what the docs say is refused is what the CLI refuses", () => {
  const doc = read("docs/design/07-as-built.md");
  const source = read("cli/src/unsupported.ts");

  const exported = [...source.matchAll(/export function (\w+)\(/g)].map((match) => match[1]);
  assert.deepEqual(
    exported.sort(),
    [
      // Not a refusal: the shared "am I in an agwinterm pane" predicate that
      // `windowsHostRefusal` decides on, kept here because `cli/src/pane.ts` and
      // `agwinterm.rs` have to agree with it. Listed so the count below still
      // means "one entry per row of the as-built table".
      "inAgwintermPane",
      "sandboxSetupNote",
      "splitUnsupported",
      "sshUnsupported",
      "upgradeUnsupported",
      "windowsHostRefusal",
    ],
    "unsupported.ts gained or lost a refusal — docs/design/07-as-built.md has a table of them",
  );

  for (const named of ["`--ssh`", "`upgrade`", "`--split`", "`shutdown`", "AppArmor"]) {
    assert.ok(doc.includes(named), `${named} is refused and the as-built doc does not say so`);
  }
});

/**
 * The three modules the port drops. `ghostty.rs` and `herdr.rs` are dropped by a
 * `#[cfg(unix)]` rather than by deletion — which is what keeps them byte-identical to
 * upstream — so the check is on the gate, not on the file's absence.
 */
test("the modules the docs say are dropped are gated off rather than deleted", () => {
  const lib = read("engine/crates/pixel-core/src/lib.rs");
  for (const module of ["ghostty", "herdr"]) {
    assert.match(
      lib,
      new RegExp(`#\\[cfg\\(unix\\)\\]\\s*\\n(pub )?mod ${module};`),
      `${module} should still be present and #[cfg(unix)]-gated`,
    );
    assert.ok(
      fs.existsSync(path.join(ROOT, `engine/crates/pixel-core/src/${module}.rs`)),
      `${module}.rs is meant to stay byte-identical to upstream, not be deleted`,
    );
  }

  // The Swift helper: dropped by a gate upstream already had, not by this port.
  assert.ok(fs.existsSync(path.join(ROOT, "engine/crates/pixel-core/native-scroll-helper.swift")));
  assert.match(read("engine/crates/pixel-core/build.rs"), /CARGO_CFG_TARGET_OS.*!=.*"macos"/s);
});

/**
 * The two accepted ceilings, at the line that makes each one a ceiling. If either of
 * these constants or gates changes, the ceiling has moved and §3 needs rewriting —
 * which is a good thing to be told by a failing test rather than by a user.
 */
test("the accepted ceilings are still where the docs say they are", () => {
  const ceilings = read("docs/design/07-as-built.md").split("## 3. The accepted ceilings")[1];
  assert.ok(ceilings, "the as-built doc should still have its ceilings section");

  // Ceiling 2: the fallback cell, and the fact that cell_size never answers None.
  assert.ok(ceilings.includes("16×32"), "the fallback cell size should be stated");
  const agwinterm = read("engine/crates/pixel-core/src/agwinterm.rs");
  assert.match(agwinterm, /FALLBACK_CELL[^=]*=\s*\(16,\s*32\)/, "FALLBACK_CELL moved");
  assert.match(agwinterm, /TERMINAL_BROWSER_CELL_PX/, "the documented override moved");

  // Ceiling 1: the flag is false, and it is false in the backend rather than by accident.
  assert.ok(ceilings.includes("reports_pixel_mouse"));
  const windows = read("engine/crates/pixel-core/src/terminal_windows.rs");
  assert.match(
    windows,
    /fn reports_pixel_mouse\(&self\) -> bool \{\s*false/,
    "reports_pixel_mouse is no longer unconditionally false — ceiling 1 has moved",
  );
});

/**
 * The dropped-fast-paths row, against the branch the controller actually takes.
 *
 * `tools/offscreen/present.test.mjs` already pins the code: the controller reaches
 * `presentPaint` only when `event.texture || shmFrame`, and on stock Electron here
 * neither is ever set, so every Windows frame goes to the throttled `BitmapPresenter`.
 * That test passed for the whole port while this doc said the opposite — "`presentPaint`
 * already falls through to `presentBitmap` ... and that is the path this port runs" —
 * because nothing ever compared the two. A reader chasing frame pacing opened
 * `paint.ts:104`, found no throttling in it, and would have concluded the port has no
 * coalescing at all: the exact opposite of the truth.
 *
 * So this asserts the doc names the class that runs, and does not promise the reader a
 * function this platform never reaches.
 */
test("the dropped fast paths name the presenter Windows actually runs", () => {
  const dropped = read("docs/design/07-as-built.md").split("### Dropped or refused in the CLI")[0];
  const row = dropped
    .split("\n")
    .find((line) => line.includes("the patched-Electron fast paths"));
  assert.ok(row, "the as-built doc should still have its patched-Electron row");

  assert.ok(
    row.includes("BitmapPresenter"),
    "the row should name BitmapPresenter, which is what every Windows frame goes through",
  );
  assert.doesNotMatch(
    row,
    /`presentBitmap`[^|]*is the path this port runs/,
    "the row claims presentBitmap is the Windows path; the controller never reaches it",
  );

  // The gate the row's correction rests on. If this moves, the row needs rewriting.
  const controller = read("browser/src/page/controller.ts");
  assert.match(
    controller,
    /event\.texture \|\| shmFrame\s*\?\s*presentPaint\(/,
    "the controller's presentPaint gate moved — re-check the as-built row against it",
  );
});

// ---------------------------------------------------------------------------
// The recovery verb, and the three paths that take a picture back
// ---------------------------------------------------------------------------

/**
 * `pane-clear` is the one verb a user reaches for when everything else has already
 * failed, so a README that describes it and a CLI that does not have it is worse than
 * no documentation at all: the reader is in a broken pane, typing a command that
 * errors. Both directions, because both rot — a rename in `main.ts` and a section
 * quietly dropped from the README fail differently and neither would be noticed.
 */
test("the recovery verb the README documents is one the CLI actually dispatches", () => {
  const readme = read("README.md");
  const section = readme.split("### Recovering a pane")[1]?.split("\n### ")[0];
  assert.ok(section, "the README should still have its recovery section");

  assert.ok(
    section.includes("main.js pane-clear"),
    "the recovery section should show the command a reader is meant to type",
  );

  // The verb, at the two places that have to agree about its name.
  assert.match(
    read("cli/src/main.ts"),
    /command === "pane-clear"/,
    "main.ts no longer dispatches pane-clear — the README tells users to run it",
  );
  assert.match(
    read("cli/src/help.ts"),
    /"pane-clear": \{/,
    "help.ts no longer carries pane-clear — `--help` and the README disagree",
  );

  // Both halves. A recovery that only sends the escape sequences fixes the frame and
  // leaves the console cursorless and echoless, which is the failure the README's
  // second bullet is about; the section promises both, so both must still be called.
  const pane = read("cli/src/pane.ts");
  for (const half of ["clearOwnedPaneFrame", "restorePaneConsole"]) {
    assert.match(
      pane,
      new RegExp(`export (async )?function ${half}[(]`),
      `pane.ts no longer exports ${half}, which the recovery section rests on`,
    );
  }
  assert.match(
    pane,
    /paneClearCommand[\s\S]{0,600}restorePaneConsole\(/,
    "paneClearCommand no longer restores the console — half the documented repair",
  );
});

/**
 * The as-built doc's clear paths, against the functions it names. This is the section
 * that went stale first: it said "two paths" for as long as there were two, and the
 * third — the verb — exists precisely because killing the CLI runs neither of them.
 */
test("the three documented paths that send image.clear all still exist", () => {
  const section = read("docs/design/07-as-built.md")
    .split("### Taking the picture back")[1]
    .split("\n---")[0];

  assert.match(section, /\*\*Three\*\*\s*\n?\s*paths send `image\.clear`/);

  assert.match(
    read("engine/crates/pixel-core/src/frame_file.rs"),
    /fn clear\(&mut self, client: &mut ControlClient\)/,
    "FramePublisher::clear moved — the as-built doc names it as the first path",
  );
  assert.match(
    read("cli/src/pane.ts"),
    /export async function clearOwnedPaneFrame/,
    "clearOwnedPaneFrame moved — the as-built doc names it as the second path",
  );
  assert.match(
    read("cli/src/main.ts"),
    /command === "pane-clear"/,
    "the pane-clear verb moved — the as-built doc names it as the third path",
  );

  // The ownership rule the section says all three share. The engine's early return is
  // the original; the CLI's is the copy Task 1 of the corrections plan added, and a
  // CLI that clears unconditionally again is the exact regression that paragraph warns
  // about — it would take down a placement another process owns.
  assert.match(
    read("cli/src/main.ts"),
    /clearOwnedPaneFrame\(process\.env, \{ pid: child\.pid \}\)/,
    "the exit path no longer asks whether the placement is ours before clearing it",
  );
});

/**
 * The mechanism the console half actually uses, against the one the as-built doc
 * narrates. This paragraph went stale silently: it explained the restore as
 * `setRawMode` on stdin for a whole round after that call was measured to reach no
 * syscall and replaced by a child process, and nothing here noticed — the checks above
 * pin function *names*, and `restorePaneConsole` kept its name through the rewrite.
 */
test("the console restore the as-built doc explains is the one the CLI performs", () => {
  const doc = read("docs/design/07-as-built.md");
  const at = doc.indexOf("The console is the half that is easy to forget");
  assert.ok(at > 0, "the as-built doc lost the paragraph that explains the console half");
  const section = doc.slice(at).split(/^### /m)[0];
  const pane = read("cli/src/pane.ts");

  // The claim that has to move with the code: a *child process* is what restores the
  // input modes, because nothing this process can call survives its own stdio teardown.
  assert.match(
    pane,
    /function cookConsoleModes\(\)/,
    "cookConsoleModes moved — the as-built doc names it as the modes half",
  );
  assert.match(section, /cookConsoleModes/, "the doc no longer names the mechanism");
  assert.match(section, /cmd\.exe/, "the doc no longer says what the child is");
  assert.ok(
    !/raw mode, taken back off stdin/.test(section),
    "the doc still explains the restore as a call that reaches no syscall",
  );
  // And the gate, which is the reason the two halves are reported apart.
  assert.match(pane, /if \(input\.isTTY\)/, "the modes half is no longer gated on a tty");
  assert.match(section, /isTTY/, "the doc no longer explains why a redirect skips the half");
});

/**
 * The deadline, as a number, in both places. `07-as-built.md` §4 explains why 1040 ms
 * and not a rounder number — the derivation is the documentation — so a constant that
 * moves without the prose moving turns a reasoned figure back into a guess.
 */
test("the control-pipe deadline the docs derive is the one the engine uses", () => {
  const doc = read("docs/design/07-as-built.md");
  // Scoped to the section that derives it, not to the first bold duration in the
  // file: a bolded number added anywhere above would silently retarget this check at
  // something that has nothing to do with the deadline, and it would still pass.
  const at = doc.indexOf("### A control-pipe exchange has a deadline");
  assert.ok(at > 0, "the as-built doc lost the section that derives the deadline");
  const section = doc.slice(at).split(/^### /m)[1] ?? "";
  const stated = section.match(/\*\*(\d+) ms\*\*/);
  assert.ok(stated, "the as-built doc should still state the exchange deadline");

  const engine = read("engine/crates/pixel-core/src/agwinterm.rs");
  const constant = engine.match(
    /const EXCHANGE_DEADLINE: Duration = Duration::from_millis\((\d+)\)/,
  );
  assert.ok(constant, "EXCHANGE_DEADLINE moved or was renamed");
  assert.equal(
    constant[1],
    stated[1],
    "the documented deadline and EXCHANGE_DEADLINE disagree",
  );
});

/**
 * The dev guard, in **all three** readers.
 *
 * `cli/src/pane.ts` and `cli/src/unsupported.ts` import nothing from the workspace on
 * purpose, so each carries its own copy of the fallback pipe name — which is why a
 * guard on the engine alone left the CLI publishing into production, the case that
 * actually wrecked a pane. The as-built doc tabulates three readers and what each one
 * withholds; this is that claim, checked. It said "twice" while a third had already
 * been added, which is the drift a list of two sources could not catch.
 */
test("the dev-build pipe guard is enforced in all three readers, not just the engine", () => {
  const doc = read("docs/design/07-as-built.md");
  assert.ok(
    doc.includes("TERMINAL_BROWSER_ALLOW_PIPE"),
    "the as-built doc should still name the guard variable",
  );

  for (const source of [
    "engine/crates/pixel-core/src/agwinterm.rs",
    "cli/src/pane.ts",
    "cli/src/unsupported.ts",
  ]) {
    assert.ok(
      read(source).includes("TERMINAL_BROWSER_ALLOW_PIPE"),
      `${source} no longer consults the guard — the docs say all three halves do`,
    );
    assert.ok(
      doc.includes(source.split("/").pop()),
      `${source} reads the guard and the as-built table does not name it`,
    );
  }

  // Only the engine can gate on a build kind, and the docs must not claim otherwise:
  // `tsc` emits the same JavaScript for every build, so the CLI's two copies honour
  // the variable whenever it is set. A README that says a release build ignores it
  // outright sends a user with a stale shell profile looking in the wrong place.
  assert.ok(
    read("engine/crates/pixel-core/src/agwinterm.rs").includes("cfg!(debug_assertions)"),
    "the engine's copy is the build-gated one",
  );
  // The positive claim, so a rewording that reintroduces the same error under
  // different words is caught rather than only the one sentence that was wrong.
  const readme = read("README.md");
  assert.match(
    readme,
    /the CLI's cannot be[^.]*`tsc` emits the same JavaScript either way/,
    "the README should still say the CLI's copy honours the variable in every build",
  );
  assert.doesNotMatch(
    readme,
    /a release\s+build ignores it entirely/,
    "the README still claims the whole guard is release-inert; the CLI's copy is not",
  );
});

/**
 * The standing note about the `pane-clear` hang, against the suite it cites.
 *
 * This one is a documentation claim of an unusual kind: it says a defect is **not**
 * fixed, and names the coverage that failed to reproduce it as the reason for leaving
 * the code alone. That makes the citation load-bearing in the direction prose normally
 * is not — a reader who wants to know whether the hang is explained has nothing but the
 * named suite to check, and a note that cites a suite which no longer exists, or no
 * longer contains the case it quotes, reads exactly like a live one.
 *
 * So the name and the quoted `describe` title are held to the file, and nothing else
 * is: the measured timings are a record of one run and are not re-derived here.
 */
test("the as-built note on the pane-clear hang cites a case that is really in the suite", () => {
  const doc = read("docs/design/07-as-built.md");
  const at = doc.indexOf("### The `pane-clear` hang");
  assert.ok(at > 0, "the as-built doc lost its note on the pane-clear hang");
  const section = doc.slice(at);

  const suite = "tools/acceptance/pane-clear.test.mjs";
  assert.ok(section.includes(suite), "the note no longer names the suite that covers it");

  const quoted = section.match(/grew "([^"]+)"/);
  assert.ok(quoted, "the note no longer quotes the case it says was added");
  // Wrapped prose, so the quote arrives with the paragraph's line break inside it. A
  // comparison that kept it would fail on a re-wrap and on nothing else.
  const title = quoted[1].replace(/\s+/g, " ").trim();
  assert.ok(
    read(suite).includes(`describe("${title}"`),
    `the note sends a reader to "${title}" and ${suite} has no such describe. The ` +
      `note's whole argument is that this case passes; a case nobody can find cannot ` +
      `carry it.`,
  );

  // The handoff the note says is still uncovered on a real console. If this spawn
  // stops inheriting stdin, the open question the note leaves has changed shape and
  // the note is describing a program that no longer exists.
  assert.match(
    read("cli/src/pane.ts"),
    /stdio: "inherit"/,
    "cookConsoleModes no longer inherits stdin — the note's open question has moved",
  );
});

/**
 * The divergence counts the as-built doc states, against the table that decides them.
 *
 * `07-as-built.md` is the one place a reader is given the *size* of the divergence set
 * rather than the set itself, and the sentence carrying it already went stale once —
 * it says so itself two lines later ("that sentence used to say six"). A count that
 * reads authoritative and is not is the exact failure this file exists for, and the
 * numbers are derivable, so they are derived rather than trusted.
 */
test("the as-built divergence counts match tools/vendor-check/dispositions.mjs", async () => {
  const { DIVERGENCES } = await import(
    pathToFileURL(path.join(ROOT, "tools/vendor-check/dispositions.mjs")).href
  );
  const entries = Object.values(DIVERGENCES);
  const port = entries.filter((one) => one.appliedIn === "port").length;
  const vendoring = entries.filter((one) => one.appliedIn === "vendoring-commit").length;
  assert.equal(port + vendoring, entries.length, "a divergence has an appliedIn nobody counts");

  const doc = read("docs/design/07-as-built.md");
  const words = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
    "eighteen", "nineteen", "twenty",
  ];
  const spell = (n) => words[n] ?? String(n);
  assert.ok(
    doc.includes(`numbers the ${spell(entries.length)} deliberate`),
    `the doc does not say there are ${spell(entries.length)} deliberate edits, and there are`,
  );
  assert.ok(
    doc.includes(`for the ${spell(port)} the port applied`),
    `the doc does not say the port applied ${spell(port)} of them, and it did`,
  );
  assert.ok(
    doc.includes(`for the ${spell(vendoring)} the vendoring commit applied`),
    `the doc does not say the vendoring commit applied ${spell(vendoring)} of them, and it did`,
  );
});

/**
 * The README's test counts against the acceptance table it links to.
 *
 * The README is where a reader meets these numbers first, and it links straight to
 * `06-acceptance.md` for the run they came from — so the two are one claim made twice,
 * and the copy nothing checks is the one that goes stale. It did: the node row was
 * re-derived to 546 in the acceptance table while the README kept saying 544, in the
 * same branch, because the table has a suite that counts it and the README had nothing.
 *
 * This holds the two to each other rather than to a run of the suite. Re-running the
 * tests here to compare would be circular — the count would be of a process that is
 * this file's own caller — and the acceptance table is already the place where a
 * measured number is recorded against a date. The check a reader needs is only that
 * the front page repeats it correctly.
 */
test("the README's test counts match the acceptance table it cites", () => {
  const readme = read("README.md");
  const table = read("docs/design/06-acceptance.md");

  const claimed = readme.match(/(\d+) Rust tests and (\d+) node tests/);
  assert.ok(claimed, "the README no longer states its Rust and node test counts");

  const rust = table.match(/`cargo nextest run --workspace` \| \*\*(\d+) passed\*\*/);
  assert.ok(rust, "the acceptance table no longer records a nextest count for the README to match");
  assert.equal(
    claimed[1],
    rust[1],
    `the README says ${claimed[1]} Rust tests and the acceptance table says ${rust[1]}`,
  );

  const node = table.match(/`node --test "tools\/\*\/\*\.test\.mjs"` \| \*\*(\d+) passed\*\*/);
  assert.ok(node, "the acceptance table no longer records a node count for the README to match");
  assert.equal(
    claimed[2],
    node[1],
    `the README says ${claimed[2]} node tests and the acceptance table says ${node[1]}`,
  );
});
