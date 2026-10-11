// Copies the built extension into release/extension (ready for "Load unpacked") and zips it
// (manifest.json at the zip root, as the Chrome Web Store expects). Run via `npm run package:extension`.
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"));
const outDir = join(root, "release", "extension");
const zipPath = join(root, "release", `lyrics-overlay-extension-${version}.zip`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const item of ["manifest.json", "dist", "icons"]) {
  cpSync(join(root, "extension", item), join(outDir, item), { recursive: true });
}

rmSync(zipPath, { force: true });

if (process.platform === "win32") {
  // Windows' bundled bsdtar writes proper zips (PowerShell 5's Compress-Archive uses "\" in entry names,
  // which the zip format doesn't allow). Use the full path so Git Bash's GNU tar isn't picked up instead.
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-a", "-c", "-f", zipPath, "-C", outDir, "manifest.json", "dist", "icons"], { stdio: "inherit" });
} else {
  execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: outDir, stdio: "inherit" });
}

console.log(`Extension folder: ${outDir}`);
console.log(`Extension zip:    ${zipPath}`);
