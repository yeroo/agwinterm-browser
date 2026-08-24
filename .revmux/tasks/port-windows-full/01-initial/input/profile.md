# Project conventions

winterm-browser is a Windows-native port. Its conventions are inherited from two places, and where
they disagree with general taste, they win.

## From upstream terminal-browser, which is vendored into this tree

- Rust: `cargo nextest run --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo fmt --all --check`. Warnings are errors.
- `pixel-core` lints deny undocumented unsafe blocks and warn on `unsafe_code` crate-wide. A port
  that reaches for Win32 will need unsafe; it must be documented to build.
- TypeScript packages test with `node --test`.
- 37 upstream Rust source files carry tests. They are the regression net for the modules this port
  claims not to touch.

## From agwinterm, the host terminal this port renders into

- The control API is a versioned contract. `tests/conformance/control-api.json` is shared with a
  second product (agliteterm) and running in both repositories' CI, so a verb added there breaks a
  project that does not implement it.
- Never test against the real running instance or its data dir. A Debug build gets instance id
  `agwinterm-dev` with its own pipe and data dir; routing must be verified before results are
  trusted. Running against the real data dir has destroyed real user session state before.
- MSBuild silently serves stale DLLs in several documented ways. "It builds" is not evidence the
  new code ran.

## How this project is built

ralphex executes plans autonomously, task by task. revmux is meant to review every plan and every
diff before it is accepted; `.revmux/` is committed, so the review standard is versioned with the
code. For this port that second half did not happen, which is what this round is correcting.

Testing is regular, not TDD: code first, then tests. That was chosen deliberately for work whose
interfaces are discovered by making them run, so "the test was written after the code" is not by
itself a finding. A test that cannot fail, or that exercises a stub the real implementation
replaced, is.

A checked-in lens is executed by a headless agent with a shell. Treat `.revmux/` as code.
