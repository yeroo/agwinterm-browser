// "Is the thing under test the thing on disk?"
//
// Three suites import the *built* `pixel-store` rather than transpiling its
// sources, because what they are checking includes the migration runner and the
// real `node:sqlite` behaviour underneath it. `dist/` is gitignored and the test
// script does not build (it cannot shell out to a bare `pnpm`: that is not on PATH
// unless corepack has been enabled, which is why `README.md` says
// `corepack pnpm -r build`). So two things can go wrong silently:
//
//   - a fresh clone has no `dist/` at all, and the suite dies at its top-level
//     import with a module-not-found stack that names neither the cause nor the fix;
//   - a stale `dist/` is worse, because everything passes -- against yesterday's
//     source. That is precisely the failure the whole `tools/vendor-check/` suite
//     exists to prevent, happening inside the tests themselves.
//
// This turns both into one sentence naming the command to run.

import fs from "node:fs";
import path from "node:path";

/** The newest mtime under `dir`, or 0 if it does not exist. */
function newestUnder(dir) {
  let newest = 0;
  const walk = (at) => {
    let entries;
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/**
 * Asserts that `builtRelative` exists and is no older than everything in
 * `sourceRelative`, and returns its absolute path. Throws with the build command
 * otherwise.
 */
export function requireBuilt(repo, builtRelative, sourceRelative, buildCommand) {
  const built = path.join(repo, builtRelative);
  if (!fs.existsSync(built)) {
    throw new Error(
      `${builtRelative} is missing — this suite tests the built package. Run: ${buildCommand}`,
    );
  }
  const source = newestUnder(path.join(repo, sourceRelative));
  if (source > fs.statSync(built).mtimeMs) {
    throw new Error(
      `${builtRelative} is older than ${sourceRelative} — this suite would pass ` +
        `against the previous build. Run: ${buildCommand}`,
    );
  }
  return built;
}
