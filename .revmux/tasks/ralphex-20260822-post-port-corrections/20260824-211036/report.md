# Review: ralphex-20260822-post-port-corrections / 20260824-211036

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260822-post-port-corrections\20260824-211036\input\scope.md`

## Minor

### The fold-equivalence comment covers the pipe name but not the list entry, which is unvalidated and does diverge

`cli/src/pane.ts:178-180`

The new doc comment on `pipeAllowed` justifies the case-fold with: "Both readers restrict a pipe name to ASCII (`PIPE_NAME`, `valid_pipe_name`), so `toLowerCase` and Rust's `eq_ignore_ascii_case` agree on every input that gets this far."

The first clause is true of `pipe`, which is validated before the guard runs on all three paths (`pane.ts:223` and `unsupported.ts:170-171` gate on `PIPE_NAME`; `agwinterm.rs:202` gates on `valid_pipe_name` before `pipe_refusal`). But the fold has two operands, and only one of them is that pipe. The *list entries* come straight out of `TERMINAL_BROWSER_ALLOW_PIPE` and are never validated — `pane.ts:184-187`, `unsupported.ts:178-181` and `allows_pipe` (`agwinterm.rs:339-342`) only split, trim and drop empties.

The two copies genuinely disagree there. JS `toLowerCase` is a full Unicode fold; Rust `eq_ignore_ascii_case` is ASCII-only and requires equal byte length. With a pipe of `agwinterm-kiosk` and `TERMINAL_BROWSER_ALLOW_PIPE=AGWINTERM-KIOSK` where the K is U+212A KELVIN SIGN, one reviewer confirmed under node that `entry.toLowerCase() === pipe.toLowerCase()` is `true`, while the entry is 17 bytes against the pipe's 15, so `eq_ignore_ascii_case` cannot match. The CLI's two copies allow; the engine's copy refuses.

Both sources report the comment rather than the behaviour, and are plain that reaching the divergence needs a non-ASCII homoglyph typed into the allow-list. In a debug build the engine still refuses, so the guard fails closed and the developer just gets a confusing second refusal after the CLI let them through. What the comment gets wrong is the scope of its own guarantee, in a file whose stated contract is that the three copies match "character for character" — and it is exactly the sentence that would stop a later reader from noticing. The sibling comment at `agwinterm.rs:335-336` makes the same claim ("[`valid_pipe_name`] restricts a name to ASCII, so `eq_ignore_ascii_case` is the whole of it — and is what the CLI's two copies spell `toLowerCase`") and is wrong in the same way.

Fix: Scope the claim to the operand it is true of, e.g. "the *pipe* is ASCII by `PIPE_NAME`/`valid_pipe_name`, so the two folds agree on it; a list entry is not validated, and a non-ASCII entry that Unicode-folds to ASCII would match here but not in `allows_pipe`." Apply the same qualification to `agwinterm.rs:335`.

_confidence: 95 | sources: arch+quality, docs+tests | lenses: architecture, quality, comments, docs | verdict: confirmed_

### New acceptance paragraph puts `sameMark` "forty lines away" from the guard; it is 379

`docs/design/06-acceptance.md:357`

The seventh-round paragraph added to §6 says the allow-list "matched its entry exactly while `sameMark`, forty lines away in the same module, folded the case of the same identifier and said why".

In `cli/src/pane.ts`, `pipeAllowed` is declared at line 182 and `sameMark` at line 561 — 379 lines apart, at opposite ends of the module. "Forty lines away" is off by roughly an order of magnitude, and the number is doing the rhetorical work in the sentence: the point is that the contradiction was sitting in plain sight next to itself, which is a much weaker claim at 379 lines than at 40. The "in the same module" half is correct; only the distance is wrong.

Failure case: a reader takes the paragraph at face value, opens `pane.ts` at `pipeAllowed` and looks forty lines in either direction, finds `pipeRefusal` and `paneAddress` rather than `sameMark`, and concludes the doc is describing a file that no longer exists. Human-facing design prose, so nothing executes differently. Introduced by this change — the whole paragraph is new.

Fix: Drop the number or replace it with something true — e.g. "while `sameMark`, at the other end of the same module, folded the case of the same identifier".

_confidence: 99 | sources: bugs+impl, docs+tests | lenses: impl, docs | verdict: confirmed_

### Test comment claims the assertion below it pins `*`; the assertion contains no `*`

`tools/cli/pane-clear.test.mjs:207-208`

The new `it("compares the pipe the way the object manager resolves it")` ends with:

```js
// Folding a name is not folding the escape hatch: `*` stays a literal.
assert.equal(pane.pipeAllowed("agwinterm-dev", "agwinterm-prod"), false);
```

The assertion passes a list of `"agwinterm-dev"` and a pipe of `"agwinterm-prod"`. No `*` appears on either side, so nothing about the escape hatch is exercised — what is actually asserted is that a differently-named instance is still refused after the fold, which is a different (and worthwhile) claim. Concretely: delete the `entry === "*"` arm from `pipeAllowed` (pane.ts:190) and this line still passes, despite its comment saying it is what guards that arm.

The Rust twin added by the same change gets this right — `agwinterm.rs:1714` says "Folding a name is not folding anything else: a different name is still one", which is what the assertion beneath it checks. The JS comment reads like that sentence mid-edit, with the wildcard clause left attached to the wrong assertion.

Failure case: a maintainer reading line 207 believes the `*` escape hatch is pinned in this suite and does not add coverage for it. It is in fact covered, but at `pane-clear.test.mjs:192` (the `"*"` entry in the list loop) and in `unsupported.test.mjs:255-263` — so a change breaking the `entry === "*"` branch would fail a different test than the one this comment points at. No coverage is lost today; the defect is a mislabel, in a suite whose whole convention is that each comment says exactly what its assertion pins.

Fix: Replace line 207 with what line 208 checks, matching the Rust twin at agwinterm.rs:1714 — e.g. `// Folding a name is not folding anything else: a different name is still one.` — or keep the `*` claim and add `assert.equal(pane.pipeAllowed("*", "Agwinterm-Dev"), true);` beneath it.

_confidence: 99 | sources: bugs+impl, arch+quality, docs+tests | lenses: impl, quality, comments, tests | verdict: confirmed_

## Pre-existing

### Stale sweeping deletes live directories based only on frame activity

`engine/crates/pixel-core/src/frame_file.rs:393`

The reporting source states this is pre-existing and that the current diff only corrects the comments describing it — the sweeping behaviour itself is untouched by the change under review.

Browser A can publish a frame, remain static for over an hour, and then have its directory removed when Browser B starts and calls `sweep_stale`. If A and its foreground CLI are forcibly terminated before A paints another frame, `pane-clear` finds no directory or pane marker and refuses to clear A's still-displayed placement. The recreate-and-remark mitigation only runs on A's next frame, so it does not cover this force-kill window. The trigger requires an idle browser, a second publisher, and termination before the next repaint, keeping the impact minor.

Fix: Track liveness with a separate renewable lease or heartbeat and sweep only directories whose lease has expired, rather than treating the last frame timestamp as liveness.

_confidence: 93 | sources: adversarial | lenses: adversarial_

## Immaterial

### Unicode folding makes the TypeScript guards accept allow-list entries the Rust guard rejects

`cli/src/pane.ts:190`

The two TypeScript copies use Unicode `toLowerCase()`, while Rust uses ASCII-only `eq_ignore_ascii_case`. Only the resolved pipe is validated as ASCII; allow-list entries are not.

With `AGWINTERM_PIPE=k` and `TERMINAL_BROWSER_ALLOW_PIPE=K` (U+212A KELVIN SIGN), TypeScript folds both values to `k`, so `windowsHostRefusal` permits the launch and `paneClearRequest` permits addressing the pane. The debug engine compares the same entry with `eq_ignore_ascii_case`, rejects it, and fails before drawing. This violates the stated three-reader contract.

Reported here as a behavioural defect in the guard rather than as a comment defect — note that the fold-equivalence comment finding on the same function covers the same divergence but proposes only a documentation fix. The trigger requires a malformed Unicode allow-list entry, so the impact is contained.

Fix: Validate every non-wildcard allow-list entry with the ASCII pipe-name pattern before folding it, or implement an explicitly ASCII-only fold in both TypeScript copies, so all three readers agree by construction.

_confidence: 92 | sources: adversarial | lenses: adversarial | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 1890482 | 2 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 1173034 | 2 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 2265410 | 4 | ok |
| adversarial | codex | gpt-5.6-sol | high | 77346 | 2 | ok |
