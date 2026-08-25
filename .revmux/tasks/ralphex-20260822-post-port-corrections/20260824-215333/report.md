# Review: ralphex-20260822-post-port-corrections / 20260824-215333

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260822-post-port-corrections\20260824-215333\input\scope.md`

## Minor

### New `asciiLower` doc claims the allow-list entry is "the one place a non-ASCII operand can reach"; `sameMark` is a second such site, still Unicode-folding

`cli/src/pane.ts:170-172`

Verified in source. `asciiLower`'s new doc (pane.ts:165-176) states: "Where the two sides of a comparison are both ASCII the difference cannot show, so this exists for the one place a non-ASCII operand can reach — an entry a developer typed into `TERMINAL_BROWSER_ALLOW_PIPE`."

That scope claim is false for this module. `sameMark` (pane.ts:582-583) does `mark.pipe.toLowerCase() === pane.pipe.toLowerCase()` — the exact Unicode fold this change removed from `pipeAllowed` — and one of its operands is just as unconstrained as an allow-list entry. Confirmed both halves:
- `pane.pipe` is ASCII-gated: `clearOwnedPaneFrame` builds `here` only when `request` is non-null (pane.ts:760), and `paneClearRequest` returns null on `pipeRefusal(env)` (pane.ts:139), which runs `PIPE_NAME.test(pipe)` (pane.ts:244).
- `mark.pipe` is not: `frameMark` (pane.ts:562-572) reads `PANE_FILE` off disk, splits on newline, trims, and returns it with no `PIPE_NAME` check.

So the module folds the same identifier two ways, and the doc tells the next reader the ASCII case has been swept up everywhere it can arise.

Two corrections to the original finding:
- It claims the line-187 cite and `unsupported.ts:184` tell a reader "the two folds agree." They do not. Both cite `sameMark` only for *why the comparison is case-insensitive at all* ("the object manager resolves pipe names case-insensitively"), and pane.ts:193-201 then states separately that the fold is ASCII-only. The misleading claim is confined to the `asciiLower` doc's "one place."
- `sameMark` has no engine twin, so the "character for character" contract that binds `pipeAllowed` does not bind it: `rg` over `pixel-core/src` finds `eq_ignore_ascii_case` only at agwinterm.rs:349 (`allows_pipe`) and ghostty.rs:120; nothing in the engine compares a `PANE_FILE` marker. That makes this a comment-accuracy defect rather than a divergence-from-Rust defect.

Runtime impact is negligible, as the finding itself concedes — `FrameDir::mark_pane` (frame_file.rs:327-331) only ever writes a `valid_pipe_name` pipe, so reaching the U+212A adoption path needs something else to have planted the directory in temp. The reportable part is the comment.

Fix: Narrow the claim to what it covers — e.g. "...so this exists for the operand `PIPE_NAME` has not been over: an entry a developer typed into `TERMINAL_BROWSER_ALLOW_PIPE`" — and, if the divergence is worth closing rather than just describing, note in `sameMark`'s doc that it folds a marker whose contents this module does not validate, or fold it with `asciiLower` too.

_confidence: 70 | sources: docs+tests, arch+quality | lenses: comments, docs, architecture, quality | verdict: refined_

### Line-wrapped code span splits `AGWINTERM-KIOSK` into two rendered spans

`docs/design/06-acceptance.md:366-367`

The seventh-round paragraph this change adds wraps mid-identifier and closes the code span at the line break:

```
...and an entry spelling `AGWINTERM-`
`KIOSK` with a U+212A KELVIN SIGN would have cleared CLI preflight...
```

There is a closing backtick after `AGWINTERM-` and an opening one before `KIOSK` (confirmed byte-for-byte). Markdown renders that as two adjacent code spans with a space between them — `AGWINTERM-` `KIOSK` — so the one pipe name the paragraph exists to name reads as two tokens, and a reader scanning for the identifier used in the tests (`AGWINTERM-<U+212A>IOSK`) does not find it. Every other mention of the name in this change (07-as-built.md:375, agwinterm.rs:339, pane.ts:197, both test files) keeps it whole.

Fix: Reflow so the identifier sits inside one span: drop the interior backtick pair and move the whole `` `AGWINTERM-KIOSK` `` onto one line.

_confidence: 90 | sources: docs+tests | lenses: docs | verdict: confirmed_

### Raw U+212A in both `.mjs` test copies where the same round's Rust twin uses a visible `\u{212a}` escape

`tools/cli/pane-clear.test.mjs:217-218`

Verified byte-for-byte. `cat -A` shows `AGWINTERM-M-bM-^DM-*IOSK` (E2 84 AA = U+212A) at tools/cli/pane-clear.test.mjs:217 and in the `HOST_CASES` row at tools/cli/unsupported.test.mjs:263, while the Rust twin added in the same round writes `let kelvin = "AGWINTERM-\u{212a}IOSK";` (agwinterm.rs:1729). Line 218 is the all-ASCII control asserting `true`, so in a terminal or `git diff` the pair renders as two identical lines asserting opposite results. Same round, same fixture, two spellings — and only the JavaScript copies hide the character.

The original finding's concrete failure — a maintainer deleting line 217 as an apparent duplicate — is weaker than stated. Both sites carry an explanatory comment immediately above (pane-clear.test.mjs:212-216 and unsupported.test.mjs:260-262) that names the entry as "`AGWINTERM-KIOSK` with its first `K` written as U+212A KELVIN SIGN," and that comment travels with the lines in any diff. The real residue is the inconsistency itself and the homoglyph's fragility under normalising tooling (an editor's "convert to ASCII", a find-and-replace on `KIOSK`), which would silently turn 217 into a literal contradiction with 218.

Nothing executes differently today; the fix is behaviour-preserving (`"AGWINTERM-\u{212a}IOSK"` is the identical string) and stays entirely at the two sites.

Fix: Spell the entry as an escape in both JavaScript copies, matching `agwinterm.rs:1729`: `const kelvin = "AGWINTERM-\u{212a}IOSK";`, used in the assertion at tools/cli/pane-clear.test.mjs:217 and in the `HOST_CASES` row at tools/cli/unsupported.test.mjs:263. Add a one-line comment on pane-clear.test.mjs:218 marking it the all-ASCII control for the line above, so the pair reads as a contrast rather than a duplicate.

_confidence: 70 | sources: bugs+impl, arch+quality | lenses: bugs, impl, quality, architecture | verdict: refined_

## Pre-existing

### A starting publisher can delete a live idle publisher's directory, leaving its pane unrecoverable

`engine/crates/pixel-core/src/frame_file.rs:385-404`

Pre-existing — this diff rewrites only the doc comments on `STALE_AFTER` and `sweep_stale`; the sweeping logic itself is untouched.

`FrameDir::create` (frame_file.rs:271) calls `sweep_stale(&root, STALE_AFTER)` on every new publisher, before `create_in`. `sweep_stale` selects on directory mtime alone (:394-399) and `remove_dir_all`s anything at or past an hour (:401). A publisher's directory mtime advances only when a frame file is created inside it, so it tracks painting, not liveness — a browser parked on a static page goes quiet and ages past the threshold while still holding its pane. Nothing in `FrameDir` keeps a handle open inside the directory, so the removal succeeds against a live process.

Failure sequence: browser A publishes a frame, marks its pane, then sits idle for over an hour. Browser B starts; `FrameDir::create` sweeps A's directory and its `pane` marker away. A is then force-killed (`taskkill /F`) before it repaints. A's placement is still on the pane, but there is now no directory and no marker, so `ownedFrames` (`cli/src/pane.ts:673-698`) finds nothing to attribute and `pane-clear` reports nothing owned. The pane stays painted with no recovery path.

The recoveries the new comment cites are real but do not cover this: `write_frame` (:710-719) recreates the directory and `FrameDir::remark` (:344-349) restores the marker only on the *next* frame, which by construction never arrives here. The `STALE_AFTER` comment added by this diff now names this window and its consequence explicitly, and gives the reason liveness-based sweeping was rejected (pid reuse would strand real wrecks unboundedly) — so this is a documented, deliberate trade rather than an oversight, but the failure is still reachable and the window is not closed.

Fix: No small fix; closing it means renewing the directory's mtime independently of painting. The cheapest shape that fits the existing design is for the publisher to touch its own directory on the frame-budget tick it already runs, so mtime tracks the process rather than the repaint, leaving `sweep_stale` age-based and pid-free. Alternatively, leave as-is: the comment added by this diff already records the window and the reasoning, which may be the intended resolution.

_confidence: 88 | sources: bugs+impl | lenses: bugs_

### JavaScript and Rust trim different code points before matching the allow-list

`cli/src/pane.ts:207-211`

Pre-existing — the reviewer notes the former exact comparison had the same divergence, and the new ASCII fold neither introduces nor widens it.

With `AGWINTERM_PIPE=agwinterm-dev` and `TERMINAL_BROWSER_ALLOW_PIPE` set to `other,<U+FEFF>agwinterm-dev`, both TypeScript readers remove U+FEFF from the second entry with `String.trim()` and allow the pipe, while `allows_pipe` at `engine/crates/pixel-core/src/agwinterm.rs:347` retains it with `str::trim()` and the debug engine refuses the same launch. ECMAScript includes U+FEFF in whitespace (tc39.es/ecma262 — sec-white-space), whereas Rust whitespace follows Unicode `White_Space` via `char::is_whitespace`, which excludes it. The reportable residue against this change is that the new ASCII fold does not make the three guards "character for character" as described. The trigger requires unusual non-ASCII configuration and fails closed, so impact is minor.

Fix: Use an explicitly enumerated, identical trim set in all three readers before splitting and comparing allow-list entries.

_confidence: 95 | sources: adversarial | lenses: adversarial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 2395082 | 2 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 2006990 | 2 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 2061809 | 2 | ok |
| adversarial | codex | gpt-5.6-sol | high | 142882 | 1 | ok |
