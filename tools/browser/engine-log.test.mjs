// `browser/src/engine-log.ts`: the engine's warnings, forwarded to a line writer.
//
// The module is import-free and takes its store as an argument, so it is checked
// here with a store built to `createLogStore`'s contract — rows appended, an
// identical consecutive message folded into the last row's `count`, the oldest
// dropped past a cap — and no Electron, engine or `pixel-react` in the process.
// What `pixel-react` actually does is pinned by the "folds" test reading its source.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "winterm-engine-log-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

async function loadModule(relative) {
  const source = fs.readFileSync(path.join(REPO, relative), "utf8");
  const { code } = await esbuild.transform(source, { loader: "ts", format: "esm" });
  const out = path.join(scratch, `${path.basename(relative, ".ts")}.mjs`);
  fs.writeFileSync(out, code);
  return import(pathToFileURL(out).href);
}

const { FORWARDED_LEVELS, formatEngineLog, forwardEngineWarnings } = await loadModule(
  "browser/src/engine-log.ts",
);

/**
 * A store to `createLogStore`'s contract. `cap` is `LOG_CAP` made small enough to
 * turn over in a test.
 */
function fakeLogs(cap = 2000) {
  let value = { rows: [], version: 0 };
  const listeners = new Set();
  let nextId = 1;
  const set = (next) => {
    value = next;
    for (const listener of listeners) listener();
  };
  return {
    store: {
      get: () => value,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    push(level, target, text) {
      const rows = value.rows.slice(-cap);
      const last = rows[rows.length - 1];
      if (last && last.text === text && last.level === level && last.target === target) {
        rows[rows.length - 1] = { ...last, count: last.count + 1 };
      } else {
        rows.push({ id: nextId++, level, target, text, epochMs: 0, count: 1 });
      }
      set({ rows, version: value.version + 1 });
    },
  };
}

const recorder = () => {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
};

describe("forwardEngineWarnings", () => {
  it("writes warn and error rows as they arrive, and nothing quieter", () => {
    const logs = fakeLogs();
    const out = recorder();
    forwardEngineWarnings(logs, out.write);
    logs.push("info", "agwinterm", "frames are going out over `image.frame`");
    logs.push("debug", "agwinterm", "probe");
    logs.push("warn", "agwinterm", "`image.frameshm` did not carry this frame");
    logs.push("error", "bridge", "boom");
    assert.deepEqual(out.lines, [
      "engine warn agwinterm: `image.frameshm` did not carry this frame\n",
      "engine error bridge: boom\n",
    ]);
    assert.deepEqual([...FORWARDED_LEVELS].sort(), ["error", "warn"]);
  });

  it("writes each occurrence once, so a reader can count", () => {
    // The store folds an identical consecutive message into the previous row and
    // bumps `count` instead of appending. A forwarder that wrote rows would say
    // "once" about a warning the engine said three times; one that re-walked the
    // store on every change would say it six.
    const logs = fakeLogs();
    const out = recorder();
    forwardEngineWarnings(logs, out.write);
    logs.push("warn", "agwinterm", "same");
    logs.push("warn", "agwinterm", "same");
    logs.push("warn", "agwinterm", "same");
    logs.push("warn", "agwinterm", "other");
    assert.equal(logs.store.get().rows.length, 2, "the fake store no longer folds");
    assert.deepEqual(out.lines, [
      "engine warn agwinterm: same\n",
      "engine warn agwinterm: same\n",
      "engine warn agwinterm: same\n",
      "engine warn agwinterm: other\n",
    ]);
  });

  it("replays what the store already holds, once", () => {
    const logs = fakeLogs();
    logs.push("warn", "agwinterm", "early");
    logs.push("info", "agwinterm", "quiet");
    const out = recorder();
    forwardEngineWarnings(logs, out.write);
    assert.deepEqual(out.lines, ["engine warn agwinterm: early\n"]);
    logs.push("warn", "agwinterm", "later");
    assert.deepEqual(out.lines, [
      "engine warn agwinterm: early\n",
      "engine warn agwinterm: later\n",
    ]);
  });

  it("stops on unsubscribe", () => {
    const logs = fakeLogs();
    const out = recorder();
    const stop = forwardEngineWarnings(logs, out.write);
    logs.push("warn", "agwinterm", "before");
    stop();
    logs.push("warn", "agwinterm", "after");
    assert.deepEqual(out.lines, ["engine warn agwinterm: before\n"]);
  });

  it("does not grow without bound on a store that is turning over", () => {
    // The store keeps `LOG_CAP` rows and drops the oldest. The forwarder tracks
    // rows by id; without pruning, a long session is one map entry per row the
    // store has already forgotten. The observable claim is that nothing is
    // written twice and nothing is missed across the turnover — the size is
    // checked indirectly, through a writer that would notice a replay.
    const logs = fakeLogs(8);
    const out = recorder();
    forwardEngineWarnings(logs, out.write);
    for (let n = 0; n < 5000; n += 1) logs.push("warn", "t", `w${n}`);
    assert.equal(out.lines.length, 5000);
    assert.equal(out.lines[0], "engine warn t: w0\n");
    assert.equal(out.lines[4999], "engine warn t: w4999\n");
  });

  it("formats a line the acceptance test can grep by target", () => {
    assert.equal(
      formatEngineLog({ level: "warn", target: "agwinterm", text: "x" }),
      "engine warn agwinterm: x\n",
    );
  });
});

describe("the contract the fake store copies", () => {
  it("is what pixel-react's createLogStore does: fold identical consecutive rows", () => {
    // If upstream stops folding, the "each occurrence once" test above is testing
    // a store nothing uses. Pinned against the source so the fake cannot drift.
    const store = fs.readFileSync(
      path.join(REPO, "engine", "packages", "pixel-react", "src", "devtools", "store.ts"),
      "utf8",
    );
    assert.match(store, /last\.text === text && last\.level === level && last\.target === target/);
    assert.match(store, /count: last\.count \+ 1/);
    assert.match(store, /rows\.slice\(-LOG_CAP\)/);
  });

  it("is what the foreground shape wires to fd 2", () => {
    const foreground = fs.readFileSync(
      path.join(REPO, "browser", "src", "foreground.ts"),
      "utf8",
    );
    assert.match(foreground, /import \{ engineLogs \} from "pixel-react\/dist\/devtools\/stores\.js"/);
    assert.match(foreground, /forwardEngineWarnings\(engineLogs/);
    // Only when fd 2 is not a console: under the CLI it is the log file
    // `openInForeground` opened, and a line on a console would paint over the
    // frame the host is holding as a placement.
    assert.match(foreground, /process\.stderr\.isTTY !== true/);
  });
});
