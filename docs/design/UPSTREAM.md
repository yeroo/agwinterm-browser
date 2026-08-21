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

These are the only edits to vendored files so far. Each is asserted by a test in
`tools/vendor-check/install.test.mjs`, so a re-vendor that drops one fails loudly
rather than at the Task 10 milestone.

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

## Re-vendoring checklist

1. Refresh `.reference/terminal-browser/`, re-run `digest.py`, update this file.
2. Copy per "What was copied"; do not copy per "What was deliberately not copied".
3. Re-apply the three divergences above.
4. `pnpm install` and confirm `browser/node_modules/electron/dist/electron.exe`.
5. `pnpm test` — the vendor-check suite fails if the `pixel-core` inventory drifted
   or a new unix-bound module appeared.
6. Re-run the disposition pass in `docs/design/01-baseline-errors.md` if the
   inventory test reports additions.
