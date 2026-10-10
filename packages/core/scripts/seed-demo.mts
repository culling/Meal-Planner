// Fill a THROWAWAY data folder with demo recipes (from the saved RecipeTin Eats fixtures), a plan and a shopping list,
// so the app can be looked at and tested without touching real data.
//   tsx scripts/seed-demo.mts <data-dir> [--fake-ai]
// Refuses to run in a folder that already has recipes. Never point it at your real data folder.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { loadConfig } from "../src/config.ts";
import { Importer } from "../src/importer.ts";
import { JobManager } from "../src/jobs.ts";
import { Planner } from "../src/planner.ts";
import { applyBreakdown } from "../src/nutrition.ts";
import { addDays, isoWeekOf, todayYmd } from "../src/dates.ts";
import { DataStore } from "../src/store.ts";
import type { PoliteFetcher } from "../src/webfetch.ts";

const dir = process.argv[2];
if (!dir) throw new Error("Usage: tsx scripts/seed-demo.mts <data-dir>");
const cfg = loadConfig({ dataDir: dir, watch: false });
if (fs.existsSync(path.join(cfg.dataDir, "recipes")) && fs.readdirSync(path.join(cfg.dataDir, "recipes")).length) throw new Error(`${cfg.dataDir} already has recipes — refusing to seed it`);

const store = new DataStore(cfg);
await store.init();
const fixtures = path.join(import.meta.dirname, "..", "test", "fixtures");
const colours: Record<string, string> = { "butter-chicken": "#e07a3f", "beef-stew": "#8a4b2d", "chicken-fried-rice": "#d9a441", "spaghetti-bolognese": "#c0453a" };

const fetcher = {
  html: async (u: string) => fs.readFileSync(path.join(fixtures, `${new URL(u).pathname.replace(/\//g, "")}.html`), "utf8"),
  // a coloured placeholder instead of downloading the photo
  binary: async (u: string) => {
    const name = u.toLowerCase().includes("butter") ? "butter-chicken" : u.toLowerCase().includes("stew") ? "beef-stew" : u.toLowerCase().includes("rice") ? "chicken-fried-rice" : "spaghetti-bolognese";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="100%" height="100%" fill="${colours[name]}"/><circle cx="800" cy="450" r="260" fill="rgba(255,255,255,.25)"/><text x="800" y="480" font-size="110" text-anchor="middle" fill="white" font-family="Georgia">${name.replace(/-/g, " ")}</text></svg>`;
    return sharp(Buffer.from(svg)).jpeg().toBuffer();
  },
} as unknown as PoliteFetcher;

const jobs = new JobManager();
const importer = new Importer(store, {} as any, fetcher, jobs);
const slugs: string[] = [];
for (const name of ["butter-chicken", "beef-stew", "chicken-fried-rice", "spaghetti-bolognese"]) {
  const { draft } = await importer.fromUrl(`https://www.recipetineats.com/${name}/`);
  const r = await importer.confirm(draft);
  slugs.push(r.slug);
  console.log("imported", r.slug);
}
await store.setFlag("butter-chicken", "favorite", true);
await store.logCooked("butter-chicken", { date: addDays(todayYmd(), -9), people: 4, rating: 5 });
await store.logCooked("beef-stew", { date: addDays(todayYmd(), -30), people: 4, rating: 4 });
await store.createRecipe({
  title: "Cheese on Toast",
  servings: 1,
  times: { prepMinutes: 2, cookMinutes: 5, totalMinutes: 7 },
  tags: ["quick", "lunch"],
  course: ["lunch"],
  ingredientsMd: "- 2 slices bread\n- 40 g cheddar, grated\n- 1 tsp butter",
  methodMd: "1. Toast the bread.\n2. Top with cheese and grill until bubbling.",
  nutrition: { perServing: { calories: 380, proteinG: 17, carbsG: 32, fatG: 20, saturatedFatG: 10, fibreG: 2, sugarG: 3, sodiumMg: 700 }, source: "manual", confidence: "high", calculatedAt: null, breakdown: [] },
  leftovers: { fridgeDays: 1, freezerDays: null, freezable: false, reheatNotes: null, source: "manual" },
});

if (process.argv.includes("--fake-ai")) {
  // pretend the model filled in a few foods so the "?" markers and the nutrition database have something to show
  const n = (calories: number, p: number, c: number, f: number, sat: number, fibre: number, sugar: number, sodium: number) => ({ calories, proteinG: p, carbsG: c, fatG: f, saturatedFatG: sat, fibreG: fibre, sugarG: sugar, sodiumMg: sodium });
  await store.upsertFoods([
    { id: "bread", name: "bread", aliases: ["white bread"], per100g: n(265, 9, 49, 3.2, 0.7, 2.7, 5, 491), source: "manual" },
    { id: "cheddar", name: "cheddar cheese", aliases: ["cheddar"], per100g: n(403, 25, 1.3, 33, 21, 0, 0.5, 621), source: "manual" },
    { id: "butter", name: "butter", aliases: [], per100g: n(717, 0.9, 0.1, 81, 51, 0, 0.1, 11), source: "ai", gramsPerCup: 227 },
    { id: "chicken-breast", name: "chicken breast", aliases: [], per100g: n(120, 22.5, 0, 2.6, 0.6, 0, 0, 45), source: "ai" },
    { id: "white-rice", name: "white rice", aliases: ["cooked white rice"], per100g: n(130, 2.7, 28, 0.3, 0.1, 0.4, 0.1, 1), source: "ai", gramsPerCup: 185 },
    { id: "peanut-oil", name: "peanut oil", aliases: [], per100g: n(884, 0, 0, 100, 17, 0, 0, 0), source: "manual" },
  ]);
  const r = store.requireRecipe("chicken-fried-rice");
  const row = (ingredient: string, food: string, grams: number, kcal: number, p: number, c: number, f: number, ai: boolean) => ({
    ingredient,
    food,
    grams,
    gramsSource: ai ? ("ai" as const) : ("unit" as const),
    excluded: false,
    override: false,
    source: ai ? ("ai" as const) : ("manual" as const),
    total: n(kcal, p, c, f, 0, 0, 0, 0),
  });
  await applyBreakdown(store, r.slug, [
    row("2 tbsp oil (peanut, vegetable or canola)", "peanut-oil", 28, 247, 0, 0, 28, false),
    row("150g (5oz) chicken breast (finely sliced into small pieces)", "chicken-breast", 150, 180, 33.8, 0, 3.9, true),
    row("2 cups (packed) cooked white rice (day old)", "white-rice", 370, 481, 10, 104, 1.1, true),
  ]);
}

// two saved photos: one waiting to be read, one already made into a recipe
const page = (title: string, lines: string[]) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect width="100%" height="100%" fill="#f6f1e6"/><g font-family="Georgia, serif" fill="#2b2b2b"><text x="80" y="170" font-size="64" font-weight="bold">${title}</text>${lines.map((l, i) => `<text x="80" y="${300 + i * 56}" font-size="36">${l}</text>`).join("")}</g></svg>`)).jpeg({ quality: 85 }).toBuffer();
await store.photos.create({
  name: "Daal Curry",
  files: [{ data: await page("Tasty Daal Curry", ["Serves 4 | 696 calories", "1 onion", "1 clove of garlic", "300g dried red split lentils", "1 x 400g tin of light coconut milk", "200g baby spinach"]), name: "daal.jpg" }],
  book: { title: "The Veggie Book", author: null, page: 240 },
});
const done = await store.photos.create({ name: "Lemon Chicken", files: [{ data: await page("Lemon Chicken", ["600 g chicken thigh", "3 tbsp olive oil", "1 lemon, juiced"]), name: "lemon.jpg" }] });
await store.photos.markDone(done.id, "cheese-on-toast");

const week = isoWeekOf(todayYmd());
const planner = new Planner(store);
const monday = (await store.getPlan(week)).startDate;
await planner.setPeople(week, {}, 3);
await planner.setMeal(week, monday, "dinner", { recipe: "butter-chicken", type: "cook", portions: 6, cooked: false });
await planner.setMeal(week, addDays(monday, 1), "lunch", { recipe: "butter-chicken", type: "leftovers", leftoverFrom: `${monday}/dinner`, people: 2 });
await planner.setMeal(week, addDays(monday, 1), "dinner", { recipe: "chicken-fried-rice", type: "cook" });
await planner.setPeople(week, { date: addDays(monday, 2) }, 5);
await planner.setMeal(week, addDays(monday, 2), "dinner", { recipe: "spaghetti-bolognese", type: "cook" });
await planner.setMeal(week, addDays(monday, 3), "dinner", { type: "eat-out", note: "Pizza night" });
await planner.generateShopping(week);
await store.close();
console.log(`Demo data written to ${cfg.dataDir}`);
