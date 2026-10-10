// Copies new screenshots into docs/screenshots, but only when they differ from the saved one by more than a threshold,
// so the docs folder doesn't churn on tiny rendering differences (anti-aliasing, a changed date…).
//
//   tsx scripts/compare-screenshots.mts [--from .e2e/screenshots] [--to docs/screenshots] [--threshold 3]
//
// Threshold (percent of pixels that differ), in order of priority:
//   --threshold N  ·  SCREENSHOT_THRESHOLD=N env var  ·  "thresholdPercent" in e2e/screenshot-config.json  ·  3
import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = JSON.parse(fs.readFileSync(path.join(root, "e2e", "screenshot-config.json"), "utf8")) as { thresholdPercent: number; pixelTolerance: number };
const threshold = Number(arg("threshold") ?? process.env.SCREENSHOT_THRESHOLD ?? config.thresholdPercent ?? 3);
if (!Number.isFinite(threshold) || threshold < 0) throw new Error("The threshold must be a number of percent, like 3");
const from = path.resolve(root, arg("from") ?? ".e2e/screenshots");
const to = path.resolve(root, arg("to") ?? "docs/screenshots");

/** Percent of pixels that differ; 100 if the image size changed. */
export function diffPercent(a: Buffer, b: Buffer, pixelTolerance = config.pixelTolerance ?? 0.1): number {
  const x = PNG.sync.read(a);
  const y = PNG.sync.read(b);
  if (x.width !== y.width || x.height !== y.height) return 100;
  const changed = pixelmatch(x.data, y.data, undefined, x.width, x.height, { threshold: pixelTolerance });
  return (changed / (x.width * x.height)) * 100;
}

if (!fs.existsSync(from)) {
  console.log(`No new screenshots in ${path.relative(root, from)} — nothing to compare.`);
  process.exit(0);
}
fs.mkdirSync(to, { recursive: true });

const rows: { name: string; result: string }[] = [];
for (const file of fs.readdirSync(from).filter((f) => f.endsWith(".png")).sort()) {
  const fresh = fs.readFileSync(path.join(from, file));
  const target = path.join(to, file);
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, fresh);
    rows.push({ name: file, result: "new — saved" });
    continue;
  }
  const pct = diffPercent(fresh, fs.readFileSync(target));
  if (pct > threshold) {
    fs.writeFileSync(target, fresh);
    rows.push({ name: file, result: `${pct.toFixed(2)}% different — UPDATED` });
  } else {
    rows.push({ name: file, result: `${pct.toFixed(2)}% different — kept (limit ${threshold}%)` });
  }
}

const width = Math.max(...rows.map((r) => r.name.length), 10);
console.log(`\nScreenshots → ${path.relative(root, to)} (update only if more than ${threshold}% of pixels changed)`);
for (const r of rows) console.log(`  ${r.name.padEnd(width)}  ${r.result}`);
const updated = rows.filter((r) => /UPDATED|new/.test(r.result)).length;
console.log(`${updated} updated, ${rows.length - updated} unchanged.\n`);
