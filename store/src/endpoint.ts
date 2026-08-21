// One name for both control protocols.
//
// Upstream has two, not one: the daemon socket that `terminal-browser open` talks
// to (`browser/src/daemon.ts`), and the per-browser socket every running browser
// listens on so `ls`, `new-tab` and `action` can reach it (`browser/src/registry.ts`).
// Both are unix-domain paths under the runtime directory, created by
// `net.Server.listen(path)` and cleaned up with `fs.rmSync`. Both are persisted —
// the second one literally, in a database column.
//
// Windows has no unix-domain socket Node's `net` will listen on, but it has named
// pipes, and `net` speaks those through the identical API as long as the address
// looks like `\\.\pipe\<name>`. So the *protocol* needs no porting at all. What
// differs is the **lifetime of the name**:
//
//   - A socket file outlives the process that listened on it. A crash leaves a
//     path that `connect` refuses and `listen` will not reuse, so the code unlinks
//     before binding and unlinks again on shutdown.
//   - A named pipe does not exist apart from its server. The last instance closing
//     — including by the process dying — removes the name from the object manager.
//     There is nothing to unlink, and no `fs.rmSync` analogue to write.
//
// That asymmetry is the whole of this module: `removeEndpoint` is a real unlink on
// unix and an honest no-op on Windows, and `endpointAlive` is what both platforms
// must actually use to answer "is someone there", because on Windows it is the only
// thing that can answer it.

import fs from "node:fs";
import net from "node:net";

/** The prefix every local named pipe address carries. */
export const PIPE_PREFIX = "\\\\.\\pipe\\";

/** Endpoints that name a Win32 pipe rather than a file. */
export function isPipeEndpoint(endpoint: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(endpoint);
}

/**
 * A pipe name may not contain a path separator — the object manager treats one as
 * a further level of nesting, and `\\.\pipe\a\b` is a different (and for us,
 * unintended) name. Instance keys are `${pid}-${seq}` today, so nothing here is
 * expected to be replaced; this is a guard, not a transformation.
 */
export function pipeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Builds `\\.\pipe\a-b-c` from segments, each sanitised. */
export function pipeEndpoint(...segments: string[]): string {
  return PIPE_PREFIX + segments.map(pipeSegment).join("-");
}

/** What to call this thing in a message the user reads. */
export function endpointKind(endpoint: string): "named pipe" | "socket" {
  return isPipeEndpoint(endpoint) ? "named pipe" : "socket";
}

/**
 * Removes a filesystem endpoint, if that is what it is.
 *
 * Returns whether anything could have been removed — `false` for a pipe, which is
 * the caller's signal that "gone" has to be established by probing instead.
 */
export function removeEndpoint(endpoint: string): boolean {
  if (isPipeEndpoint(endpoint)) return false;
  try {
    fs.rmSync(endpoint, { force: true });
  } catch {}
  return true;
}

/** Connects, or rejects. Shared by every caller so the timeout is one rule. */
export function connectEndpoint(endpoint: string, timeoutMs = 10_000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connecting to the ${endpointKind(endpoint)} ${endpoint} timed out`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Whether someone is listening. The only stale-check a named pipe can support. */
export async function endpointAlive(endpoint: string, timeoutMs = 1_000): Promise<boolean> {
  try {
    const socket = await connectEndpoint(endpoint, timeoutMs);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes an endpoint free to listen on, or reports that it is not.
 *
 * On unix this is the `fs.rmSync(…, { force: true })` upstream does before
 * `listen`, with the probe it never did: unlinking a *live* socket does not stop
 * the server holding it, it just makes it unreachable, so the probe comes first.
 *
 * On Windows there is nothing to unlink. A pipe name is free exactly when nobody
 * is listening on it, and `listen` on a taken name fails with `EADDRINUSE` — which
 * is the correct outcome, because the owner is alive.
 */
export async function reclaimEndpoint(endpoint: string, timeoutMs = 1_000): Promise<boolean> {
  if (await endpointAlive(endpoint, timeoutMs)) return false;
  removeEndpoint(endpoint);
  return true;
}
