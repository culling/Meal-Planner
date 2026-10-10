// Run one photo through the photo-import pipeline and print what comes out.
//   tsx scripts/try-photo.mts "<path to image>"
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Importer } from "../src/importer.ts";
import { JobManager } from "../src/jobs.ts";
import { OllamaClient } from "../src/ollama.ts";
import { DataStore } from "../src/store.ts";

const file = process.argv[2];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-photo-"));
const cfg = loadConfig({ dataDir: dir, gitAutocommit: false, watch: false });
const store = new DataStore(cfg);
await store.init();
const jobs = new JobManager();
const importer = new Importer(store, new OllamaClient(cfg.ollamaUrl), {} as any, jobs);
const t0 = Date.now();
const job = importer.startImageImport([{ data: fs.readFileSync(file), name: path.basename(file) }], {});
let seen = 0;
for (;;) {
  const j = jobs.get(job.id)!;
  while (seen < j.progress.length) console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, j.progress[seen++]);
  if (j.status !== "running") {
    console.log(j.status, `${Math.round((Date.now() - t0) / 1000)}s`);
    if (j.status === "error") console.log("ERROR:", j.error);
    else console.log(JSON.stringify((j.result as any).draft, (k, v) => (k === "confidence" || k === "warnings" || k === "ingredientsMd" || k === "methodMd" || k === "title" || k === "servings" || k === "times" || k === "nutrition" || k === "sourceNotes" || k === "leftovers" || k === "tags" || k === "cuisine" || k === "" ? v : undefined), 1));
    const d = (j.result as any)?.draft;
    if (d) console.log("\nINGREDIENTS\n" + d.ingredientsMd + "\n\nMETHOD\n" + d.methodMd);
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
fs.rmSync(dir, { recursive: true, force: true });
