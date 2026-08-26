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
// in the universe by construction; a newly vendored file is covered the moment it is
// committed, with nobody to remind. What a human still owns is the *exceptions*, and
// those are here as declarations with a reason each, so an exclusion is a decision on
// the record rather than an absence.
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
 */
export function assertExclusionsAreReal() {
  const universe = new Set(vendoringCommitPaths());
  const stale = Object.keys(EXCLUSIONS).filter((p) => !universe.has(p));
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
 * How the working tree differs from the vendored baseline: `{ changed, deleted }`,
 * both sorted, both restricted to the vendored universe.
 *
 * Diffed against the *working tree* rather than `HEAD`, so an uncommitted edit to a
 * vendored file is caught by the run that would otherwise ship it. `--no-renames` so
 * that moving a vendored file shows up as the deletion it is at the old path rather
 * than dissolving into an `R` that nothing checks.
 */
export function surveyVendored() {
  const fields = splitNul(git(["diff", "--name-status", "--no-renames", "-z", BASELINE]));
  const statuses = [];
  for (let i = 0; i + 1 < fields.length; i += 2) statuses.push([fields[i], fields[i + 1]]);
  return partitionDivergences(vendoredUniverse(), statuses, (file) =>
    fs.existsSync(path.join(REPO, ...file.split("/"))),
  );
}
