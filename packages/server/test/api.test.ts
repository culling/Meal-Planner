import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "@mp/core";
import { buildServer } from "../src/server";

let app: App;
let server: Awaited<ReturnType<typeof buildServer>>;
let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mp-api-"));
  app = await createApp({ dataDir: dir, gitAutocommit: false, watch: false });
  server = await buildServer(app, { webDir: path.join(dir, "no-web") });
});
afterAll(async () => {
  await server.close();
  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const j = async (method: string, url: string, body?: unknown) => {
  const res = await server.inject({ method: method as any, url, payload: body as any });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

function multipart(fields: Record<string, string>, files: { name: string; filename: string; data: Buffer }[]) {
  const boundary = "----mp" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(f.data, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("recipes API", () => {
  it("creates, lists, filters and reads recipes", async () => {
    const a = await j("POST", "/api/recipes", {
      title: "Butter Chicken",
      servings: 4,
      ingredientsMd: "- 600 g chicken thigh\n- 2 tbsp butter",
      methodMd: "1. Cook",
      tags: ["curry"],
      times: { totalMinutes: 40 },
      nutrition: { perServing: { calories: 520 }, source: "page" },
      leftovers: { fridgeDays: 4, freezable: true, source: "page" },
    });
    expect(a.status).toBe(201);
    expect(a.body.slug).toBe("butter-chicken");
    await j("POST", "/api/recipes", { title: "Green Salad", servings: 2, ingredientsMd: "- 1 lettuce", methodMd: "1. Toss", nutrition: { perServing: { calories: 120 } }, times: { totalMinutes: 10 } });
    await j("POST", "/api/recipes", { title: "Mystery Dish" });

    const all = await j("GET", "/api/recipes");
    expect(all.body.total).toBe(3);

    const light = await j("GET", "/api/recipes?caloriesMax=300");
    expect(light.body.recipes.map((r: any) => r.slug)).toEqual(["green-salad"]);
    expect(light.body.excludedForMissing.calories).toBe(1); // Mystery Dish has no calorie data

    expect((await j("GET", "/api/recipes?fridgeDaysMin=3&freezable=yes")).body.recipes.map((r: any) => r.slug)).toEqual(["butter-chicken"]);
    expect((await j("GET", "/api/recipes?q=chicken")).body.recipes[0].slug).toBe("butter-chicken");
    expect((await j("GET", "/api/recipes?maxTotalMinutes=15")).body.recipes.map((r: any) => r.slug)).toEqual(["green-salad"]);
    expect((await j("GET", "/api/recipes?sort=calories&order=desc")).body.recipes[0].slug).toBe("butter-chicken");

    const one = await j("GET", "/api/recipes/butter-chicken");
    expect(one.body.ingredients).toHaveLength(2);
    expect(one.body.parts.methodMd).toContain("Cook");
    expect((await j("GET", "/api/recipes/nope")).status).toBe(404);
    expect((await j("GET", "/api/facets")).body.tags[0]).toEqual({ name: "curry", count: 1 });
  });

  it("hides, favourites, notes and cook log", async () => {
    await j("POST", "/api/recipes/mystery-dish/hide", {});
    expect((await j("GET", "/api/recipes")).body.total).toBe(2);
    expect((await j("GET", "/api/recipes?hidden=only")).body.recipes[0].slug).toBe("mystery-dish");
    await j("POST", "/api/recipes/butter-chicken/favorite", { value: true });
    expect((await j("GET", "/api/recipes?favoritesOnly=true")).body.total).toBe(1);

    const n = await j("POST", "/api/recipes/butter-chicken/notes", { text: "Used less chilli", date: "2026-10-09" });
    expect(n.body.notes[0]).toEqual({ date: "2026-10-09", text: "Used less chilli" });
    const c = await j("POST", "/api/recipes/butter-chicken/cooked", { date: "2026-10-09", people: 4, rating: 4 });
    expect(c.body.cookLog[0]).toMatchObject({ people: 4, rating: 4 });
    expect((await j("GET", "/api/recipes?notCookedInDays=30")).body.recipes.map((r: any) => r.slug)).not.toContain("butter-chicken");
  });

  it("returns 409 when the file changed since it was loaded, 400 for bad input", async () => {
    const loaded = (await j("GET", "/api/recipes/green-salad")).body;
    await new Promise((r) => setTimeout(r, 20));
    await fs.appendFile(path.join(dir, "recipes", "green-salad", "recipe.md"), "\nedited elsewhere\n");
    const conflict = await j("PATCH", "/api/recipes/green-salad", { title: "Green Salad 2", expectedMtimeMs: loaded.mtimeMs });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/changed on disk/);
    expect((await j("PATCH", "/api/recipes/green-salad", { rating: 99 })).status).toBe(400);
    const ok = await j("PATCH", "/api/recipes/green-salad", { title: "Green Salad 2", ingredientsMd: "- 1 lettuce\n- 1 cucumber" });
    expect(ok.status).toBe(200);
    expect(ok.body.ingredients).toHaveLength(2);
    expect((await fs.readFile(path.join(dir, "recipes", "green-salad", "recipe.md"), "utf8"))).toContain("edited elsewhere");
  });

  it("uploads images and serves thumbnails", async () => {
    const img = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#369" } }).jpeg().toBuffer();
    const m = multipart({ kind: "hero" }, [{ name: "file", filename: "My Photo.JPG", data: img }]);
    const up = await server.inject({ method: "POST", url: "/api/recipes/butter-chicken/images", ...m });
    expect(up.statusCode).toBe(200);
    expect(JSON.parse(up.body).meta.images.hero).toBe("images/hero.jpg");
    const full = await server.inject({ method: "GET", url: "/images/butter-chicken/images/hero.jpg" });
    expect(full.headers["content-type"]).toBe("image/jpeg");
    const thumb = await server.inject({ method: "GET", url: "/images/butter-chicken/images/hero.jpg?w=200" });
    expect((await sharp(thumb.rawPayload).metadata()).width).toBe(200);
    expect((await server.inject({ method: "GET", url: "/images/butter-chicken/..%2F..%2Fsettings.md" })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("round-trips the raw Markdown editor", async () => {
    const raw = (await j("GET", "/api/recipes/butter-chicken/raw")).body;
    expect(raw.text).toContain("title: Butter Chicken");
    const saved = await j("PUT", "/api/recipes/butter-chicken/raw", { text: raw.text.replace("Butter Chicken", "Butter Chook"), expectedMtimeMs: raw.mtimeMs });
    expect(saved.body.meta.title).toBe("Butter Chook");
    const bad = await j("PUT", "/api/recipes/butter-chicken/raw", { text: "---\ntitle: [oops\n---\nx" });
    expect(bad.status).toBe(400);
  });
});

describe("meal plans API", () => {
  it("sets people at each level and reports where the value came from", async () => {
    await j("PATCH", "/api/meal-plans/2026-W42", { defaultPeople: 3 });
    await j("PUT", "/api/meal-plans/2026-W42/days/2026-10-12/meals/dinner", { meal: { recipe: "butter-chicken", type: "cook", portions: 6 } });
    let v = (await j("GET", "/api/meal-plans/2026-W42")).body;
    expect(v.days[0].meals.dinner.people).toEqual({ value: 3, from: "week" });
    expect(v.days[0].meals.dinner.scale).toBe(1.5); // 6 portions / 4 servings

    v = (await j("PATCH", "/api/meal-plans/2026-W42/days/2026-10-12", { people: 5 })).body;
    expect(v.days[0].meals.dinner.people).toEqual({ value: 5, from: "day" });
    v = (await j("PATCH", "/api/meal-plans/2026-W42/days/2026-10-12/meals/dinner/people", { people: 2 })).body;
    expect(v.days[0].meals.dinner.people).toEqual({ value: 2, from: "meal" });
    v = (await j("PATCH", "/api/meal-plans/2026-W42/days/2026-10-12/meals/dinner/people", { people: null })).body;
    expect(v.days[0].meals.dinner.people.from).toBe("day");
  });

  it("tracks leftovers and warns about expired ones", async () => {
    await j("PATCH", "/api/meal-plans/2026-W42/days/2026-10-12", { people: null }); // back to the week default of 3: 6 portions, 3 left over
    await j("PUT", "/api/meal-plans/2026-W42/days/2026-10-14/meals/lunch", { meal: { recipe: "butter-chicken", type: "leftovers", leftoverFrom: "2026-10-12/dinner", people: 1 } });
    let v = (await j("GET", "/api/meal-plans/2026-W42")).body;
    expect(v.warnings).toEqual([]);
    await j("PUT", "/api/meal-plans/2026-W42/days/2026-10-18/meals/lunch", { meal: { recipe: "butter-chicken", type: "leftovers", leftoverFrom: "2026-10-12/dinner", people: 1 } });
    v = (await j("GET", "/api/meal-plans/2026-W42")).body;
    expect(v.warnings.map((w: any) => w.code)).toContain("expired");
    const avail = (await j("GET", "/api/leftovers?date=2026-10-13")).body.leftovers;
    expect(avail[0]).toMatchObject({ recipe: "butter-chicken", safeUntil: "2026-10-16" });
    await j("DELETE", "/api/meal-plans/2026-W42/days/2026-10-18/meals/lunch");
  });

  it("marks cooked, builds the shopping list, copies and suggests", async () => {
    const cooked = await j("POST", "/api/meal-plans/2026-W42/days/2026-10-12/meals/dinner/cooked", { rating: 5 });
    expect(cooked.body.days[0].meals.dinner.meal.cooked).toBe(true);
    const list = await j("POST", "/api/meal-plans/2026-W42/shopping-list");
    expect(list.body.items.length).toBeGreaterThan(0);
    const toggled = await j("PUT", "/api/meal-plans/2026-W42/shopping-list", { items: [...list.body.items.map((i: any, n: number) => (n === 0 ? { ...i, checked: true } : i)), { key: "bin-bags", text: "bin bags", checked: false, manual: true, from: [] }] });
    expect(toggled.body.items[0].checked).toBe(true);
    expect((await j("POST", "/api/meal-plans/2026-W42/shopping-list")).body.items.some((i: any) => i.key === "bin-bags")).toBe(true);

    expect((await j("POST", "/api/meal-plans/2026-W43/copy-from", { from: "2026-W42" })).body.days[0].meals.dinner.meal.cooked).toBe(false);
    expect((await j("POST", "/api/meal-plans/2026-W43/copy-from", { from: "2026-W42" })).status).toBe(400); // already has meals
    expect((await j("POST", "/api/meal-plans/2026-W43/copy-from", { from: "2026-W42", overwrite: true })).status).toBe(200);

    const sug = await j("POST", "/api/meal-plans/2026-W50/suggest", { seed: 1 });
    expect(sug.body.saved).toBe(false);
    expect(sug.body.notes.length).toBeGreaterThan(0);
    expect((await j("GET", "/api/meal-plans")).body.weeks).toEqual(["2026-W42", "2026-W43"]);
    expect((await j("GET", "/api/meal-plans/bad-week")).status).toBe(400);
  });
});

describe("foods, settings, status", () => {
  it("edits the nutrition database and clears the question mark", async () => {
    await app.store.upsertFoods([{ id: "chicken-thigh", name: "chicken thigh", source: "ai", per100g: { calories: 200, proteinG: 18, carbsG: 0, fatG: 14, saturatedFatG: 4, fibreG: 0, sugarG: 0, sodiumMg: 90 } }]);
    const res = await j("PUT", "/api/foods/chicken-thigh", { per100g: { calories: 210, proteinG: 19, carbsG: 0, fatG: 15, saturatedFatG: 4, fibreG: 0, sugarG: 0, sodiumMg: 90 } });
    expect(res.status).toBe(200);
    const foods = (await j("GET", "/api/foods")).body.foods;
    expect(foods[0]).toMatchObject({ id: "chicken-thigh", source: "manual" });
    expect((await j("POST", "/api/foods", { name: "Chicken Thigh" })).status).toBe(400); // duplicate id
    expect((await j("POST", "/api/foods", { name: "Rice", per100g: { calories: 130 } })).status).toBe(200);
    expect((await j("DELETE", "/api/foods/rice")).status).toBe(200);
  });

  it("re-totals a recipe when a person edits one ingredient row", async () => {
    const row = (ingredient: string, calories: number, ai: boolean) => ({ ingredient, food: null, grams: 100, gramsSource: "manual", excluded: false, override: !ai, source: ai ? "ai" : "manual", total: { calories } });
    const res = await j("PUT", "/api/recipes/butter-chicken/nutrition/breakdown", { rows: [row("600 g chicken", 800, true), row("2 tbsp butter", 200, false)] });
    expect(res.body.meta.nutrition.perServing.calories).toBe(250); // (800 + 200) / 4 servings
    const rows = res.body.meta.nutrition.breakdown;
    expect(rows.map((r: any) => r.source)).toEqual(["ai", "manual"]);
    const manual = await j("PUT", "/api/recipes/butter-chicken/nutrition/manual", { perServing: { calories: 480, proteinG: 30 } });
    expect(manual.body.meta.nutrition).toMatchObject({ source: "manual", confidence: "high" });
    expect(manual.body.meta.nutrition.breakdown.every((r: any) => r.source === "manual")).toBe(true);
  });

  it("updates settings and reports status", async () => {
    const s = await j("PUT", "/api/settings", { defaultPeople: 3, mealSlots: ["breakfast", "lunch", "dinner", "snack"] });
    expect(s.body.defaultPeople).toBe(3);
    expect((await j("PUT", "/api/settings", { defaultPeople: "lots" })).status).toBe(400);
    const st = (await j("GET", "/api/status")).body;
    expect(st.recipes).toBe(3);
    expect(st.dataDir).toBe(dir);
  });
});

describe("saved photos and meal copying API", () => {
  it("saves a named photo, lists it, edits it, serves its pages, and deletes it", async () => {
    const img = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#ddd" } }).jpeg().toBuffer();
    const m = multipart({ name: "Daal Curry", bookTitle: "Veggie", bookPage: "240" }, [{ name: "files", filename: "IMG_2043.jpg", data: img }]);
    const made = await server.inject({ method: "POST", url: "/api/photos", ...m });
    expect(made.statusCode).toBe(201);
    const { photo } = JSON.parse(made.body);
    expect(photo).toMatchObject({ id: "daal-curry", name: "Daal Curry", status: "waiting", images: ["page-1.jpg"], book: { title: "Veggie", page: "240" } });
    expect((await j("GET", "/api/photos")).body.photos[0]).toMatchObject({ id: "daal-curry", hasDraft: false });
    expect((await j("PATCH", "/api/photos/daal-curry", { name: "Tasty Daal", notes: "p240" })).body.photo.name).toBe("Tasty Daal");
    const page = await server.inject({ method: "GET", url: "/api/photos/daal-curry/images/page-1.jpg?w=200" });
    expect(page.headers["content-type"]).toBe("image/jpeg");
    expect((await sharp(page.rawPayload).metadata()).width).toBe(200);
    expect((await server.inject({ method: "GET", url: "/api/photos/daal-curry/images/..%2Fphoto.md" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await j("POST", "/api/photos/daal-curry/blank-draft")).body.draft).toMatchObject({ title: "Tasty Daal", photoId: "daal-curry" });
    expect((await j("POST", "/api/photos/nope/read", {})).status).toBe(404);
    const bad = await server.inject({ method: "POST", url: "/api/photos", ...multipart({ name: "x" }, [{ name: "files", filename: "x.heic", data: Buffer.from("nope") }]) });
    expect(bad.statusCode).toBe(400);
    expect((await j("DELETE", "/api/photos/daal-curry")).status).toBe(200);
    expect((await j("GET", "/api/photos/daal-curry")).status).toBe(404);
  });

  it("copies a meal as leftovers across weeks and undoes it", async () => {
    await j("PUT", "/api/meal-plans/2026-W46/days/2026-11-15/meals/dinner", { meal: { recipe: "butter-chicken", type: "cook" } });
    const r = await j("POST", "/api/meal-plans/2026-W46/copy", { from: { date: "2026-11-15", slot: "dinner" }, to: [{ date: "2026-11-16", slot: "lunch" }, { date: "2026-11-17", slot: "dinner" }] });
    expect(r.status).toBe(200);
    expect(r.body.result.mode).toBe("leftovers");
    expect(r.body.weeks.sort()).toEqual(["2026-W46", "2026-W47"]);
    expect(r.body.message).toMatch(/leftovers on Mon lunch, Tue dinner/);
    expect((await j("GET", "/api/meal-plans/2026-W47")).body.days[0].meals.lunch.meal.type).toBe("leftovers");
    const undone = await j("POST", "/api/meal-plans/2026-W46/restore", { plans: r.body.undo.plans });
    expect(undone.status).toBe(200);
    expect((await j("GET", "/api/meal-plans/2026-W47")).body.days[0].meals.lunch).toBeFalsy();
    expect((await j("POST", "/api/meal-plans/2026-W46/copy", { from: { date: "2026-11-15", slot: "dinner" }, to: [] })).status).toBe(400);
  });
});
