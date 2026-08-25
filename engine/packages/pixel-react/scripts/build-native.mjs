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
  try {
    fs.rmSync(destination, { force: true });
    fs.copyFileSync(source, destination);
  } catch (error) {
    // `force: true` covers a *missing* file, not a busy one. Windows refuses to
    // unlink or overwrite a DLL that is currently mapped, which here means a
    // browser is still running on the previous build — and `EBUSY`/`EPERM` from a
    // path called `pixel.node` reads as a permissions problem rather than as
    // "close the browser and build again".
    if (error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES") {
      throw new Error(
        `${destination} is in use (${error.code}) — a browser is still running on ` +
          `the previous build. Close it and build again.`,
      );
    }
    throw error;
  }
  return destination;
}

/**
 * Whether this module is the process entry point.
 *
 * Both sides are resolved through `realpath`, because they arrive in different
 * shapes: `import.meta.filename` has already been realpath'd by the ESM loader,
 * while `process.argv[1]` is the path as typed. Comparing them directly made any
 * invocation through a symlink — which is how a linked `node_modules/.bin` entry or
 * a junctioned checkout runs — silently build nothing and exit 0.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  const real = (file) => {
    try {
      return fs.realpathSync(path.resolve(file));
    } catch {
      return path.resolve(file);
    }
  };
  return real(process.argv[1]) === real(import.meta.filename);
}

// Importing this module — which the tests do, for `libraryName` — must not shell out
// to cargo, so the build runs only when the file is the entry point.
if (isEntryPoint()) {
  build();
}
