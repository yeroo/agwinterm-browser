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
 * Every path the vendoring commit introduced, sorted. This is the raw 239, before
 * the exclusions are taken out — `vendoredUniverse` is what most callers want.
 *
 * `-z` rather than plain `--name-only` because `core.quotepath` will otherwise
 * mangle any path outside ASCII into a C-style escape, and a path that reads back
 * differently than it is on disk is a silent hole in the scope.
 */
export function vendoringCommitPaths() {
  if (universeCache) return universeCache;
  universeCache = splitNul(git(["show", "--name-only", "--format=", "-z", BASELINE])).sort();
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
 * Every directory holding a path of the vendored universe, derived rather than listed.
 *
 * Derived from `vendoredUniverse()` rather than from the raw commit, because an
 * excluded path is a declaration that the file is *this repo's own* — and a directory
 * that qualifies only through one of them is not a vendored tree. `docs/plans` is the
 * case: its single baseline path is `20260821-windows-port.md`, excluded because
 * "changing is what a plan does". Deriving from the raw set made every new plan
 * document an untracked-file failure while it was still being written, which is the
 * guard-gets-silenced pressure this whole directory exists to avoid.
 *
 * The repo root is deliberately not in it either. `LICENSE`, `pnpm-lock.yaml` and
 * `pnpm-workspace.yaml` are root-level paths in the universe, so `.` qualifies on the
 * same rule every other directory does — and since every path in the repo descends
 * from the root, including it would make "is this inside a vendored tree" true of
 * everything. The root is this workspace's floor, not a tree.
 */
export function vendoredDirectories() {
  const dirs = new Set();
  for (const file of vendoredUniverse()) {
    const cut = file.lastIndexOf("/");
    if (cut > 0) dirs.add(file.slice(0, cut));
  }
  return dirs;
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
