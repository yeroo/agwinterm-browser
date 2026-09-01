# Project conventions

winterm-browser is a Windows-native port of upstream terminal-browser, which is vendored here.
Where upstream's conventions disagree with general taste, upstream wins.

This particular change is in **harness code** — the plumbing that reviews the repository — not in
the product. Judge it as tooling: its job is to fail loudly and never to fail quietly.

## The platform, which is most of what bites here

Windows 11, no WSL. The shell is Git Bash for `.sh` files and PowerShell otherwise.

- Invoke `node.exe`, not `node`. The shell aliases `node` to `winpty node.exe`, which refuses
  redirected stdout with "stdout is not a tty" and exits non-zero even when every test passes.
- `.sh` files are reached through a `.cmd` shim because Go's `exec.Command` cannot run a `.sh`
  directly on Windows. `tools/ralphex-revmux.cmd` locates `bash.exe` under `%ProgramFiles%\Git`.
- Paths cross three quoting layers (cmd → bash → node). Backslash handling is a real and
  recurring source of defects in this tree; a test that silently normalises a path away is worse
  than no test. `tools/launcher/launch.test.mjs` carries a guard for exactly that reason.

## Build and test

```bash
node.exe --test "tools/*/*.test.mjs"     # the Node-side tools: 558 tests
cargo nextest run --workspace            # from engine/
python tools/vendor-check/fmt-scope.py   # from the repo root
python tools/vendor-check/clippy-scope.py
```

`cargo fmt --all --check` **fails on this tree by design** — vendored code is not reformatted.
The scoped scripts are the real gate: they attribute each complaint to a vendored or a port line
by `git blame`, and only port lines count. Do not report vendored-line complaints.

Warnings are errors on the Rust side. Neither language is touched by this change.

## What is worth reporting

- Real defects: wrong behaviour, dropped data, silent fallbacks that hide a caller's mistake.
  A silent fallback is the severest class in *this* file specifically — see the scope.
- Shell quoting, word splitting and unset-variable handling. `set -uo pipefail` is in force;
  `set -e` is not, so a failing command mid-script continues unless its status is checked.
- A test that cannot fail, asserts something other than what its name claims, or passes for a
  reason unrelated to the code — including one that depends on this machine, this clock, or
  process scheduling.
- A comment or doc left describing a world the code no longer has. Comments in this tree are
  load-bearing: several carry the incident that motivated the code, and a fabricated rationale
  in one has been a reported finding twice before in this repository.
- Missing coverage for a path the change introduced.

## What is not

- Style preferences, naming, comment density. Matching the surrounding code beats improving it.
- Anything the scope lists as known, deferred, or as a recorded decision.
- Pre-existing behaviour the change did not touch, unless the change makes it newly reachable
  or newly dangerous.

## Severity

Findings here are almost certainly Minor by product standards — this is a 35-line shell hunk and
a test file. Rank them against each other rather than inflating them, and say plainly when the
honest answer is that the change is correct. A confirmed "this is fine, and here is what I ran
to check" is a useful outcome; a padded list is not.
