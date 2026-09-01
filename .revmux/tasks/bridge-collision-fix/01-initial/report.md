# Review: bridge-collision-fix / 01-initial

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\bridge-collision-fix\01-initial\input\scope.md`

## Major

### The retry gate matches wording revmux never emits, so the retry loop is dead in production

`tools/ralphex-revmux.sh:82`

`grep -Eqi 'already exists|duplicate|collision' "$NEW_LOG" || break` is the only thing that turns a refusal into a retry, and none of those three strings appear in revmux's refusals for a run name it will not open.

Verified independently against the binary the bridge actually calls (`C:\Users\boris\go\bin\revmux.exe`, the only `revmux` on PATH). Note that `strings` is not installed on this machine, so it was read with `grep -aoE`; four bespoke "this round name is not available" messages are present verbatim:

- `round %s has already run, %s is in place: a round that went badly is exactly the one a later reflection agent reads, so it is never reused`
- `round %s is being written by a run holding it: two runs sharing a round truncate each other's artifacts, so open a new round instead`
- `round %s was claimed by a run that never came back and still holds what it wrote (%s): re-using it would put two runs' artifacts under one %s, so open a new round instead`
- `%s %q is reserved: the task directory keeps %s beside its rounds, and a round named after it is read as the task's own metadata`

`-i` does not help: "has already run" is not "already exists", and neither "duplicate" nor "collision" occurs anywhere in revmux's own output (the only `already exists` in the binary is Go's stdlib `file already exists`; the only `duplicate` tokens are `checkForDuplicateFlags` / `duplicated flag` from the argument parser, and every `collision` hit belongs to unrelated syntax-highlighting keyword lists). Two of the real messages literally end with "so open a new round instead" — they are exactly the case the loop was written for, and the gate rejects all of them.

Failure path: revmux refuses attempt 1 with `round 20260901-120000-4812-9137-1 is being written by a run holding it: ...`. `grep` exits 1, `break` fires on the first iteration, `NEW_OK` stays `false`, and control falls to lines 84-89 — the reason is echoed to stderr and the script exits 0 having printed `<<<RALPHEX:CODEX_REVIEW_DONE>>>` from the `finish` trap. ralphex records a review that ran and found nothing, the exact silent-success outcome this change exists to make less dangerous. Nothing hangs; what does not happen is the retry.

Why the test does not catch it: `tools/ralphex/bridge.test.mjs:38` claims the stub refuses "with the wording revmux uses for a taken name", and `:58` emits `revmux: run "$RUN" already exists` — a string authored to satisfy the grep rather than to match revmux. Subtest 3 (`:135`) therefore proves only that the loop retries when the pattern happens to match, and would stay green no matter how far the pattern drifts from the real tool. The profile lists "a test that ... passes for a reason unrelated to the code" as reportable, and this is one.

Honest bound on the blast radius: the `$$`/`$RANDOM` half of the change makes a genuine collision rare, so this is a safety net that does not work rather than a live break, and the new `tail -n 20 "$NEW_LOG"` at least surfaces revmux's reason on the way out. No real collision was forced against revmux (that would have written into `.revmux/tasks/`), so this rests on the binary's strings, not on an observed run. The binary does contain a `create round: %w` wrap, so a Windows `Cannot create a file when that file already exists.` could in principle match the gate — but that is a residual filesystem path, not the three state checks above, each of which refuses with its own message before any mkdir.

Fix: Match revmux's actual refusals — e.g. `grep -Eqi 'already run|being written by|was claimed by|is reserved' "$NEW_LOG"` — and change the stub at `tools/ralphex/bridge.test.mjs:58` to emit one of revmux's verbatim messages (`round \"$RUN\" is being written by a run holding it: ...`) so subtest 3 fails if the pattern drifts again. Dropping the comment at `:38` that asserts the stub already does this, or making it true, is the same edit. Alternatively drop the wording match entirely and retry on any failure for the fixed three attempts — the attempt cap already bounds it, and a non-collision failure costs two extra sub-second calls.

_confidence: 95 | sources: docs+tests, bugs+impl | lenses: tests, comments, docs, bugs, impl | verdict: refined_

## Minor

### Comment claims the old stderr-discarding path left a broken bridge indistinguishable from a clean review; it did not

`tools/ralphex-revmux.sh:85-86`

The new comment on the failure branch reads:

```
# revmux's own words. This is the failure path that used to discard them, which
# is why a broken bridge and a clean review read the same in the progress log.
```

The first sentence is right; the second is not. The pre-change code (visible in the diff) was:

```
PATHS_JSON="$(revmux new --task "$TASK" --run "$RUN" 2>/dev/null)" || {
  echo "ralphex-revmux: revmux new failed" >&2; exit 0; }
```

It discarded revmux's *reason*, but it still echoed `ralphex-revmux: revmux new failed` to stderr, and ralphex merges stderr into the stream it logs. So the progress log did carry a distinguishing line; what it lacked was the explanation. `2>/dev/null` was never what made the two read the same — the `trap finish EXIT` at `:32` is, and that is documented at `:25-26` as deliberate.

The change's own test comment states this correctly at `tools/ralphex/bridge.test.mjs:158-159` — "the progress log carries 'revmux new failed' and no reason" — so the script comment and the test comment now disagree about the same incident, and the script's is the wrong one. The profile flags a fabricated rationale in a comment as something this repo has had reported twice; this is one, in the load-bearing position of explaining why the branch exists.

Pure prose, so nothing executes differently. The cost is that a maintainer reading `:85-86` will believe the pre-change bridge failed with no trace at all and will misjudge what the trap already hides on its own.

Fix: Narrow the claim to what was actually lost, e.g. "This is the failure path that used to discard them: the log said `revmux new failed` and never why, so a misconfigured panel and a clean review were only distinguishable by reading the round directory."

_confidence: 90 | sources: docs+tests | lenses: comments, docs | verdict: confirmed_

### No stub mode collides on every name, so the retry loop's exhaustion exit is never reached

`tools/ralphex/bridge.test.mjs:56-60`

The change introduces a retry loop with three exits: success (`accept`), give-up-on-a-non-collision (`fail`), and exhaust-the-attempts. The third is the only one the change newly created that no subtest reaches. `collide` refuses only names ending `-1` (tools/ralphex/bridge.test.mjs:57-58), so attempt 2 always succeeds and the loop leaves via `break` at `tools/ralphex-revmux.sh:79`; `fail` refuses everything but with wording ("names an agent that is not configured") that misses the `already exists|duplicate|collision` grep, so it leaves via the early `break` at `:82`. The `for attempt in 1 2 3` list is therefore never run to its end, and the `NEW_OK != true` branch at `:84` is only ever entered from `fail`.

So the exhaustion path is untested end to end: three distinct names offered, `: > "$NEW_LOG"` having truncated all but the last attempt's stderr, `tail -n 20` reaching the log, and exit 0 with the done signal. The profile lists "missing coverage for a path the change introduced" as reportable, and the scope names this directly as worth attacking ("does the retry loop ... terminate in the cases it claims to").

One correction to the original reasoning. The mutation offered as the thing the suite cannot see — rewrite the loop head as `while true` keeping the same body — does *not* stay green: `$attempt` becomes unbound, and `set -u` (in force, `tools/ralphex-revmux.sh:20`) aborts the script before `revmux` is ever called, so subtests 1 through 5 go red. The conclusion survives under an adjacent mutation that carries its own counter (`attempt=1; while true; do ...; attempt=$((attempt+1)); done`): that is unbounded and all six subtests stay green. Against a persistent collision such a bridge spins forever — no round opens, nothing reaches stdout, the `finish` trap never runs, and ralphex sits out the full `idle_timeout` the always-exit-0 design exists to prevent. The missing-coverage argument does not depend on that mutation, but the bound genuinely is unpinned.

The fix stays inside the new, untracked test file.

Fix: Add a fourth stub mode that refuses every name with taken-name wording, and assert `calls.length === 3`, that the three names are distinct (both `$RANDOM` and the attempt suffix are re-evaluated per iteration, so they should be), that `scopeWritten` is null, that the final diagnostic reaches stderr, and that the process still exits 0 having printed the done signal. That pins the bound, the freshness of each retry, and termination in one subtest. While there: `collide`'s message only exercises the `already exists` alternative of `grep -Eqi 'already exists|duplicate|collision'`, so the other two branches are also unverified — cheap to cover by varying the new mode's wording.

_confidence: 95 | sources: adversarial, arch+quality | lenses: adversarial, quality | verdict: refined_

### The stub hands the bridge a path shape real revmux never emits, so pluck's backslash conversion is never exercised

`tools/ralphex/bridge.test.mjs:34-69`

`const slash = (p) => p.replaceAll("\\", "/")` at line 34 is applied to everything the bridge sees: the script path and the prompt path passed to `spawnSync` (`:88`), and both JSON values `stubRevmux` emits (`:68-69` via `:81`). So every subtest feeds the bridge `"scope": "C:/Users/.../scope.md"`.

Real `revmux new` emits JSON, and JSON escapes the separator: on Windows it emits `"C:\\Users\\...\\scope.md"` — two backslash bytes per separator. `pluck`'s trailing substitution exists for exactly that. `tools/ralphex-revmux.sh:96` is the byte sequence `sed 's/\\\\/\//g'`, i.e. the sed program `s/\\\\/\//g`, which matches *two* literal backslashes and replaces them with one `/`. Fed the stub's already-slashed value it matches nothing and passes the string through untouched.

So the one transformation standing between revmux's payload and a usable `$SCOPE` on this platform is a no-op in all six subtests. Nothing here fails if it regresses: drop the substitution entirely, or change it to match a single backslash, and every assertion stays green — `existsSync(scope)` still finds the file because the stub never produced a backslash to mishandle. The test's own comment at lines 32-34 states that forward slashes survive "the bridge's own sed", which is true and is the problem: it documents that the fixture was chosen to avoid the conversion rather than to drive it.

The same normalisation hits the argument shape. The real entry point is `tools/ralphex-revmux.cmd:14`, `"%BASH%" "%~dp0ralphex-revmux.sh" %1` — `%~dp0` expands to `C:\Users\boris\source\winterm-browser\tools\` and `%1` is ralphex's Windows temp path, so bash receives two backslash-separated arguments, not the forward-slash ones the test supplies; the `[ -f "$PROMPT_FILE" ]` guard at `:34` is therefore never driven on a backslash path either.

Neither reviewer claims a live bug: both shapes work today — the real one because the sed converts it, the stub's because it needs no conversion, and both real shapes were run under Git Bash and behave correctly. The defect is that this new test, the repo's first coverage of the bridge, cannot tell those two apart. The profile calls it out by name — "Paths cross three quoting layers (cmd -> bash -> node) ... a test that silently normalises a path away is worse than no test" — and `tools/launcher/launch.test.mjs:253-257` is the standing precedent, doubling its separators deliberately and then asserting `cwd.includes("\\")` with the message "the fixture must keep its separators to be worth asserting".

Fix: Emit the JSON-escaped Windows form the real tool produces. The heredoc is unquoted (`cat <<JSON`), so bash eats one backslash level: write four backslashes per separator in the template to land two in the output — e.g. build the stub value from `scope.replaceAll("\\", "\\\\\\\\")` — and assert the plucked result. Pass `BRIDGE` and `prompt` to `spawnSync` as native backslash paths too. Keep `slash()` only for the `LOG` path inside the stub's own shell body, where a bash-side path is genuinely required, and add a launcher-style guard that the fixtures still contain a separator before spawning, so a future edit cannot quietly normalise them away again.

_confidence: 95 | sources: arch+quality, bugs+impl | lenses: quality, impl | verdict: confirmed_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 1315992 | 2 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 726272 | 2 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 1194461 | 2 | ok |
| adversarial | codex | gpt-5.6-sol | high | 155080 | 1 | ok |
