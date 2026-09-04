// The frame budget, both transports, one pane: the driver `02-frame-budget.md`'s
// comparison table is read off.
//
// The baseline was taken by hand — `run-milestone.cmd` in a pane, one
// `TERMINAL_BROWSER_CELL_PX` at a time, the budget file copied out afterwards.
// That was fine for one transport. With two, the thing that matters is that the
// `file` rows and the `shm` rows come from the *same* host, the same pane and the
// same page, minutes apart, so the only variable is the transport. So this runs
// the matrix: for every cell size given, one session per transport, the shipped
// CLI in each (`cli/dist/main.js open`, as `tools/acceptance/frameshm.test.mjs`
// runs it), until the budget file has the rows asked for. The TSVs are kept, one
// per case, and the medians are printed as the table's row.
//
// **Where the frames come from.** A static page paints while it loads and then
// never again: the load is a burst of ten to twenty frames, fewer the larger the
// canvas, and after it the budget file stops growing. The baseline's operator
// poked the pane by hand to get more. This asks the browser instead, over the
// control endpoint every browser listens on (`browser/src/registry.ts`, the one
// `terminal-browser new-tab` dials): once the burst has gone quiet it opens a
// second tab on the same page, then switches between the two until there are
// enough rows. Every switch repaints the whole canvas — a run of full frames of
// the same page — so the rows after the burst cost what the rows in it cost,
// and the only thing the tab strip adds is a second tab in it.
//
// The pane's size is the host's window's, not this script's: `session.new` gives
// every session the window's cell box. Resize the window between runs
// (`agwintermctl --pipe agwinterm-dev window resize --w … --h …`, or by hand) and
// read the `span` column to see what you got.
//
//   node.exe tools/milestone/measure-transports.mjs [--pipe agwinterm-dev]
//       [--cells 10x20,16x32] [--transports file,shm] [--frames 20] [--out <dir>]
//
// Run it from any pane, or from none: the host is named by `--pipe`, never by the
// pane's `AGWINTERM_PIPE`. It refuses a host that answers `unknown command` to
// `image.frameshm` when `shm` is in the matrix, because a `shm` row from such a
// host would be a `file` row with the wrong name on it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PIPE_PREFIX } from "../lib/control-host.mjs";
import { settlesWithin, withDeadline } from "../lib/deadline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PAGE = pathToFileURL(path.join(REPO, "tools", "milestone", "static-page.html")).href;

const CONTROL_MS = 5_000;
/** Electron's cold start, to the first frame the host answered. */
const LAUNCH_MS = 90_000;
/** How long a browser that has stopped painting stays quiet before it counts as done. */
const QUIET_MS = 2_000;
/** How long a burst of frames may go on for. */
const BURST_MS = 60_000;
const EXIT_MS = 15_000;

// -- arguments ---------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { pipe: "agwinterm-dev", cells: ["10x20", "16x32"], transports: ["file", "shm"], frames: 20, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case "--pipe":
        opts.pipe = value();
        break;
      case "--cells":
        opts.cells = value().split(",");
        break;
      case "--transports":
        opts.transports = value().split(",");
        break;
      case "--frames":
        opts.frames = Number.parseInt(value(), 10);
        break;
      case "--out":
        opts.out = path.resolve(value());
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  for (const cell of opts.cells) {
    if (!/^\d+x\d+$/.test(cell)) throw new Error(`--cells wants <w>x<h>, got ${cell}`);
  }
  for (const transport of opts.transports) {
    if (!["file", "shm"].includes(transport)) throw new Error(`--transports wants file or shm, got ${transport}`);
  }
  if (!Number.isInteger(opts.frames) || opts.frames < 1) throw new Error("--frames wants a positive integer");
  opts.out ??= fs.mkdtempSync(path.join(os.tmpdir(), "winterm-measure-"));
  return opts;
}

// -- the control pipe ----------------------------------------------------------------

async function control(pipe, request, ms = CONTROL_MS) {
  const endpoint = PIPE_PREFIX + pipe;
  const until = Date.now() + ms;
  let last = null;
  for (;;) {
    try {
      return await exchange(endpoint, request, `${request.cmd} on ${pipe}`, ms);
    } catch (error) {
      last = error;
      if (!/^E[A-Z]+$/.test(error.code ?? "") || Date.now() >= until) throw last;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// The deadline is the socket's own: a host that accepts and never answers would
// otherwise leave a live handle behind the rejection and keep the process up past
// it. Same shape as `tools/acceptance/frameshm.test.mjs`.
function exchange(endpoint, request, what, ms = CONTROL_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    const timer = setTimeout(
      () => socket.destroy(new Error(`timed out after ${ms}ms waiting for ${what}`)),
      ms,
    );
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, at)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new Error(`${endpoint} closed before it answered`));
    });
  });
}

/**
 * `true` when the host dispatches `image.frameshm` at all; the probe touches nothing.
 * `no session` is the host failing to resolve `active` before it dispatches any
 * verb, which says nothing about this one, so it is thrown rather than read.
 */
async function hasVerb(pipe) {
  const reply = await control(pipe, {
    cmd: "image.frameshm",
    target: "active",
    args: {
      images: [
        { id: 1, name: "not-a-mapping", slot: 0, seq: 0, width: 1, height: 1, stride: 4, format: 32, row: 0, col: 0, cols: 1, rows: 1 },
      ],
    },
  });
  const error = String(reply.error ?? "").trim();
  if (error === "no session") {
    throw new Error(`${pipe} has no active session to probe image.frameshm against; run this from a pane of that instance`);
  }
  return !error.startsWith("unknown command");
}

// -- one session -----------------------------------------------------------------------

function writeLauncher(root, pipe, cell, transport) {
  const set = (name, value) => `set "${name}=${value ?? ""}"`;
  const lines = [
    "@echo off",
    set("TEMP", root),
    set("TMP", root),
    set("LOCALAPPDATA", path.join(root, "state")),
    set("TERMINAL_BROWSER_ALLOW_PIPE", pipe),
    set("TERMINAL_BROWSER_CELL_PX", cell),
    set("TERMINAL_BROWSER_FRAME_BUDGET", path.join(root, "budget.tsv")),
    set("TERMINAL_BROWSER_FRAME_TRANSPORT", transport),
    `"${process.execPath}" "${path.join(REPO, "cli", "dist", "main.js")}" open "${PAGE}"`,
    "",
  ];
  const file = path.join(root, "launch.cmd");
  fs.writeFileSync(file, lines.join("\r\n"));
  return file;
}

function budgetText(root) {
  try {
    return fs.readFileSync(path.join(root, "budget.tsv"), "utf8");
  } catch {
    return "";
  }
}

function dataRows(text) {
  return text
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split("\t"));
}

function browserPid(root) {
  const dir = fs.readdirSync(root).find((name) => name.startsWith("terminal-browser-frames-"));
  const match = dir && /-(\d+)-\d+$/.exec(dir);
  return match ? Number.parseInt(match[1], 10) : null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function forceKill(pid) {
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { timeout: 15_000, stdio: "ignore" });
  } catch {
    // Already gone.
  }
}

/**
 * Resolves once `count()` has not changed for `QUIET_MS`: the end of a burst of
 * frames, which is the only way to tell one apart from the next. Bounded by
 * `BURST_MS`, so a browser that never stops painting is a failure, not a hang.
 */
async function quiet(count, what) {
  let last = count();
  let since = Date.now();
  await settlesWithin(
    () => {
      const now = count();
      if (now !== last) {
        last = now;
        since = Date.now();
      }
      return Date.now() - since >= QUIET_MS;
    },
    what,
    BURST_MS,
    100,
  );
}

/** The browser's control endpoint, `\\.\pipe\<app>-<user>-instance-<pid>-<seq>`, or `null`. */
function instanceEndpoint(pid) {
  if (!pid) return null;
  const name = fs.readdirSync(PIPE_PREFIX).find((entry) => entry.includes(`-instance-${pid}-`));
  return name ? PIPE_PREFIX + name : null;
}

/** One request to the browser's endpoint, in `cli/src/control.ts`'s protocol; the reply's `data`. */
async function browser(endpoint, request) {
  const reply = await exchange(endpoint, request, `${request.cmd} on the browser's endpoint`, CONTROL_MS);
  if (!reply.ok) throw new Error(`${request.cmd} refused: ${reply.error}`);
  return reply.data;
}

async function measure({ pipe, frames, out }, cell, transport) {
  const root = fs.mkdtempSync(path.join(out, `${transport}-${cell}-`));
  const launcher = writeLauncher(root, pipe, cell, transport);
  const created = await control(pipe, {
    cmd: "session.new",
    args: { name: `measure ${transport} ${cell}`, cwd: REPO, command: `cmd.exe /c "${launcher}"`, "no-select": true },
  });
  if (!created.ok) throw new Error(`session.new refused: ${JSON.stringify(created)}`);
  const session = String(created.result);
  try {
    await withDeadline(
      (async () => {
        for (;;) {
          const reply = await control(pipe, { cmd: "session.text", target: session, args: { lines: 1 } });
          if (reply.ok) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      })(),
      `session ${session} to be addressable`,
      CONTROL_MS,
    );
    const count = () => dataRows(budgetText(root)).length;
    await settlesWithin(() => count() >= 1, `a first budget row from ${transport} at ${cell} in session ${session}`, LAUNCH_MS, 250);
    await quiet(count, "the load's burst of frames to end");
    // The browser's own endpoint, found by the pid its frame directory is named
    // with rather than computed: the name has the install and the user in it
    // (`store/src/paths.ts`), and the directory listing is what `ls` would read.
    await settlesWithin(() => instanceEndpoint(browserPid(root)) !== null, `the browser's control endpoint in session ${session}`, CONTROL_MS);
    const endpoint = instanceEndpoint(browserPid(root));
    const opened = await browser(endpoint, { cmd: "open-tab", url: PAGE });
    await quiet(count, "the second tab's load to end");
    const tabs = opened.tabs.map((tab) => tab.id);
    for (let i = 0; count() < frames; i += 1) {
      if (i >= frames) throw new Error(`${frames} rows did not come in ${i} tab switches (${count()} rows)`);
      await browser(endpoint, { cmd: "activate-tab", tab: tabs[i % tabs.length] });
      await quiet(count, `tab switch ${i} to be painted`);
    }
  } finally {
    const pid = browserPid(root);
    await control(pipe, { cmd: "session.close", target: session }).catch(() => {});
    if (pid) await settlesWithin(() => !alive(pid), "the browser to leave", EXIT_MS).catch(() => forceKill(pid));
  }
  const text = budgetText(root);
  const rows = dataRows(text);
  const span = rows[rows.length - 1][2];
  const file = path.join(out, `measured-${transport}-${cell}-${span}.tsv`);
  fs.writeFileSync(file, text);
  return { file, rows };
}

// -- the table ---------------------------------------------------------------------------

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One table row from a case's data rows: medians of every timed column. */
function summarise(rows) {
  const column = (i) => rows.map((row) => Number.parseFloat(row[i]));
  const encode = median(column(4));
  const write = median(column(5));
  const publish = median(column(6));
  const copy = median(column(8));
  return {
    canvas: rows[rows.length - 1][1],
    span: rows[rows.length - 1][2],
    bytes: median(column(3)),
    encode,
    write,
    publish,
    copy,
    producer: median(rows.map((row) => [4, 5, 6, 8].reduce((sum, i) => sum + Number.parseFloat(row[i]), 0))),
    transport: rows[rows.length - 1][7],
    frames: rows.length,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.transports.includes("shm") && !(await hasVerb(opts.pipe))) {
    throw new Error(`${opts.pipe} answers unknown command to image.frameshm; a shm row from it would be a file row`);
  }
  const results = [];
  for (const cell of opts.cells) {
    for (const transport of opts.transports) {
      const { file, rows } = await measure(opts, cell, transport);
      const summary = summarise(rows);
      results.push(summary);
      console.log(`${transport}\t${cell}\t${summary.span}\t${rows.length} rows -> ${file}`);
    }
  }
  console.log("");
  console.log("transport\tcanvas\tspan\tbytes\tencode_ms\twrite_ms\tcopy_ms\tpublish_ms\tproducer_ms\tfps\tframes");
  for (const r of results) {
    const fmt = (n) => n.toFixed(2);
    console.log(
      [r.transport, r.canvas, r.span, r.bytes, fmt(r.encode), fmt(r.write), fmt(r.copy), fmt(r.publish), fmt(r.producer), (1000 / r.producer).toFixed(0), r.frames].join("\t"),
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
