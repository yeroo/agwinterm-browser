# Upstream provenance

What was vendored, from where, and every place this tree deliberately differs.
Re-vendoring is expected to happen more than once; this file plus
`tools/vendor-check/` is what makes it cheap.

## Source

| | |
|---|---|
| project | `terminal-browser` (the "terminal graphics engine" monorepo) |
| local checkout | `.reference/terminal-browser/` — read-only, never committed |
| vendored on | 2026-08-21 |
| `packageManager` | `pnpm@10.13.1` |
| `browser`, `cli` version | `0.1.0` |

**There is no commit hash to record.** The reference checkout carries no VCS
metadata — no `.git`, no `.hg` — so the upstream revision cannot be named, only
the bytes. A content digest stands in for it:

| tree | files | sha256 |
|---|---|---|
| whole checkout (excl. `node_modules`, `target`, `dist`) | 256 | `f6cc301011e1ee844be7a8b32e536a6949cbc63fadbead1fcc56323d75ca4b79` |
| `engine/crates/pixel-core` | 49 | `07761059df991330b300e44074cc6b52ee056ec0abebf4e37df88a1082e8e300` |

Reproduce with `python tools/vendor-check/digest.py .reference/terminal-browser`.

⚠️ Recording a hash instead of a revision is weaker than the plan assumed: it can
tell us *that* upstream moved, not *what* moved. If a real upstream remote becomes
available, replace this section with the commit and keep the digests as a check.

## What was copied

`engine/` (`crates/`, `packages/`, `examples/`, `assets/`, `Cargo.toml`,
`Cargo.lock`, `deny.toml`, `justfile`, `rust-toolchain.toml`), `browser/`, `cli/`,
`store/`, `terminals/`, `assets/`, plus `LICENSE`, `package.json`,
`pnpm-workspace.yaml` and `pnpm-lock.yaml`.

`assets/` at the repo root is separate from `engine/assets/` and both are needed:
`pixel-core` and `pixel-node` `include_bytes!` the engine copy at compile time,
while `browser/src/session/session.tsx:89` resolves the root copy at runtime.

The Rust workspace root stays at `engine/`, as upstream has it. `cargo` commands
in this plan run from `engine/`, not the repo root.

## What was deliberately not copied

| omitted | why |
|---|---|
| `scripts/` (incl. `install.sh`, `fetch-electron.sh`, `apparmor.sh`, `bundle.sh`) | POSIX shell installers; `fetch-electron.sh` fetches the patched Electron fork the Constraints forbid |
| `herdr-plugin/`, `release-worker/`, `skill/` | outside the port's scope; not referenced by the five vendored packages |
| `engine/target/`, `engine/examples/agent/dist/` | build output |
| `AGENTS.md`, `CLAUDE.md`, `README.md`, `.github/`, `.vscode/` | this repo has its own |

## Intentional divergences from upstream

Edits to vendored files that are *not* the port's own subject matter. The three
unix-bound modules (`terminal.rs`, `ghostty.rs`, `herdr.rs`) and `pixel-core`'s
`lib.rs` are excluded — replacing those is what the port *is*, and the plan tracks
them task by task. What is listed here is everything else, so the claim "the other
43 files are untouched" stays checkable.

Each is asserted by a test in `tools/vendor-check/`, so a re-vendor that drops one
fails loudly rather than at the Task 10 milestone.

1. **`browser/package.json` — `postinstall` replaced.** Upstream runs
   `bash ../scripts/fetch-electron.sh`. That is forbidden twice over: it needs a
   POSIX shell, and it fetches the patched Electron fork. Replaced with
   `node node_modules/electron/install.js`.

   Not simply *removed*, because removal alone yields an install that succeeds and
   produces no Electron binary anywhere. Electron 43.3.0 has **no `postinstall` of
   its own** — it dropped one and now downloads lazily on first `require("electron")`.
   Invoking its installer explicitly keeps the binary's arrival at install time,
   where a failure is legible.

2. **`pnpm-workspace.yaml` — `electron` added to `onlyBuiltDependencies`.** pnpm 10
   blocks a dependency's build scripts unless listed. With Electron 43 this is
   currently inert (there is no script to block), but it is the documented reason
   upstream substituted the fork fetch, and it costs nothing to keep correct for a
   version that reinstates one.

3. **`package.json` — a root `test` script added**, running the vendor-check suite.
   Upstream has no root test entry point.

4. **`engine/crates/pixel-core/src/clipboard_image.rs` — POSIX path assumptions
   widened** (Task 4). This is the first edit to one of the 43 supposedly-portable
   files, and it was found by running their tests rather than by reading them: the
   file uses no unix *API*, which is what `inventory.test.mjs` screens for, but it
   assumed unix *paths* in three places, and three of its five tests failed on
   Windows.

   - `image_path_from_paste` gated on a leading `/` or `~`, so every Windows path
     (`C:\…`, `\\host\share\…`) was rejected as prose. Now `looks_absolute`.
   - `~/` expanded through `HOME`, which Windows spells `USERPROFILE`. Now `home_dir`.
   - `unescape` treated every backslash as a quote character, turning
     `C:\Users\me\a.png` into `C:Usersmea.png`. On Windows it now unescapes only an
     escaped space or tab — the case the function exists for — and leaves every other
     backslash standing as a separator.

   All three are `cfg!(windows)` branches, so unix behaviour is byte-for-byte what it
   was. Upstream would probably take this patch; it is a portability fix, not a
   divergence in intent.

   ⚠️ **The lesson generalises: "no unix API" is not "portable".** Two other files
   handle paths (`image_cache.rs`, `native.rs`) and their tests pass today, but the
   screen that cleared all 43 cannot see this class of problem. Task 14's
   unchanged-check should expect this list to grow.

5. **`engine/crates/pixel-node/src/lib.rs` — `watch_resize` is on under Windows**
   (Task 10). Upstream passes `watch_resize: false` unconditionally, which is right
   for it: its engine lives in a daemon that is not the tty's foreground process
   group, so `SIGWINCH` would not arrive anyway, and in the no-tty shape
   `pixel-react` nudges the engine from `process.stdout.on("resize", …)` instead.

   Neither route exists on Windows — there is no `SIGWINCH`, and Electron's stdout
   is a pipe rather than a `tty.WriteStream`, so that event never fires. Without
   this the pane resizes and the browser goes on drawing the old size; agwinterm
   then places a canvas it has to clip, silently. It is one line —
   `WATCH_RESIZE = cfg!(windows)` — and off Windows it is byte-for-byte upstream's
   behaviour, but a re-vendor that drops it fails as a picture that stops being
   right rather than as a build error, so it is listed here and pinned by a test.

6. **`engine/crates/pixel-core/src/engine/mod.rs` — one added `#[test]`** (Task 11).
   No production line changed, and the test asserts something about *upstream's*
   code rather than the port's: that `NativeScroll::spawn(None)` yields nothing
   unless `NATIVE_SCROLL_HELPER` names a helper.

   It is here because that is what makes `reports_pixel_mouse() == false` a
   documented ceiling instead of a bug. Both gates the flag feeds — `pointer.rs:61`
   and `scroll.rs:192` — sit behind `self.native`, so on a platform with no scroll
   helper the flag changes nothing that runs. If upstream ever spawns a helper
   without the variable, that reasoning stops holding, and this is what says so.

   The lightest possible touch to one of the 43, and still a touch: recorded so the
   `git diff`-against-baseline check in `tools/vendor-check/unchanged.test.mjs` has
   a written reason for every file it finds.

## Re-vendoring checklist

1. Refresh `.reference/terminal-browser/`, re-run `digest.py`, update this file.
2. Copy per "What was copied"; do not copy per "What was deliberately not copied".
3. Re-apply every divergence listed above.
4. `pnpm install` and confirm `browser/node_modules/electron/dist/electron.exe`.
5. `pnpm test` — the vendor-check suite fails if the `pixel-core` inventory drifted
   or a new unix-bound module appeared.
6. Re-run the disposition pass in `docs/design/01-baseline-errors.md` if the
   inventory test reports additions.
