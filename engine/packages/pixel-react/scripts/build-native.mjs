import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const packageDir = path.resolve(import.meta.dirname, "..");

/**
 * The name `crate-type = ["cdylib"]` gives the artifact on this platform.
 *
 * Windows differs in both halves of the name — no `lib` prefix, and `.dll` rather
 * than `.so` — so the pre-port `platform === "darwin" ? … : …` resolved to
 * `libpixel_node.so` here and the copy below failed with ENOENT, which reads as a
 * missing build rather than a wrong filename.
 */
export function libraryName(platform) {
  if (platform === "darwin") return "libpixel_node.dylib";
  if (platform === "win32") return "pixel_node.dll";
  return "libpixel_node.so";
}

export function build() {
  execFileSync("cargo", ["build", "-p", "pixel-node"], { cwd: packageDir, stdio: "inherit" });

  const targetDir = path.resolve(packageDir, process.env.CARGO_TARGET_DIR ?? "../../target");
  const source = path.join(targetDir, "debug", libraryName(process.platform));
  const destination = path.join(packageDir, "native", "pixel.node");

  if (!fs.existsSync(source)) {
    throw new Error(
      `cargo build reported success but ${source} does not exist — pixel-node's ` +
        `cdylib is not named what ${process.platform} was expected to name it`,
    );
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(destination, { force: true });
  fs.copyFileSync(source, destination);
  return destination;
}

// Importing this module — which the tests do, for `libraryName` — must not shell out
// to cargo, so the build runs only when the file is the entry point.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  build();
}
