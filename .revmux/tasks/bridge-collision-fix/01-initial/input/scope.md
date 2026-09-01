# Item under review: a collision fix ported into the ralphex → revmux bridge

Two changes, both uncommitted, in the working tree of branch `main`:

```
git diff -- tools/ralphex-revmux.sh      # 35 insertions, 5 deletions — the fix
cat tools/ralphex/bridge.test.mjs        # new, untracked — the test for it
```

The second file is **untracked**, so `git diff` will not show it. Read it from disk.

Nothing else in the tree is under review. `git status --short` should show exactly
`M tools/ralphex-revmux.sh` and `?? tools/ralphex/`.

## What the bridge is

`tools/ralphex-revmux.sh` (invoked on Windows through its `.cmd` sibling) makes revmux serve as
ralphex's external review tool. ralphex runs it with `exec.Command(script, promptFile)`, merges
stdout and stderr, and watches the stream for `<<<RALPHEX:CODEX_REVIEW_DONE>>>`.

The script's governing design decision, which predates this change: a `trap finish EXIT` prints
that done-signal and the script exits 0 on **every** path, success or failure. That is deliberate
— without it ralphex sits out its `idle_timeout` on a review that already finished. The cost is
that a bridge which never opened a round is, to ralphex, indistinguishable from a review that
found nothing. Every failure path is therefore a silent-success path, and that is the property
the change is trying to make less dangerous.

`.ralphex/config` names the `.cmd`; this repo has run four ralphex plans through it, most
recently three external rounds under `.revmux/tasks/ralphex-20260826-deferred-browser-defects/`.

## What changed

1. **Run-name collision.** The run name was `$(date +%Y%m%d-%H%M%S)` and nothing else. The task
   name is deterministic per plan (`ralphex-<plan stem>`), so two external reviews of the same
   plan opening in the same second ask revmux for the same run and the second is refused — and
   refused into the silent-success path above. It is now
   `<timestamp>-<pid>-<$RANDOM>-<attempt>`, retried up to three times, and the retry fires only
   when revmux's stderr matches `already exists|duplicate|collision`.

2. **Discarded stderr.** `revmux new` was called with `2>/dev/null`. Its stderr is now captured
   to a temp file and the last 20 lines are echoed on failure. The temp file is removed in the
   `finish` trap.

## Where it came from

Ported from the sibling repository `agwinterm`, commit `05117b5` (2026-08-31), on branch
`feat/image-frameshm-control` — `C:\Users\boris\source\agwinterm`. That repo hit the collision
in production. Its copy of the script has diverged in other ways; **only** the run-name and
stderr changes were taken. Reading agwinterm's version alongside this one is encouraged.

One divergence was deliberate and is not an oversight: agwinterm derives its task name as
`ralphex-<slug>-<sha256 prefix>`, this repo keeps `ralphex-<plan stem>`. Changing it here would
orphan the existing `.revmux/tasks/ralphex-*` directories, and carrying earlier rounds into
later prompts is the reason the task name is stable across iterations. Do not report it.

## The test

`tools/ralphex/bridge.test.mjs` is this repo's first coverage of the bridge. It runs the real
script under Git Bash with a stub `revmux` first on `PATH` and `RALPHEX_REVMUX_DRY_RUN=1`, which
halts the script once the round is open and the scope written. Three stub modes: `accept`,
`collide` (refuses any run name ending `-1`, with revmux's wording for a taken name), `fail`
(refuses everything, for a reason a fresh name would not cure).

Verified red against the unpatched script before it went green: subtests 2, 3 and 5 fail at
`HEAD`, subtests 1, 4 and 6 pass either way because they pin behaviour that already existed.

Run it:

```
node.exe --test tools/ralphex/bridge.test.mjs
node.exe --test "tools/*/*.test.mjs"          # 558 tests, 558 pass
```

Use `node.exe`, not `node` — the shell aliases the latter to `winpty node.exe`, which fails
non-interactively with "stdout is not a tty" and exits non-zero even when every test passes.

## Known and already recorded — do not report these

- The always-exit-0 / always-print-done-signal behaviour. It is intentional, documented in the
  script, and subtest 6 pins it. Reasoning about what it makes *invisible* is in scope; calling
  the behaviour itself a defect is not.
- `pluck`'s sed capture is greedy, so it only works because revmux prints its JSON one key per
  line. The stub reproduces that shape. This is a pre-existing latent fragility, already noted,
  and not part of this change.
- The task-name divergence from agwinterm, above.

## Worth attacking

- Does the retry loop actually retry the case it claims to, and terminate in the cases it
  claims to? `set -uo pipefail` is in force and `set -e` is not.
- `$RANDOM` and `$$` as a uniqueness source under this script's real invocation — one process
  per review, spawned by ralphex through a `.cmd` wrapper through Git Bash.
- The `NEW_LOG` lifetime: it is declared before the trap that removes it, assigned later, and
  the trap also runs on the early-exit paths that precede the assignment.
- Whether the six subtests assert what their names claim, and whether any of them would still
  pass if the fix were reverted in a way the author did not try. The red-then-green evidence
  above covers exactly one mutation — reverting the whole hunk.
- Anything in the new test that depends on this machine rather than on the code.
