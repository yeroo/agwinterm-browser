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
 *
 * `terminal_backend.rs` and `terminal_windows.rs` are Task 4: the trait the two
 * backends have to agree on, and the Windows backend itself. `terminal.rs`
 * re-exports `Terminal` from the latter on Windows, so — again — no importer
 * changed and `lib.rs`'s crate-root `pub use terminal::Terminal` still resolves.
 */
const PORT_ADDED_FILES = [
  "terminal_backend.rs",
  "terminal_types.rs",
  "terminal_windows.rs",
];

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
    // The path, not the word: a comment naming the module is not an import of it.
    const offenders = actualFiles.filter(
      (rel) =>
        !SPEAKS_OF_THE_NEW_PATH.includes(rel) && /crate::terminal_types/.test(read(rel)),
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

describe("the backend seam", () => {
  // Task 4. The plan's claim is that `terminal.rs` splits rather than gates: the tty
  // code goes behind `#[cfg(unix)]` and the VT decoder below it does not. These are
  // assertions about that split holding, and about the two backends staying the same
  // shape — a drift the Rust build would otherwise only catch on the other platform.
  const terminal = read("terminal.rs");
  const lines = terminal.split(/\r?\n/);

  /**
   * The 24 public methods of the unix `impl Terminal`, which is what the trait was
   * derived from. Listed here rather than counted, so a re-vendor that adds a 25th
   * names it in the failure instead of just moving a number.
   */
  const SEAM = [
    "new",
    "open",
    "reports_color_scheme",
    "relayed",
    "kitty_keyboard",
    "set_key_event_types",
    "draw",
    "read_event",
    "poll_event",
    "waker",
    "watch_resize",
    "size",
    "reports_pixel_mouse",
    "frames_are_inline",
    "forget_cell_size",
    "cell_size",
    "query_colors",
    "request_colors",
    "set_pointer_shape",
    "set_clipboard",
    "request_clipboard",
    "clipboard_data_supported",
    "request_clipboard_types",
    "request_clipboard_data",
  ];

  it("gates the tty code and leaves the decoder unconditional", () => {
    const first = lines.findIndex((line) => /^enum RawEvent/.test(line));
    const last = lines.findIndex((line, i) => i > first && /^mod tests \{/.test(line));
    const gated = lines
      .slice(first, last - 1)
      .map((line, i) => [first + 1 + i, line])
      .filter(([, line]) => /#\[cfg\(unix\)\]/.test(line));
    assert.deepEqual(
      gated,
      [],
      "a `#[cfg(unix)]` appeared inside the decoder region; Task 5's Windows backend " +
        "feeds that decoder, so gating any of it strands the thing the split existed for",
    );

    // The mirror: the tty code above it really is gated, not merely deleted.
    assert.ok(
      /#\[cfg\(unix\)\]\r?\nimpl Terminal \{/.test(terminal),
      "`impl Terminal` in terminal.rs is no longer `#[cfg(unix)]`-gated",
    );
    assert.ok(
      /#\[cfg\(windows\)\]\r?\npub use crate::terminal_windows::Terminal;/.test(terminal),
      "terminal.rs no longer re-exports the Windows `Terminal`, so `crate::terminal::" +
        "Terminal` and lib.rs's crate-root `pub use` cannot resolve on Windows",
    );
  });

  it("exposes exactly the 24 methods the trait was derived from", () => {
    // Only the trait's own declarations — the forwarding `impl` further down the file
    // repeats every name, so matching the whole file would count each one twice and a
    // 25th method could hide in the overflow.
    const source = read("terminal_backend.rs");
    const opens = source.indexOf("pub trait TerminalBackend: Sized {");
    assert.ok(opens > 0, "terminal_backend.rs no longer declares the trait");
    const body = source.slice(opens, source.indexOf("\n}", opens));
    const declared = [...body.matchAll(/^    fn (\w+)\(/gm)].map((m) => m[1]);

    assert.deepEqual(
      [...declared].sort(),
      [...SEAM].sort(),
      "TerminalBackend no longer declares exactly the seam's 24 methods",
    );
  });

  it("keeps the unix backend and the Windows backend the same shape", () => {
    const windows = read("terminal_windows.rs");
    for (const method of SEAM) {
      const signature = new RegExp(`^    pub fn ${method}\\b`, "m");
      assert.ok(signature.test(terminal), `${method} is gone from the unix backend`);
      assert.ok(signature.test(windows), `${method} is missing from the Windows backend`);
    }
  });

  it("gates the two modules with no Windows analogue at the crate root", () => {
    // `ghostty` signals ghostty over SIGUSR2; `herdr` speaks a Unix socket and is
    // deferred to Task 13. Both are declared conditionally so they do not have to be
    // ported to make the crate build.
    const lib = read("lib.rs").split(/\r?\n/);
    for (const decl of ["pub mod ghostty;", "mod herdr;"]) {
      const at = lib.indexOf(decl);
      assert.ok(at > 0, `lib.rs no longer declares \`${decl}\``);
      assert.equal(
        lib[at - 1],
        "#[cfg(unix)]",
        `lib.rs no longer gates \`${decl}\` on unix`,
      );
    }
  });
});

describe("the Windows path fixes in clipboard_image.rs", () => {
  // Divergence 4 in docs/design/UPSTREAM.md, and the first edit to one of the 43
  // files the plan calls portable. A re-vendor overwrites it silently — the file
  // would still compile, still pass the unix-API screen, and only three of its own
  // tests would go red on Windows. So it is pinned here too.
  const source = read("clipboard_image.rs");

  it("accepts absolute Windows paths, not just POSIX ones", () => {
    assert.match(
      source,
      /fn looks_absolute\(path: &str\) -> bool/,
      "clipboard_image.rs is back to gating pastes on a leading `/` or `~`, which " +
        "rejects every Windows path as prose",
    );
  });

  it("expands `~` through USERPROFILE on Windows", () => {
    assert.match(
      source,
      /fn home_dir\(\) -> Option<String>/,
      "clipboard_image.rs is back to reading HOME, which Windows does not set",
    );
  });

  it("does not unescape the Windows path separator", () => {
    assert.match(
      source,
      /let separator_is_backslash = cfg!\(windows\);/,
      "clipboard_image.rs is back to unescaping every backslash, which turns " +
        String.raw`C:\Users\me\a.png into C:Usersmea.png`,
    );
  });
});
