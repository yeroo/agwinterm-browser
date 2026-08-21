import { eq } from "drizzle-orm";

import { store } from "./client";
import { endpointAlive, isPipeEndpoint, removeEndpoint } from "./endpoint";
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
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and is someone else's — Windows reports it
    // for processes at a higher integrity level. ESRCH is the only "gone".
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
  const live: InstanceRow[] = [];
  for (const row of rows) {
    if (await stillThere(row)) {
      live.push(row);
      continue;
    }
    await removeInstance(row.key);
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
 * socket *file* outlives its server, so `endpointAlive` answering `false` for one
 * does not mean the browser is gone -- `removeEndpoint` returning `true` is what
 * says "this endpoint is a file", and those rows are trusted to the pid alone,
 * which is exactly upstream's rule.
 */
async function stillThere(row: InstanceRow): Promise<boolean> {
  if (!alive(row.pid)) return false;
  if (!isPipeEndpoint(row.endpoint)) return true;
  return endpointAlive(row.endpoint, ENDPOINT_PROBE_MS);
}

/**
 * How long a row's endpoint gets to answer before it is treated as gone. Short: a
 * live browser answers a local pipe connect immediately, and this runs once per
 * row on every `ls`.
 */
const ENDPOINT_PROBE_MS = 250;
