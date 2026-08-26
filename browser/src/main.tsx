import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app, screen } from "electron";

import { runDaemon } from "./daemon";
import { entryMode, sessionArgv } from "./entry";
import { releaseProfileLock, runForeground } from "./foreground";
import { LOGS_DIR, ensureDataDir } from "pixel-store";
import { appLog } from "pixel-react";
import { claimProfile } from "./profile";
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

if (process.env.TERMINAL_BROWSER_DISABLE_GPU === "1") {
  app.commandLine.appendSwitch("disable-gpu");
}
try {
  ensureDataDir();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch {}
app.commandLine.appendSwitch("enable-logging", "file");
app.commandLine.appendSwitch("log-file", path.join(LOGS_DIR, "chromium.log"));
app.setName("terminal-browser");
claimProfile();
// The lock is claimed here, before the shape is chosen, so every browser process holds
// one — and nothing in Electron gives it back. `claimProfile` removes it from
// `will-quit`, which `app.exit` does not emit, so all nine `app.exit` sites release it
// explicitly first. What none of that covers is the exit nobody wrote: an uncaught
// throw or rejection from a callback the IIFE below is no longer awaiting, which Node
// terminates on with none of those lines running.
//
// That leak used to heal itself. Upstream's `alive()` answered every failed probe with
// "dead", so the next launch reclaimed the directory; divergence 13 deliberately
// stopped that, and a leaked lock naming a pid Windows has since reissued to a
// higher-integrity process now probes `EPERM`, reads as alive, and strands its profile
// for as long as that process lives. The user is logged out again, which is the whole
// defect. So the last exit route gets a handler too. `releaseProfileLock` is
// synchronous, ownership-checked and throws nothing, which is all a Node `exit`
// handler may be; the explicit calls stay, because `app.exit` is not specified to run
// Node's exit handlers either.
process.on("exit", releaseProfileLock);


function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no port assigned"));
      });
    });
  });
}


void (async () => {
  const cdpPort = await freePort().catch(() => null);
  if (cdpPort != null) app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
  await app.whenReady();
  appLog(
    "info",
    "scale",
    `chromium reports ${screen
      .getAllDisplays()
      .map((d) => `${d.size.width}x${d.size.height}@${d.scaleFactor}x`)
      .join(", ")}`,
  );
  const argv = process.argv.slice(2);
  if (entryMode(argv) === "daemon") await runDaemon(cdpPort);
  else await runForeground(cdpPort, sessionArgv(argv));
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  // `claimProfile()` ran above, before either shape was chosen, so a start that
  // never reached one is still holding a lock — and `app.exit` emits no `will-quit`
  // to remove it. A browser that failed to start is exactly the process whose lock
  // nobody goes back for.
  releaseProfileLock();
  app.exit(1);
});
