import { spawnSync } from "node:child_process";
import path from "node:path";

// After every run, bring docs/screenshots up to date (only images that changed by more than the threshold are replaced).
export default function globalTeardown() {
  if (process.env.SKIP_SCREENSHOT_UPDATE) return;
  const root = path.resolve(import.meta.dirname, "..");
  spawnSync(process.execPath, ["--import", "tsx", "scripts/compare-screenshots.mts"], { cwd: root, stdio: "inherit" });
}
