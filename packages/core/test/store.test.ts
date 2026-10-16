import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../src/fsutil";
import { tempStore, sleep } from "./helpers";

let ctx: Awaited<ReturnType<typeof tempStore>>;
beforeEach(async () => {
  ctx = await tempStore();
});
afterEach(async () => {
  await ctx.cleanup();
});

const input = {
  title: "Butter Chicken",
  servings: 4,
  ingredientsMd: "- 600 g chicken thigh\n- 2 tbsp butter",
  methodMd: "1. Marinate.\n2. Cook.",
  tags: ["curry"],
};

describe("recipes", () => {
  it("creates a folder per recipe and unique slugs", async () => {
    const a = await ctx.store.createRecipe(input);
    const b = await ctx.store.createRecipe(input);
    expect(a.slug).toBe("butter-chicken");
    expect(b.slug).toBe("butter-chicken-2");
    const text = await fs.readFile(path.join(ctx.dir, "recipes", "butter-chicken", "recipe.md"), "utf8");
    expect(text).toContain("title: Butter Chicken");
    expect(a.ingredients).toHaveLength(2);
  });

  it("keeps unknown frontmatter fields across updates", async () => {
    const r = await ctx.store.createRecipe(input);
    const file = path.join(ctx.dir, "recipes", r.slug, "recipe.md");
    const text = await fs.readFile(file, "utf8");
    await fs.writeFile(file, text.replace("tags:", "myField: hello\ntags:"));
    await ctx.store.setFlag(r.slug, "favorite", true);
    const after = await fs.readFile(file, "utf8");
    expect(after).toContain("myField: hello");
    expect(after).toContain("favorite: true");
  });

  it("does not rewrite a file when nothing changed", async () => {
    const r = await ctx.store.createRecipe(input);
    const file = path.join(ctx.dir, "recipes", r.slug, "recipe.md");
    const before = (await fs.stat(file)).mtimeMs;
    await sleep(30);
    await ctx.store.mutateRecipe(r.slug, () => undefined, { touch: false });
    expect((await fs.stat(file)).mtimeMs).toBe(before);
  });

  it("refuses to overwrite a file edited elsewhere", async () => {
    const r = await ctx.store.createRecipe(input);
    const loaded = r.mtimeMs;
    await sleep(20);
    const file = path.join(ctx.dir, "recipes", r.slug, "recipe.md");
    await fs.appendFile(file, "\nedited in a text editor\n");
    await expect(ctx.store.updateRecipe(r.slug, { rating: 5 }, { expectedMtimeMs: loaded })).rejects.toBeInstanceOf(ConflictError);
    // without a stale timestamp the edit is applied on top of what is on disk
    await ctx.store.updateRecipe(r.slug, { rating: 5 });
    expect(await fs.readFile(file, "utf8")).toContain("edited in a text editor");
  });

  it("adds notes and cook log lines", async () => {
    const r = await ctx.store.createRecipe(input);
    await ctx.store.addNoteToRecipe(r.slug, "Used less chilli", "2026-10-09");
    const after = await ctx.store.logCooked(r.slug, { date: "2026-10-09", people: 4, rating: 4 });
    expect(after.notes[0]).toEqual({ date: "2026-10-09", text: "Used less chilli" });
    expect(after.cookLog[0]).toMatchObject({ date: "2026-10-09", people: 4, rating: 4 });
    expect(after.lastCooked).toBe("2026-10-09");
    expect(after.meta.rating).toBe(4);
  });

  it("moves deleted recipes to .trash", async () => {
    const r = await ctx.store.createRecipe(input);
    await ctx.store.deleteRecipe(r.slug);
    expect(ctx.store.getRecipe(r.slug)).toBeUndefined();
    const trash = await fs.readdir(path.join(ctx.dir, ".trash"));
    expect(trash[0]).toContain("butter-chicken");
  });

  it("rejects path tricks in slugs", () => {
    expect(() => ctx.store.recipeDir("../etc")).toThrow();
  });

  it("renames a slug and updates meal plans", async () => {
    const r = await ctx.store.createRecipe(input);
    const plan = await ctx.store.getPlan("2026-W42");
    plan.days[0].meals.dinner = { recipe: r.slug, people: null, type: "cook", portions: null, cooked: false, leftoverFrom: null, leftoverStore: "fridge", frozen: [], note: null };
    await ctx.store.savePlan(plan);
    await ctx.store.renameSlug(r.slug, "butter-chook");
    const after = await ctx.store.getPlan("2026-W42");
    expect(after.days[0].meals.dinner?.recipe).toBe("butter-chook");
    expect(ctx.store.getRecipe("butter-chook")).toBeDefined();
  });

  it("reports broken files without crashing", async () => {
    await fs.mkdir(path.join(ctx.dir, "recipes", "broken"), { recursive: true });
    await fs.writeFile(path.join(ctx.dir, "recipes", "broken", "recipe.md"), "---\ntitle: [unclosed\n---\nhello");
    const fresh = new (ctx.store.constructor as any)(ctx.store.cfg);
    await fresh.init();
    expect(fresh.getProblems()[0].slug).toBe("broken");
    await fresh.close();
  });
});

describe("images", () => {
  it("rotates, stores and lists a hero image and thumbnail", async () => {
    const r = await ctx.store.createRecipe(input);
    const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#c33" } }).jpeg().toBuffer();
    const { recipe, file } = await ctx.store.addImage(r.slug, { data: img, originalName: "IMG 1.JPG", kind: "hero" });
    expect(file).toBe("images/hero.jpg");
    expect(recipe.meta.images.hero).toBe("images/hero.jpg");
    const thumb = await ctx.store.thumbnail(r.slug, file, 400);
    expect((await sharp(thumb).metadata()).width).toBe(400);
    const step = await ctx.store.addImage(r.slug, { data: img, originalName: "x.jpg", kind: "step", step: 3, caption: "Looks like this" });
    expect(step.file).toBe("images/step-03.jpg");
    expect(step.recipe.meta.images.gallery[0]).toMatchObject({ kind: "step", step: 3 });
  });
  it("blocks reading outside the recipe folder", () => {
    expect(() => ctx.store.imagePath("butter-chicken", "../../settings.md")).toThrow();
  });
});

describe("settings, foods, plans", () => {
  it("creates default settings and merges updates", async () => {
    expect(ctx.store.getSettings().mealSlots).toEqual(["breakfast", "lunch", "dinner"]);
    await ctx.store.updateSettings({ defaultPeople: 3, extraction: { visionModel: "x:1" } });
    expect(ctx.store.getSettings().defaultPeople).toBe(3);
    expect(ctx.store.getSettings().extraction.textModel).toBeTruthy();
    const text = await fs.readFile(path.join(ctx.dir, "settings.md"), "utf8");
    expect(text).toContain("defaultPeople: 3");
  });
  it("tidies the Ollama address and rejects bad ones", async () => {
    expect(ctx.store.getSettings().ollamaUrl).toBe("");
    await ctx.store.updateSettings({ ollamaUrl: " 192.168.0.66 " });
    expect(ctx.store.getSettings().ollamaUrl).toBe("http://192.168.0.66:11434");
    await ctx.store.updateSettings({ ollamaUrl: "http://my-pc:8080/" });
    expect(ctx.store.getSettings().ollamaUrl).toBe("http://my-pc:8080");
    await ctx.store.updateSettings({ ollamaUrl: "my-pc:9000" });
    expect(ctx.store.getSettings().ollamaUrl).toBe("http://my-pc:9000");
    await expect(ctx.store.updateSettings({ ollamaUrl: "ftp://nope" })).rejects.toThrow(/valid address/);
    expect(ctx.store.getSettings().ollamaUrl).toBe("http://my-pc:9000");
    await ctx.store.updateSettings({ ollamaUrl: "" });
    expect(ctx.store.getSettings().ollamaUrl).toBe("");
  });
  it("stores foods in a Markdown file", async () => {
    await ctx.store.upsertFoods([{ id: "flour", name: "flour", per100g: { calories: 364, proteinG: 10, carbsG: 76, fatG: 1, saturatedFatG: 0.2, fibreG: 3, sugarG: 0.3, sodiumMg: 2 }, source: "manual" }]);
    expect(ctx.store.listFoods()).toHaveLength(1);
    const text = await fs.readFile(path.join(ctx.dir, "nutrition-db.md"), "utf8");
    expect(text).toContain("| flour |");
  });
  it("saves a plan with a readable table and reloads it", async () => {
    const r = await ctx.store.createRecipe(input);
    const plan = await ctx.store.getPlan("2026-W42");
    plan.defaultPeople = 3;
    plan.days[0].meals.dinner = { recipe: r.slug, people: 4, type: "cook", portions: null, cooked: false, leftoverFrom: null, leftoverStore: "fridge", frozen: [], note: null };
    const saved = await ctx.store.savePlan(plan);
    expect(saved.saved).toBe(true);
    const text = await fs.readFile(path.join(ctx.dir, "meal-plans", "2026-W42.md"), "utf8");
    expect(text).toContain("Butter Chicken (cook, 4)");
    expect(text).toContain("startDate: 2026-10-12");
    const again = await ctx.store.getPlan("2026-W42");
    expect(again.days).toHaveLength(7);
    expect(again.days[0].meals.dinner?.people).toBe(4);
    expect(again.defaultPeople).toBe(3);
  });
  it("honours ticks made in a text editor on shopping lists", async () => {
    await ctx.store.saveShoppingList({ week: "2026-W42", generatedAt: null, items: [{ key: "milk", text: "1 l milk", checked: false, manual: false, from: ["X"] }] });
    const file = path.join(ctx.dir, "shopping-lists", "2026-W42.md");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("- [ ]", "- [x]"));
    expect((await ctx.store.getShoppingList("2026-W42")).items[0].checked).toBe(true);
  });
});

describe("file watching", () => {
  it("picks up edits made outside the app", async () => {
    const w = await tempStore({ watch: true });
    try {
      const r = await w.store.createRecipe(input);
      const file = path.join(w.dir, "recipes", r.slug, "recipe.md");
      await sleep(600);
      const text = await fs.readFile(file, "utf8");
      await fs.writeFile(file, text.replace("title: Butter Chicken", "title: Butter Chook"));
      for (let i = 0; i < 40 && w.store.getRecipe(r.slug)?.meta.title !== "Butter Chook"; i++) await sleep(100);
      expect(w.store.getRecipe(r.slug)?.meta.title).toBe("Butter Chook");
      // and brand new folders appear
      await fs.mkdir(path.join(w.dir, "recipes", "toast"), { recursive: true });
      await fs.writeFile(path.join(w.dir, "recipes", "toast", "recipe.md"), "---\ntitle: Toast\n---\n\n# Toast\n\n## Ingredients\n\n- 2 slices bread\n");
      for (let i = 0; i < 40 && !w.store.getRecipe("toast"); i++) await sleep(100);
      expect(w.store.getRecipe("toast")?.ingredients).toHaveLength(1);
    } finally {
      await w.cleanup();
    }
  });
});
