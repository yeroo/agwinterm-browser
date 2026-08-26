import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app } from "electron";
import { APP_DIR_NAME } from "pixel-store";

// er i don't think this is necessary anymore given our daemon but i guess it doesn't hurt to be explicit 
export function claimProfile() {
  const appData = process.env.TERMINAL_BROWSER_APPDATA ?? app.getPath("appData");
  for (let i = 0; i < 32; i++) {
    const dir = path.join(appData, i === 0 ? APP_DIR_NAME : `${APP_DIR_NAME}-${i + 1}`);
    const lock = path.join(dir, "terminal-browser.lock");
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      } catch {
        const holder = Number(fs.readFileSync(lock, "utf8"));
        if (holder && holder !== process.pid && alive(holder)) continue;
        fs.writeFileSync(lock, String(process.pid));
      }
      app.setPath("userData", dir);
      app.on("will-quit", () => {
        try {
          if (Number(fs.readFileSync(lock, "utf8")) === process.pid) fs.unlinkSync(lock);
        } catch {}
      });
      return;
    } catch {}
  }
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-")));
}

/**
 * Whether `pid` still holds the lock. `ESRCH` is the only "gone".
 *
 * Upstream answered every error with `false`, which is right on the platform it was
 * written for and wrong here. `process.kill(pid, 0)` sends no signal; it asks whether
 * the process *can* be signalled, and Windows answers `EPERM` for one that exists at a
 * higher integrity level than the caller — an elevated browser probed by an ordinary
 * one. Reading that as death lets the second browser take the first's `userData`, and
 * the symptom is a Chromium profile-lock failure or a concurrent-profile conflict, not
 * anything that names this line. `store/src/instances.ts` already gets this right.
 *
 * An unrecognised code is **not** silently either answer. It is reported and then
 * treated as alive, because the two mistakes are not the same size: refusing a profile
 * that was in fact free costs one numbered directory, and taking one that was not costs
 * the user their session. The warning is what keeps that from being a guess nobody sees.
 *
 * The one thing "treat it as alive" must not do is become permanent, and it would for a
 * value that is not a pid at all: `process.kill` rejects a non-int32 with a `TypeError`
 * rather than an errno, so a lock reading `99999999999` would be warned about and
 * skipped on every launch forever, costing a numbered directory each time. Upstream's
 * blanket `false` at least self-healed there. So the shape of the argument is checked
 * first — a value no pid can take names no process, and reclaiming it is safe.
 */
function alive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code !== "EPERM") {
      console.warn(
        `terminal-browser: probing profile-lock holder ${pid} failed with ${code ?? "no code"}; ` +
          `treating it as alive. Only ESRCH means the holder is gone.`,
      );
    }
    return true;
  }
}
