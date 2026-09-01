# Close the vendor-check gap

## Overview

`tools/vendor-check/` exists to keep the port honest about what it changed in vendored
upstream code. It does that for `pixel-core/src` and nowhere else.

`docs/design/UPSTREAM.md` tells a re-vendorer two things that are not true:

> What is listed here is everything else, so the claim "the other 43 files are
> untouched" stays checkable.

> Each is asserted by a test in `tools/vendor-check/`, so a re-vendor that drops one
> fails loudly rather than at the Task 10 milestone.

Neither holds outside `engine/crates/pixel-core/src`. `engine/crates/pixel-node/src` and
`engine/packages/pixel-react` are vendored upstream trees with **no baseline check at
all**, and the two `Cargo.toml` files the port edited are unguarded too. An edit there —
or a re-vendor that drops one — passes `pnpm test` in silence.

This plan replaces "the files in this list" with "every path the vendoring commit
introduced", so the guard's scope comes from git rather than from what someone
remembered to write down. That is the whole point: the defect is not that two trees were
forgotten, it is that **a hand-maintained list decided what got checked**, and lists rot.

## Context (from discovery)

Measured on 2026-08-26 against `45b5e43`, the vendoring commit.

| fact | evidence |
|---|---|
| the guard is scoped to one directory | `tools/vendor-check/unchanged.test.mjs:43` — `const SRC = "engine/crates/pixel-core/src"`, diffing the 46 paths in `pixel-core-files.json` and nothing else |
| the inventory check is scoped the same way | `tools/vendor-check/inventory.test.mjs:23` — `PIXEL_CORE_SRC` only |
| `pixel-node` is unguarded | 12 tracked files under `engine/crates/pixel-node/src`, **3 changed**: `capture.rs`, `lib.rs`, `surface.rs` |
| `pixel-react` is unguarded | 23 tracked files under `engine/packages/pixel-react`, **1 changed**: `scripts/build-native.mjs` |
| the manifests are unguarded | `engine/Cargo.toml` and `engine/crates/pixel-core/Cargo.toml` both differ from baseline |
| the vendored universe is larger than the guarded one | `45b5e43` introduced **239 paths**; **48** differ from baseline today, **0** are deleted |
| the divergence list covers six | `UPSTREAM.md` numbers 6 divergences; the other changed paths are either the port's own subject matter or unrecorded |

### The wrinkle that shapes the design

Most of those 48 are supposed to have changed. `cli/src/main.ts`, `browser/src/page/controller.ts`
and `engine/crates/pixel-core/src/terminal.rs` are what the port *is*. The `UPSTREAM.md` list
is explicitly only for "edits to vendored files that are **not** the port's own subject
matter", which is exactly why the existing guard retreated to `pixel-core/src` — the one
tree where a "keep these unchanged" claim was ever made.

So a derived scope cannot simply demand a reason for all 48. It has to distinguish:

- **subject matter** — the port rewrote this on purpose, and a task owns it
- **incidental divergence** — vendored code edited for a reason that is not the port's
  subject, which is what the numbered list in `UPSTREAM.md` is for
- **not vendored** — `45b5e43` also carried project files (`.gitignore`, `package.json`,
  `docs/design/UPSTREAM.md`, `docs/plans/completed/20260821-windows-port.md`). Four of the 48 are
  these. They must be excluded by a declared list, never silently

### A documented divergence that understates itself

Divergence 5 says of `engine/crates/pixel-node/src/lib.rs`:

> It is one line — `WATCH_RESIZE = cfg!(windows)` — and off Windows it is byte-for-byte
> upstream's behaviour

The actual diff is **237 insertions, 5 deletions**: a `SurfaceSink` trait, an
`impl SurfaceSink for Engine`, and the genericisation of `draw_frame` and `draw_pixels`
over it. The one-line claim covers the `WATCH_RESIZE` constant only. This is worse than an
omission — it is a recorded divergence whose recorded scope is wrong, so a re-vendorer
following the checklist restores one line and loses the trait.

## Constraints

- **The scope must come from git, not from a file someone edits.** A manifest may exist
  as a cache or an assertion, but it must not be what decides coverage. If adding a new
  vendored file requires remembering to list it, this plan has failed.
- **Do not make the failure message worse.** The current check names the file and the
  recorded reason. A digest that says "something changed" is a regression.
- **Every one of the 48 gets a disposition.** Subject matter, incidental divergence, or
  explicitly not vendored. None may be silently tolerated.
- **`45b5e43` is load-bearing and already asserted** (`unchanged.test.mjs:100` checks its
  subject matches `/vendor upstream/i`). Keep that.
- Regular testing (code first, then tests), same as the two prior plans.

## Development Approach

- Complete each task fully before the next.
- **CRITICAL: every task MUST include new/updated tests**, as separate checklist items.
- **CRITICAL: all tests pass before the next task starts.**
- `python tools/vendor-check/fmt-scope.py`, `python tools/vendor-check/clippy-scope.py`
  and `node --test` are part of that. Note `cargo fmt --all --check` fails on this tree
  by design — the scoped scripts are the real gate.
- Update this plan when scope changes.

## Implementation Steps

### Task 1: Derive the vendored universe from the vendoring commit

- [x] add a module in `tools/vendor-check/` that returns every path `45b5e43` introduced,
      read from git rather than from a checked-in list
- [x] give it a declared exclusion list for the project files that commit also carried —
      currently `.gitignore`, `package.json`, `docs/design/UPSTREAM.md`,
      `docs/plans/completed/20260821-windows-port.md` — with a one-line reason each, so an exclusion
      is a decision on the record rather than an absence
- [x] make an unknown path fail rather than default into any category
- [x] have it report deletions as well as edits: a re-vendor that drops a file entirely is
      the failure this whole directory exists to catch, and today nothing detects it
- [x] write tests for the universe matching the commit (count and membership)
- [x] write tests for an excluded path being excluded, and for an undeclared one failing
- [x] run tests — must pass before Task 2

### Task 2: Classify all 48 changed paths

- [x] build the disposition table: every changed vendored path is **subject matter** (with
      the task that owns it), **incidental divergence** (with its `UPSTREAM.md` number), or
      **excluded** (with its reason)
- [x] key it by path, so a file moving does not silently lose its entry
- [x] verify the six existing divergences still describe real edits
- [x] make an unclassified changed path a test failure naming the path and the three
      choices, so the next person is told what to do rather than only what went wrong
- [x] write tests that every changed path has exactly one disposition
- [x] write tests that a disposition for a path that no longer differs also fails — a stale
      entry is how the table starts lying
- [x] run tests — must pass before Task 3

**Found while doing it.** The 48 split 35 subject-matter / 9 incidental / 4 excluded, in
`tools/vendor-check/dispositions.mjs`. Two things the discovery pass did not have:

- **Divergences 1, 2 and 3 have no diff against the baseline, because the vendoring
  commit applied them itself** — the port needed `pnpm install` to work before it could
  write a line. `browser/package.json`, `pnpm-workspace.yaml` and the root `package.json`
  therefore never appear in the survey, and *no check has ever covered them*: a re-vendor
  that dropped the `postinstall` replacement leaves every diff-based check green while
  producing no Electron binary. They are checked by content instead
  (`divergenceEvidenceHolds`), which is the only honest question to ask of an edit that
  is the baseline.
- **Six incidental divergences have no `UPSTREAM.md` number yet** — the five Task 4 names
  plus `engine/Cargo.lock`, which is cargo's regeneration of the two manifest edits. The
  gap is pinned by `UNRECORDED_BUDGET = 6` so it cannot grow while it waits; Task 4 takes
  it to 0.

### Task 3: Rewrite `unchanged.test.mjs` onto the derived scope

- [x] replace the `SRC` + `pixel-core-files.json` scoping with the derived universe
- [x] keep the existing named-reason output: the message must still name the file and say
      why it was expected to differ
- [x] keep `pixel-core-files.json` as the inventory assertion it already is, but stop it
      deciding what gets checked
- [x] keep the assertion that `45b5e43` is the vendoring commit
- [x] confirm the three `pixel-node` files, the one `pixel-react` file and the two
      `Cargo.toml` files are now covered
- [x] write tests for a simulated undeclared edit to `pixel-node/src/surface.rs` failing
- [x] write tests for a simulated edit under `pixel-react` failing
- [x] write tests for a simulated deletion failing
- [x] run tests — must pass before Task 4

**Found while doing it.** The named-reason output is now `guardVerdict` in
`dispositions.mjs` — pure, so the three simulated failures are driven by a fabricated
survey rather than by a test writing to `pixel-node/src` while the rest of the suite
reads it. Two notes on what that cost and bought:

- **Simulating an undeclared `surface.rs` needs the row withheld, not the file edited.**
  `surface.rs` is dispositioned *today* precisely because this check now demands it, so
  asking "would the guard have caught it?" means asking the question with the row
  missing. `auditDispositions` and `guardVerdict` take an injectable `dispositionCount`
  for that one reason.
- **`pixel-react` is 23 vendored paths, not 35.** The discovery table said 23 and was
  right; a first pass here counted the `pixel-node` and `pixel-react` greps together.
  Both counts are now pinned in the test (12 and 23), so the scope silently shrinking
  is a failure rather than an observation nobody makes.

### Task 4: Correct UPSTREAM.md

- [x] rewrite divergence 5 to describe what `pixel-node/src/lib.rs` actually contains —
      the `SurfaceSink` trait, the `impl` for `Engine`, the genericisation of `draw_frame`
      and `draw_pixels`, **and** the `WATCH_RESIZE` constant — not "one line"
- [x] add entries for the incidental divergences that have none: `pixel-node/src/capture.rs`
      (the `read_exact_at` shim replacing `std::os::unix::fs::FileExt`),
      `pixel-node/src/surface.rs` (the `cfg_attr(windows, allow(irrefutable_let_patterns))`),
      `pixel-react/scripts/build-native.mjs` (rewritten, including the `win32` branch of
      `libraryName`), both `Cargo.toml` files, and `engine/Cargo.lock` (cargo's
      regeneration of those two, found in Task 2) — six in all, which is
      `UNRECORDED_BUDGET`; take it to 0
- [x] make the exhaustiveness claim true, or narrow it to what is actually checked — do not
      leave a sentence that promises more than the guard delivers
- [x] state which trees are guarded and how the scope is derived, so the next reader knows
      the list is not the boundary
- [x] write tests that every numbered divergence names a path that really differs
- [x] write tests that every incidental divergence in the table has a numbered entry
- [x] run tests — must pass before Task 5

**Found while doing it.** `UNRECORDED_BUDGET` is 0: the six unnumbered incidental
divergences are now 7-12 in `UPSTREAM.md`, and `upstream-doc.test.mjs` parses the
document and holds it to `DIVERGENCES` — same paths, same numbers, contiguous, each
describing an edit that is really in the tree. Three things worth recording:

- **The document is now checked, not just written.** Nothing in `tools/` had ever read
  `UPSTREAM.md` before this task; the numbering was a convention two files agreed on by
  hand. A renumber or a deleted entry now fails, which matters because `INCIDENTAL`
  cites those numbers and a re-vendorer works down them.
- **Divergence 3 is about an *excluded* path** (`package.json`), so "every numbered
  divergence names a vendored path" had to be asked against the vendoring commit's whole
  path set rather than against `vendoredUniverse()`. Exclusion decides whether a path
  needs its *diff* explained, not whether it can carry a re-vendor instruction.
- **A latent bug fell out of it.** `guardVerdict` built its roster with
  `.map(describeDisposition)`; giving that function an injectable second argument meant
  `map` passed it the array index, and every line came out `— not vendored: undefined`.
  Plausible prose, wrong about all 44 paths, and the guard's message is its whole
  product. `describeDisposition` now refuses a verdict that is not one.

### Task 5: Make the napi artifact check refuse to skip

`tools/vendor-check/native-build.test.mjs:74` degrades to a skip when
`engine/packages/pixel-react/native/pixel.node` is absent, and never checks staleness when
it is present. `tools/lib/built.mjs` exists to make both loud and says why: "a stale
`dist/` is worse, because everything passes — against yesterday's source." Three call
sites use it; this file is the outlier, and it guards the artifact this directory exists
to protect.

- [x] route the artifact check through `requireBuilt` against `engine/crates` — both
      crates, since `pixel-node` depends on `pixel-core` and so `pixel-core/src` is
      compiled into the artifact — plus `engine/Cargo.toml` and `engine/Cargo.lock`, so a
      missing or stale `pixel.node` fails with the build command instead of skipping
- [x] check the three degraded tests then run rather than skip
- [x] write a test that a stale artifact fails
- [x] write a test that a missing artifact fails with the build command in the message
- [x] run tests — must pass before Task 6

**Found while doing it.** The file no longer contains a `skip`, and `node --test`
reports 18 passed / 0 skipped where it reported 11 / 3. Both failures were then driven
against the real tree rather than only against fixtures: moving `pixel.node` aside exits
1 with *"...is missing — this suite tests the built package. Run: corepack pnpm --filter
pixel-react build:native"*, and `touch`ing `pixel-node/src/lib.rs` exits 1 with *"...is
older than engine/crates — this suite would pass against the previous build"*. Three
things worth recording:

- **The obvious fix was itself a silent pass.** Calling `requireBuilt` once in the
  `describe` body — which is how the other three call sites do it, at module scope —
  prints `not ok 3 - the built napi module` with the right message and then exits **0**:
  node 22.19.0 counts a throw from a suite callback as neither pass nor fail. `pnpm test`
  would have stayed green while printing its own failure. The check therefore lives
  inside each test, where a throw is a failure the exit code knows about. Anything that
  moves it back up a level re-introduces the bug this task was closing.
- **`requireBuilt`'s source-root guard is now exercised.** `newestUnder` answers 0 for a
  directory it cannot read, which would make every staleness comparison pass; a renamed
  `pixel-node/src` is exactly how this check would go quiet again, so the fixture that
  deletes the source tree asserts the refusal names the path.
- **A source root is not the whole set of build inputs.** `engine/Cargo.toml` carries the
  `windows-sys` feature list, the workspace lints and the `opt-level = 2` overrides for
  both crates, and `engine/Cargo.lock` carries what they resolve to — neither is under
  `engine/crates`, so a `cargo update`, a feature flag or a profile edit left all three
  tests passing against the previous binary. Widening the root to `engine` is not the fix:
  `engine/target` is a sibling of `crates`, so the walk would find the build output, whose
  mtimes are always newest, and every run would report stale. `requireBuilt` takes an
  optional list of extra inputs instead, and reports *which* one is newer so the reader is
  not sent to the tree the edit was not in. Review then found the same argument reached
  three inputs further than the list did: `engine/rust-toolchain.toml` picks the compiler
  (cargo runs with `cwd` inside `pixel-react`, so rustup walks up to `engine/` for it),
  both fonts under `engine/assets/fonts/` are `include_bytes!`d into the cdylib, and
  `build-native.mjs` decides which profile is copied. All four are now compared, and
  because a hand-written list is exactly what goes quiet, the embedded-asset half is
  derived from the crate sources by a test rather than restated.

### Task 6: Verify acceptance criteria

- [x] edit a `pixel-node` source file by hand and confirm `node --test` fails naming it
- [x] edit a `pixel-react` file by hand and confirm the same
- [x] delete a vendored file by hand and confirm the failure says it was deleted
- [x] add an untracked file under a vendored tree and confirm it is reported, not ignored
- [x] revert all of the above and confirm the suite is green again
- [x] confirm the failure message for each names the path and what to do about it
- [x] run the full suite: `node --test "tools/*/*.test.mjs"`, `cargo nextest run --workspace`
- [x] run `python tools/vendor-check/fmt-scope.py` and `clippy-scope.py` — 0 on port lines

**Found while doing it.** Three of the four hand-made failures were already caught, by
name, with the fix in the message. The fourth was not caught at all, so this task wrote
code rather than only confirming it.

- **An untracked file in a vendored tree passed silently.** `?? pixel-node/src/intruder.rs`
  and `?? pixel-react/src/intruder.ts` together left `node --test` at 472/472. The reason
  is structural, not an oversight: every check in this directory asks a question about a
  path `45b5e43` introduced, and an untracked file is by construction not one of those —
  `changed` and `deleted` both scope through `vendoredUniverse()`, and nothing diffs a
  path git has never heard of. A re-vendor that drops in a new upstream module looks
  exactly like this. The survey now carries a third field from
  `untrackedInVendoredTrees()`, and `guardVerdict` reports it as its own finding rather
  than folding it into stale-or-deleted, which would send the reader to the wrong fix.
- **The scope for it had to be derived too, and the repo root is the trap.** `.` holds
  `package.json`, `.gitignore` and `pnpm-workspace.yaml`, so it qualifies as a vendored
  directory under the same rule every other directory does — and since every path
  descends from the root, including it would make the check a repo-wide nag on any
  scratch file. `vendoredDirectories()` therefore drops the root, and `inVendoredTree`
  walks *ancestors* rather than testing the immediate directory, so a re-vendor that adds
  `pixel-node/src/backends/` is still inside the tree. Both halves are pinned by test.
- **`.gitignore` is the escape hatch, and it already works.** `--exclude-standard` means
  `engine/packages/pixel-react/native/pixel.node` — gitignored at `.gitignore:28` — does
  not trip the new check. So the failure has two answers, commit it or ignore it, and
  both are decisions on the record. A guard whose only answer is "stop working" gets
  silenced, which is the failure mode this whole plan is about.
- **`pixel-core/src` was already covered and the other two trees were not.** An untracked
  file there fails `inventory.test.mjs` four ways, because that suite reads the directory
  instead of the commit. That is the same asymmetry this plan started from, surviving in
  a second file.
- **One incidental confirmation of Task 5.** `git checkout -- shm.rs` during the deletion
  experiment gave the file a fresh mtime, and `requireBuilt` immediately called
  `pixel.node` stale — against the real tree, not a fixture. Content was identical; the
  check is mtime-based and said so. Rebuilt with `corepack pnpm --filter pixel-react
  build:native`.

Final gate: `node --test` 480 passed / 0 failed / 0 skipped, `cargo nextest run
--workspace` 467 passed / 1 skipped, `fmt-scope.py` 297 complaints and 0 on port lines,
`clippy-scope.py` 12 warnings and 0 on port lines.

### Task 7: [Final] Update documentation

- [x] document the re-vendoring checklist against the new guard in `UPSTREAM.md`
- [x] note in the Tests section of `README.md` what the vendor-check suite now covers
- [x] record in `docs/design/07-as-built.md` that the guard covered one of three vendored
      trees from the port until this plan, and that `UPSTREAM.md` claimed otherwise — the
      gap is part of the record, the same way the missing revmux review was

**Found while doing it.** The checklist was the last place the old scope survived: step 5
still said the suite "fails if the `pixel-core` inventory drifted or a new unix-bound
module appeared", which was the whole of what it did and is now the smallest part. It is
eight steps against the derived guard, and the failure table quotes the message builders
in `dispositions.mjs` verbatim so a re-vendorer can match what the suite printed against a
row. Three things worth recording:

- **The quotes are checked against the real messages.** A table row nobody can match is
  worse than no row, because it is only ever read while something is already broken.
  `upstream-doc.test.mjs` pulls every `*…quoted*` fragment out of the section and requires
  it in the output of `deletedMessage`, `unclassifiedMessage`, `untrackedMessage` or
  `staleMessage`; a fabricated row fails by name, which is what a mutation of that row
  confirmed.
- **The prose counts are derived too.** Both this document and `README.md` state the size
  of the vendored universe — 239 paths, 235 after exclusions — and those are exactly the
  numbers that stay written while the tree moves underneath them. They are now asserted
  against `vendoringCommitPaths()` and `vendoredUniverse()`, so the next vendoring commit
  makes a stale coverage claim fail rather than merely be wrong.
- **Two new steps exist because of what earlier tasks changed.** Step 5 tells the reader
  to build `native/pixel.node` before running the suite, since Task 5 made a stale
  artifact a failure and a re-vendor makes every source file newer than the last build by
  definition. And the closing note says what happens if the *baseline commit itself* is
  replaced: `BASELINE` moves, and every disposition whose edit is now inside that commit
  stops having a diff to show. That is a rewrite of the table, and it is better said here
  than discovered.

## Technical Details

**Deriving the universe.** `git show --name-only --format= 45b5e43` is the source of
truth: 239 paths. `git diff --quiet 45b5e43 HEAD -- <path>` per path gives the changed
set; a missing working-tree path is a deletion. Both are cheap enough to run per test —
the whole sweep takes well under a second — so there is no reason to cache it into a file
that can go stale.

**That query is a diff, not an inventory, and the difference is load-bearing.** `45b5e43`
is not a root commit — its parent `0b526fe` already carried 54 paths — so `--name-only`
answers what the commit *introduced*, and its tree holds 291 paths against the 239 it
reports. The gap is benign today only because every one of those 52 is this repo's own
harness (`.ralphex/`, `.revmux/`, `README.md`, the port brief and the revmux shims), which
`PRE_BASELINE` in `universe.mjs` now declares with a reason each. It stops being benign the
moment `BASELINE` moves to a re-vendor commit: every upstream file byte-identical across
that re-vendor would be in the new tree, absent from the new diff, and so out of the
guard's scope — with no count moving to say so, since the pinned 239 would simply be
re-baselined to whatever the new diff reported. `assertUniverseIsTheWholeSnapshot` holds
the diff to `git ls-tree` and fails naming the paths that fell out. Reading the snapshot
directly is not the simpler alternative it looks: it would pull `.revmux/` and `README.md`
into the universe and demand a divergence reason for the review harness this port is run
with.

**Why not a manifest per tree.** It was the first option considered and rejected: adding
`pixel-node-files.json` and `pixel-react-files.json` would be symmetric and quick, but it
reproduces the design that failed. The scope would still be whatever someone remembered to
list, and a newly vendored file would still be invisible.

**Why not a digest.** `tools/vendor-check/digest.py` already exists and hashing the trees
would be the least code. But the failure would say "something changed" with no path and no
reason, which is a worse signal than the current check gives for `pixel-core`.

## Post-Completion

**Manual verification**: do a dry re-vendor — check out upstream at the pinned revision
into a scratch directory, apply the divergence list by hand, and confirm the guard goes
green. That is the scenario every claim in `UPSTREAM.md` is about, and it has never been
run.

**Process**: this gap and the missing revmux review share a shape — a check that was
believed to be running, was not, and whose absence looked exactly like success. Worth
asking what else in this repo is trusted because it has never failed.
