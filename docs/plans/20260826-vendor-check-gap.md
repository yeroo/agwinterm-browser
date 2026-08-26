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
  `docs/design/UPSTREAM.md`, `docs/plans/20260821-windows-port.md`). Four of the 48 are
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
      `docs/plans/20260821-windows-port.md` — with a one-line reason each, so an exclusion
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

- [ ] replace the `SRC` + `pixel-core-files.json` scoping with the derived universe
- [ ] keep the existing named-reason output: the message must still name the file and say
      why it was expected to differ
- [ ] keep `pixel-core-files.json` as the inventory assertion it already is, but stop it
      deciding what gets checked
- [ ] keep the assertion that `45b5e43` is the vendoring commit
- [ ] confirm the three `pixel-node` files, the one `pixel-react` file and the two
      `Cargo.toml` files are now covered
- [ ] write tests for a simulated undeclared edit to `pixel-node/src/surface.rs` failing
- [ ] write tests for a simulated edit under `pixel-react` failing
- [ ] write tests for a simulated deletion failing
- [ ] run tests — must pass before Task 4

### Task 4: Correct UPSTREAM.md

- [ ] rewrite divergence 5 to describe what `pixel-node/src/lib.rs` actually contains —
      the `SurfaceSink` trait, the `impl` for `Engine`, the genericisation of `draw_frame`
      and `draw_pixels`, **and** the `WATCH_RESIZE` constant — not "one line"
- [ ] add entries for the incidental divergences that have none: `pixel-node/src/capture.rs`
      (the `read_exact_at` shim replacing `std::os::unix::fs::FileExt`),
      `pixel-node/src/surface.rs` (the `cfg_attr(windows, allow(irrefutable_let_patterns))`),
      `pixel-react/scripts/build-native.mjs` (rewritten, including the `win32` branch of
      `libraryName`), both `Cargo.toml` files, and `engine/Cargo.lock` (cargo's
      regeneration of those two, found in Task 2) — six in all, which is
      `UNRECORDED_BUDGET`; take it to 0
- [ ] make the exhaustiveness claim true, or narrow it to what is actually checked — do not
      leave a sentence that promises more than the guard delivers
- [ ] state which trees are guarded and how the scope is derived, so the next reader knows
      the list is not the boundary
- [ ] write tests that every numbered divergence names a path that really differs
- [ ] write tests that every incidental divergence in the table has a numbered entry
- [ ] run tests — must pass before Task 5

### Task 5: Make the napi artifact check refuse to skip

`tools/vendor-check/native-build.test.mjs:74` degrades to a skip when
`engine/packages/pixel-react/native/pixel.node` is absent, and never checks staleness when
it is present. `tools/lib/built.mjs` exists to make both loud and says why: "a stale
`dist/` is worse, because everything passes — against yesterday's source." Three call
sites use it; this file is the outlier, and it guards the artifact this directory exists
to protect.

- [ ] route the artifact check through `requireBuilt` against `engine/crates/pixel-node/src`
      so a missing or stale `pixel.node` fails with the build command instead of skipping
- [ ] check the three degraded tests then run rather than skip
- [ ] write a test that a stale artifact fails
- [ ] write a test that a missing artifact fails with the build command in the message
- [ ] run tests — must pass before Task 6

### Task 6: Verify acceptance criteria

- [ ] edit a `pixel-node` source file by hand and confirm `node --test` fails naming it
- [ ] edit a `pixel-react` file by hand and confirm the same
- [ ] delete a vendored file by hand and confirm the failure says it was deleted
- [ ] add an untracked file under a vendored tree and confirm it is reported, not ignored
- [ ] revert all of the above and confirm the suite is green again
- [ ] confirm the failure message for each names the path and what to do about it
- [ ] run the full suite: `node --test "tools/*/*.test.mjs"`, `cargo nextest run --workspace`
- [ ] run `python tools/vendor-check/fmt-scope.py` and `clippy-scope.py` — 0 on port lines

### Task 7: [Final] Update documentation

- [ ] document the re-vendoring checklist against the new guard in `UPSTREAM.md`
- [ ] note in the Tests section of `README.md` what the vendor-check suite now covers
- [ ] record in `docs/design/07-as-built.md` that the guard covered one of three vendored
      trees from the port until this plan, and that `UPSTREAM.md` claimed otherwise — the
      gap is part of the record, the same way the missing revmux review was

## Technical Details

**Deriving the universe.** `git show --name-only --format= 45b5e43` is the source of
truth: 239 paths. `git diff --quiet 45b5e43 HEAD -- <path>` per path gives the changed
set; a missing working-tree path is a deletion. Both are cheap enough to run per test —
the whole sweep takes well under a second — so there is no reason to cache it into a file
that can go stale.

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
