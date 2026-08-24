# Review: ralphex-20260822-post-port-corrections / 20260824-213636

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260822-post-port-corrections\20260824-213636\input\scope.md`

No findings.

## Pre-existing

### Age-based sweeping removes ownership evidence from live idle publishers

`engine/crates/pixel-core/src/frame_file.rs:393`

The change under review touches only the comments describing this behaviour, not the sweeping logic itself. If browser A publishes a frame and remains static for an hour, starting browser B calls `sweep_stale` and can remove A's directory even though A is alive. If A is then force-terminated before another repaint, its placement remains displayed but `pane-clear` has neither frames nor a pane marker with which to attribute and clear it. `write_frame` and `remark` only repair the directory on a later repaint, so they do not cover this window. The trigger requires an hour-idle publisher, another publisher starting, and termination before repaint, keeping the impact minor.

Fix: Sweep using a renewable liveness lease or heartbeat rather than the timestamp of the last frame.

_confidence: 94 | sources: adversarial | lenses: adversarial_

## Immaterial

### Unicode lowercasing admits allow-list entries the Rust guard rejects

`cli/src/pane.ts:199`

With `AGWINTERM_PIPE=agwinterm-kiosk` and an allow-list spelling `AGWINTERM-KIOSK` with its first `K` replaced by U+212A KELVIN SIGN, both TypeScript guards lowercase the entry to the ASCII pipe name and permit launch. The debug engine then compares the same entry using ASCII-only `eq_ignore_ascii_case` at `agwinterm.rs:349` and refuses it. The launch therefore passes CLI preflight but fails when the engine tries to draw. The new comments explicitly confirm this mismatch, but documenting it does not satisfy the plan's same-guard contract. This is introduced by the changed TypeScript comparison; it affects only unusual non-ASCII configuration and debug builds, so the impact is minor.

Fix: Make both TypeScript copies use ASCII-only comparison, for example by requiring non-wildcard entries to match `PIPE_NAME` before lowercasing them.

_confidence: 94 | sources: adversarial | lenses: adversarial | verdict: immaterial_

### `Pick` does not reject `pane` on a pre-typed options value

`cli/src/pane.ts:725`

The narrowed parameter rejects `pane` only during excess-property checking of a fresh object literal. A caller can still declare `const options: OwnedFramesOptions = { root, pane: "any" }` and pass `options` to `clearOwnedPaneFrame`; TypeScript's structural assignability accepts the wider value. The function then overwrites that `pane` in both branches at lines 739-745, leaving the caller with the same silent no-op the new comment says is now a type error. The ignored runtime option is pre-existing; this change only partially mitigates it.

Fix: Add `pane?: never` to the accepted parameter type so values typed as `OwnedFramesOptions` are rejected when they can contain `pane`.

_confidence: 88 | sources: adversarial | lenses: adversarial | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 1883019 | 0 | ok, nothing raised |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 1549632 | 0 | ok, nothing raised |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 2159169 | 2 | ok |
| adversarial | codex | gpt-5.6-sol | high | 61160 | 3 | ok |
