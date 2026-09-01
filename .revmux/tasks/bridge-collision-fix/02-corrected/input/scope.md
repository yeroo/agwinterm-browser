# Item under review: the ralphex → revmux bridge fix, after round 01's findings

Same two files as round `01-initial`, both still uncommitted on branch `main`:

```
git diff -- tools/ralphex-revmux.sh      # 45 insertions, 5 deletions
cat tools/ralphex/bridge.test.mjs        # new, untracked — read it from disk
```

`git status --short` should show exactly `M tools/ralphex-revmux.sh` and `?? tools/ralphex/`.
Nothing else is under review.

**Read `../01-initial/report.md` first.** This round exists because round 01 found a real bug in
the change, and everything below is what was done about it. The most useful thing you can do is
check whether the corrections are right — not re-derive the original findings.

## What the bridge is

`tools/ralphex-revmux.sh` (reached on Windows through its `.cmd` sibling) makes revmux serve as
ralphex's external review tool. ralphex runs it with `exec.Command(script, promptFile)`, merges
stdout and stderr, and watches for `<<<RALPHEX:CODEX_REVIEW_DONE>>>`.

Governing design decision, predating this change: `trap finish EXIT` prints that signal and the
script exits 0 on **every** path. Deliberate — otherwise ralphex sits out its `idle_timeout` on a
review that already finished. The cost is that a bridge which never opened a round is, to
ralphex, indistinguishable from a review that found nothing. Every failure path is a
silent-success path, and reducing that hazard is the point of the change.

## What round 01 found, and what changed

**Major — the retry gate matched wording revmux never emits.** The ported code gated the retry on
`grep -Eqi 'already exists|duplicate|collision'`. Confirmed against
`C:\Users\boris\go\bin\revmux.exe` (read with `grep -aoE`; `strings` is not installed): revmux's
four refusals for a run name it will not open are "has already run", "is being written by a run
holding it", "was claimed by a run that never came back", and "is reserved". None matched. The
retry was inert, and failed into the silent-success path above.

The fix **deletes the wording match entirely** rather than correcting it to those four phrases.
The reasoning, which is itself worth attacking: a gate keyed on another tool's prose goes dead
silently on the next wording change, and it goes dead in the direction of a review that looks
clean; two of revmux's own messages advise "open a new round instead", which is what a retry
does; a failure a fresh name cannot cure costs two extra sub-second calls; and the attempt cap,
not the wording, is what bounds the loop. If that trade is wrong, say so.

**Minor — a fabricated rationale in a comment.** The failure branch claimed `2>/dev/null` was why
a broken bridge and a clean review read the same in the progress log. False: the old code still
echoed `ralphex-revmux: revmux new failed`; only the *reason* was lost. Comment narrowed.

**Minor — the exhaustion exit had no coverage.** A fourth stub mode (`taken`) now refuses all
three attempts, each with a different verbatim revmux refusal.

**Minor — the stub emitted a path shape revmux never produces.** The stub now emits the
JSON-escaped Windows form (`C:\\Users\\...`), verified against a live `revmux new`, and the
fixtures are guarded against being normalised away.

## One round-01 finding that was rejected, with evidence

Round 01 argued `pluck`'s `sed 's/\\\\/\//g'` is "the one transformation standing between
revmux's payload and a usable `$SCOPE`" and that the test never exercises it. The fixture was
corrected to the real shape anyway — and the suite stayed green, because **msys collapses a
doubled separator by itself**:

```
bash -c 'echo hi > "$1"' _ 'C:\\Users\\...\\dbl.txt'   →  /c/Users/.../dbl.txt
```

So the sed is defensive, not load-bearing; deleting it leaves the bridge working, which is why no
assertion can catch its removal. Verified two ways: the probe above, and deleting the sed from
the script and re-running the suite (6/6 still green). The comments in the test now say this
outright rather than claiming the conversion is pinned.

**If this rejection is wrong, that is the single most valuable finding this round.** It rests on
msys path normalisation on this machine, and on the claim that no other consumer of `pluck`'s
output cares about the separator style.

## Mutation evidence for the corrected version

- Restore the dead wording gate → subtests 3 and 4 go red.
- Delete `pluck`'s sed → all 6 stay green (see above; this is the known no-op).
- Reverting the whole hunk → subtests 2, 3, 5 go red (from round 01).

Not covered: any mutation of the loop that keeps its own counter and drops the bound. Round 01
established `while true` with the body unchanged is caught by `set -u` on `$attempt`, but an
adjacent rewrite carrying its own counter would spin forever against a persistent refusal. The
`taken` mode is what is meant to pin the bound now — check that it does.

## Run it

```
node.exe --test tools/ralphex/bridge.test.mjs      # 6 subtests
node.exe --test "tools/*/*.test.mjs"               # 558 tests, 558 pass
```

`node.exe`, not `node`: the shell aliases the latter to `winpty node.exe`, which fails
non-interactively with "stdout is not a tty" and exits non-zero even when every test passes.

## Known — do not report

- The always-exit-0 / always-print-done-signal behaviour. Intentional, documented at the trap,
  pinned by subtest 6. Reasoning about what it makes *invisible* is in scope; calling it a defect
  is not.
- The task name staying `ralphex-<plan stem>` where agwinterm uses `ralphex-<slug>-<hash>`.
  Changing it would orphan the existing `.revmux/tasks/ralphex-*` directories, and a task name
  stable across iterations is what carries earlier rounds into later prompts.
- `pluck`'s greedy sed capture requiring one JSON key per line. Pre-existing, and the stub
  reproduces the real shape.

## Worth attacking

- Is retrying *every* failure right? Name a refusal where three attempts is worse than one.
- Does the loop terminate in every case it now claims to, under `set -uo pipefail` with `set -e`
  not in force?
- `$$` and `$RANDOM` as the uniqueness source, given one process per review, spawned by ralphex
  through a `.cmd` through Git Bash. `$RANDOM` is seeded per process — is `$$` doing real work
  here, or is it decoration?
- `NEW_LOG` lifetime: declared before the trap that removes it, assigned later, and the trap also
  runs on the early-exit paths that precede the assignment.
- Whether each of the six subtests would fail if the behaviour it names regressed, and whether
  the new `taken` mode's assertions hold for the reason its name gives.
- Anything in the test that depends on this machine, this clock, or process scheduling rather
  than on the code.
