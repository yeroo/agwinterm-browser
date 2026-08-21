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

const ROOT = path.resolve(import.meta.dirname, "..", "..");

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

/** Every markdown file this project maintains. Not `.reference/`, not `node_modules/`. */
function docFiles() {
  const docs = ["README.md"];
  for (const dir of ["docs/design", "docs/plans"]) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith(".md")) docs.push(`${dir}/${name}`);
    }
  }
  return docs;
}

/**
 * GitHub's heading slug, for the subset of punctuation these docs use: lower-case,
 * drop everything that is not a letter, digit, space or hyphen (so backticks, dots,
 * em dashes and `⚠️` all go), then spaces become hyphens.
 *
 * The doubled hyphens that leaves are not a bug — `## 1. Rust — \`cargo check\`` really
 * does anchor at `1-rust--cargo-check`, because the dropped em dash leaves its two
 * spaces behind.
 */
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
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
