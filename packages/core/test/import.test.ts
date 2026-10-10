import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Importer } from "../src/importer";
import { JobManager } from "../src/jobs";
import { draftFromHtml, findJsonLdRecipe } from "../src/jsonld";
import { Planner } from "../src/planner";
import { ImportError, PoliteFetcher } from "../src/webfetch";
import { tempStore } from "./helpers";

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", `${name}.html`), "utf8");
const url = (name: string) => `https://www.recipetineats.com/${name}/`;
const parse = (name: string) => draftFromHtml(fixture(name), url(name), { fridgeDays: 3 })!;

describe("JSON-LD import from saved RecipeTin Eats pages", () => {
  it("reads the basics of butter chicken", () => {
    const { draft, imageUrl } = parse("butter-chicken");
    expect(draft.title).toBe("Butter Chicken");
    expect(draft.servings).toBe(3);
    expect(draft.times).toEqual({ prepMinutes: 10, cookMinutes: 25, totalMinutes: 35 });
    expect(draft.source).toMatchObject({ type: "web", site: "RecipeTin Eats", author: "Nagi", url: url("butter-chicken") });
    expect(draft.nutrition).toMatchObject({ source: "page" });
    expect(draft.nutrition!.perServing).toMatchObject({ calories: 402, proteinG: 39.8, sodiumMg: 928 });
    expect(draft.ingredientsMd.split("\n").length).toBeGreaterThan(15);
    expect(draft.ingredientsMd).toContain("- 1/2 cup plain yoghurt (full fat)");
    expect(draft.methodMd.split("\n")[0]).toMatch(/^1\. /);
    expect(draft.tags).toContain("indian");
    expect(imageUrl).toMatch(/^https:\/\/www\.recipetineats\.com\/.*\.jpg$/);
  });

  it("cleans plugin noise out of ingredient lines", () => {
    const { draft } = parse("beef-stew");
    expect(draft.ingredientsMd).not.toMatch(/Note \d|\(,/);
    expect(draft.ingredientsMd).toContain('chuck beef (cut into 3.5 cm / 1.5" cubes)');
  });

  it("extracts the notes box with one note per line", () => {
    const { draft } = parse("butter-chicken");
    expect(draft.sourceNotes.split("\n\n").length).toBeGreaterThanOrEqual(5);
    expect(draft.sourceNotes).toMatch(/^1\. Garam Masala/);
  });

  it("finds storage advice in the article and ignores reader comments", () => {
    expect(parse("beef-stew").draft.leftovers).toMatchObject({ fridgeDays: 4, freezerDays: 90, freezable: true, source: "page" });
    expect(parse("chicken-fried-rice").draft.leftovers).toMatchObject({ fridgeDays: 3, source: "page" });
    // these two pages only mention freezing in comments, so nothing is claimed
    expect(parse("butter-chicken").draft.leftovers).toMatchObject({ freezerDays: null, freezable: null, source: "estimated" });
    expect(parse("spaghetti-bolognese").draft.leftovers).toMatchObject({ freezerDays: null, freezable: null, source: "estimated" });
  });

  it("copes with the three JSON-LD shapes", () => {
    const wrap = (json: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(json)}</script></head><body></body></html>`;
    const recipe = { "@type": "Recipe", name: "T", recipeIngredient: ["1 egg"], recipeInstructions: "Boil it" };
    expect(findJsonLdRecipe(wrap(recipe))?.name).toBe("T");
    expect(findJsonLdRecipe(wrap([{ "@type": "WebSite" }, recipe]))?.name).toBe("T");
    expect(findJsonLdRecipe(wrap({ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, { ...recipe, "@type": ["Recipe", "Thing"] }] }))?.name).toBe("T");
    expect(findJsonLdRecipe(wrap({ "@type": "Article" }))).toBeNull();
  });

  it("flattens HowToSection steps with the section name", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      name: "X",
      recipeYield: ["4", "4 servings"],
      totalTime: "PT1H15M",
      recipeInstructions: [
        { "@type": "HowToSection", name: "Sauce", itemListElement: [{ "@type": "HowToStep", text: "Mix." }, { "@type": "HowToStep", text: "Heat." }] },
        { "@type": "HowToStep", text: "Serve." },
      ],
    })}</script>`;
    const d = draftFromHtml(html, "https://example.com/x", { fridgeDays: 3 })!.draft;
    expect(d.methodMd).toBe("1. **Sauce:** Mix.\n2. Heat.\n3. Serve.");
    expect(d.servings).toBe(4);
    expect(d.times.totalMinutes).toBe(75);
  });
});

describe("polite fetcher", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses pages that robots.txt disallows and sends an identifying User-Agent", async () => {
    const seen: { url: string; ua: string }[] = [];
    vi.stubGlobal("fetch", async (u: string, init: any) => {
      seen.push({ url: u, ua: init?.headers?.["user-agent"] });
      if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /private/", { status: 200 });
      return new Response("<html>ok</html>", { status: 200 });
    });
    const f = new PoliteFetcher({ fetchDelayMs: 0, userAgent: "TestAgent/1.0 (home app)" });
    expect(await f.html("https://example.com/public/recipe")).toContain("ok");
    await expect(f.html("https://example.com/private/recipe")).rejects.toThrow(/robots/);
    expect(seen.every((s) => s.ua === "TestAgent/1.0 (home app)")).toBe(true);
    expect(seen.filter((s) => s.url.endsWith("robots.txt"))).toHaveLength(1); // cached
  });

  it("waits between requests to the same site", async () => {
    const times: number[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      if (!u.endsWith("/robots.txt")) times.push(Date.now());
      return new Response(u.endsWith("/robots.txt") ? "" : "<html></html>", { status: 200 });
    });
    const f = new PoliteFetcher({ fetchDelayMs: 150, userAgent: "x" });
    await Promise.all([f.html("https://a.example/1"), f.html("https://a.example/2")]);
    expect(Math.abs(times[1] - times[0])).toBeGreaterThanOrEqual(140);
  });

  it("only accepts http(s) URLs", async () => {
    const f = new PoliteFetcher({ fetchDelayMs: 0, userAgent: "x" });
    await expect(f.html("file:///etc/passwd")).rejects.toBeInstanceOf(ImportError);
    await expect(f.html("not a url")).rejects.toBeInstanceOf(ImportError);
  });
});

describe("importer and the whole flow", () => {
  let ctx: Awaited<ReturnType<typeof tempStore>>;
  let hero: Buffer;
  beforeEach(async () => {
    ctx = await tempStore();
    hero = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: "#e90" } }).jpeg().toBuffer();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  const makeImporter = (extra: { aiDraft?: unknown } = {}) => {
    const fetcher = {
      html: async (u: string) => {
        const name = new URL(u).pathname.replace(/\//g, "");
        if (name === "plain-page") return `<html><body><article>${"<p>Some prose about toast and butter and the bread. </p>".repeat(20)}</article></body></html>`;
        return fixture(name);
      },
      binary: async () => hero,
    } as unknown as PoliteFetcher;
    const ollama = { chatJson: async () => extra.aiDraft } as any;
    const jobs = new JobManager();
    return { importer: new Importer(ctx.store, ollama, fetcher, jobs), jobs };
  };

  it("imports, saves with the hero photo, and refuses to double-import", async () => {
    const { importer } = makeImporter();
    const { draft, duplicateOf } = await importer.fromUrl(url("beef-stew"));
    expect(duplicateOf).toBeNull();
    expect(draft.uploadedImages).toEqual([{ file: "hero.jpg", kind: "hero" }]);
    const recipe = await importer.confirm(draft);
    expect(recipe.slug).toBe("beef-stew");
    expect(recipe.meta.images.hero).toBe("images/hero.jpg");
    expect(fs.existsSync(path.join(ctx.dir, "recipes", "beef-stew", "images", "hero.jpg"))).toBe(true);
    expect(recipe.meta.source.url).toBe(url("beef-stew"));
    expect(recipe.meta.source.importedAt).toBeTruthy();
    expect(recipe.meta.leftovers.fridgeDays).toBe(4);
    expect(recipe.ingredients.length).toBeGreaterThan(10);
    expect(fs.existsSync(path.join(ctx.store.cacheDir, "uploads", draft.uploadId!))).toBe(false);

    const again = await importer.fromUrl(url("beef-stew"));
    expect(again.duplicateOf).toBe("beef-stew");
    expect(again.draft.warnings[0]).toMatch(/already imported/);
  });

  it("bulk import skips what is already saved, reports failures, and can leave drafts for review", async () => {
    const { importer, jobs } = makeImporter();
    await importer.confirm((await importer.fromUrl(url("beef-stew"))).draft);
    const job = importer.startBulk([url("beef-stew"), url("chicken-fried-rice"), "not-a-url", url("missing-fixture")], { saveDirectly: false });
    for (let i = 0; i < 100 && jobs.get(job.id)!.status === "running"; i++) await new Promise((r) => setTimeout(r, 50));
    const res = (jobs.get(job.id)!.result as { results: any[] }).results;
    expect(res.map((r) => r.status)).toEqual(["skipped", "draft", "failed", "failed"]);
    expect(res[1].draft.title).toBe("Chicken Fried Rice");
    expect(ctx.store.getRecipe("chicken-fried-rice")).toBeUndefined();
  });

  it("falls back to the local model when a page has no recipe data", async () => {
    const ai = {
      title: "Cheese Toast",
      servings: 2,
      prepMinutes: 5,
      cookMinutes: 5,
      totalMinutes: null,
      ingredientGroups: [{ group: null, items: ["2 slices bread", "50 g cheese"] }],
      methodSteps: ["1. Toast the bread.", "Add cheese and grill."],
      notes: "Keeps 2 days in the fridge.",
      tags: ["Quick"],
      cuisine: null,
      nutritionPerServing: null,
      storage: null,
      confidence: { title: "high", servings: "medium", times: "medium", ingredients: "high", method: "high", nutrition: "low" },
    };
    const { importer } = makeImporter({ aiDraft: ai });
    const { draft } = await importer.fromUrl("https://example.com/plain-page");
    expect(draft.title).toBe("Cheese Toast");
    expect(draft.ingredientsMd).toBe("- 2 slices bread\n- 50 g cheese");
    expect(draft.methodMd).toBe("1. Toast the bread.\n2. Add cheese and grill.");
    expect(draft.times.totalMinutes).toBe(10);
    expect(draft.leftovers).toMatchObject({ fridgeDays: 2, source: "page" });
    expect(Object.values(draft.confidence).every((c) => c === "low")).toBe(true);
    expect(draft.warnings[0]).toMatch(/local AI model/);
  });

  it("end to end: import, plan, mark cooked, cook log updated", async () => {
    const { importer } = makeImporter();
    const recipe = await importer.confirm((await importer.fromUrl(url("chicken-fried-rice"))).draft);
    const planner = new Planner(ctx.store);

    await planner.setPeople("2026-W42", {}, 4);
    let view = await planner.setMeal("2026-W42", "2026-10-12", "dinner", { recipe: recipe.slug, type: "cook", portions: 8 });
    const dinner = view.days[0].meals.dinner!;
    expect(dinner.people).toEqual({ value: 4, from: "week" });
    expect(dinner.scale).toBe(2); // 8 portions from a 4-serving recipe

    view = await planner.setMeal("2026-W42", "2026-10-13", "lunch", { recipe: recipe.slug, type: "leftovers", leftoverFrom: "2026-10-12/dinner", people: 2 });
    expect(view.warnings).toEqual([]);
    expect(view.batches[0]).toMatchObject({ extra: 4, fridgeRemaining: 2 });
    expect((await planner.availableLeftovers("2026-10-14"))[0]).toMatchObject({ remaining: 2, safeUntil: "2026-10-15" });
    expect(await planner.availableLeftovers("2026-10-20")).toEqual([]);

    view = await planner.markCooked("2026-W42", "2026-10-12", "dinner", { rating: 5 });
    expect(view.days[0].meals.dinner!.meal.cooked).toBe(true);
    const after = ctx.store.getRecipe(recipe.slug)!;
    expect(after.cookLog).toHaveLength(1);
    expect(after.cookLog[0]).toMatchObject({ date: "2026-10-12", people: 4, rating: 5 });
    expect(after.lastCooked).toBe("2026-10-12");
    // marking again does not double-log
    await planner.markCooked("2026-W42", "2026-10-12", "dinner");
    expect(ctx.store.getRecipe(recipe.slug)!.cookLog).toHaveLength(1);

    const list = await planner.generateShopping("2026-W42");
    expect(list.items.length).toBeGreaterThan(5);
    const rice = list.items.find((i) => /rice/i.test(i.text));
    expect(rice?.from).toEqual(["Chicken Fried Rice"]);
    const tick = { ...list, items: list.items.map((i, n) => (n === 0 ? { ...i, checked: true } : i)) };
    await ctx.store.saveShoppingList(tick);
    const regenerated = await planner.generateShopping("2026-W42");
    expect(regenerated.items.find((i) => i.key === list.items[0].key)?.checked).toBe(true);
  });
});
