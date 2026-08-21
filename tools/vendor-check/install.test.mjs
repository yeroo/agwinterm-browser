// Guards the two install fixes Task 1 made, because both fail late and quietly.
//
// Upstream's `browser` package fetches a patched Electron from a `bash` script in
// `scripts/`, which this port neither copies nor is allowed to use. Removing that
// hook is not enough on its own: pnpm 10 blocks a dependency's own build scripts
// unless the package is listed in `onlyBuiltDependencies`, so a tree with the hook
// removed and nothing put back installs cleanly and leaves no `electron.exe`
// anywhere — a failure that only surfaces at the Task 10 milestone.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const readJson = (...parts) =>
  JSON.parse(fs.readFileSync(path.join(REPO, ...parts), "utf8"));
const readText = (...parts) => fs.readFileSync(path.join(REPO, ...parts), "utf8");

describe("browser package install hooks", () => {
  const pkg = readJson("browser", "package.json");

  it("does not run bash, which Windows has no obligation to provide", () => {
    const scripts = Object.values(pkg.scripts ?? {});
    const usesBash = scripts.filter((s) => /\bbash\b/.test(s));
    assert.deepEqual(usesBash, [], `bash-dependent scripts: ${usesBash.join(", ")}`);
  });

  it("does not fetch the patched Electron fork", () => {
    const all = JSON.stringify(pkg);
    assert.ok(
      !all.includes("fetch-electron"),
      "the patched-Electron fetch is back; stock Electron is a hard constraint",
    );
  });

  it("fetches stock Electron on postinstall instead", () => {
    // Electron 43 dropped its own `postinstall` and downloads lazily on first
    // `require`. Invoking its installer explicitly keeps the binary's arrival at
    // install time, where a failure is legible, rather than at first launch.
    assert.match(pkg.scripts?.postinstall ?? "", /electron[\\/]install\.js/);
    assert.ok(
      !/\bbash\b|\bsh -c\b/.test(pkg.scripts.postinstall),
      "the postinstall hook must run without a POSIX shell",
    );
  });

  it("still depends on a pinned Electron version", () => {
    const version = pkg.devDependencies?.electron;
    assert.ok(version, "electron is not a devDependency of browser/");
    assert.match(version, /^\d+\.\d+\.\d+$/, `electron version "${version}" is not pinned`);
  });
});

describe("pnpm workspace build policy", () => {
  const workspace = readText("pnpm-workspace.yaml");

  it("allows electron's own build scripts to run", () => {
    const block = workspace.split("onlyBuiltDependencies:")[1] ?? "";
    const allowed = block
      .split("\n")
      .filter((line) => line.trim().startsWith("- "))
      .map((line) => line.trim().slice(2).trim());
    assert.ok(
      allowed.includes("electron"),
      `onlyBuiltDependencies is [${allowed.join(", ")}] — electron's binary download stays blocked`,
    );
  });

  it("keeps the workspace packages upstream declares", () => {
    for (const pkg of ["browser", "cli", "store", "terminals", "engine/packages/*"]) {
      assert.ok(workspace.includes(pkg), `workspace no longer contains ${pkg}`);
    }
  });
});

describe("scripts the port deliberately did not vendor", () => {
  it("has no copy of the POSIX-only installer scripts", () => {
    for (const name of ["install.sh", "fetch-electron.sh", "apparmor.sh", "bundle.sh"]) {
      assert.ok(
        !fs.existsSync(path.join(REPO, "scripts", name)),
        `scripts/${name} was vendored; the Constraints exclude it`,
      );
    }
  });
});
