---
description: the run-name collision fix ported into the ralphex → revmux bridge, and its first test
branch: bridge-collision-retry
base: 96fa204
---

Two rounds on `tools/ralphex-revmux.sh` and the new `tools/ralphex/bridge.test.mjs`.

The change started as a port of agwinterm `05117b5` (2026-08-31, branch
`feat/image-frameshm-control`), which gave the bridge's run name a `-<pid>-<$RANDOM>-<attempt>`
suffix and retried a refused name. agwinterm hit the collision in production; this repo had the
same bare `date +%Y%m%d-%H%M%S` run name and the same deterministic per-plan task name.

## What the rounds found

**01-initial** — one Major: the ported retry was gated on
`grep -Eqi 'already exists|duplicate|collision'`, and revmux emits none of those. Its four
refusals for a run name it will not open are "has already run", "is being written by a run
holding it", "was claimed by a run that never came back" and "is reserved". The retry was inert,
and it failed into the bridge's always-exit-0 path, which reaches ralphex as a review that ran
and found nothing. Confirmed against the binary with `grep -aoE`.

The fix deletes the wording match rather than correcting it: a gate keyed on another tool's prose
dies silently on the next wording change, and dies toward a review that looks clean. The attempt
cap bounds the loop; the wording never did.

Two of round 01's other findings were accepted (a fabricated rationale in a comment, no coverage
for the exhaustion exit). One was **rejected with evidence**: `pluck`'s `sed 's/\\\\/\//g'` was
called the one transformation between revmux's payload and a usable `$SCOPE`, but msys collapses
a doubled separator on its own — `bash -c 'echo hi > "$1"' _ 'C:\\Users\\...\\x'` lands on
`/c/Users/.../x` — so the sed is defensive and deleting it leaves every subtest green because it
leaves the bridge working. The test says so outright rather than claiming the conversion is
pinned.

**02-corrected** — no Major. Three Minors, all in the corrections themselves: the fabricated
rationale survived its own rewrite and had been copied into the test; subtest 4's `spawnSync`
carried no `timeout`, so the unbounded-loop mutation it existed to catch would wedge the suite
rather than redden it; and one of the stub's four refusals was invented wording, in a file whose
header claims all of them are verbatim.

Also raised, pre-existing and fixed here because it misdirects every future panel: the conventions
block this bridge writes into revmux's profile slot told reviewers to run
`cargo fmt --all --check`, a gate this tree cannot pass by design. It now names
`fmt-scope.py` / `clippy-scope.py` and says vendored-line complaints are not findings.

## Mutation evidence

- Restore the dead wording gate → subtests 3, 4 red.
- Unbounded loop carrying its own counter → subtests 4, 5, 6 red after 3 × 30s. Before the
  `timeout:` was added this hung indefinitely; `set -u` catches only the naive `while true`.
- Revert the whole hunk → subtests 2, 3, 5 red.
- Delete `pluck`'s sed → all green, by design. See the rejection above.
