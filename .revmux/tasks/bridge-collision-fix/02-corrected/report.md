# Review: bridge-collision-fix / 02-corrected

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\bridge-collision-fix\02-corrected\input\scope.md`

## Minor

### The fabricated rationale round 01 reported is still in the comment, reworded, and has been copied into the test

`tools/ralphex-revmux.sh:94-96`

Round 01 reported the comment on this failure branch for claiming `2>/dev/null` was why a broken bridge and a clean review read the same. The corrected text is:

```
# revmux's own words. The old code discarded them with 2>/dev/null: the log said
# "revmux new failed" and never why, so telling a misconfigured panel from a
# genuinely quiet review meant going and reading the round directory by hand.
```

The first clause is now right. The `so` clause is the same false claim in new words, and it contradicts its own premise inside one sentence: it states the log carried `revmux new failed`, then concludes you had to read the round directory to tell a broken bridge from a quiet review. The pre-change code was `... 2>/dev/null) || { echo "ralphex-revmux: revmux new failed" >&2; exit 0; }` — ralphex merges stderr into the stream it logs, so a misconfigured panel produced that line and a quiet review produced revmux's markdown plus the done signal. Those are distinguishable from the log alone. What `2>/dev/null` cost was *which* misconfiguration, not *whether* one occurred. What makes the two indistinguishable is the `trap finish EXIT` at :32, documented as deliberate at :25-26.

The correction also propagated the clause rather than removing it: tools/ralphex/bridge.test.mjs:206-208 now reads "the progress log carries 'revmux new failed' and no reason, and telling a misconfigured panel from a quiet review means reading the round directory by hand". Round 01 cited that test comment as the version that stated it correctly; the second half is new.

Nothing executes differently. The cost is that a maintainer reading either site will believe the pre-change bridge failed with no trace and will misjudge how much the always-exit-0 trap hides on its own — which is the exact judgement this file's comments exist to inform.

Fix: Drop the unsupported conclusion in both places and keep only what was actually lost, e.g. "The old code discarded them with 2>/dev/null: the log said \"revmux new failed\" and never which of revmux's refusals caused it, so a misconfigured panel could not be told from a transient collision without reading the round directory." Note that it is the trap at :32, not this redirect, that makes a failed bridge and a quiet review read alike.

_confidence: 85 | sources: arch+quality | lenses: quality | verdict: confirmed_

### The spawn subtest 4 relies on is unbounded, so the unbounded-loop mutation it exists to catch wedges the suite instead of failing it

`tools/ralphex/bridge.test.mjs:125-134`

Subtest 4 (`a name refused three times gives up bounded`, :186-200) was added this round specifically to pin the attempt cap — its assertion message is "the attempt cap did not hold" (:194), and its comment at :190-193 names the regression precisely: "Unbounded retrying here would hang the pane instead."

It cannot fail on that regression. Rewrite the loop at tools/ralphex-revmux.sh:85 as `attempt=1; while true; do RUN="$RUN_STAMP-$$-${RANDOM:-0}-$attempt"; ...; attempt=$((attempt+1)); done` — unbounded, but `$attempt` stays defined so `set -u` at :20 does not abort. The `taken` stub refuses every attempt (its `*)` arm at bridge.test.mjs:90 has no upper bound), so `revmux new` is refused forever. `spawnSync` at :125 carries no `timeout` option, and it is *synchronous*: it blocks the event loop, so node's test-timeout timer can never fire. `assert.equal(r.calls.length, 3)` at :194 is never reached. Instead of one red subtest naming the regression, the whole file hangs and `calls.log` grows without bound on disk. Under `pnpm test` (`node --test --test-timeout=120000`, package.json:5) the backstop cannot fire either, and under the command the scope and profile.md:24 document (bare `node.exe --test`) there is no `--test-timeout` at all — its Node 22 default is `Infinity`.

This repo has a written rule for exactly this and a recorded incident behind it. tools/cli/pane-clear.test.mjs:436 — "`execFileSync` blocks the event loop, so an unbounded one is not slow but stuck" — is asserted on as a production requirement. tools/lib/deadline.test.mjs:3-11 records the failure where an unbounded wait "hung, and took `pnpm test` down with it — three `node` processes still alive eighteen hours later", and states the convention: "a bug in the helper must fail this file rather than wedge it." Every other synchronous spawn in tools/*/*.test.mjs that waits on external work carries a `timeout:` (acceptance/pane-clear.test.mjs:110, acceptance/profile-lock.test.mjs:76,328, cli/unsupported.test.mjs:104, vendor-check/universe.test.mjs:43). This new file is the only one that does not.

Nothing hangs today — the loop is bounded at three and DRY_RUN stops before the 40m revmux call — so this is the guard failing, not a live break. But it is the guard the round was asked to add. What the subtest does pin, it pins correctly: the attempt count, the three distinct names, `scopeWritten` being null, and attempt 3's refusal reaching stderr. The gap is only that the loop's *termination*, as opposed to its count, is unenforceable from a call that can block forever.

Fix: Add `timeout: 30_000` (and optionally `killSignal: "SIGKILL"`) to the `spawnSync` options at :125-134, matching tools/cli/unsupported.test.mjs:104. On timeout `res.status` comes back null and `res.signal` is set, so subtest 4's existing `assert.equal(r.calls.length, 3)` and `assert.equal(r.status, 0)` both go red instead of the run stalling. Asserting `res.signal === null` / absence of `res.error` in `runBridge` would name the failure directly.

_confidence: 99 | sources: adversarial, bugs+impl, arch+quality, docs+tests | lenses: adversarial, bugs, impl, quality, architecture, tests | verdict: confirmed_

### The stub's fourth refusal is invented wording, contradicting the file's own header claim that it answers verbatim in revmux's words

`tools/ralphex/bridge.test.mjs:58`

The file's header states the correction this round is built on (:14-17): "The stub answers in revmux's own words, taken verbatim from the binary the bridge calls ... the ported retry was gated on wording revmux never emits, and a stub written to satisfy the gate rather than to imitate the tool is what let it look tested."

The three `TAKEN` strings (:52-56) are verbatim — the reporter re-checked each against the binary and they match byte for byte, including the `%s` slots filled with `report.md` / `findings.json` / `round`. `HOPELESS` at :58 is not:

```js
const HOPELESS = 'profile "comprehensive" names an agent that is not configured';
```

`grep -ac 'names an agent' C:\\Users\\boris\\go\\bin\\revmux.exe` returns 0, and `not configured` does not appear anywhere in the binary either. revmux's real profile/roster refusals are `profile %q, have %s`, `profile %s: roster is empty`, `profile %s: agent %s: %w` and `profile %s: duplicate agent name %q`. So one of the stub's four refusals is a string authored for the test — the exact thing the header comment condemns two lines earlier, and the thing the round exists to have removed.

Subtest 5 (:202-211) asserts on it: `assert.match(r.stderr, /names an agent that is not configured/)` under the label "revmux's own explanation reaches stderr". It is not revmux's explanation. No behaviour is wrong today — the wording gate was deleted, so the bridge blindly `tail`s whatever revmux wrote and the specific text is inert — but the header's blanket claim is false, and if anyone reintroduces a wording-sensitive branch they will calibrate it against a refusal revmux cannot emit.

Fix: Replace `HOPELESS` with a real revmux roster refusal — e.g. `'profile "comprehensive", have expert'` or `'profile comprehensive: roster is empty'` — and update the assertion at :209 to match it. Alternatively narrow the header at :14-17 to say the *taken-name* refusals are verbatim and that the contrast case is synthetic; the string is the cheaper fix and keeps the claim true.

_confidence: 90 | sources: docs+tests | lenses: docs, comments, tests | verdict: confirmed_

## Pre-existing

### The conventions profile the bridge hands every review panel names a build gate this tree cannot pass, and omits the two that replaced it

`tools/ralphex-revmux.sh:148-149`

The reporter marks this pre-existing: the heredoc at :145-151 is not touched by the diff under review. It is raised because it is a document an agent executes against as a contract.

tools/ralphex-revmux.sh:145-151 writes into revmux's profile slot, for every reviewer in every ralphex-triggered round:

```
cargo nextest run --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

tools/vendor-check/fmt-scope.py's own docstring says the opposite, in its first paragraph: "The vendored tree is not rustfmt-clean and reformatting it is the silent edit the port's Constraints forbid (see `docs/design/01-baseline-errors.md`), so `cargo fmt --all --check` **cannot be green here**. The checkable claim that replaces it is narrower and stronger: *no rustfmt complaint lands on a line this port wrote*." `clippy-scope.py` exists alongside it for the same reason.

So a reviewer that follows the profile it was handed runs `cargo fmt --all --check`, gets a diff across the vendored tree, and either reports vendored-line complaints or concludes the tree is broken — the exact class of non-finding this repo scopes out. The profile also never mentions `python tools/vendor-check/fmt-scope.py` / `clippy-scope.py`, never says "do not report vendored-line complaints", and its "What is not [worth reporting]" section defers to "the plan file" for out-of-scope items rather than to the vendoring boundary. The consequence is recurring noise in every automated round, in the one document that exists to prevent it — and the comment above it at :131-133 states that preventing exactly this ("the panel spends every round re-reporting the same non-findings", :110-111) is why the profile is written at all.

Fix: Replace the `cargo fmt --all --check` and bare `cargo clippy` lines with `python tools/vendor-check/fmt-scope.py` and `python tools/vendor-check/clippy-scope.py`, and add a line stating that the tree is a vendored port and vendored-line complaints are not findings.

_confidence: 85 | sources: docs+tests | lenses: docs, comments_

## Immaterial

### `: > "$NEW_LOG"` is dead — the `2>` redirect on the next line already truncates

`tools/ralphex-revmux.sh:87`

Line 87 truncates `$NEW_LOG` at the top of each attempt so that only the last refusal survives to `tail -n 20` at :97. The very next line does that already: `2>"$NEW_LOG"` in the command substitution at :88 opens the file with `O_TRUNC` before `revmux` execs, on every iteration. Line 87 has no observable effect on any path — including the one where `revmux` cannot be executed at all, since the redirection is applied before the exec fails and the shell's own "command not found" lands in the truncated file.

Verified by the reporter: a file containing `first`, after `bash -c 'echo second >&2' 2>"$T"`, holds only `second`.

It is not harmless as documentation, because it misattributes the mechanism — round 01's own reasoning credited the truncation to this line ("`: > \"$NEW_LOG\"` having truncated all but the last attempt's stderr") rather than to the redirect. A later edit that changed :88 to `2>>` for append would look correct against line 87 while silently changing what `tail -n 20` reports, and subtest 4's `/was claimed by a run that never came back/` assertion at :197 would still pass, since the last refusal is present either way.

Fix: Delete line 87. If the intent is to make the last-refusal-wins behaviour explicit rather than incidental, say so in a comment on :88 where the truncation actually happens.

_confidence: 90 | sources: arch+quality | lenses: quality | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 657437 | 1 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 661917 | 3 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 813775 | 4 | ok |
| adversarial | codex | gpt-5.6-sol | high | 113854 | 1 | ok |
