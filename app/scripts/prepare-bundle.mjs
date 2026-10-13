// Builds what the installer bundles next to the app: the native-messaging host
// (as a Tauri sidecar) and both browser-extension builds.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(app, "..");
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

run("cargo build --release -p idm-host", root);
const triple = execSync("rustc -vV", { encoding: "utf8" }).match(/host: (\S+)/)[1];
const binDir = join(app, "src-tauri", "binaries");
mkdirSync(binDir, { recursive: true });
copyFileSync(join(root, "target", "release", "idm-host.exe"), join(binDir, `idm-host-${triple}.exe`));

run("npm run build", join(root, "extension"));
console.log("bundle inputs ready");
