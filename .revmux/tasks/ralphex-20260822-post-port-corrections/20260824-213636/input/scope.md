# Review scope (handed over by ralphex)

This round was opened automatically by ralphex's external review phase for the
task it just implemented. Everything below is ralphex's own review prompt,
verbatim — it carries the goal, the exact diff command for this iteration, and
the paths to the plan and the progress log.

Review the diff it names. The plan file states what the task was supposed to do;
a change that works but does not match the plan is a finding worth reporting.

---

You are reviewing code changes for: implementation of plan at C:\Users\boris\source\winterm-browser\docs\plans\20260822-post-port-corrections.md

## Get the Diff

Run this command to see the changes:
git diff

## Review Focus

Analyze the code for:

1. Bugs and logic errors - incorrect behavior, edge cases, null/nil handling
2. Security issues - injection, XSS, secrets exposure, improper validation
3. Race conditions - concurrent access, shared state, missing synchronization
4. Error handling - silent failures, ignored errors, missing fallbacks
5. Test coverage - missing tests, inadequate edge case coverage
6. Code quality - unnecessary complexity, poor naming, unclear logic

## Output Format

Report issues as a structured list:

- file:line - description of issue
- file:line - description of issue

If no issues found, output: NO ISSUES FOUND

## Previous Review History

Check the progress log at C:\Users\boris\source\winterm-browser\.ralphex\progress\progress-20260822-post-port-corrections-review.txt for previous review iterations and findings history before reporting issues.

## Important

- Focus on real problems, not style preferences
- Check if issues are already mitigated in the code
- Only report issues you can verify by reading the actual code
- Be specific about file paths and line numbers

---
PREVIOUS REVIEW CONTEXT:
Claude (previous reviewer) responded to your findings:

I'll examine each finding at its reported location.Now the Rust twin:Now the two doc fixes:Now verify — build, lint, and run both test suites:All three minor findings were valid and are fixed. The immaterial one I agree should stay unfixed — reasoning below.

Fixed

1. KELVIN SIGN example named a string with no K in it — confirmed and fixed in both copies.
   - Verified AGWINTERM-DEV is A G W I N T E R M - D E V: no K. U+212A lowercases to k, so the named string does not exist, and the plain-ASCII AGWINTERM-DEV is precisely the case eq_ignore_ascii_case does match — the reverse of the claim.
   - Independently re-ran the homoglyph scan over U+0080–U+2FFFF: zero code points whose toLowerCase() is a single character occurring in agwinterm-dev, so no substitute code point rescues the name.
   - cli/src/pane.ts:183 and engine/crates/pixel-core/src/agwinterm.rs:340 now use AGWINTERM-KIOSK with its first K written as U+212A, against a pipe of agwinterm-kiosk. Verified the instance is real in both directions: "AGWINTERM-KIOS\u212A".toLowerCase() === "agwinterm-kiosk" (CLI admits), and it is 17 UTF-8 bytes against the pipe's 15 (eq_ignore_ascii_case cannot match). Both comments now state the byte counts so the next reader can check the example without re-deriving it.
   - cli/src/unsupported.ts's copy only cross-references pane.ts and carries no example, so it needed no change.

2. README test count stale — fixed. README.md:31 now reads 452 Rust tests and 365 node tests. I measured rather than copied: node --test "tools/*/*.test.mjs" reports 365 passed / 88 suites, and cargo nextest run --workspace reports 452 passed, 1 skipped. Both match docs/design/06-acceptance.md:213. The other 364 in that doc (line 206) is the historical 2026-08-21 cargo test count, not a node count, so it stays.

3. "The five rounds below" above six paragraphs — fixed. Confirmed the paragraphs beneath line 293 are second (295), third (304), fourth (313), fifth (322), sixth (340) and seventh (355) — six. Changed to "The six rounds below".

Not fixed, and I think correctly so

4. Unicode-aware CLI folding diverges from the engine's ASCII-only comparison (adversarial, immaterial). The divergence is real, but the release-build half of the claim is wrong. pipe_refusal opens with if !dev_build { return None; } (agwinterm.rs:298-300) and is passed cfg!(debug_assertions), so in a release build the engine does not consult the allow-list at all — it admits every pipe, and the CLI cannot be "more permissive than its engine-equivalent parser" because no engine-side parser runs. In a debug build the CLI allows and the engine refuses with an explicit PermissionDenied naming the variable: fail-closed, no wrong pane drawn. The trigger requires a developer to type a non-ASCII homoglyph into TERMINAL_BROWSER_ALLOW_PIPE. The proposed fix means hand-mirroring an ASCII-only fold across two TypeScript copies and the Rust twin plus their tests — three readers in two languages — which widens the drift surface it is meant to close, against a consequence nobody observes. The comment now documents the asymmetry, which is the proportionate response.

Verification (all from a clean rebuild — the comment edit to cli/src/pane.ts made cli/dist stale and tools/lib/built.mjs correctly failed the acceptance suite until I ran corepack pnpm -r build):
- node --test "tools/*/*.test.mjs": 365 passed, 0 failed, 88 suites
- cargo nextest run --workspace: 452 passed, 1 skipped
- cargo clippy --workspace --all-targets and cargo fmt --all --check: zero complaints referencing agwinterm.rs; remaining warnings are the pre-existing ones in untouched inherited files
- tsc via the workspace build: clean

Not committed — leaving the working tree for the next review iteration.

Re-evaluate considering Claude's arguments. If Claude's fixes are correct, acknowledge them.
If Claude's arguments are invalid, explain why the issues still exist.