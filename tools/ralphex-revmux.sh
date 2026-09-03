#!/usr/bin/env bash
# Bridge: make revmux serve as ralphex's external review tool.
#
# ralphex calls this with exec.Command(script, promptFile) — no shell, one argument,
# stdout and stderr merged and streamed line by line. It watches the stream for
# <<<RALPHEX:CODEX_REVIEW_DONE>>>, which we must emit exactly once when finished.
#
# The prompt file ralphex hands us is its rendered custom_review.txt: it already
# contains the goal, the git diff command for this iteration, the plan path and the
# progress log. That is very nearly a revmux scope, so we pass it through as one
# rather than reconstructing it.
#
# Wire it up with, in .ralphex/config:
#     external_review_tool = custom
#     custom_review_script = <repo>/tools/ralphex-revmux.cmd
#
# Invoked on Windows through the .cmd sibling, because exec.Command cannot run a
# .sh directly there.

set -uo pipefail

PROMPT_FILE="${1:-}"
DONE_SIGNAL='<<<RALPHEX:CODEX_REVIEW_DONE>>>'

# Always emit the completion signal, on every exit path. Without it ralphex waits
# out its idle timeout on a review that already finished.
NEW_LOG=""
finish() {
  if [ -n "$NEW_LOG" ]; then rm -f "$NEW_LOG"; fi
  printf '%s\n' "$DONE_SIGNAL"
}
trap finish EXIT

if [ -z "$PROMPT_FILE" ] || [ ! -f "$PROMPT_FILE" ]; then
  echo "ralphex-revmux: no prompt file passed (got '${PROMPT_FILE}')" >&2
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || REPO_ROOT="$PWD"
cd "$REPO_ROOT" || exit 0

command -v revmux >/dev/null 2>&1 || { echo "ralphex-revmux: revmux not on PATH" >&2; exit 0; }

# Profile: comprehensive is the diff-shaped roster (bugs+impl, arch+quality,
# docs+tests on claude plus an adversarial codex peer). Override per repo with
# RALPHEX_REVMUX_PROFILE.
PROFILE="${RALPHEX_REVMUX_PROFILE:-comprehensive}"
MIN_CONFIDENCE="${RALPHEX_REVMUX_MIN_CONFIDENCE:-60}"
# revmux's default hard timeout is 20m per agent attempt, which a wide diff
# exceeds — this repo's own manual round was given 40m for exactly that reason.
# An agent killed mid-read reports nothing, so a review that silently covered
# less looks identical to a clean one.
HARD_TIMEOUT="${RALPHEX_REVMUX_HARD_TIMEOUT:-40m}"

# One revmux task per plan, one run per review iteration. Keeping the task stable
# across iterations is the point: revmux carries earlier rounds into every later
# prompt, so iteration 2 knows what iteration 1 already reported.
PLAN_NAME="$(grep -m1 -oE '[^ /\\]+\.md' "$PROMPT_FILE" 2>/dev/null | head -1 | sed 's/\.md$//')"
[ -z "$PLAN_NAME" ] && PLAN_NAME="review"
TASK="ralphex-${PLAN_NAME}"
# The timestamp reads well in a directory listing but is not unique: two external
# reviews can open in the same second under the same deterministic task name, and
# revmux refuses the second. The PID plus bash's per-process $RANDOM separates
# concurrent callers, and the attempt suffix guarantees that a collision revmux
# does report gets a genuinely fresh name to retry with.
#
# Worth retrying rather than giving up, because of the trap above: every failure
# path here exits 0 having printed the done signal, so a collision left unretried
# reaches ralphex as a review that ran and found nothing.
#
# Every failure retries, deliberately, rather than only the ones that read like a
# taken name. The ported version gated the retry on
# `grep -Eqi 'already exists|duplicate|collision'` and revmux says none of those:
# its four refusals are "has already run", "is being written by a run holding it",
# "was claimed by a run that never came back" and "is reserved", so the gate was
# dead on arrival and would have gone dead again on the next wording change,
# silently and in the direction of a review that looks clean. Two of those
# messages end by advising "open a new round instead", which is what a retry does.
# A failure a new name cannot cure costs two extra sub-second calls; the attempt
# cap is what bounds this, not the wording.
RUN_STAMP="$(date +%Y%m%d-%H%M%S)"
NEW_LOG="$(mktemp)" || { echo "ralphex-revmux: could not allocate revmux-new log" >&2; exit 0; }
PATHS_JSON=""
NEW_OK=false
for attempt in 1 2 3; do
  RUN="$RUN_STAMP-$$-${RANDOM:-0}-$attempt"
  # The 2> below opens with O_TRUNC before revmux execs, so only the last attempt's
  # refusal survives to the tail. That is the intent, but it is the redirect doing
  # it, not a separate truncation: an edit to 2>> would silently change what gets
  # reported and nothing here would look wrong.
  if PATHS_JSON="$(revmux new --task "$TASK" --run "$RUN" 2>"$NEW_LOG")"; then
    NEW_OK=true
    break
  fi
done
if [ "$NEW_OK" != true ]; then
  # revmux's own words. The old code discarded them with 2>/dev/null: the log said
  # "revmux new failed" and never which refusal caused it, so a misconfigured panel
  # could not be told from a transient collision without opening the round
  # directory. It is the trap at :32, not this redirect, that makes a bridge which
  # failed here and a review that found nothing read alike.
  tail -n 20 "$NEW_LOG" >&2
  echo "ralphex-revmux: revmux new failed after $attempt attempts" >&2
  exit 0
fi

# Take the scope path out of revmux's payload rather than joining it by hand.
pluck() {
  printf '%s' "$PATHS_JSON" \
    | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\(.*\)\".*/\1/p" \
    | head -1 | sed 's/\\\\/\//g'
}
SCOPE="$(pluck scope)"
# revmux allocates a profile file beside the scope. Left unwritten, every
# reviewer runs with this project's conventions empty, and the panel spends
# every round re-reporting the same non-findings.
PROFILE_MD="$(pluck profile)"
[ -z "$SCOPE" ] && { echo "ralphex-revmux: could not read scope path from revmux new" >&2; exit 0; }

{
  echo "# Review scope (handed over by ralphex)"
  echo
  echo "This round was opened automatically by ralphex's external review phase for the"
  echo "task it just implemented. Everything below is ralphex's own review prompt,"
  echo "verbatim — it carries the goal, the exact diff command for this iteration, and"
  echo "the paths to the plan and the progress log."
  echo
  echo "Review the diff it names. The plan file states what the task was supposed to do;"
  echo "a change that works but does not match the plan is a finding worth reporting."
  echo
  echo '---'
  echo
  cat "$PROMPT_FILE"
} > "$SCOPE" 2>/dev/null || { echo "ralphex-revmux: could not write scope" >&2; exit 0; }

# The conventions every reviewer is held to, in revmux's own profile slot. Kept
# apart from the scope because it describes the REPOSITORY rather than this
# diff: what the harness can and cannot do, and what counts as a finding here.
if [ -n "$PROFILE_MD" ]; then
  cat > "$PROFILE_MD" <<'CONVENTIONS' || \
    echo "ralphex-revmux: could not write profile (continuing)" >&2
# Project conventions

agwinterm-browser is a Windows-native port, and its conventions are inherited
from upstream terminal-browser, which is vendored here. Where they disagree
with general taste, they win.

## Build and test

```bash
cargo nextest run --workspace                    # from engine/
python tools/vendor-check/fmt-scope.py           # from the repo root
python tools/vendor-check/clippy-scope.py
node.exe --test "tools/*/*.test.mjs"
```

`cargo fmt --all --check` **fails on this tree by design**, and so does a bare
`cargo clippy`: the vendored tree is not rustfmt-clean, and reformatting it is
the silent edit the port's Constraints forbid. The two scoped scripts are the
real gate — they attribute each complaint to a vendored or a port line by
`git blame`, and only port lines count. A complaint on a vendored line is not a
finding; do not report it, and do not conclude the tree is broken.

Warnings are errors. `pixel-core` denies undocumented unsafe blocks and warns
on `unsafe_code` crate-wide; a port that adds unsafe must document it.

For the Node-side tools, invoke `node.exe` directly rather than `node`: the
shell aliases it to `winpty node.exe`, which fails non-interactively with
"stdout is not a tty" and exits non-zero even when every test passes.

## What is worth reporting

- Real defects: wrong behaviour, dropped data, panics, silent fallbacks that
  hide a caller's mistake.
- Anything crossing the C# boundary or touching shared memory by hand —
  lifetime and ownership errors there are the severest class in this repo.
- A change that works but does not match the plan it was built from, and a plan
  or doc left describing a world the code no longer has.
- Missing tests for a code path the change introduced.

## What is not

- Style preferences, naming, comment density. Upstream's conventions are
  settled and matching them beats improving them.
- Anything the plan file lists as out of scope or deferred, or argues against
  as a recorded decision.
CONVENTIONS
fi

echo "ralphex-revmux: running revmux (profile=$PROFILE, task=$TASK, run=$RUN)" >&2

# Verify the wiring without paying for a panel: RALPHEX_REVMUX_DRY_RUN=1 stops here,
# having proven the argument arrived, the round was created and the scope was written.
if [ "${RALPHEX_REVMUX_DRY_RUN:-0}" = "1" ]; then
  echo "ralphex-revmux: DRY RUN — round created, scope written, revmux not invoked" >&2
  echo "scope: $SCOPE" >&2
  echo "NO ISSUES FOUND"
  exit 0
fi

# revmux exits nonzero when it HAS findings — that is a normal review outcome, not a
# failure, so the status is deliberately not propagated. ralphex reads the findings
# off stdout.
revmux --task "$TASK" --run "$RUN" \
       --profile "$PROFILE" \
       --min-confidence "$MIN_CONFIDENCE" \
       --hard-timeout "$HARD_TIMEOUT" \
       --markdown --no-tui \
       --workdir "$REPO_ROOT" 2>&1 || true

exit 0
