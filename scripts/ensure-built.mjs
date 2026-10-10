// Builds the web app if it's missing or older than its sources. Shared by `npm run start` and the e2e tests.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function newestMtime(dir) {
  let newest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

export function ensureBuilt(root) {
  const webDir = path.join(root, "packages", "web");
  const dist = path.join(webDir, "dist", "index.html");
  const sources = Math.max(newestMtime(path.join(webDir, "src")), fs.statSync(path.join(webDir, "index.html")).mtimeMs, newestMtime(path.join(root, "packages", "core", "src")));
  if (fs.existsSync(dist) && fs.statSync(dist).mtimeMs >= sources) return;
  console.log("Building the web app…");
  const r = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error("The web app failed to build. Run `pnpm install` first if you haven't.");
    process.exit(r.status ?? 1);
  }
}
