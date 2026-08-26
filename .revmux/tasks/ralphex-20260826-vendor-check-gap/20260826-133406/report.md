# Review: ralphex-20260826-vendor-check-gap / 20260826-133406

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260826-vendor-check-gap\20260826-133406\input\scope.md`

## Minor

### The embedded-asset matcher silently ignores valid non-plain Rust literals

`tools/vendor-check/native-build.test.mjs:326`

The derivation only recognizes `include_bytes!("...")` and `include_str!("...")`. Valid forms such as `include_bytes!(r"../../../assets/new.bin")` or a path constructed with `concat!` are ignored. After such an include is added and the binary rebuilt once, a later edit to the external asset does not move anything under `SOURCE_REL`, the asset need not be in `ALSO_REL`, and both this coverage test and `requireBuilt` pass against the old embedded bytes. That contradicts the adjacent promise that a newly added include cannot silently fall out of the freshness set.

Fix: Parse include macro arguments robustly, or at least fail on any `include_bytes!`/`include_str!` invocation whose path the test cannot resolve instead of silently skipping it.

_confidence: 90 | sources: adversarial | lenses: adversarial | verdict: confirmed_

### Plan records `native-build.test.mjs` at 17 tests where the file has 18 and the acceptance doc says 18

`docs/plans/20260826-vendor-check-gap.md:228`

This same diff bumps the plan's Task 5 note from "reports 14 passed / 0 skipped" to "reports 17 passed / 0 skipped", but it also adds a further test to `native-build.test.mjs` ("compares against every asset the crates compile into the artifact", line 312). The file now holds 18 `it(` blocks, and `docs/design/06-acceptance.md` was updated in the same diff to say 18 twice (the per-file table row at line 288 and "that 18 because they no longer skip" at line 296), with the node column there summing to the 510 that README.md and the acceptance table both now claim.

So the change ships two documents disagreeing about the same number: the plan says 17, the acceptance record says 18, and 18 is the true count. The plan is the single outlier, and it is the file treated as the contract for what the task was supposed to do. The paragraph incorporates the subsequent review fixes, so the stale count understates the final result rather than documenting an earlier frozen state.

Failure case: a maintainer re-running Task 5's verification reads the plan, sees 17, gets 18, and has to work out which of two documents in the same commit is lying about the file's own test count — in a plan whose entire subject is checks that go quiet because a hand-written number stopped being re-derived.

Fix: Change "reports 17 passed / 0 skipped" to "reports 18 passed / 0 skipped" at docs/plans/20260826-vendor-check-gap.md:228, matching `06-acceptance.md`.

_confidence: 99 | sources: adversarial, bugs+impl, docs+tests | lenses: adversarial, impl, docs | verdict: confirmed_

## Immaterial

### `ALSO_REL` stops below the manifest that dispatches the build command

`tools/vendor-check/native-build.test.mjs:69-76`

The recorded repair command is `corepack pnpm --filter pixel-react build:native`, whose implementation is selected by `engine/packages/pixel-react/package.json` (`scripts.build:native`), but the freshness set tracks only the currently selected `build-native.mjs`. If that package script is changed to invoke another builder or profile while the existing `pixel.node` remains newer than the listed inputs, `requireBuilt` passes and these tests load the old artifact even though the prescribed build now produces something different. This requires an unusual but supported build-script change, so the impact is contained, but it leaves the same stale-artifact gap the new list is intended to close.

Fix: Add `engine/packages/pixel-react/package.json` to `ALSO_REL` so changes to the command dispatcher require rebuilding the artifact.

_confidence: 88 | sources: adversarial | lenses: adversarial | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 2992743 | 2 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 3086583 | 0 | ok, nothing raised |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 2196547 | 3 | ok |
| adversarial | codex | gpt-5.6-sol | high | 100849 | 3 | ok |
