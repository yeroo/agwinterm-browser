# Review: ralphex-20260822-post-port-corrections / 20260824-221702

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260822-post-port-corrections\20260824-221702\input\scope.md`

## Minor

### Doc comments define the new trim set as `str::trim`, contradicting their own bodies and the Rust definition

`cli/src/pane.ts:166-167`

The two new TypeScript trim helpers head their doc comments with an equation that the same comments then refute.

`cli/src/pane.ts:166-167`: "Rust's `str::trim`, as an edge trim: the Unicode `White_Space` property, plus U+FEFF." Six lines later, in the same comment (pane.ts:171-174): "ECMAScript counts U+FEFF ZWNBSP as whitespace and Unicode `White_Space` does not, so `String.trim` takes a byte-order mark off the front of an entry and `str::trim` leaves it on." Both cannot be true: if `str::trim` leaves U+FEFF on, `str::trim` is not "`White_Space` plus U+FEFF". `pane.ts:181` repeats it — "the way `str::trim` takes it" — of a helper that deliberately does not take it that way.

`cli/src/unsupported.ts:140-141` is the same claim plus a second error: "`pane.ts`'s `PADDING`, and `agwinterm.rs`'s `str::trim`: the Unicode `White_Space` property, plus U+FEFF." `agwinterm.rs` does not use `str::trim` for this any more — this change replaced it with `fn trimmed` (agwinterm.rs:372-374) precisely because `str::trim` is the wrong set, and that function's own doc says so plainly: "[`str::trim`] would be this, but ..." (agwinterm.rs:365). `unsupported.ts:151` repeats "the way `str::trim` takes it".

Concrete failure: the whole point of the change is that three readers must trim one set, and the set is `White_Space ∪ {U+FEFF}`. A maintainer reading pane.ts:166 or unsupported.ts:140 learns that this set *is* `str::trim`, which is the licence to collapse `trimmed` back to `value.trim()` on the Rust side (or to drop U+FEFF from `PADDING` on the JS side, since `String.trim` already covers it) — reintroducing exactly the U+0085/U+FEFF divergence between CLI preflight and engine `valid_pipe_name` that this change exists to close. The Rust doc gets it right and the two TypeScript docs get it backwards, so the reader has no way to tell which is authoritative except by re-deriving the sets.

Fix: Head both TypeScript comments with the set rather than with `str::trim`: e.g. "The Unicode `White_Space` property, plus U+FEFF — `agwinterm.rs`'s `trimmed`, which is what `str::trim` is not." Same for the two one-liners at pane.ts:181 and unsupported.ts:151, and correct unsupported.ts:140 to name `agwinterm.rs`'s `trimmed` rather than `str::trim`.

_confidence: 95 | sources: arch+quality | lenses: quality | verdict: confirmed_

### The trim fix on `nonempty` (AGWINTERM_PIPE / AGWINTERM_SESSION_ID) has no test in either language

`cli/src/pane.ts:288`

The change routes `nonempty` through the new union trim in all three readers — `cli/src/pane.ts:288`, `cli/src/unsupported.ts:157-159`, and `engine/crates/pixel-core/src/agwinterm.rs:385-389` — and `docs/design/07-as-built.md:386-389` states the guarantee explicitly: "it is the same trim `AGWINTERM_PIPE` and `AGWINTERM_SESSION_ID` go through, since a pane addressed by one reader and drawn by another has to be one pane." Nothing tests that half.

Every `\u{feff}` / `\u{85}` occurrence under `tools/`, `cli/src/` and `engine/crates/pixel-core/src/` was grepped, and all six hits are on the allow-list path: `tools/cli/pane-clear.test.mjs:229-230` (`pipeAllowed`), `tools/cli/unsupported.test.mjs:278` (a `HOST_CASES` row's `TERMINAL_BROWSER_ALLOW_PIPE`), and `agwinterm.rs:1756-1773`. The Rust cases drive `pipe_refusal(Some(list), pipe, ...)` directly, so they exercise `allows_pipe`'s per-entry trim and never reach `nonempty`. The existing padding coverage in `tools/cli/pane-clear.test.mjs:101,122` uses only ASCII spaces, and the two `HOST_CASES` loops (`unsupported.test.mjs:303-313`) assert `=== null` / `!== null` rather than the resolved value, so neither would see a wrong target.

Concrete defect that returns silently: revert `nonempty` in `pane.ts` to `env[key]?.trim()` (or `agwinterm.rs`'s to `str::trim`) and the whole suite stays green — the surviving allow-list assertions are unaffected, since `nonempty(env, ALLOW_PIPE_VAR)` sees a value beginning `other,` in every fixture and the discriminating trim there is the per-entry one. Meanwhile `AGWINTERM_SESSION_ID="s1\u{85}"` splits the readers again: `String.trim` does not strip U+0085 (NEL is category Cc, neither a Zs nor an ECMAScript LineTerminator) and `str::trim` does, so the CLI builds a clear request addressed to `"s1\u{85}"` while the engine drew on `"s1"`. The host never clears the pane, and `sameMark`'s `mark.target === pane.target` then fails against the engine's own marker, so `pane-clear` also declines to adopt its own wreck. `AGWINTERM_PIPE="\u{feff}agwinterm-dev"` splits it the other way: pre-fix the CLI trimmed the BOM and passed `PIPE_NAME`, the engine kept it and failed `valid_pipe_name`.

Raised by the tests lens; the docs lens is what makes it visible, since 07-as-built.md asserts the property as settled.

Fix: Add one assertion to `tools/cli/pane-clear.test.mjs` in the `paneClearRequest` addressing describe (near lines 106-122), asserting the *resolved* value rather than non-nullness: `assert.equal(pane.paneClearRequest(inPane({ AGWINTERM_SESSION_ID: "s1\u{85}" })).target, "s1")` plus the U+FEFF pair on `AGWINTERM_PIPE`'s `endpoint`. Mirror it in `agwinterm.rs` alongside the existing `HostTarget::from_env` tests (agwinterm.rs:1556-1567), driving a `SessionEnv` whose `SESSION_VAR` carries a leading U+FEFF and asserting `target.session()` comes back bare.

_confidence: 90 | sources: docs+tests | lenses: tests, docs | verdict: refined_

### "The six rounds below" now precedes seven round paragraphs

`docs/design/06-acceptance.md:292-293`

The change adds two round paragraphs — "A seventh round moved one" (06-acceptance.md:355) and "An eighth round moved none" (06-acceptance.md:371) — but bumps the running count in the lead-in sentence by only one, from "The five rounds below" to "The six rounds below" (06-acceptance.md:292-293).

The paragraphs that actually follow are second (line 295), third (304), fourth (313), fifth (322), sixth (340), seventh (355) and eighth (371) — seven of them. `git show HEAD:docs/design/06-acceptance.md` confirms the previous text was internally consistent: five paragraphs and "The five rounds below", so the prior state cannot distinguish "rounds below" from "rounds that moved a count" — all five moved counts. The eighth round says "moved none", so six is defensible under the second reading, but the sentence's referent is literally "the rounds below", and this is the first revision where the two readings diverge.

Concrete failure: a reader auditing the test-count arithmetic in this section — which is the section's entire purpose, since it reconciles 13 → 74 for `pane-clear.test.mjs` against the 365 in the table — counts seven rounds where the prose promises six and cannot tell whether a round is undocumented or the number is simply stale. No tooling consumes this number (nothing under `tools/` matches on it), so the cost is confined to a human reader.

Fix: Change "The six rounds below" to "The seven rounds below" at 06-acceptance.md:292, or make the counting rule explicit — e.g. "The six rounds below that moved a count carry them the rest of the way; an eighth moved none."

_confidence: 99 | sources: arch+quality, docs+tests | lenses: quality, docs | verdict: confirmed_

## Immaterial

### `asciiLower` is an undocumented closure inside `pipeRefusal` while every other shared rule in the file is a documented top-level binding

`cli/src/unsupported.ts:204`

This module's stated organizing principle is that each rule it shares with `agwinterm.rs` and `pane.ts` is a named top-level binding whose doc comment points at its two counterparts. Every one of them follows it: `PIPE_NAME` (unsupported.ts:164-165, "`agwinterm.rs`'s `valid_pipe_name`, and `pane.ts`'s `PIPE_NAME`"), `DEFAULT_PIPE` (167-168), `ALLOW_PIPE_VAR` (170-171), and the two this same change added — `PADDING` (139-149) and `trimmed` (151-153).

`asciiLower`, added by the same change, breaks the pattern: it is an anonymous arrow assigned to a `const` inside the body of `pipeRefusal` (unsupported.ts:204), with no doc comment, reachable by nothing else. Its counterpart in `pane.ts` is a documented module-level `function asciiLower` (pane.ts:186-197), and the as-built doc names it as one of the three readers' folds: "an `asciiLower` in the two TypeScript copies" (docs/design/07-as-built.md, "The fold is **ASCII-only** in all three readers").

Concrete failure: the parity test that guards this file against drift reads source text out of `agwinterm.rs` and looks for named declarations in the two TypeScript copies (`tools/cli/unsupported.test.mjs:315-340` matches `ALLOW_PIPE_VAR: &str = "..."` and `/^[A-Za-z0-9._-]+$/`). A rule buried in a function body is the one that cannot be reached that way, and it is the one whose ASCII-vs-Unicode distinction the change spends four doc paragraphs justifying. It also re-evaluates the `/[A-Z]/g` literal on every call, unlike the module-level `PADDING` beside it.

This is an organization/consistency defect, not a behavioural one — the fold itself is correct and equivalent to `pane.ts`'s and to `eq_ignore_ascii_case`.

Fix: Hoist it to module scope beside `PADDING` and `trimmed`, with a doc comment naming its two counterparts the way `PIPE_NAME` and `DEFAULT_PIPE` name theirs — e.g. "`pane.ts`'s `asciiLower`, and `agwinterm.rs`'s `eq_ignore_ascii_case`: `A`-`Z` and nothing else."

_confidence: 70 | sources: arch+quality | lenses: architecture | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 2472735 | 0 | ok, nothing raised |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 2098054 | 3 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 3053557 | 2 | ok |
| adversarial | codex | gpt-5.6-sol | high | 107440 | 0 | ok, nothing raised |
