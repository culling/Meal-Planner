// Live checks against the local Ollama models (not part of the automated tests).
//   tsx scripts/live-check.mts nutrition   -> calculate nutrition for a saved fixture recipe
//   tsx scripts/live-check.mts photo       -> read a synthetic cookbook page with the vision model
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { loadConfig } from "../src/config.ts";
import { draftFromAi, structureFromImages } from "../src/extract.ts";
import { draftFromHtml } from "../src/jsonld.ts";
import { calculateNutrition } from "../src/nutrition.ts";
import { OllamaClient } from "../src/ollama.ts";
import { SettingsSchema } from "../src/schemas.ts";
import { DataStore } from "../src/store.ts";

const what = process.argv[2] ?? "nutrition";
const cfg = loadConfig();
const ollama = new OllamaClient(cfg.ollamaUrl);
const settings = SettingsSchema.parse({});
console.log("Ollama:", (await ollama.status()).ok ? "reachable" : "NOT reachable");

if (what === "photo") {
  const page = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1700"><rect width="100%" height="100%" fill="#fbf7ee"/>
  <g font-family="Georgia, serif" fill="#222">
  <text x="80" y="140" font-size="64" font-weight="bold">Lemon Garlic Chicken</text>
  <text x="80" y="195" font-size="28" font-style="italic">Serves 4 · Prep 10 min · Cook 25 min</text>
  <text x="80" y="290" font-size="38" font-weight="bold">Ingredients</text>
  <text x="80" y="350" font-size="32">600 g chicken thigh fillets</text>
  <text x="80" y="395" font-size="32">3 tbsp olive oil</text>
  <text x="80" y="440" font-size="32">4 cloves garlic, crushed</text>
  <text x="80" y="485" font-size="32">1 lemon, juiced</text>
  <text x="80" y="530" font-size="32">1 tsp dried oregano</text>
  <text x="80" y="575" font-size="32">1/2 cup chicken stock</text>
  <text x="80" y="620" font-size="32">Salt and pepper, to taste</text>
  <text x="80" y="720" font-size="38" font-weight="bold">Method</text>
  <text x="80" y="780" font-size="30">1. Season the chicken with salt, pepper and oregano.</text>
  <text x="80" y="825" font-size="30">2. Heat the oil in a large pan over medium-high heat and brown</text>
  <text x="110" y="865" font-size="30">the chicken for 5 minutes each side.</text>
  <text x="80" y="910" font-size="30">3. Add the garlic, lemon juice and stock. Simmer for 12 minutes.</text>
  <text x="80" y="955" font-size="30">4. Rest for 5 minutes before serving.</text>
  <text x="80" y="1060" font-size="28" font-style="italic">Leftovers keep in the fridge for 3 days. Not suitable for freezing.</text>
  <text x="1000" y="1640" font-size="26">p. 87</text></g></svg>`;
  const jpg = await sharp(Buffer.from(page)).jpeg({ quality: 90 }).toBuffer();
  const t0 = Date.now();
  console.log(`Reading with ${settings.extraction.visionModel}...`);
  const ai = await structureFromImages(ollama, settings.extraction.visionModel, [jpg]);
  console.log(`(${Math.round((Date.now() - t0) / 1000)} s)`);
  const draft = draftFromAi(ai, { source: { type: "book", url: null, site: null, author: null, book: null, importedAt: null }, uploadId: null, uploadedImages: [] }, settings, "ocr");
  console.log(JSON.stringify(draft, null, 2));
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-live-"));
  const store = new DataStore({ ...cfg, dataDir: dir, gitAutocommit: false, watch: false });
  await store.init();
  const html = fs.readFileSync(path.join(import.meta.dirname, "..", "test", "fixtures", "chicken-fried-rice.html"), "utf8");
  const d = draftFromHtml(html, "https://www.recipetineats.com/chicken-fried-rice/", { fridgeDays: 3 })!.draft;
  const recipe = await store.createRecipe({ title: d.title, servings: d.servings, ingredientsMd: d.ingredientsMd, methodMd: d.methodMd });
  const t0 = Date.now();
  const res = await calculateNutrition(store, ollama, recipe, { onProgress: (m) => console.log(m) });
  console.log(`(${Math.round((Date.now() - t0) / 1000)} s)  page says 441 kcal/serving (${d.servings} servings)`);
  console.log("per serving:", JSON.stringify(res.nutrition.perServing), res.nutrition.confidence);
  for (const r of res.nutrition.breakdown) console.log(`${r.source === "ai" ? "?" : " "} ${String(r.grams ?? "-").padStart(5)} g  ${String(r.total.calories ?? "-").padStart(6)} kcal  ${r.ingredient}`);
  console.log("warnings:", res.warnings);
  console.log("new foods:", res.newFoods.join(", "));
  fs.rmSync(dir, { recursive: true, force: true });
}
