// Pins the shape of the vendored upstream tree.
//
// The port's plan rests on a measurement: of `pixel-core`'s 46 source files, only
// three touch unix APIs, and the 659-line VT decoder inside `terminal.rs` touches
// none. Tasks 3, 4 and 5 all spend that measurement. Re-vendoring upstream is
// expected to happen more than once, and a new unix-bound module arriving with it
// would invalidate the plan silently — the Rust build would simply fail later, in
// a task that has nothing to do with the cause.
//
// So these are assertions about the vendored tree, not about our own code — which
// is why files the port adds are listed in PORT_ADDED_FILES and excluded from the
// inventory comparison rather than folded into it. A re-vendor must still be
// measurable against upstream's 46.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PIXEL_CORE_SRC = path.join(REPO, "engine", "crates", "pixel-core", "src");

const EXPECTED_FILES = JSON.parse(
  fs.readFileSync(path.join(HERE, "pixel-core-files.json"), "utf8"),
);

/** The three modules the port is allowed to touch. Everything else stays as vendored. */
const UNIX_BOUND_MODULES = ["ghostty.rs", "herdr.rs", "terminal.rs"];

/**
 * Files this port adds to `pixel-core/src`. They are not upstream's and must not
 * count towards — or hide drift in — the vendored inventory.
 *
 * `terminal_types.rs` is Task 3: the type vocabulary `terminal.rs` used to define,
 * lifted out so the tty code below it can be platform-gated without taking the
 * vocabulary (and the crate root's `pub use`) with it. `terminal.rs` re-exports
 * every name, so no importer changed.
 */
const PORT_ADDED_FILES = ["terminal_types.rs"];

/**
 * Direct use of a unix-only API. Deliberately narrower than "mentions a platform":
 * `throttle.rs` carries macOS-only code behind `#[cfg(target_os = "macos")]` and
 * compiles on Windows untouched, so a cfg attribute alone is not a blocker.
 */
const UNIX_API = /std::os::unix|rustix::|libc::/;

/**
 * The decoder Task 5 reuses rather than rewriting. It was measured at `terminal.rs`
 * lines 1251-1909 (659 lines) on the vendored tree; Task 3's extraction shifted it
 * up by 178 lines and Task 4's gating will move it again. So it is located by its
 * own anchors — it opens on `enum RawEvent` and closes where `mod tests` begins —
 * and pinned by size and unix-freedom, which are the properties the plan spends.
 */
const DECODER_MIN_LINES = 650;

function rustFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.name.endsWith(".rs")) out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

const actualFiles = rustFiles(PIXEL_CORE_SRC);
const vendoredFiles = actualFiles.filter((f) => !PORT_ADDED_FILES.includes(f));

const read = (rel) => fs.readFileSync(path.join(PIXEL_CORE_SRC, rel), "utf8");

describe("vendored pixel-core inventory", () => {
  it("has exactly the 46 source files the plan was measured against", () => {
    assert.equal(
      vendoredFiles.length,
      46,
      `pixel-core has ${vendoredFiles.length} vendored .rs files, not 46`,
    );
  });

  it("adds only the files the port declares it adds", () => {
    const unexpected = actualFiles.filter(
      (f) => !EXPECTED_FILES.includes(f) && !PORT_ADDED_FILES.includes(f),
    );
    assert.deepEqual(
      unexpected,
      [],
      "a file appeared in pixel-core/src that is neither upstream's nor declared " +
        "in PORT_ADDED_FILES",
    );
    for (const rel of PORT_ADDED_FILES) {
      assert.ok(actualFiles.includes(rel), `${rel} is declared but missing`);
    }
  });

  it("matches the recorded inventory file for file", () => {
    const added = vendoredFiles.filter((f) => !EXPECTED_FILES.includes(f));
    const removed = EXPECTED_FILES.filter((f) => !vendoredFiles.includes(f));
    assert.deepEqual(
      { added, removed },
      { added: [], removed: [] },
      "the vendored file set drifted; re-run the unix-API disposition pass before " +
        "updating pixel-core-files.json",
    );
  });

  it("confines unix APIs to the three modules the port replaces", () => {
    const offenders = vendoredFiles.filter(
      (rel) => UNIX_API.test(read(rel)) && !UNIX_BOUND_MODULES.includes(rel),
    );
    assert.deepEqual(
      offenders,
      [],
      `new unix-bound module(s) in the vendored tree: ${offenders.join(", ")}`,
    );
  });

  it("still finds unix APIs in each module the port expects to replace", () => {
    // The mirror of the check above: if upstream ported one of these itself, the
    // plan's task list shrinks and we want to notice that too.
    for (const rel of UNIX_BOUND_MODULES) {
      assert.ok(
        vendoredFiles.includes(rel),
        `${rel} is missing from the vendored tree`,
      );
      assert.ok(
        UNIX_API.test(read(rel)),
        `${rel} no longer uses unix APIs; the port plan may be out of date`,
      );
    }
  });

  it("leaves 43 files with no unix API use at all", () => {
    const clean = vendoredFiles.filter((rel) => !UNIX_API.test(read(rel)));
    assert.equal(
      clean.length,
      43,
      `${clean.length} files are unix-free, not the 43 the plan counts on`,
    );
  });
});

describe("the VT decoder inside terminal.rs", () => {
  const lines = read("terminal.rs").split(/\r?\n/);
  // The decoder opens on its own event type and closes where terminal.rs's tests
  // begin. Both anchors sit outside the tty code, so gating moves them together.
  const first = lines.findIndex((line) => /^enum RawEvent/.test(line));
  const last = lines.findIndex((line, i) => i > first && /^mod tests \{/.test(line));

  it("is where the plan says it is", () => {
    assert.ok(first > 0, "terminal.rs no longer declares `enum RawEvent`");
    assert.ok(last > first, "terminal.rs's `mod tests` no longer follows the decoder");
    assert.ok(
      lines[last - 1].startsWith("#[cfg(test)]"),
      "the decoder region no longer ends just before terminal.rs's own tests",
    );
  });

  it("is still the whole 659-line decoder, not a remnant of it", () => {
    const size = last - 1 - first;
    assert.ok(
      size >= DECODER_MIN_LINES,
      `the decoder region is ${size} lines, fewer than the ${DECODER_MIN_LINES} ` +
        "the plan counts on; something was moved or deleted out of it",
    );
  });

  it("uses no unix APIs, so Task 5 can reuse it as-is", () => {
    const region = lines.slice(first, last - 1);
    const hits = region
      .map((line, i) => [first + 1 + i, line])
      .filter(([, line]) => UNIX_API.test(line));
    assert.deepEqual(
      hits,
      [],
      "the decoder region gained a unix dependency; it can no longer be lifted " +
        "out of the tty code unchanged",
    );
  });
});

describe("the extracted type vocabulary", () => {
  // Task 3. The point of the split is that nothing outside `terminal.rs` had to
  // change, so that is what is asserted: the names still resolve through the old
  // path, and no importer was rewritten to use the new one.
  const VOCABULARY = [
    "Event",
    "KeyEvent",
    "KeyKind",
    "Mods",
    "Key",
    "Mouse",
    "MouseKind",
    "MouseButton",
    "TerminalColors",
    "ColorSlot",
    "WindowSize",
    "Waker",
    "SessionEnv",
  ];

  it("defines every moved name in terminal_types.rs", () => {
    const src = read("terminal_types.rs");
    const missing = VOCABULARY.filter(
      (name) => !new RegExp(`pub (struct|enum) ${name} \\{`).test(src),
    );
    assert.deepEqual(missing, [], "names the extraction was supposed to move");
  });

  it("re-exports every moved name from terminal.rs", () => {
    const shim = read("terminal.rs").match(/pub use crate::terminal_types::\{([^}]*)\}/);
    assert.ok(shim, "terminal.rs no longer re-exports the vocabulary");
    const exported = shim[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const missing = VOCABULARY.filter((name) => !exported.includes(name));
    assert.deepEqual(
      missing,
      [],
      "a moved name is no longer reachable as `crate::terminal::_`; the eleven " +
        "importers and lib.rs's crate-root `pub use` depend on it",
    );
  });

  it("leaves every importer naming crate::terminal, not crate::terminal_types", () => {
    // The shim exists so the keep-unchanged files stay byte-identical. An importer
    // "modernised" onto the new path is the quiet edit Task 14 is meant to catch.
    // `lib.rs` is exempt for one line only: it has to declare the module.
    const SPEAKS_OF_THE_NEW_PATH = ["terminal.rs", "terminal_types.rs", "lib.rs"];
    const offenders = actualFiles.filter(
      (rel) => !SPEAKS_OF_THE_NEW_PATH.includes(rel) && /terminal_types/.test(read(rel)),
    );
    assert.deepEqual(
      offenders,
      [],
      `module(s) rewritten to import the new path: ${offenders.join(", ")}`,
    );

    const declaration = read("lib.rs")
      .split(/\r?\n/)
      .filter((line) => /terminal_types/.test(line));
    assert.deepEqual(
      declaration,
      ["mod terminal_types;"],
      "lib.rs does more than declare the new module; its crate-root `pub use` " +
        "must keep going through `terminal`",
    );
  });

  it("confines the vocabulary's remaining unix dependency to Waker", () => {
    // `Waker` moved with a tty-shaped body (the write end of a self-pipe). Task 5
    // replaces the body, not the name; until then this records the one place the
    // split did not make portable, so it cannot spread quietly.
    const hits = read("terminal_types.rs")
      .split(/\r?\n/)
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => UNIX_API.test(line));
    assert.equal(
      hits.length,
      2,
      `unix API use in terminal_types.rs: ${JSON.stringify(hits)}`,
    );
    for (const [, line] of hits) {
      assert.ok(
        /OwnedFd|rustix::io::write/.test(line),
        `unix API outside Waker in terminal_types.rs: ${line.trim()}`,
      );
    }
  });
});
