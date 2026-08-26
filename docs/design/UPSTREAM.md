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

Edits to vendored files that are *not* the port's own subject matter. The port's own
work is excluded — `terminal.rs`, `pixel-core`'s `lib.rs`, the CLI, the store, the
browser's input path and the rest — because replacing those is what the port *is*.
Those files are not unrecorded, they are recorded elsewhere: `SUBJECT` in
`tools/vendor-check/dispositions.mjs` names the plan task that owns each.

**What is guarded, and how the scope is decided.** The vendoring commit `45b5e43`
introduced 239 paths. Four are declared out (`EXCLUSIONS` in
`tools/vendor-check/universe.mjs`, with a reason each); the remaining 235 are the
vendored universe, and every one of them is diffed against that commit on every
`pnpm test`. That covers all three vendored trees — `engine/crates/pixel-core`,
`engine/crates/pixel-node` and `engine/packages/pixel-react` — plus `browser/`,
`cli/`, `store/`, `terminals/`, `assets/` and the two `Cargo.toml` files. A path that
differs must be one of exactly three things: the port's subject matter with a task
that owns it, an incidental divergence numbered below, or a declared exclusion. A
vendored file that is *deleted* fails too, which is the failure a diff cannot see.

**The scope comes from git, not from this file.** `universe.mjs` asks
`git show --name-only 45b5e43` what was vendored, so every path that commit carried is
in scope with nobody to remind. **This list is therefore not the boundary of what is
checked** — it is the subset of checked paths whose edits a re-vendorer has to re-apply
by hand.

The edge of that is worth stating, because it is the one thing the derived scope cannot
do: a file vendored *later* is not in the universe, since the universe is one commit's
contents. What covers it is `untrackedInVendoredTrees`, which fails while the file sits
in a vendored tree untracked. "Vendored tree" there means the trees under **What was
copied** above: `45b5e43` also laid down this repo's own `tools/` and `docs/`, so those
two roots are declared out of that check by `PROJECT_ROOTS` — they stay in the diffed
universe, they are just not places upstream code arrives. Committing it under this baseline clears the finding
without putting the file in scope, so for genuinely new upstream code the answer is a
re-vendor that moves `BASELINE` — see the closing note below.

That distinction is the correction this section needed. Until 2026-08-26 the guard was
scoped to a checked-in inventory of `engine/crates/pixel-core/src`, and the sentence
that stood here — that each divergence "is asserted by a test in
`tools/vendor-check/`" — was true of divergences 4 and 6 and false of every other
one. `docs/plans/20260826-vendor-check-gap.md` is the repair.

Two limits worth naming. Divergences 1-3 were applied by the vendoring commit itself
— the port needed `pnpm install` to work before it could write a line — so they *are*
the baseline and no diff can show them; they are checked by content instead
(`divergenceEvidenceHolds`). And the numbering below is what `INCIDENTAL` in
`dispositions.mjs` cites, so an entry renumbered or deleted here without being changed
there fails the suite.

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

   Two things about that script are deliberate and would otherwise read as
   oversights. It does **not** build first: a nested bare `pnpm` is not on `PATH`
   unless `corepack enable` has been run, so `pnpm -r build && …` fails on a stock
   machine. The three suites that import the built `pixel-store` instead call
   `requireBuilt` (`tools/lib/built.mjs`), which refuses a missing *or stale*
   `dist/` and names the build command — a stale one would otherwise pass green
   against the previous source. And it does **not** include
   `terminals/test/terminals.test.js`: that suite is upstream's, is vendored
   byte-identical, and is **red at this baseline** — `herdr falls back when the
   running herdr predates --right-click` expects a fallback `herdr.ts` does not
   implement. Fixing it means editing vendored code for a host this port
   permanently disables ([`07-as-built.md`](07-as-built.md) §2) and cannot test
   against, so it is left to upstream. The one line of `pixel-terminals` this port
   *did* change — `callerTty`'s Windows early return — is covered in
   `tools/vendor-check/inventory.test.mjs` instead.

   The inherited `build:dist`, `install:dist`, `dist` and `release:*` scripts all
   target `scripts/`, which was not copied (see below), and `browser` runs a `start`
   script built around the POSIX `exec`. All six are inert here and are kept only to
   keep the diff against upstream small.

4. **`engine/crates/pixel-core/src/clipboard_image.rs` — POSIX path assumptions
   widened, and UNC deliberately narrowed** (Task 4, plus a later review round). This
   is the first edit to one of the 43 supposedly-portable files, and it was found by
   running their tests rather than by reading them: the file uses no unix *API*, which
   is what `inventory.test.mjs` screens for, but it assumed unix *paths* in four
   places, and three of its five tests failed on Windows.

   - `image_path_from_paste` gated on a leading `/` or `~`, so every drive-qualified
     Windows path (`C:\…`, `C:/…`) was rejected as prose. Now `looks_absolute`.
   - a `file://` URL kept the empty authority's slash — `file:///C:/pics/a.png` became
     `/C:/pics/a.png`, which reads as absolute and then fails `is_file` silently, on
     the one spelling every real producer writes. Now `file_url_path`, which unwraps
     the empty-authority form and leaves a named authority alone.
   - `~/` expanded through `HOME`, which Windows spells `USERPROFILE`. Now `home_dir`
     — and through `strip_home`, which takes `~\` as well: `looks_absolute` admits a
     leading `~` in either separator, so the spelling a Windows user types reached the
     expansion and fell out of it as a relative literal, probed against the browser's
     working directory and never found. The same widening `browser/src/url.ts` makes
     for `~\` and `.\`, on the same reasoning and Windows-only for the same one.
   - `unescape` treated every backslash as a quote character, turning
     `C:\Users\me\a.png` into `C:Usersmea.png`. On Windows it now unescapes only an
     escaped space or tab — the case the function exists for — and leaves every other
     backslash standing as a separator.

   All four are `cfg!(windows)` branches, so unix behaviour is byte-for-byte what it
   was. Upstream would probably take that much; it is a portability fix, not a
   divergence in intent.

   ⚠️ **The fifth change is a divergence in intent, and it goes the other way.**
   `looks_absolute` now **refuses** UNC — `\\host\share\a.png`, `//host/share/…`,
   `\\?\UNC\…` and `file://host/share/…` are all declined before `is_file` is asked.
   On Windows that probe is not a filesystem question: it is an outbound SMB or WebDAV
   connection with implicit authentication, made synchronously on the thread that runs
   `handle_event`. A page that puts `\\attacker.example\s\a.png` on the clipboard would
   get a credential handshake out of this machine on the next Ctrl+V, and a host that
   does not route would freeze the UI for the whole connect timeout. The extended-length
   spelling of a *local* path (`\\?\C:\pics\a.png`) is still admitted, because there is
   no host in it. Pinned by `a_unc_share_is_never_probed` and
   `an_extended_length_local_path_is_still_local`, both of which assert on the gate
   rather than on the result — `is_file` on an unreachable share is `false` too, so an
   outcome check would pass with the guard removed. Upstream would not take this one
   unchanged: it costs a paste that used to work on a trusted share.

   A later review round found the refusal had **two doors left open**, and both are
   now shut. `looks_absolute` runs on the text *as pasted*, where a leading `~`
   satisfies it outright — and `Path::join` replaces its base rather than appending
   when the joined component carries a root or a Windows prefix, so
   `~/\\attacker.example\s\a.png` expanded to the share itself, home discarded, and
   reached `is_file`. `under_home` re-decides the question after expansion and is
   pinned by `a_tilde_does_not_smuggle_a_share_past_the_gate`. Separately,
   `read_for_worker` opened every `CF_HDROP` entry through `from_file` with no gate
   at all; it now applies `looks_absolute` to each. That door is narrower — a page
   cannot put a file *list* on the clipboard the way it can put text — but the
   promise this divergence makes is that no share is opened, not that no share is
   opened from one code path.

   ⚠️ **The lesson generalises: "no unix API" is not "portable".** Two other files
   handle paths (`image_cache.rs`, `native.rs`) and their tests pass today, but the
   screen that cleared all 43 cannot see this class of problem. Task 14's
   unchanged-check should expect this list to grow.

5. **`engine/crates/pixel-node/src/lib.rs` — the `SurfaceSink` seam, and
   `watch_resize` on under Windows** (Task 10). Two edits, 237 insertions and 5
   deletions between them.

   ⚠️ **This entry said "It is one line — `WATCH_RESIZE = cfg!(windows)`" until
   2026-08-26.** That was true of the second edit and silent about the first, which
   is worse than an omission: a re-vendorer working through this checklist would have
   restored the constant, lost the trait and the six tests that hang off it, and had
   nothing tell them so. A recorded divergence whose recorded scope is wrong is the
   one failure mode a checklist cannot survive.

   **`watch_resize`.** Upstream passes `watch_resize: false` unconditionally, which
   is right for it: its engine lives in a daemon that is not the tty's foreground
   process group, so `SIGWINCH` would not arrive anyway, and in the no-tty shape
   `pixel-react` nudges the engine from `process.stdout.on("resize", …)`
   (`index.ts:583`) instead.

   Neither route exists on Windows — there is no `SIGWINCH`, and Electron's stdout
   is a pipe rather than a `tty.WriteStream`, so that event never fires. Without
   this the pane resizes and the browser goes on drawing the old size; agwinterm
   then places a canvas it has to clip, silently. The value is *named* —
   `pub(crate) const WATCH_RESIZE: bool = cfg!(windows)` — rather than written
   inline at the `EngineConfig`, so a test can pin both halves without constructing
   an `Engine`, which opens a real console. Off Windows the behaviour is byte-for-byte
   upstream's. A re-vendor that drops it fails as a picture that stops being right
   rather than as a build error, which is why it is listed here at all.

   **`SurfaceSink`.** A one-method trait (`draw_surface`), an `impl` of it for
   `Engine`, and `draw_frame`/`draw_pixels` made generic over it. Nothing observable
   changes: the `impl` delegates to `Engine`'s inherent method of the same name, so
   every call site does exactly what it did.

   It exists because `draw_frame` is where a submitted frame stops being
   platform-shaped — an IOSurface on macOS, a shared-memory region on Linux, an owned
   buffer and nothing else on Windows — and the Windows arm is the only arm that
   compiles here. Naming the single thing `draw_frame` asks of the engine lets that
   arm be exercised against a recording sink, because `Engine::new` opens a real
   console and cannot be built in a unit test. What that buys is in the same file: six
   tests, pinning stride handling (an `Owned` buffer has no stride field, so padded
   rows must be repacked at submit time rather than described on the way out) and the
   two damage-rect cases that must not be confused — absent means "the whole surface",
   zero-area means "nothing".

   Upstream would plausibly take this one: it is a testability seam over its own code,
   not a Windows behaviour. It is listed here because it is 200 lines of a vendored
   file that a re-vendor overwrites wholesale.

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

7. **`engine/crates/pixel-node/src/capture.rs` — a `read_exact_at` shim.** Upstream
   imports `std::os::unix::fs::FileExt` and calls `read_exact_at` on the segment file
   from `Segment::apply`, reading at an explicit offset without moving a shared
   cursor. That import does not exist on Windows, so the crate did not compile.

   Windows' `std::os::windows::fs::FileExt` offers `seek_read`, which takes the offset
   but is a *short* read like `Read::read` — the `pread` half without the `read_exact`
   half. The replacement is a free function of the same name with two `cfg` bodies:
   the unix one delegates to upstream's method unchanged, and the Windows one loops
   over `seek_read`, retries `Interrupted`, and turns a zero-byte read into
   `UnexpectedEof` carrying `std`'s own "failed to fill whole buffer" message. The
   call site becomes `read_exact_at(&self.seg, …)`.

   ⚠️ `seek_read` also moves the file pointer, which `read_exact_at` does not. That
   is harmless here only because every read on this handle carries its own offset; a
   future caller that mixed `Read::read` with this shim on the same `File` would find
   the cursor somewhere it did not put it.

   The same file carries one `#[cfg_attr(windows, allow(dead_code))]`, on
   `Registry::wants`. Only the zero-copy submit paths ask it before paying for a
   surface lock, and Windows' `update_surface` already holds plain pixels and calls
   `capture` directly, so it has no caller on this platform.

8. **`engine/crates/pixel-node/src/surface.rs` — three
   `#[cfg_attr(windows, allow(irrefutable_let_patterns))]`.** `SurfacePixels` has
   exactly one variant on Windows — `Owned`; the zero-copy variants are `cfg`'d out —
   so the `Owned` patterns in `SurfaceMailbox::submit`, `SurfaceMailbox::recycle` and
   the test module are irrefutable there, and the lint fires on code that is correct
   on all three platforms.

   Scoped to those three sites rather than to the crate, deliberately: crate-wide it
   would silence the unix builds too, where an arm that becomes genuinely unreachable
   is worth hearing about. No production line changed.

9. **`engine/packages/pixel-react/scripts/build-native.mjs` — rewritten around
   `libraryName(platform)`.** This script produces `native/pixel.node`, the napi
   artifact `pixel-react` loads. Upstream picks the source filename with
   `platform === "darwin" ? "libpixel_node.dylib" : "libpixel_node.so"`. Windows
   differs in both halves of that name — no `lib` prefix, `.dll` rather than `.so` —
   so the script looked for `libpixel_node.so`, `copyFileSync` failed with `ENOENT`,
   and the error read as a missing build rather than a wrong filename. `libraryName`
   is exported so all three platforms can be checked without running cargo.

   Three things were added around it, each for a failure that otherwise reads as
   something else:

   - an explicit `existsSync` on the source, so "cargo build reported success but the
     artifact is not where we looked" says that, instead of surfacing as a copy error;
   - `EBUSY`/`EPERM`/`EACCES` on the copy re-thrown as "a browser is still running on
     the previous build. Close it and build again." Windows refuses to unlink or
     overwrite a mapped DLL, and `rmSync`'s `force: true` covers a *missing* file, not
     a busy one;
   - an `isEntryPoint()` guard, so importing the module for `libraryName` does not
     shell out to cargo. Both sides are compared through `realpath`, because
     `import.meta.filename` arrives already resolved while `process.argv[1]` is the
     path as typed — comparing them directly made any invocation through a symlink (a
     linked `node_modules/.bin` entry, a junctioned checkout) build nothing and exit 0.

10. **`engine/Cargo.toml` — the `windows-sys` workspace dependency.** Six features,
    kept to what the port actually calls: `Win32_Foundation`, `Win32_Security`,
    `Win32_Storage_FileSystem`, `Win32_System_Console`, `Win32_System_IO` and
    `Win32_System_Pipes`. Declared at the workspace root so the two crates that need
    it cannot disagree about the version. Nothing else in upstream's manifest changed.

    `Win32_System_Pipes` is the one that looks unnecessary and is not: the control-pipe
    client dials with `OpenOptions`, but its test fixture is a real `CreateNamedPipeW`
    server rather than a mock of one.

11. **`engine/crates/pixel-core/Cargo.toml` — `windows-sys` as a `cfg(windows)` target
    dependency.** One `[target.'cfg(windows)'.dependencies]` block taking the workspace
    entry, for the Windows console backend (`terminal_windows.rs`): attaching to the
    pane's console, opening `CONIN$`/`CONOUT$` by name, the mode pair VT input needs,
    and the screen-buffer query that stands in for `SIGWINCH`. Under a target gate
    rather than a plain dependency, so a unix build of `pixel-core` resolves
    byte-for-byte upstream's dependency graph.

12. **`engine/Cargo.lock` — one line: `windows-sys 0.61.2` in `pixel-core`'s
    dependency list.** Cargo's regeneration of divergences 10 and 11 — resolved, not
    authored, and re-applied by running cargo rather than by editing the file.

    It gets an entry rather than an exclusion because a lockfile that moves without a
    manifest moving is a real event — an unpinned transitive bump arriving on somebody's
    machine — and requiring a written reason is the only way anyone notices one.

## Re-vendoring checklist

The guard is what makes this cheap, so the checklist is written around it rather than
around this document. Work down the numbered divergences by hand — nothing can re-apply
them for you — and then let `pnpm test` tell you what you missed. **The suite is the
completeness check; this list is not.**

1. Refresh `.reference/terminal-browser/`, re-run `digest.py`, update the Source table
   above. A hash that moved is the only notice you get that upstream did.
2. Copy per "What was copied"; do not copy per "What was deliberately not copied".
3. Re-apply every divergence numbered above. Divergences 1-3 are the ones a fresh copy
   silently undoes without breaking a build: `browser/package.json`'s `postinstall`,
   `pnpm-workspace.yaml`'s `onlyBuiltDependencies`, and the root `test` script.
4. `corepack pnpm install`, then confirm `browser/node_modules/electron/dist/electron.exe`
   exists. Divergence 1 is the reason it does; an install that succeeds and produces no
   binary is what its absence looks like.
5. `corepack pnpm --filter pixel-react build:native`, so `native/pixel.node` is newer
   than every input it is built from: `engine/crates`, `engine/Cargo.toml`,
   `engine/Cargo.lock`, `engine/rust-toolchain.toml`, both fonts under
   `engine/assets/fonts/` and `pixel-react`'s `scripts/build-native.mjs`. Both crates
   count, not just `pixel-node/src`: `pixel-node` depends on `pixel-core`, so
   `pixel-core/src` is compiled *into* the artifact. `native-build.test.mjs` refuses a missing *or* stale
   artifact rather than skipping, and a re-vendor makes every source file newer than the
   last build by definition.
6. `corepack pnpm test`. Every failure below names the path and what to do about it, so
   read them as a worklist rather than as a verdict:

   | what it says | what happened |
   |---|---|
   | *…no longer differs from 45b5e43* | a divergence you did not re-apply. The roster printed under "Every path that is supposed to differ" in the same output is the whole re-apply list, one line per path, with its reason |
   | *…was vendored by 45b5e43 and is not in the working tree* | the copy dropped a file. No diff can show this one, which is why it is checked separately |
   | *…is inside a vendored tree and git does not track it* | upstream added a module. Committing it under the old baseline only hides it — it is tracked and still outside the universe — so this one means moving `BASELINE`, per the closing note. If the file is this repo's own, commit it; otherwise name it in `.gitignore`. All three are decisions on the record; leaving it is not |
   | *…differs from 45b5e43 and has no disposition* | a path that differs and is neither subject matter nor a numbered divergence. The message names the three choices |
   | the `pixel-core` inventory drifted, or a new unix-bound module appeared | `inventory.test.mjs`; re-run the disposition pass in [`01-baseline-errors.md`](01-baseline-errors.md) |

7. For anything upstream genuinely changed, edit `tools/vendor-check/dispositions.mjs`
   as well as this file: `SUBJECT` for the port's own work, `INCIDENTAL` for an edit
   that is not, keyed by path. A new incidental divergence needs a numbered entry here
   too — `upstream-doc.test.mjs` parses this document and holds the numbering to
   `DIVERGENCES`, so the two cannot drift apart quietly.
8. `cd engine; cargo nextest run --workspace`, then
   `python tools/vendor-check/fmt-scope.py` and `clippy-scope.py`. Both scope their
   complaints to lines this port wrote by blaming against `45b5e43`, so a re-vendor
   that moves upstream lines around moves what they ignore, automatically.

**If the baseline commit itself is replaced** — a re-vendor committed as a new "vendor
upstream" commit rather than as edits on top of `45b5e43` — then `BASELINE` in
`tools/vendor-check/universe.mjs` moves with it, and every disposition and divergence
whose edit is now *in* that commit stops having a diff to show. That is a rewrite of
the table, not a maintenance edit, and the suite will say so path by path.

It is also a rewrite of the *scope*. `vendoringCommitPaths` asks `git show --name-only`
what the commit introduced, which is a diff against its parent — so once the baseline is
a re-vendor on top of the port, every upstream file byte-identical across it is in the
new tree and absent from the new diff, and would leave the guard's universe silently.
`assertUniverseIsTheWholeSnapshot` fails naming those paths. Re-derive the query against
the snapshot; do not re-baseline the counts until it passes.
