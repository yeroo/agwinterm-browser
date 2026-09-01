// The ralphex -> revmux bridge, driven for real: bash runs tools/ralphex-revmux.sh
// with a stub `revmux` on PATH and RALPHEX_REVMUX_DRY_RUN=1, which stops the script
// once the round has been opened and the scope written.
//
// That window is the whole subject here. The bridge's trap prints
// <<<RALPHEX:CODEX_REVIEW_DONE>>> and exits 0 on every failure path, deliberately —
// ralphex would otherwise sit out its idle_timeout on a review that already
// finished. The cost is that a bridge which never opened a round looks exactly like
// a review that found nothing. So the failure paths are worth pinning: how many
// times a refusal is retried, and whether revmux's explanation survives to stderr.
//
// Ported from agwinterm, which hit the collision this covers (05117b5, 2026-08-31).
//
// The stub answers in revmux's own words, taken verbatim from the binary the bridge
// calls (`C:\Users\boris\go\bin\revmux.exe`, read with `grep -aoE`). That matters:
// the ported retry was gated on wording revmux never emits, and a stub written to
// satisfy the gate rather than to imitate the tool is what let it look tested.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BRIDGE = path.join(REPO, "tools", "ralphex-revmux.sh");

// The same two locations tools/ralphex-revmux.cmd looks in, in the same order.
const BASH = [
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
].find((p) => existsSync(p));

// A bash-side path, for the one place inside the stub's own shell body that needs one.
const slash = (p) => p.replaceAll("\\", "/");
// A JSON-escaped Windows path: what revmux really prints, verified against a live
// `revmux new` — "C:\\Users\\boris\\source\\...".
//
// `pluck` converts those separators to forward slashes, but that substitution is
// defensive rather than load-bearing, and no assertion below pins it: msys collapses
// a doubled separator on its own, so bash writes "C:\\Users\\x" and "C:/Users/x" to
// the same file. Deleting the sed leaves every subtest green because it leaves the
// bridge working. The stub emits the real shape anyway — a fixture that quietly
// sidesteps the separator handling is how this tree has been bitten before.
const jsonWinPath = (p) => p.replaceAll("\\", "\\\\");

// Verbatim revmux refusals. The first three are the ones a taken run name draws;
// each is a separate code path in revmux, and none of them contains "already
// exists", "duplicate" or "collision".
const TAKEN = [
  'round %RUN% has already run, report.md is in place: a round that went badly is exactly the one a later reflection agent reads, so it is never reused',
  'round %RUN% is being written by a run holding it: two runs sharing a round truncate each other\'s artifacts, so open a new round instead',
  'round %RUN% was claimed by a run that never came back and still holds what it wrote (findings.json): re-using it would put two runs\' artifacts under one round, so open a new round instead',
];
// A refusal no fresh name can cure, for contrast. Also verbatim — revmux's roster
// lookup says `profile %q, have %s`.
const HOPELESS = 'profile "comprehensive", have expert';

// Stub revmux. `new` records every run name it is offered, then answers per mode:
//   accept   - always succeeds
//   collide  - refuses attempt 1 only, so the retry finds a free name
//   taken    - refuses every attempt, a different real refusal each time
//   fail     - refuses everything, for a reason a fresh name would not cure
//
// The JSON heredoc is quoted, so bash does not touch the backslashes; the paths are
// escaped on the JS side instead. One key per line because that is what `pluck` can
// read: its sed capture is greedy, so a single-line object would hand it everything
// from the first value to the last quote.
function stubRevmux(dir, scope, profile) {
  const say = (i) => TAKEN[i].replaceAll("'", "'\\''");
  return `#!/usr/bin/env bash
set -u
LOG="${slash(dir)}/calls.log"
if [ "\${1:-}" != "new" ]; then exit 0; fi
RUN=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--run" ]; then RUN="\${2:-}"; fi
  shift
done
printf '%s\\n' "$RUN" >> "$LOG"
ATTEMPT="\${RUN##*-}"
refuse() { printf '%s\\n' "\${1//%RUN%/$RUN}" >&2; exit 1; }
case "\${STUB_MODE:-accept}" in
  collide) [ "$ATTEMPT" = 1 ] && refuse '${say(1)}' ;;
  taken)
    case "$ATTEMPT" in
      1) refuse '${say(0)}' ;;
      2) refuse '${say(1)}' ;;
      *) refuse '${say(2)}' ;;
    esac
    ;;
  fail) refuse '${HOPELESS.replaceAll("'", "'\\''")}' ;;
esac
cat <<'JSON'
{
  "scope": "${jsonWinPath(scope)}",
  "profile": "${jsonWinPath(profile)}"
}
JSON
`;
}

function runBridge(mode) {
  const dir = mkdtempSync(path.join(tmpdir(), "ralphex-bridge-"));
  mkdirSync(path.join(dir, "bin"));

  const scope = path.join(dir, "scope.md");
  const profile = path.join(dir, "profile.md");
  writeFileSync(path.join(dir, "bin", "revmux"), stubRevmux(dir, scope, profile));

  // What ralphex hands over is its rendered custom_review.txt; the bridge only reads
  // a plan name out of it, which is what makes the task name deterministic per plan.
  const prompt = path.join(dir, "prompt.txt");
  writeFileSync(prompt, "Review docs/plans/20260826-deferred-browser-defects.md against the diff.\n");

  // The real entry point is tools/ralphex-revmux.cmd:14 — `"%BASH%" "%~dp0ralphex-revmux.sh" %1`
  // — so bash is handed two native backslash paths, not the forward-slash form a
  // test would reach for. Keep them that way, and refuse to run if a future edit
  // normalises them: a fixture without separators cannot exercise the path handling
  // it exists to cover. tools/launcher/launch.test.mjs:253 guards the same way.
  assert.ok(BRIDGE.includes("\\") && prompt.includes("\\"), "fixtures must keep their separators");
  assert.ok(scope.includes("\\"), "the scope path must reach pluck with separators to convert");

  // spawnSync blocks the event loop, so node's --test-timeout can never fire against
  // it — an unbounded child is not slow but stuck, and it takes the whole run down
  // with it (tools/lib/deadline.test.mjs:3-11 records the eighteen-hour version of
  // that). This bound is what lets subtest 4 report an unbounded retry loop as a red
  // assertion instead of wedging on it. 30s matches tools/cli/unsupported.test.mjs:104.
  const res = spawnSync(BASH, [BRIDGE, prompt], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
      STUB_MODE: mode,
      RALPHEX_REVMUX_DRY_RUN: "1",
    },
  });
  // Name the timeout rather than letting it surface as a puzzling assertion failure
  // three lines later: on timeout status is null and signal is set.
  assert.equal(res.error ?? null, null, `the bridge did not return: ${res.error?.message}`);
  assert.equal(res.signal, null, `the bridge was killed after ${30_000}ms — it did not terminate`);

  const calls = existsSync(path.join(dir, "calls.log"))
    ? readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter(Boolean)
    : [];

  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    calls,
    scopeWritten: existsSync(scope) ? readFileSync(scope, "utf8") : null,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("the ralphex -> revmux bridge", { skip: BASH ? false : "git bash not installed" }, async (t) => {
  await t.test("opens a round and writes the scope ralphex's prompt becomes", () => {
    const r = runBridge("accept");
    t.after(r.cleanup);

    assert.equal(r.status, 0);
    assert.equal(r.calls.length, 1, "one revmux new for one review");
    assert.match(r.stdout, /<<<RALPHEX:CODEX_REVIEW_DONE>>>/);
    // The scope landing where revmux said it would covers pluck end to end: the
    // greedy sed capture found the right key, and the escaped Windows path the stub
    // emitted reached bash as something it could write to.
    assert.ok(r.scopeWritten, "the scope file revmux allocated was written");
    assert.match(r.scopeWritten, /20260826-deferred-browser-defects\.md/);
  });

  await t.test("the run name is not just the second the review started in", () => {
    const r = runBridge("accept");
    t.after(r.cleanup);

    // Bare `date +%Y%m%d-%H%M%S` and nothing else is the shape that collided:
    // two reviews of one plan opening in the same second ask for one name.
    assert.doesNotMatch(r.calls[0], /^\d{8}-\d{6}$/, `run name was bare: ${r.calls[0]}`);
    assert.match(r.calls[0], /^\d{8}-\d{6}-\d+-\d+-1$/, `unexpected run name: ${r.calls[0]}`);
  });

  await t.test("a taken name is retried under a fresh one, not reported as a clean review", () => {
    const r = runBridge("collide");
    t.after(r.cleanup);

    assert.equal(r.status, 0);
    assert.equal(r.calls.length, 2, "the refused name was retried exactly once");
    assert.notEqual(r.calls[0], r.calls[1], "the retry asked for a different name");
    assert.ok(r.calls[1].endsWith("-2"), `retry kept attempt 1's name: ${r.calls[1]}`);
    assert.ok(r.scopeWritten, "the round opened on the retry, so the review is real");
  });

  await t.test("a name refused three times gives up bounded, and says why", () => {
    const r = runBridge("taken");
    t.after(r.cleanup);

    // The exhaustion exit: three names offered, all refused, no round opened.
    // Unbounded retrying here would hang the pane instead — nothing reaches stdout
    // while it spins, so ralphex waits out the full idle_timeout that the
    // always-exit-0 design exists to prevent.
    assert.equal(r.calls.length, 3, "the attempt cap did not hold");
    assert.equal(new Set(r.calls).size, 3, "an attempt reused a name already refused");
    assert.equal(r.scopeWritten, null, "no round opened, so nothing was reviewed");
    assert.match(r.stderr, /was claimed by a run that never came back/, "last refusal reached stderr");
    assert.match(r.stderr, /revmux new failed after 3 attempts/);
    assert.equal(r.status, 0);
  });

  await t.test("revmux's own explanation reaches stderr when the round cannot open", () => {
    const r = runBridge("fail");
    t.after(r.cleanup);

    // Without this the progress log carries "revmux new failed" and never which
    // refusal caused it, so a misconfigured panel cannot be told from a transient
    // collision without opening the round directory.
    assert.match(r.stderr, /profile "comprehensive", have expert/);
    assert.match(r.stderr, /ralphex-revmux: revmux new failed/);
  });

  await t.test("even a bridge that opened nothing still releases ralphex", () => {
    const r = runBridge("fail");
    t.after(r.cleanup);

    // Deliberate, and the reason every case above checks what reached stderr:
    // this signal is all ralphex sees, so it cannot tell these apart itself.
    assert.equal(r.status, 0);
    assert.match(r.stdout, /<<<RALPHEX:CODEX_REVIEW_DONE>>>/);
  });
});
