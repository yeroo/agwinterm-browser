import { eq } from "drizzle-orm";

import { store } from "./client";
import { removeEndpoint } from "./endpoint";
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
    if (alive(row.pid)) {
      live.push(row);
      continue;
    }
    await removeInstance(row.key);
    removeEndpoint(row.endpoint);
  }
  return live.sort((a, b) => a.startedAt - b.startedAt);
}
