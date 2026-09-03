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
 *
 * `agwinterm.rs` is Task 6: the control-pipe client. It is the output half's
 * transport and the only source of pane geometry there is on Windows — the
 * analogue of `herdr.rs` on unix, which is one of the three modules the port
 * replaces rather than keeps.
 *
 * `frame_file.rs` is Task 7: the file-based frame path that rides on it — a canvas
 * to a PNG on disk and the `image.frame` request that points agwinterm at the file.
 * It is what `terminal.rs`'s Kitty-escape `draw` becomes on Windows, where ConPTY
 * strips the escapes; the shared-memory path is layered over it rather than
 * replacing it, and it stays as the fallback and the baseline.
 *
 * `frame_shm.rs` is Task 12: the transport selection and the `unknown command`
 * capability probe from the port, and — once agwinterm published the contract
 * (2026-09) — the `image.frameshm` layout, mapping and producer.
 */
const PORT_ADDED_FILES = [
  "agwinterm.rs",
  "frame_file.rs",
  "frame_shm.rs",
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
 * up by 178 lines and Task 4's gating moved it again. So it is located by its own
 * anchors — it opens on `enum RawEvent` and closes where `mod tests` begins — and
 * pinned by size and unix-freedom, which are the properties the plan spends.
 *
 * Task 5 widened five of its items to `pub(crate)` so the Windows backend can call
 * them from a sibling module, hence the optional visibility in the anchor. Those
 * five widenings are the entire cost of "reuse the decoder, do not write a second
 * one", and they are pinned by name further down.
 */
const DECODER_OPENS = /^(?:pub\(crate\) )?enum RawEvent/;
const DECODER_MIN_LINES = 650;

/**
 * The decoder items the Windows console backend calls, and therefore the ones a
 * re-vendor has to re-widen. `parse_event_kitty` is the parser itself; `RawEvent`
 * and its two clipboard payload types are what it returns; `parse_osc_color` is
 * what `query_colors` reads the palette out of.
 */
const DECODER_REUSED = [
  ["fn", "parse_event_kitty"],
  ["fn", "parse_osc_color"],
  ["enum", "RawEvent"],
  ["enum", "ClipStatus"],
  ["struct", "ClipPacket"],
];

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
  const first = lines.findIndex((line) => DECODER_OPENS.test(line));
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

  it("confines the vocabulary's remaining unix dependency to Waker, and gates it", () => {
    // `Waker` moved with a tty-shaped body (the write end of a self-pipe). Task 5
    // replaced the body without touching the name: the unix field and the `wake`
    // that writes to it are `#[cfg(unix)]`, and Windows carries an inbox handle
    // instead. Both halves are asserted, because getting this wrong produces a
    // crate that builds on exactly one platform.
    const lines = read("terminal_types.rs").split(/\r?\n/);
    const hits = lines
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => UNIX_API.test(line));
    assert.equal(
      hits.length,
      2,
      `unix API use in terminal_types.rs: ${JSON.stringify(hits)}`,
    );
    for (const [at, line] of hits) {
      assert.ok(
        /OwnedFd|rustix::io::write/.test(line),
        `unix API outside Waker in terminal_types.rs: ${line.trim()}`,
      );
      assert.equal(
        lines[at - 2].trim(),
        "#[cfg(unix)]",
        `Waker's unix half is no longer gated, so Windows cannot build it: ${line.trim()}`,
      );
    }
    assert.match(
      lines.join("\n"),
      /#\[cfg\(windows\)\]\n\s*pub\(crate\) inbox: std::sync::Arc<crate::terminal_windows::Inbox>/,
      "Waker has no Windows half, so `waker()` cannot be implemented there",
    );
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
    const first = lines.findIndex((line) => DECODER_OPENS.test(line));
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

describe("the Windows console input backend", () => {
  // Task 5. The plan's instruction was "reuse the existing decoder — do not write a
  // second one", and Task 2's brief added four Win32 requirements that upstream had
  // no analogue for. Both are structural claims that compile either way, so they are
  // asserted here rather than left to a code review.
  const terminal = read("terminal.rs");
  const windows = read("terminal_windows.rs");

  it("widens the decoder items the backend calls, rather than copying them", () => {
    for (const [kind, name] of DECODER_REUSED) {
      assert.match(
        terminal,
        new RegExp(`^pub\\(crate\\) ${kind} ${name}\\b`, "m"),
        `terminal.rs no longer exposes \`${name}\` to the crate, so the Windows ` +
          "backend cannot reach the decoder and would have to grow its own",
      );
    }
    assert.match(
      windows,
      /parse_event_kitty\(&self\.pending, self\.kitty_keyboard\(\)\)/,
      "terminal_windows.rs no longer feeds the inherited decoder",
    );
  });

  it("grows no parser of its own", () => {
    // The failure this catches is a slow one: a `parse_` helper added here because
    // it was easier than reaching for the decoder, after which the two disagree
    // about some escape and only one platform is fixed.
    const own = [...windows.matchAll(/^(?:pub\(crate\) )?fn (parse_\w+)/gm)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      own,
      [],
      `terminal_windows.rs defines its own parser(s): ${own.join(", ")}`,
    );
  });

  it("attaches to the console before opening it, and tolerates already being attached", () => {
    // Measured in tools/console-inherit-probe: a GUI-subsystem child gets no
    // console (`conin_err=6`) until it attaches, and an attached one is refused a
    // second attach with ERROR_ACCESS_DENIED.
    const attach = windows.indexOf("fn attach_console");
    const open = windows.indexOf("ConsoleHandle::open(CONIN)");
    assert.ok(attach > 0, "terminal_windows.rs no longer attaches to a console");
    assert.ok(
      windows.indexOf("attach_console(&env)") < open,
      "CONIN$ is opened before AttachConsole, which is the measured failure",
    );
    assert.match(
      windows.slice(attach),
      /ERROR_ACCESS_DENIED/,
      "an already-attached process is treated as a failure to attach",
    );
    assert.match(
      windows.slice(attach),
      /ATTACH_PARENT_PROCESS/,
      "there is no fallback for a missing or stale console pid",
    );
  });

  it("opens the console devices by name, never through GetStdHandle", () => {
    // A ConPTY child's std handles can be NUL: FILE_TYPE_CHAR, then
    // ERROR_INVALID_HANDLE from every console call. Opening by name is the
    // analogue of upstream opening /dev/tty rather than using fd 0.
    // The prose in the module docs says why it is not used, so match a call.
    assert.doesNotMatch(
      windows,
      /GetStdHandle\s*\(/,
      "GetStdHandle is back, and under a pseudoconsole it can hand back NUL",
    );
    assert.match(windows, /const CONIN: &\[u16\]/);
    assert.match(windows, /const CONOUT: &\[u16\]/);
  });

  it("restores the console mode on the panicking path as well as on drop", () => {
    assert.match(
      windows,
      /std::panic::set_hook/,
      "nothing restores the console when a panic skips the guard's Drop",
    );
    assert.match(
      windows,
      /impl Drop for ModeGuard/,
      "raw mode is no longer tied to a value's lifetime, which is the trait's contract",
    );
  });

  it("does not claim capabilities this host does not have", () => {
    // `kitty_keyboard` decides how the decoder reads every key, and
    // `reports_pixel_mouse` decides whether a mouse report is a pixel or a cell.
    // Both are `false` here, and the setup string has to agree with them.
    for (const capability of ["kitty_keyboard", "reports_pixel_mouse"]) {
      assert.match(
        windows,
        new RegExp(`pub fn ${capability}\\(&self\\) -> bool \\{\\r?\\n\\s*false`),
        `${capability} no longer answers false, which the setup string assumes`,
      );
    }
  });
});

describe("the agwinterm control-pipe client", () => {
  // Task 6. Structural claims that compile either way, so a Rust test cannot be the
  // only thing holding them: that a frame is addressed to *this* pane, that the
  // cell-metrics decision in docs/design/04-cell-metrics.md and the code that
  // implements it still name the same verb, and that the wrong-guess fallback the
  // plan warned about did not quietly reappear elsewhere.
  const client = read("agwinterm.rs");
  const windows = read("terminal_windows.rs");
  const DECISION = path.join(REPO, "docs", "design", "04-cell-metrics.md");

  it("addresses the pane by id and never the active one", () => {
    // agwinterm resolves an absent target as the active session
    // (`target ?? "active"` throughout ControlServer.cs), so a frame sent without
    // one lands wherever the user last looked.
    assert.ok(
      client.includes(`push_quoted(&mut line, &self.target.session);`),
      "requests no longer carry the pane id as their target",
    );
    assert.ok(
      client.includes(`if session == "active" {`),
      'the guard that refuses "active" as a session id is gone',
    );
    assert.doesNotMatch(
      client,
      /push_quoted\(&mut line, "active"\)/,
      'something builds a request addressed to "active"',
    );
  });

  it("names what is required when the host is not there", () => {
    // A blank pane with no explanation is the failure this exists to prevent, so
    // the message names all three variables rather than the first one missing.
    const message = client.match(/fn not_hosted\(missing: &str\) -> io::Error \{[\s\S]*?\n\}/);
    assert.ok(message, "agwinterm.rs no longer explains an absent host");
    for (const name of ["ENABLED_VAR", "SESSION_VAR", "PIPE_VAR"]) {
      assert.ok(
        message[0].includes(name),
        `the "no agwinterm here" message no longer names ${name}`,
      );
    }
  });

  it("treats a dropped pipe as recoverable rather than fatal", () => {
    assert.ok(
      client.includes("fn recoverable(err: &io::Error) -> bool"),
      "nothing distinguishes a dropped connection from a missing host, so either " +
        "a host restart is fatal or an absent host is retried forever",
    );
    assert.match(
      client,
      /Err\(err\) if recoverable\(&err\) => \{[\s\S]*?self\.attempt\(line\)/,
      "a recoverable failure no longer replays the request on a new connection",
    );
  });

  it("keeps the cell-metrics decision and the code that implements it in step", () => {
    const decision = fs.readFileSync(DECISION, "utf8");
    for (const constant of ["METRICS_CMD", "CELL_PX_VAR"]) {
      const declared = client.match(
        new RegExp(`const ${constant}: &str = "([^"]+)"`),
      );
      assert.ok(declared, `agwinterm.rs no longer declares ${constant}`);
      assert.ok(
        decision.includes(declared[1]),
        `${declared[1]} is not what docs/design/04-cell-metrics.md records for ` +
          `${constant}; the decision and the code have drifted`,
      );
    }
  });

  it("never lets cell_size answer None on Windows", () => {
    // `engine/mod.rs:347` does `term.cell_size()?.unwrap_or((16, 32))`. A `None`
    // means the engine sizes the canvas with a number the backend does not have
    // and the pointer is mapped in a different coordinate space — the failure that
    // actually moves click targets. So it resolves once and both readers use the
    // cache.
    assert.ok(
      client.includes("pub(crate) fn cell_size("),
      "the three-source resolution the decision records is gone",
    );
    assert.ok(
      windows.includes("agwinterm::cell_size(self.host(), &env)"),
      "cell_size no longer goes through that resolution",
    );
    assert.ok(
      windows.includes("let (width, height) = self.cell.unwrap_or(agwinterm::FALLBACK_CELL);"),
      "the pointer no longer falls back to the number the canvas would be sized " +
        "with, so a report before the first cell_size lands in the wrong place",
    );
  });

  it("keeps the fallback a named constant in one place", () => {
    // The plan's instruction was that terminal.rs's hardcoded (16, 32) must not
    // stand as the answer. It may be the last resort, but only once, named, and
    // logged where the reason is known.
    assert.ok(
      client.includes("pub(crate) const FALLBACK_CELL: (u32, u32) = (16, 32);"),
      "the fallback cell size is no longer a named constant",
    );
    // Comments are allowed to name the number — explaining why the constant is
    // what it is *requires* naming it. Code is not.
    const inCode = windows
      .split(/\r?\n/)
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => !/^\s*(\/\/|\*)/.test(line) && /\(16, 32\)/.test(line));
    assert.deepEqual(
      inCode,
      [],
      "a bare (16, 32) reappeared in the Windows backend's code instead of going " +
        "through agwinterm::FALLBACK_CELL",
    );
  });
});

describe("the file-based frame path", () => {
  // Task 7. Two of its decisions are the kind that compile perfectly well when
  // reversed, and both were reversed in the design that preceded it: reusing one
  // path per frame, and rotating the image id to exploit the host's cache. A Rust
  // test can show the current code does the right thing; only this can show the
  // wrong thing did not come back.
  const frames = read("frame_file.rs");
  const windows = read("terminal_windows.rs");

  it("gives every frame a path no frame has had before", () => {
    // agwinterm's phase 1 reads the file synchronously while a free-running
    // producer writes the next frame. Reusing a path means either a sharing
    // violation — swallowed by the bare `catch` at ControlServer.cs:458, which
    // silently re-places the stale image — or a truncated PNG.
    assert.match(
      frames,
      /fn next_path\(&mut self\) -> PathBuf \{[\s\S]*?self\.seq \+= 1;/,
      "the frame path is no longer derived from a sequence that only goes up",
    );
    assert.ok(
      frames.includes(".create_new(true)"),
      "frames are written with a call that would silently overwrite an existing " +
        "file, so a repeated path would race the host's read instead of failing",
    );
  });

  it("does not rotate the image id to court the host's cache", () => {
    // ContentSignature is mtime ^ (length << 1) ^ hash(path) and never reads a
    // byte, so the cache cannot help a browser frame — and *can* drop one, when
    // two consecutive frames of equal length land inside the timestamp
    // granularity. The id therefore stays put and the path is what varies.
    assert.ok(
      frames.includes("const FRAME_IMAGE_ID: u32 = 1;"),
      "the one fixed image id is gone; check nothing started rotating ids",
    );
    const built = frames.match(/fn frame_args\([\s\S]*?[\r\n]\}/);
    assert.ok(built, "frame_file.rs no longer builds the image.frame args");
    assert.ok(
      built[0].includes("FRAME_IMAGE_ID"),
      "the request's id is no longer the fixed one",
    );
    assert.doesNotMatch(
      built[0],
      /self\.seq|% *FRAME_SLOTS/,
      "the image id is derived from the frame sequence again",
    );
  });

  it("keeps the churn bounded and does not leave it behind", () => {
    for (const [what, needle] of [
      ["a retention limit", "const RETAINED: usize = 3;"],
      ["the reaper", "fn reap(&mut self)"],
      ["the drop that removes the directory", "impl Drop for FrameDir"],
      ["the sweep for directories a crash left", "fn sweep_stale("],
    ]) {
      assert.ok(frames.includes(needle), `${what} is gone from frame_file.rs`);
    }
  });

  it("is the Windows backend's draw, and stays the fallback", () => {
    assert.ok(
      windows.includes("frames.publish(client, canvas, span)"),
      "the Windows backend no longer draws through the file-based path",
    );
    assert.doesNotMatch(
      windows,
      /fn draw\(&mut self, _canvas: &Canvas\)/,
      "draw is back to ignoring its canvas",
    );
    // Task 12 layers image.frameshm over this path rather than replacing it, and
    // diffs against it. A frame_file.rs that stops being reachable would make
    // that comparison vacuous.
    assert.ok(
      frames.includes('pub(crate) const FRAME_CMD: &str = "image.frame";'),
      "the verb this path uses is no longer named in one place",
    );
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

/**
 * `terminals/src/shared.ts` — the one line of `pixel-terminals` this port changed,
 * and the only one, so it is covered here rather than in the package's own suite.
 *
 * That suite (`terminals/test/terminals.test.js`) is upstream's, is vendored
 * byte-identical, and is **red at the vendor baseline**: one herdr case expects a
 * `--right-click` fallback that `herdr.ts` does not implement. It is therefore not
 * wired into the repo's `test` script, and fixing it is upstream's business, not
 * this port's — `herdr` is permanently disabled here (`docs/design/07-as-built.md`
 * §2), so the port has no way to verify a change to it. Recorded in `UPSTREAM.md`
 * rather than left as a silent gap.
 */
describe("callerTty on Windows", () => {
  const source = fs.readFileSync(path.join(REPO, "terminals", "src", "shared.ts"), "utf8");
  const body = source.slice(source.indexOf("export function callerTty"));

  it("answers before the ps walk, rather than letting it fail", () => {
    // `ps` does not exist on Windows, so the walk throws on its first hop and
    // reports `denied: true` — which callers read as a sandbox refusal and answer
    // with advice about escalating permissions. There is no tty path to find here
    // at all; that absence is the fact the whole port is built around.
    const early = body.indexOf('process.platform === "win32"');
    const walk = body.indexOf("execFileSync");
    assert.ok(early > 0, "the Windows early return is gone from callerTty");
    assert.ok(early < walk, "the ps walk now runs before the Windows check");
    assert.match(
      body.slice(early, walk),
      /\{\s*path:\s*null,\s*denied:\s*false\s*\}/,
      "the Windows answer must be `not found`, not `refused`",
    );
  });
});
