# Review: ralphex-20260826-vendor-check-gap / 20260826-131835

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260826-vendor-check-gap\20260826-131835\input\scope.md`

## Minor

### `ALSO_REL` omits build inputs that decide the contents of `pixel.node`

`tools/vendor-check/native-build.test.mjs:55`

The freshness set contains `engine/crates`, the workspace manifest, and the lockfile, but several inputs that determine the produced binary sit outside every compared path:

- `engine/crates/pixel-node/src/lib.rs:273-275` embeds both fonts from `engine/assets/fonts` via `include_bytes!`. If either font is updated after `pixel.node` was built, `requireBuilt` returns the old artifact and the three native tests run against its old embedded bytes.
- `engine/rust-toolchain.toml` is tracked and pins `channel = "1.93.1"`. `engine/packages/pixel-react/scripts/build-native.mjs:22` runs `cargo build -p pixel-node` with `cwd` = the package dir, so rustup walks up to `engine/` and that file selects the compiler that produces the cdylib. Bump the channel to 1.94 and do not rebuild: nothing under `engine/crates` moved, `engine/Cargo.toml` and `engine/Cargo.lock` did not move, so `requireBuilt` passes and all three tests in "the built napi module" (native-build.test.mjs:118, 136, 151) assert against a binary produced by the previous rustc.

That is precisely the silent stale pass the new `stale-manifest` test at line 239 exists to close, one input over. The whole argument this change is built on — recorded in `tools/lib/built.mjs:46-52`, `docs/plans/20260826-vendor-check-gap.md:246-253` and `docs/design/UPSTREAM.md:368-369` — is that `engine/crates` is not the whole set of build inputs, so inputs that decide what goes into `pixel.node` must be named explicitly. The surrounding comment at lines 46-54 enumerates the reasons a file belongs in this list — dependency versions, feature flags, profile overrides — and neither "which compiler compiled it" nor "which bytes it embedded" is mentioned, so a reader cannot tell whether the omissions were decided or overlooked.

Fix: At minimum add the two `engine/assets/fonts/*.ttf` files and `"engine/rust-toolchain.toml"` to `ALSO_REL` at native-build.test.mjs:55, and extend the comment above it to say why embedded assets and the toolchain pin count. The `fixture` helper already writes every `ALSO_REL` entry generically (lines 182-186, 194-197), so no fixture change is needed. Preferably derive or centrally declare all build inputs outside `engine/crates`, including the native build script. If any omission was deliberate, say so in the comment.

_confidence: 99 | sources: adversarial, arch+quality | lenses: adversarial, architecture, quality | verdict: confirmed_

### `PRE_BASELINE`'s docstring credits `assertUniverseIsTheWholeSnapshot` with a staleness guarantee it does not implement

`tools/vendor-check/universe.mjs:179-180`

The `PRE_BASELINE` docstring ends: "`assertUniverseIsTheWholeSnapshot` holds the list to the real difference, so it can neither rot nor absorb an upstream path someone would rather not disposition." That is not what the function does. `assertUniverseIsTheWholeSnapshot` (lines 225-244) has exactly one loop and one throw, and it walks a single direction: every path in `BASELINE`'s tree must be in the diff *or* under a `PRE_BASELINE` prefix. It never asks whether a declared prefix covers anything, so it cannot detect a prefix that covers nothing (rot), and by construction a broader prefix only makes it *more* permissive, so it cannot detect absorption either.

Concretely: rename `.ralphex/` to `.plans/` and the entry `".ralphex"` covers nothing; `assertUniverseIsTheWholeSnapshot` still passes, and a future `.ralphex/` path would be waived before anyone read it — exactly the hazard `assertExclusionsAreReal` and `assertProjectRootsAreReal` are written to catch for their own lists, and whose doc comments correctly name the function that catches it.

The rot check does exist, but in the test file — `universe.test.mjs:227-240` ("names every declared prefix against something really in the snapshot") — and it is weaker than the docstring claims: it only requires a prefix to cover at least one carried-over path, so widening an already-valid prefix passes. Nothing anywhere checks for absorption.

This matters because the same docstring is the instruction sheet for the one situation the whole mechanism exists for. The throw's own message says "If they really are this repo's own, declare them here with a reason each" — a maintainer on a re-vendor reads that, reads this docstring, and adds a prefix believing production code will reject it if it is too broad or covers nothing. It will not; only the test will, and only for the narrow case. It is a comment defect and executes nothing, so it is minor.

Fix: Reword lines 179-180 to attribute the two halves where they live, e.g.: "`assertUniverseIsTheWholeSnapshot` fails if the snapshot holds a path neither the diff nor this list accounts for. That the list does not *rot* is a separate check, in `universe.test.mjs` — a prefix here that covers nothing the snapshot carried over is a failure there." Alternatively, move the non-emptiness check into `assertUniverseIsTheWholeSnapshot` itself so the sentence becomes true, which also gets it running on every guard invocation rather than only under `node --test`.

_confidence: 95 | sources: bugs+impl, docs+tests | lenses: impl, docs, comments | verdict: confirmed_

### The new excluded-ancestor test credits the clause with a decision it does not make

`tools/vendor-check/universe.test.mjs:313-331`

The comment says the injected case drives "the excluded-ancestor rule ... against a case it can actually decide" and names `engine/generated` as that case: "`engine/generated` holds one path, that path is declared out, and it must therefore not become a tree". Traced through `vendoredDirectories` (universe.mjs:375-398), that is not what the clause decides.

Only vendored files populate `above` (`if (vendored) above.add(at)`); a declared-out file populates `aboveExcluded` alone. With `paths = [engine/crates/pixel-core/src/lib.rs, engine/generated/manifest.json]` and `manifest.json` declared out, `above` = {`engine/crates/pixel-core/src`, `engine/crates/pixel-core`, `engine/crates`, `engine`}. `engine/generated` never enters `above` at all, so it cannot appear in the result whether or not the `!aboveExcluded.has(dir)` clause exists. The directory the clause actually removes here is `engine` — which is in `above` (via `lib.rs`), is not in `holdsVendored`, and is in `aboveExcluded` (via `manifest.json`).

Concretely: delete `!aboveExcluded.has(dir)` from line 396 of universe.mjs and re-run this test. Line 326 still passes, line 328 (`!derived.has("engine/generated")`) still passes, and line 339 still passes. The only assertion that fails is line 331, `!inVendoredTree("engine/generated/new.json", derived)` — and it fails because `engine` survived into `derived`, which the comment never mentions. So the test is load-bearing, but a reader following the comment to diagnose the failure is pointed at the wrong directory and the wrong assertion.

Fix: Reword the comment to name `engine` as the directory the clause decides: `engine/generated` is kept out by failing both rules, while `engine` holds a vendored file only indirectly *and* sits above a declared-out one — so the clause is what stops `engine` becoming a tree, which is what line 331 asserts via the ancestor walk.

_confidence: 85 | sources: docs+tests | lenses: tests, comments | verdict: confirmed_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 1989080 | 1 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 2437954 | 2 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 2622952 | 3 | ok |
| adversarial | codex | gpt-5.6-sol | high | 69561 | 2 | ok |
