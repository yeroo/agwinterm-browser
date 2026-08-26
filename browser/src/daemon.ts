import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app } from "electron";

import { DAEMON_ENDPOINT, endpointStatus, isPipeEndpoint, removeEndpoint } from "pixel-store";
import { releaseProfileLock } from "./foreground";
import { createSession } from "./session/session";
import type { SessionHandle } from "./session/session";

// what
const IDLE_EXIT_MS = 15_000;


interface OpenRequest {
  cmd: "open";
  tty: string;
  argv?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  build?: string;
}

export function buildStamp(): string {
  try {
    return String(Math.floor(fs.statSync(path.join(__dirname, "main.js")).mtimeMs));
  } catch {
    return "unknown";
  }
}

export async function runDaemon(cdpPort: number | null): Promise<void> {
  // One probe, three answers. Upstream's `socketAlive()` had no deadline, so it
  // could only say alive or gone; the probe that replaced it can also run out of
  // time, and a daemon busy enough not to accept within the budget is *not* a
  // daemon whose socket may be unlinked — that would leave it running, unreachable,
  // with a second daemon bound on top of its name. See store/src/endpoint.ts.
  const status = await endpointStatus(DAEMON_ENDPOINT);
  if (status === "alive") {
    process.stderr.write("terminal-browser daemon already running\n");
    // `claimProfile()` runs in `main.tsx` before the shape is chosen, so this
    // process already took a numbered profile and wrote a lock into it — including
    // on this path, where it decided within a line or two not to be a daemon at all.
    // `app.exit` emits no `will-quit`, the one event upstream removes the lock from.
    releaseProfileLock();
    app.exit(3);
    return;
  }
  // A socket path needs its directory to exist and its remnant unlinked before
  // `listen`. A pipe name needs neither: it has no directory, and the object
  // manager dropped the name when the previous owner died. See store/src/endpoint.ts.
  if (!isPipeEndpoint(DAEMON_ENDPOINT)) {
    fs.mkdirSync(path.dirname(DAEMON_ENDPOINT), { recursive: true });
  }
  if (status === "absent") removeEndpoint(DAEMON_ENDPOINT);

  const build = buildStamp();
  const sessions = new Map<string, SessionHandle>();
  let seq = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleIdleExit = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (sessions.size === 0) {
        releaseProfileLock();
        app.exit(0);
      }
    }, IDLE_EXIT_MS);
  };
  scheduleIdleExit();

  const stopEverything = (code: number) => {
    for (const open of [...sessions.values()]) {
      try {
        open.close();
      } catch {}
    }
    sessions.clear();
    setTimeout(() => {
      releaseProfileLock();
      app.exit(code);
    }, 200);
  };
  process.on("SIGINT", () => stopEverything(130));
  process.on("SIGTERM", () => stopEverything(143));

  const server = net.createServer((connection) => {
    let key: string | null = null;
    let session: SessionHandle | null = null;
    const reply = (value: unknown) => {
      try {
        connection.write(`${JSON.stringify(value)}\n`);
      } catch {}
    };

    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let message: Omit<OpenRequest, "cmd"> & { cmd: string };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.cmd === "open" && !session) {
          if (message.build && message.build !== build) {
            reply({ ok: false, error: "stale" });
            connection.end();
            if (sessions.size === 0) {
              releaseProfileLock();
              app.exit(0);
            }
            return;
          }
          if (!message.tty) {
            reply({ ok: false, error: "no tty" });
            connection.end();
            return;
          }
          if (idleTimer) clearTimeout(idleTimer);
          key = `${process.pid}-${++seq}`;
          const sessionKey = key;
          try {
            session = createSession({
              tty: message.tty,
              key: sessionKey,
              argv: message.argv ?? [],
              env: message.env ?? {},
              cwd: message.cwd ?? process.cwd(),
              cdpPort,
              onClose: (code) => {
                sessions.delete(sessionKey);
                reply({ event: "closed", code });
                connection.end();
                scheduleIdleExit();
              },
            });
          } catch (error) {
            reply({ ok: false, error: String(error) });
            connection.end();
            scheduleIdleExit();
            return;
          }
          sessions.set(sessionKey, session);
          reply({ ok: true, session: sessionKey, pid: process.pid });
        } else if (message.cmd === "resize") {
          session?.nudgeResize();
        } else if (message.cmd === "close") {
          session?.close();
        } else if (message.cmd === "shutdown") {
          reply({ ok: true, sessions: sessions.size });
          connection.end();
          setTimeout(() => {
            releaseProfileLock();
            app.exit(0);
          }, 50);
        }
      }
    });
    connection.on("error", () => {});
    connection.on("close", () => {
      if (key && sessions.has(key)) {
        const orphan = sessions.get(key)!;
        sessions.delete(key);
        orphan.close();
        scheduleIdleExit();
      }
    });
  });
  server.on("error", (error) => {
    process.stderr.write(`terminal-browser daemon endpoint error: ${error}\n`);
    releaseProfileLock();
    app.exit(1);
  });
  server.listen(DAEMON_ENDPOINT);
}

