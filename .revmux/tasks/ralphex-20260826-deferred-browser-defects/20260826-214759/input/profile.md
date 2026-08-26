# Project conventions

winterm-browser is a Windows-native port, and its conventions are inherited
from upstream terminal-browser, which is vendored here. Where they disagree
with general taste, they win.

## Build and test

```bash
cargo nextest run --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

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
