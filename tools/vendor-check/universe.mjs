// "Which files did the port promise not to touch?" — answered by git, not by a list.
//
// The guard this directory exists for used to scope itself with a checked-in
// inventory of `pixel-core/src`. That worked for the one tree someone remembered to
// write down, and covered nothing else: `pixel-node/src`, `pixel-react` and the two
// `Cargo.toml` files were vendored upstream code with no baseline check at all. The
// defect was never "two trees were forgotten" — it was that a hand-maintained list
// decided what got checked, and lists rot.
//
// So the scope comes from the vendoring commit. Every path `45b5e43` introduced is
// in the universe by construction, with nobody to remind. What a human still owns is
// the *exceptions*, and those are here as declarations with a reason each, so an
// exclusion is a decision on the record rather than an absence.
//
// Note the edge of that, because it is the one thing this scope cannot do: a file
// vendored *later* is not in the universe, since the universe is one commit's
// contents. `untrackedInVendoredTrees` fails while it sits there undecided, and that
// is the whole window. Committing it under this baseline silences the finding without
// putting the file in scope — so for genuinely new upstream code the answer is a
// re-vendor that moves `BASELINE`, which `untrackedMessage` and the checklist at the
// end of `UPSTREAM.md` both say out loud.
//
// This module answers three questions and refuses to guess at any of them:
//
//   - what is in the vendored universe (`vendoredUniverse`)
//   - what a given path is (`classify`) — vendored, excluded, or not ours to say
//   - what has diverged since the baseline (`surveyVendored`) — edits *and* deletions
//
// Deletions matter more than the old check admitted. A re-vendor that drops a file
// entirely is the exact failure this directory was built to catch, and until now
// nothing detected it: a file that is gone has no diff to inspect.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The repository root, so callers do not each re-derive it. */
export const REPO = path.resolve(HERE, "..", "..");

/**
 * The commit that vendored upstream, before a line of the port was written.
 *
 * A tag would be nicer, but `docs/design/UPSTREAM.md` explains why there is no
 * upstream revision to name either: the reference checkout carries no VCS metadata.
 * This tree's own first commit is the only fixed point there is.
 */
export const BASELINE = "45b5e43";

// Every `git` here is synchronous and so cannot be raced against a promise
// deadline; `timeout` is the only bound available, and without it a git that waits
// on an index lock or a credential prompt blocks the whole run with no output. Long
// enough that a cold object store on a slow disk is not a flake.
export const GIT_TIMEOUT_MS = 30_000;

/**
 * Paths `45b5e43` carried that are not vendored upstream code, and why each is out.
 *
 * The vendoring commit did two jobs: it imported upstream's trees and it laid down
 * this repo's own scaffolding. Only the first is what the unchanged-guard is about,
 * so the second needs saying out loud. A path listed here is exempt from ever
 * needing a divergence reason — which is precisely why it may not be added silently.
 *
 * Note what is *not* here: `tools/`, `LICENSE`, `pnpm-lock.yaml`,
 * `docs/design/01-baseline-errors.md` and the rest of the commit's own scaffolding
 * are left in the universe deliberately. They do not differ from the baseline today,
 * and if one starts to, the right outcome is that somebody records why rather than
 * that the guard shrugs. An exclusion is for a file whose *whole point* is to change.
 */
export const EXCLUSIONS = Object.freeze({
  ".gitignore":
    "repo hygiene, not upstream source: it names this tree's build output and " +
    "scratch directories, so it grows whenever the port adds one.",
  "package.json":
    "the workspace root manifest this repo owns; the vendoring commit wrote it to " +
    "host upstream's packages rather than copying it from them.",
  "docs/design/UPSTREAM.md":
    "this repo's record of the vendoring. It is the document the guard exists to " +
    "keep honest, so requiring it to stay byte-identical would be backwards.",
  "docs/plans/20260821-windows-port.md":
    "the port's own plan, written against the vendored tree and checked off as the " +
    "port proceeded. Changing is what a plan does.",
});

/**
 * Top-level directories the vendoring commit laid down as this repo's own workspace,
 * where upstream code has never landed and never will.
 *
 * This is a different question from `EXCLUSIONS` and answering it with that list
 * would be wrong. An exclusion says "this path is not vendored code, so do not diff
 * it"; the paths below *are* diffed, and must stay byte-identical to `45b5e43`. What
 * these entries say is narrower: an untracked file appearing here is somebody writing
 * a tool or a design note, not a re-vendor dropping in an upstream module.
 *
 * Without it the derivation in `vendoredDirectories` reads the commit's own
 * scaffolding — `tools/summarize-baseline.py`, `tools/conpty-probe/`,
 * `tools/vendor-check/` and `docs/design/01-baseline-errors.md` — as evidence that
 * `tools` and `docs/design` are trees upstream code arrives in. `UPSTREAM.md`'s "What
 * was copied" says otherwise in as many words: upstream gave `engine/`, `browser/`,
 * `cli/`, `store/`, `terminals/`, `assets/` and four root files, and nothing else.
 * 66 paths this port has since committed sit under these two roots as of 2026-08-26 —
 * every tool in `tools/`, every design note, and the files of this very change — and
 * each was an untracked-file failure for as long as it took to write. The count is
 * dated rather than asserted because it grows with every note this port writes, which
 * is itself the point: that is the guard-gets-silenced pressure the `docs/plans`
 * exclusion already names, over a whole tree rather than one file, and a guard that
 * fails on ordinary work teaches people to stop reading it.
 *
 * A root here buys no exemption from anything else: `tools/vendor-check/digest.py`
 * is still in the universe, still diffed, and still has to carry a disposition the
 * day it changes.
 */
export const PROJECT_ROOTS = Object.freeze({
  tools: "this repo's own tooling. `UPSTREAM.md` does not list it among what was copied.",
  docs: "this repo's own design notes, plans and vendoring record — none of it upstream's.",
});

/**
 * Fails if a project root holds nothing the vendoring commit introduced.
 *
 * The same staleness hazard `assertExclusionsAreReal` covers, one level up and worse:
 * a root that names no real directory reads as a considered decision while doing
 * nothing, and the day upstream code lands under that name it is outside the untracked
 * check before anyone looks. Injectable for the same reason — a guard branch that has
 * never run is a guard nobody has evidence for.
 */
export function assertProjectRootsAreReal(
  roots = PROJECT_ROOTS,
  paths = vendoringCommitPaths(),
) {
  const tops = new Set(paths.map((p) => p.split("/")[0]));
  const empty = Object.keys(roots).filter((root) => !tops.has(root));
  if (empty.length > 0) {
    throw new Error(
      `PROJECT_ROOTS names ${empty.length} director(ies) ${BASELINE} put nothing in: ` +
        `${empty.join(", ")}. Either the directory was renamed (update the key) or the ` +
        `entry is stale (delete it) — a root for a directory that does not exist takes ` +
        `a future tree of that name out of the untracked check before anyone reads it.`,
    );
  }
}

/** Whether `dir` is a project root or sits beneath one. */
function underProjectRoot(dir, roots) {
  const cut = dir.indexOf("/");
  return Object.hasOwn(roots, cut === -1 ? dir : dir.slice(0, cut));
}

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
}

/** Splits git's `-z` output, which is NUL-*terminated* and so ends in an empty field. */
function splitNul(output) {
  return output.split("\0").filter((field) => field !== "");
}

let universeCache = null;

/**
 * Every path the vendoring commit put in the tree, sorted. This is the raw 239,
 * before the exclusions are taken out — `vendoredUniverse` is what most callers want.
 *
 * `-z` rather than plain `--name-only` because `core.quotepath` will otherwise
 * mangle any path outside ASCII into a C-style escape, and a path that reads back
 * differently than it is on disk is a silent hole in the scope.
 *
 * `--diff-filter=d` — lowercase, so deletions are the one status left out — because
 * `--name-only` otherwise lists what a commit *removed* alongside what it added, and
 * a path this commit deleted is not vendored code, it is the absence of some. It
 * changes nothing today: `45b5e43` deletes nothing, and the count is 239 either way.
 * It matters the moment `BASELINE` moves, which is what `untrackedMessage` and the
 * `UPSTREAM.md` checklist both tell a re-vendorer to do — a re-vendor that drops
 * upstream files is the ordinary case, and without this every dropped path would join
 * the universe, survey as `deleted`, and be reported with a `git checkout` telling the
 * reader to restore a file upstream deliberately removed. The guard would fail loudly
 * on the exact workflow it documents.
 */
export function vendoringCommitPaths() {
  if (universeCache) return universeCache;
  universeCache = splitNul(
    git(["show", "--name-only", "--format=", "-z", "--diff-filter=d", BASELINE]),
  ).sort();
  return universeCache;
}

/**
 * The vendored universe: everything the commit introduced, minus the declared
 * exclusions. This is the set the unchanged-guard is answerable for.
 */
export function vendoredUniverse() {
  assertExclusionsAreReal();
  const excluded = new Set(Object.keys(EXCLUSIONS));
  return vendoringCommitPaths().filter((p) => !excluded.has(p));
}

/**
 * Fails if an exclusion names a path the vendoring commit never introduced.
 *
 * A stale exclusion is how the list starts lying: it reads as a considered decision
 * about a real file while covering nothing, and the day a path by that name *is*
 * vendored it is exempt before anyone looks at it.
 *
 * Both arguments are injectable so the throw can be tested. It is the only branch
 * this function has, and a check whose failure path has never run once is a check
 * nobody has evidence for.
 */
export function assertExclusionsAreReal(
  exclusions = EXCLUSIONS,
  paths = vendoringCommitPaths(),
) {
  const universe = new Set(paths);
  const stale = Object.keys(exclusions).filter((p) => !universe.has(p));
  if (stale.length > 0) {
    throw new Error(
      `EXCLUSIONS names ${stale.length} path(s) that ${BASELINE} never introduced: ` +
        `${stale.join(", ")}. Either the path moved (update the key) or the entry is ` +
        `stale (delete it) — an exclusion for a file that does not exist exempts a ` +
        `future file of that name before anyone reads it.`,
    );
  }
}

/**
 * What a path is, as far as this module is entitled to say: `"excluded"` with the
 * declared reason, or `"vendored"`.
 *
 * Throws for anything the vendoring commit did not introduce. That is the point:
 * there is no default category, because a default is how an unrecognised path gets
 * quietly treated as fine. The caller either knows the path is vendored or finds out
 * here that it is asking the wrong module.
 */
export function classify(candidate) {
  if (Object.hasOwn(EXCLUSIONS, candidate)) {
    return { category: "excluded", reason: EXCLUSIONS[candidate] };
  }
  if (vendoringCommitPaths().includes(candidate)) {
    return { category: "vendored", reason: null };
  }
  throw new Error(
    `${candidate} is not a path ${BASELINE} introduced, so it is neither vendored nor ` +
      `an excluded project file. If it was vendored later, it belongs to whatever ` +
      `commit brought it in; if it is this repo's own, it was never in scope. This ` +
      `module will not guess.`,
  );
}

/**
 * Every directory of the vendored trees, derived rather than listed.
 *
 * A directory qualifies on either of two rules: the commit put a vendored path
 * *directly* in it, or everything the commit put anywhere beneath it is vendored. The
 * first rule is what makes `pixel-node/src` a tree; the second is what makes `assets`
 * one, whose only baseline paths sit a level down in `assets/fonts` and which
 * `UPSTREAM.md` names among the guarded trees. Taking the immediate parent alone left
 * a file dropped straight into `assets/` outside the untracked check while
 * `assets/fonts/` was inside it — the same hole in miniature that this whole directory
 * exists to close.
 *
 * A path that is *declared out* is a declaration that the file is this repo's own, so
 * an ancestor of one qualifies only under the first rule. `docs/plans` is the case: its
 * one baseline path is the port's plan, declared out because changing is what a plan
 * does, so the directory is this repo's own and not a vendored tree. Counting it made
 * every plan document an untracked-file failure for as long as it took to write, which
 * is the guard-gets-silenced pressure this whole directory exists to avoid.
 *
 * Then `PROJECT_ROOTS` is subtracted, and it is what stops both rules over-reaching.
 * The vendoring commit laid down this repo's scaffolding as well as upstream's trees,
 * so `tools` and `docs/design` qualify on the first rule with no upstream file
 * anywhere in them — and the same pressure that took out `docs/plans` applies to every
 * tool and design note this port has written since, 66 of them. The exclusion rule
 * above cannot reach that case: those paths are in the universe on purpose and must
 * stay byte-identical, so declaring them out would trade a false untracked finding for
 * a real hole in the diff.
 *
 * The repo root is deliberately not in it either. `LICENSE`, `pnpm-lock.yaml` and
 * `pnpm-workspace.yaml` are root-level paths in the universe, so `.` qualifies on the
 * same rule every other directory does — and since every path in the repo descends
 * from the root, including it would make "is this inside a vendored tree" true of
 * everything. The root is this workspace's floor, not a tree.
 */
export function vendoredDirectories(roots = PROJECT_ROOTS) {
  assertProjectRootsAreReal(roots);
  const universe = new Set(vendoredUniverse());
  const above = new Set();
  const holdsVendored = new Set();
  const aboveExcluded = new Set();
  for (const file of vendoringCommitPaths()) {
    const vendored = universe.has(file);
    let at = file;
    let immediate = true;
    for (;;) {
      const cut = at.lastIndexOf("/");
      if (cut <= 0) break;
      at = at.slice(0, cut);
      if (vendored) {
        above.add(at);
        if (immediate) holdsVendored.add(at);
      } else {
        aboveExcluded.add(at);
      }
      immediate = false;
    }
  }
  return new Set(
    [...above].filter(
      (dir) =>
        !underProjectRoot(dir, roots) &&
        (holdsVendored.has(dir) || !aboveExcluded.has(dir)),
    ),
  );
}

/**
 * Whether `file` sits inside a vendored tree, walking up its ancestors.
 *
 * Ancestors rather than the immediate directory alone, so that a *new*
 * subdirectory — `pixel-node/src/backends/foo.rs`, which no vendored path shares a
 * directory with — is still inside `pixel-node/src` and still in scope. The walk
 * stops before the root for the reason `vendoredDirectories` gives.
 */
export function inVendoredTree(file, dirs = vendoredDirectories()) {
  let at = file;
  for (;;) {
    const cut = at.lastIndexOf("/");
    if (cut <= 0) return false;
    at = at.slice(0, cut);
    if (dirs.has(at)) return true;
  }
}

/**
 * Files sitting in a vendored tree that git does not track, sorted.
 *
 * The hole the diff-based half cannot see. `surveyVendored` asks how the paths
 * `45b5e43` introduced have changed, which by construction says nothing about a path
 * it never introduced — so a re-vendor that brings in a new upstream module, or a
 * stray file left in a vendored source tree, is invisible to every other check here.
 * A file that is neither committed nor ignored has been decided about by nobody.
 *
 * `--exclude-standard` is what keeps this from being a nag: build output and scratch
 * directories are already named in `.gitignore`, whose whole declared purpose in
 * `EXCLUSIONS` is that it "grows whenever the port adds one". So there are ways to
 * answer this failure — commit it if it is this repo's own, re-vendor if it is
 * upstream's, ignore it if it is neither — and every one of them is a decision on the
 * record, which is the only property the guard actually wants. `untrackedMessage`
 * spells all three out and says why the middle one is not just "commit it".
 *
 * `files` and `dirs` are injectable for the reason everything else here is: the only
 * honest test of "does this report an untracked file in a vendored tree" would drop a
 * real file into `pixel-node/src` while the rest of the run is reading that tree, and
 * a positive assertion is worth having without that. Default to git.
 */
export function untrackedInVendoredTrees(files = untrackedFiles(), dirs = vendoredDirectories()) {
  return files.filter((file) => inVendoredTree(file, dirs)).sort();
}

/** Every file git neither tracks nor ignores, as repo-relative forward-slash paths. */
export function untrackedFiles() {
  return splitNul(git(["ls-files", "--others", "--exclude-standard", "-z"]));
}

/**
 * The decision half of `surveyVendored`, with no git and no filesystem in it, so
 * that "a vendored file went missing" can be tested without a test that deletes one
 * out from under whatever else is running.
 *
 * `statuses` is git's `--name-status` output already split into `[status, path]`
 * pairs; `exists` answers whether a repo-relative path is on disk. A path is deleted
 * if git says `D` *or* if `exists` says no. The second test is not redundant
 * belt-and-braces: it is the one that holds if the diff output is ever parsed wrong,
 * and "is the file there" is the single question this whole directory would be
 * embarrassed to take from a subprocess it did not check.
 */
export function partitionDivergences(scope, statuses, exists) {
  const inScope = new Set(scope);
  const changed = new Set();
  const deleted = new Set();

  for (const [status, file] of statuses) {
    if (!inScope.has(file)) continue;
    if (status.startsWith("D")) deleted.add(file);
    else changed.add(file);
  }

  for (const file of scope) {
    if (!exists(file)) {
      deleted.add(file);
      changed.delete(file);
    }
  }

  return { changed: [...changed].sort(), deleted: [...deleted].sort() };
}

/**
 * How the working tree differs from the vendored baseline:
 * `{ changed, deleted, untracked }`, all sorted.
 *
 * Diffed against the *working tree* rather than `HEAD`, so an uncommitted edit to a
 * vendored file is caught by the run that would otherwise ship it. `--no-renames` so
 * that moving a vendored file shows up as the deletion it is at the old path rather
 * than dissolving into an `R` that nothing checks.
 *
 * `changed` and `deleted` are restricted to the vendored universe, because both are
 * questions about a path the commit introduced. `untracked` cannot be: it is the one
 * finding whose whole subject is a path that is *not* in the universe.
 */
export function surveyVendored() {
  const fields = splitNul(git(["diff", "--name-status", "--no-renames", "-z", BASELINE]));
  const statuses = [];
  for (let i = 0; i + 1 < fields.length; i += 2) statuses.push([fields[i], fields[i + 1]]);
  return {
    ...partitionDivergences(vendoredUniverse(), statuses, (file) =>
      fs.existsSync(path.join(REPO, ...file.split("/"))),
    ),
    untracked: untrackedInVendoredTrees(),
  };
}
