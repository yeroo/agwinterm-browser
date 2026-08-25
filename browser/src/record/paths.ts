import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "pixel-store";
import { urlHost } from "../url";

/**
 * Where alt+r writes its frames.
 *
 * `01-baseline-errors.md` listed the inherited `/tmp/recordings` as a Task 13 port
 * and it was the one entry on that list nothing came back for. On Windows a leading
 * slash is *drive-relative*, not absolute, so `path.join` resolved it against
 * whatever drive the browser was launched from: recordings landed in `C:\tmp\` (or
 * `D:\tmp\`, depending), outside `appPaths()` and so outside everything an uninstall
 * removes, and the "copied to clipboard" toast — which abbreviates a home-relative
 * path — showed the raw drive root because no `~` was ever in it.
 *
 * Under `%LOCALAPPDATA%\<app>\recordings` instead, beside the other four directories
 * the port gave a Windows home. Unix keeps `/tmp/recordings` byte-for-byte: it is a
 * real absolute path there, and moving it would be a behaviour change upstream did
 * not ask for.
 */
const OUTPUT_ROOT =
  process.platform === "win32" ? path.join(DATA_DIR, "recordings") : "/tmp/recordings";

export function newRecordingDir(pageUrl: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = urlHost(pageUrl).replace(/[^a-z0-9.-]/gi, "").slice(0, 40) || "page";
  const base = path.join(OUTPUT_ROOT, `${slug}-${time}`);
  for (let i = 0; ; i++) {
    const dir = i === 0 ? base : `${base}-${i + 1}`;
    if (!fs.existsSync(dir)) return dir;
  }
}
