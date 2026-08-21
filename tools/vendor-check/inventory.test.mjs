// Pins the shape of the vendored upstream tree.
//
// The port's plan rests on a measurement: of `pixel-core`'s 46 source files, only
// three touch unix APIs, and the 659-line VT decoder inside `terminal.rs` touches
// none. Tasks 3, 4 and 5 all spend that measurement. Re-vendoring upstream is
// expected to happen more than once, and a new unix-bound module arriving with it
// would invalidate the plan silently — the Rust build would simply fail later, in
// a task that has nothing to do with the cause.
//
// So these are assertions about the vendored tree, not about our own code.

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
 * Direct use of a unix-only API. Deliberately narrower than "mentions a platform":
 * `throttle.rs` carries macOS-only code behind `#[cfg(target_os = "macos")]` and
 * compiles on Windows untouched, so a cfg attribute alone is not a blocker.
 */
const UNIX_API = /std::os::unix|rustix::|libc::/;

/** The decoder Task 5 reuses rather than rewriting: `terminal.rs` lines 1251-1909. */
const DECODER_FIRST_LINE = 1251;
const DECODER_LAST_LINE = 1909;

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

const read = (rel) => fs.readFileSync(path.join(PIXEL_CORE_SRC, rel), "utf8");

describe("vendored pixel-core inventory", () => {
  it("has exactly the 46 source files the plan was measured against", () => {
    assert.equal(
      actualFiles.length,
      46,
      `pixel-core has ${actualFiles.length} .rs files, not 46`,
    );
  });

  it("matches the recorded inventory file for file", () => {
    const added = actualFiles.filter((f) => !EXPECTED_FILES.includes(f));
    const removed = EXPECTED_FILES.filter((f) => !actualFiles.includes(f));
    assert.deepEqual(
      { added, removed },
      { added: [], removed: [] },
      "the vendored file set drifted; re-run the unix-API disposition pass before " +
        "updating pixel-core-files.json",
    );
  });

  it("confines unix APIs to the three modules the port replaces", () => {
    const offenders = actualFiles.filter(
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
        actualFiles.includes(rel),
        `${rel} is missing from the vendored tree`,
      );
      assert.ok(
        UNIX_API.test(read(rel)),
        `${rel} no longer uses unix APIs; the port plan may be out of date`,
      );
    }
  });

  it("leaves 43 files with no unix API use at all", () => {
    const clean = actualFiles.filter((rel) => !UNIX_API.test(read(rel)));
    assert.equal(
      clean.length,
      43,
      `${clean.length} files are unix-free, not the 43 the plan counts on`,
    );
  });
});

describe("the VT decoder inside terminal.rs", () => {
  const lines = read("terminal.rs").split(/\r?\n/);

  it("is where the plan says it is", () => {
    assert.ok(
      lines.length >= DECODER_LAST_LINE,
      `terminal.rs has ${lines.length} lines, fewer than the decoder's last line`,
    );
    // The region opens on the decoder's own event type and closes before its tests.
    const opening = lines.slice(DECODER_FIRST_LINE - 1, DECODER_FIRST_LINE + 9);
    assert.ok(
      opening.some((line) => /enum RawEvent/.test(line)),
      "the decoder region no longer starts at RawEvent; the line range moved",
    );
    const closing = lines.slice(DECODER_LAST_LINE - 1, DECODER_LAST_LINE + 4);
    assert.ok(
      closing.some((line) => /#\[cfg\(test\)\]/.test(line)),
      "the decoder region no longer ends just before terminal.rs's own tests",
    );
  });

  it("uses no unix APIs, so Task 5 can reuse it as-is", () => {
    const region = lines.slice(DECODER_FIRST_LINE - 1, DECODER_LAST_LINE);
    const hits = region
      .map((line, i) => [DECODER_FIRST_LINE + i, line])
      .filter(([, line]) => UNIX_API.test(line));
    assert.deepEqual(
      hits,
      [],
      "the decoder region gained a unix dependency; it can no longer be lifted " +
        "out of the tty code unchanged",
    );
  });
});
