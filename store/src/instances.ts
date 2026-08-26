import { eq } from "drizzle-orm";

import { store } from "./client";
import { endpointStatus, isPipeEndpoint, removeEndpoint } from "./endpoint";
import type { EndpointStatus } from "./endpoint";
import { instances } from "./schema";
import type { InstanceRow, NewInstanceRow } from "./schema";

export async function upsertInstance(row: NewInstanceRow): Promise<void> {
  const { key, ...rest } = row;
  await store()
    .db.insert(instances)
    .values(row)
    .onConflictDoUpdate({ target: instances.key, set: rest });
}

export async function removeInstance(key: string): Promise<void> {
  await store().db.delete(instances).where(eq(instances.key, key));
}

function alive(pid: number): boolean {
  // A value no pid can take names no process. Checked before the probe because
  // `process.kill` answers a non-int32 with a `TypeError` carrying no errno, and
  // under the rule below that would read as alive and keep a bogus row forever.
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and is someone else's — Windows reports it
    // for processes at a higher integrity level. ESRCH is the only "gone", and
    // that is the whole rule: anything else is a probe that failed rather than a
    // process that is missing, and answering "dead" to it deletes a running
    // browser's row. `browser/src/profile.ts` reaches the same verdict from the same
    // code, which is what `docs/design/UPSTREAM.md` divergence 13 claims of this file.
    // It also warns on an unrecognised one and this does not, deliberately: there the
    // probe runs once per launch and decides which profile the user gets, here it runs
    // once per row on every `ls`, and a per-row warning on a repeated listing is the
    // kind of noise that stops being read.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Live rows, with the dead ones and their endpoints cleaned up.
 *
 * The endpoint half of that reads as a no-op on Windows and is not one. Upstream's
 * `fs.rmSync(row.socket)` had two jobs: drop the row's socket *file*, and make the
 * name free to bind again. A named pipe has no file and frees its own name when the
 * server dies, so the first job does not exist and the second is already done — see
 * `endpoint.ts`. What is left, and what actually strands a `terminal-browser ls`, is
 * the **row**, which outlives the process on both platforms. That is deleted here.
 */
export async function listInstances(): Promise<InstanceRow[]> {
  const rows = await store().db.select().from(instances);
  // Concurrently, because the expensive rows are the *dead* ones: each costs the
  // whole of `ENDPOINT_PROBE_MS`, and run one after another a handful of phantoms
  // turned `ls` into a multi-second command. Overlapped, the worst case is one
  // probe's budget however many rows there are — which is also what makes a budget
  // generous enough to not evict a busy browser affordable.
  const verdicts = await Promise.all(rows.map((row) => stillThere(row)));
  const live: InstanceRow[] = [];
  for (const [at, row] of rows.entries()) {
    // Only a *definite* "nobody is there" deletes anything. `unknown` — a probe
    // that ran out of budget rather than one that was refused — keeps the row and
    // reports the browser, because the two mistakes are not the same size: a row
    // kept in error costs one failed request, and a row deleted in error costs the
    // browser (see `ENDPOINT_PROBE_MS`).
    if (verdicts[at] !== "absent") {
      live.push(row);
      continue;
    }
    // Cleanup is opportunistic, and a listing is not. A locked database here used
    // to reject `listInstances` outright, so `ls`, `new-tab` and `action` failed
    // instead of reporting the live browsers they had already identified.
    await removeInstance(row.key).catch(() => {});
    removeEndpoint(row.endpoint);
  }
  return live.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Whether the browser a row describes is still running.
 *
 * The pid is the cheap answer and is usually the whole answer. It is not
 * sufficient on its own, because pids are recycled: a browser that failed to
 * delete its own row leaves one behind, and the moment the operating system hands
 * that pid to any other process the row starts looking alive again -- permanently,
 * and with no command to clear it. So a pid that *is* live has its endpoint probed
 * as well, which is the only check a named pipe supports (`endpoint.ts`) and which
 * a recycled pid cannot pass: the pipe name went with the process that owned it.
 *
 * The probe is skipped where it would be misleading rather than merely slow. A
 * socket *file* outlives its server, so a failed connect to one does not mean the
 * browser is gone -- `removeEndpoint` returning `true` is what says "this endpoint
 * is a file", and those rows are trusted to the pid alone, which is exactly
 * upstream's rule.
 *
 * Three answers, not two, because the caller deletes on one of them: `absent` is a
 * connect the operating system *refused*, `unknown` is one that did not finish in
 * time, and only the first is evidence of anything (`endpoint.ts`).
 */
async function stillThere(row: InstanceRow): Promise<EndpointStatus> {
  if (!alive(row.pid)) return "absent";
  if (!isPipeEndpoint(row.endpoint)) return "alive";
  return endpointStatus(row.endpoint, ENDPOINT_PROBE_MS);
}

/**
 * How long a row's endpoint gets to answer before the probe gives up.
 *
 * A live browser answers a local pipe connect immediately, so the *typical* cost of
 * this is nothing at all and the number only decides how long a phantom stalls
 * `ls`. Since `listInstances` overlaps its probes, that stall is paid once rather
 * than once per row, which is what makes a budget this generous affordable.
 *
 * Running out of it is no longer a verdict, which is the point: a busy browser's
 * connect can sit queued — a Win32 pipe server hands out one instance per accept
 * and only makes the next one when its loop comes round — and treating that as
 * "gone" **deleted the row of a running browser**. The row is the only thing that
 * tells `ls`, `new-tab` and `action` there is anything to talk to, and it does not
 * come back on its own: `Registry.write` only runs on a state change, so an idle
 * browser evicted that way stayed invisible indefinitely. A timeout now reads as
 * `unknown` and the row is kept; the budget is only how long `ls` waits before
 * saying so.
 */
const ENDPOINT_PROBE_MS = 2_000;
