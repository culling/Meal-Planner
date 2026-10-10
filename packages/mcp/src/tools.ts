import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import sharp from "sharp";
import {
  cookScale,
  filtersFromQuery,
  formatIngredient,
  isoWeekOf,
  resolvePeople,
  todayYmd,
  type App,
  type Meal,
  type Recipe,
} from "@mp/core";

export interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  /** returns concise JSON plus a short summary line */
  handler: (args: any) => Promise<{ summary: string; data?: unknown; image?: { data: string; mimeType: string } }>;
}

const filterShape = {
  q: z.string().optional().describe("Free-text search over title, ingredients, tags and notes"),
  caloriesMin: z.number().optional(),
  caloriesMax: z.number().optional().describe("Max calories per serving"),
  fridgeDaysMin: z.number().optional().describe("Leftovers keep at least this many days in the fridge"),
  freezable: z.enum(["yes", "no"]).optional(),
  maxTotalMinutes: z.number().optional(),
  tags: z.array(z.string()).optional(),
  tagsMode: z.enum(["any", "all"]).optional(),
  excludeTags: z.array(z.string()).optional(),
  cuisine: z.array(z.string()).optional(),
  course: z.array(z.string()).optional(),
  role: z.array(z.enum(["main", "side"])).optional().describe("main and/or side dishes"),
  diet: z.array(z.string()).optional(),
  favoritesOnly: z.boolean().optional(),
  hidden: z.enum(["exclude", "include", "only"]).optional(),
  nutritionSource: z.array(z.enum(["page", "ocr", "calculated", "estimated", "manual"])).optional(),
  ratingMin: z.number().optional(),
  notCookedInDays: z.number().optional(),
  sort: z.enum(["title", "calories", "time", "rating", "lastCooked", "added"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().optional().describe("Max results (default 25)"),
};

const week = z.string().optional().describe("ISO week like 2026-W41. Defaults to the current week.");
const mealPatch = {
  recipe: z.string().nullable().optional().describe("Recipe slug"),
  type: z.enum(["cook", "leftovers", "eat-out", "skip"]).optional(),
  people: z.number().nullable().optional(),
  portions: z.number().nullable().optional().describe("Cook meals: total portions to cook (extra become leftovers)"),
  leftoverFrom: z.string().nullable().optional().describe('Leftover meals: "YYYY-MM-DD/slot" of the cook meal'),
  leftoverStore: z.enum(["fridge", "freezer"]).optional(),
  note: z.string().nullable().optional(),
};

const brief = (r: Recipe) => ({
  slug: r.slug,
  title: r.meta.title,
  servings: r.meta.servings,
  totalMinutes: r.meta.times.totalMinutes,
  caloriesPerServing: r.meta.nutrition.perServing.calories,
  nutritionSource: r.meta.nutrition.source,
  fridgeDays: r.meta.leftovers.fridgeDays,
  freezable: r.meta.leftovers.freezable,
  favorite: r.meta.favorite,
  hidden: r.meta.hidden,
  rating: r.meta.rating,
  lastCooked: r.lastCooked,
  tags: r.meta.tags,
  role: r.meta.role,
});

export function buildTools(app: App): ToolDef[] {
  const { store, planner, importer } = app;
  const wk = (w?: string) => w ?? isoWeekOf(todayYmd());

  const full = (r: Recipe, people?: number) => {
    const scale = people && r.meta.servings ? people / r.meta.servings : 1;
    return {
      ...brief(r),
      source: r.meta.source,
      times: r.meta.times,
      nutrition: r.meta.nutrition.perServing,
      leftovers: r.meta.leftovers,
      ingredients: r.ingredients.map((i) => formatIngredient(i, scale)),
      scaledFor: people ?? null,
      method: r.method.map((s) => `${s.n}. ${s.text}`),
      notes: r.notes,
      sourceNotes: r.sourceNotes,
      cookLog: r.cookLog.slice(-10),
    };
  };

  return [
    {
      name: "search_recipes",
      description: "Search and filter the recipe collection (calories, time, leftovers, tags, favourites, rating, last cooked…).",
      shape: filterShape,
      handler: async ({ limit, ...rest }) => {
        const res = app.searchRecipes(filtersFromQuery(rest));
        const shown = res.recipes.slice(0, limit ?? 25).map(brief);
        const missing = Object.entries(res.excludedForMissing).map(([k, n]) => `${n} without ${k}`).join(", ");
        return { summary: `${res.total} recipes match${missing ? ` (left out: ${missing})` : ""}; showing ${shown.length}.`, data: { total: res.total, excludedForMissing: res.excludedForMissing, recipes: shown } };
      },
    },
    {
      name: "get_recipe",
      description: "Get one recipe by slug. Pass people to scale the ingredient amounts; includeImage returns the hero photo.",
      shape: { slug: z.string(), people: z.number().optional(), includeImage: z.boolean().optional() },
      handler: async ({ slug, people, includeImage }) => {
        const r = store.requireRecipe(slug);
        let image;
        if (includeImage && r.meta.images.hero) {
          const buf = await sharp(store.imagePath(slug, r.meta.images.hero)).rotate().resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
          image = { data: buf.toString("base64"), mimeType: "image/jpeg" };
        }
        return { summary: `${r.meta.title}${people ? ` (scaled for ${people})` : ""}`, data: full(r, people), image };
      },
    },
    {
      name: "create_recipe",
      description: "Create a recipe. Ingredients and method are Markdown lists (\"- 600 g chicken\", \"1. Cook\").",
      shape: {
        title: z.string(),
        servings: z.number().optional(),
        ingredientsMd: z.string(),
        methodMd: z.string(),
        sourceNotes: z.string().optional(),
        tags: z.array(z.string()).optional(),
        cuisine: z.string().optional(),
        role: z.array(z.enum(["main", "side"])).optional().describe("main, side, or both (default main)"),
        times: z.object({ prepMinutes: z.number().nullable().optional(), cookMinutes: z.number().nullable().optional(), totalMinutes: z.number().nullable().optional() }).optional(),
        sourceUrl: z.string().optional(),
      },
      handler: async ({ sourceUrl, ...input }) => {
        const r = await store.createRecipe({ ...input, ...(sourceUrl ? { source: { type: "web", url: sourceUrl, site: null, author: null, book: null, importedAt: null } } : {}) });
        return { summary: `Created ${r.slug}`, data: brief(r) };
      },
    },
    {
      name: "update_recipe",
      description: "Partially update a recipe: any frontmatter field (title, servings, tags, times, leftovers…) or ingredientsMd / methodMd / sourceNotes.",
      shape: { slug: z.string(), patch: z.record(z.string(), z.unknown()).describe("Fields to change") },
      handler: async ({ slug, patch }) => {
        const r = await store.updateRecipe(slug, patch);
        return { summary: `Updated ${r.slug}`, data: brief(r) };
      },
    },
    {
      name: "import_recipe_from_url",
      description: "Fetch a recipe from a web page (polite, robots.txt respected) and return a draft. save:true saves it directly.",
      shape: { url: z.string(), save: z.boolean().optional() },
      handler: async ({ url, save }) => {
        const { draft, duplicateOf } = await importer.fromUrl(url);
        if (save) {
          if (duplicateOf) return { summary: `Already imported as ${duplicateOf}`, data: { duplicateOf } };
          const r = await importer.confirm(draft);
          return { summary: `Saved ${r.slug}`, data: { slug: r.slug, warnings: draft.warnings } };
        }
        const { uploadId, uploadedImages, ...rest } = draft;
        void uploadId;
        void uploadedImages;
        return { summary: `Draft: ${draft.title} (not saved)`, data: { duplicateOf, ...rest } };
      },
    },
    {
      name: "import_recipe_from_image",
      description: "Read a recipe from photos on disk (cookbook pages) with the local AI model. Takes file paths on this computer.",
      shape: { paths: z.array(z.string()).min(1), bookTitle: z.string().optional(), bookAuthor: z.string().optional(), bookPage: z.string().optional(), save: z.boolean().optional() },
      handler: async ({ paths, bookTitle, bookAuthor, bookPage, save }) => {
        const files = await Promise.all((paths as string[]).map(async (p) => ({ data: await fs.readFile(p), name: path.basename(p) })));
        const job = importer.startImageImport(files, { title: bookTitle, author: bookAuthor, page: bookPage });
        for (;;) {
          const j = app.jobs.get(job.id)!;
          if (j.status === "error") throw new Error(j.error ?? "Import failed");
          if (j.status === "done") {
            const draft = (j.result as any).draft;
            if (save) {
              const r = await importer.confirm(draft);
              return { summary: `Saved ${r.slug}`, data: { slug: r.slug, warnings: draft.warnings } };
            }
            return { summary: `Draft: ${draft.title} (not saved; photos kept in cache)`, data: draft };
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      },
    },
    {
      name: "save_recipe_photo",
      description: "Save photos of a recipe (file paths on this computer) under a name, to be read later or typed in. No AI is used until read_recipe_photo.",
      shape: { paths: z.array(z.string()).min(1), name: z.string().optional(), bookTitle: z.string().optional(), bookAuthor: z.string().optional(), bookPage: z.string().optional() },
      handler: async ({ paths, name, bookTitle, bookAuthor, bookPage }) => {
        const files = await Promise.all((paths as string[]).map(async (p) => ({ data: await fs.readFile(p), name: path.basename(p) })));
        const book = bookTitle || bookAuthor || bookPage ? { title: bookTitle ?? null, author: bookAuthor ?? null, page: bookPage ?? null } : null;
        const photo = await store.photos.create({ name, files, book });
        return { summary: `Saved photo "${photo.name}" (${photo.id}) with ${photo.images.length} page(s)`, data: photo };
      },
    },
    {
      name: "list_recipe_photos",
      description: "List saved recipe photos and whether each is waiting, has a draft, or became a recipe.",
      shape: {},
      handler: async () => {
        const list = await store.photos.list();
        const data = await Promise.all(list.map(async (p) => ({ id: p.id, name: p.name, status: p.status, recipe: p.recipe, pages: p.images.length, draftReady: !!(await importer.getPhotoDraft(p.id)) })));
        return { summary: `${data.filter((d) => d.status === "waiting").length} waiting, ${data.length} total`, data };
      },
    },
    {
      name: "read_recipe_photo",
      description: "Read a saved photo with the local AI model (optionally a specific vision model). Returns the draft; save:true makes it a recipe.",
      shape: { id: z.string(), model: z.string().optional(), save: z.boolean().optional() },
      handler: async ({ id, model, save }) => {
        const job = importer.startPhotoRead(id, { model });
        for (;;) {
          const j = app.jobs.get(job.id)!;
          if (j.status === "error") throw new Error(j.error ?? "Reading failed");
          if (j.status === "done") {
            const draft = (j.result as any).draft;
            if (save) {
              const r = await importer.confirm(draft);
              return { summary: `Saved ${r.slug}`, data: { slug: r.slug, warnings: draft.warnings } };
            }
            return { summary: `Draft: ${draft.title} (not saved; open it in the app to check, or call again with save:true)`, data: draft };
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      },
    },
    {
      name: "copy_meal",
      description: "Copy a planned meal to other slots (also into the next/previous week). mode: leftovers (eat it as leftovers and cook enough), repeat (cook again), move, or auto (leftovers while the food keeps, otherwise repeat).",
      shape: { week, from: z.object({ date: z.string(), slot: z.string() }), to: z.array(z.object({ date: z.string(), slot: z.string() })).min(1), mode: z.enum(["auto", "repeat", "leftovers", "move"]).optional() },
      handler: async ({ week: w, from, to, mode }) => {
        const r = await planner.copyMeals(wk(w ?? isoWeekOf(from.date)), { from, to, mode });
        return { summary: r.message, data: { mode: r.result.mode, weeks: r.weeks } };
      },
    },
    {
      name: "add_recipe_note",
      description: "Add a dated note to a recipe's My notes.",
      shape: { slug: z.string(), text: z.string(), date: z.string().optional() },
      handler: async ({ slug, text, date }) => {
        await store.addNoteToRecipe(slug, text, date);
        return { summary: "Note added" };
      },
    },
    {
      name: "set_favorite",
      description: "Mark or unmark a recipe as a favourite.",
      shape: { slug: z.string(), value: z.boolean().optional() },
      handler: async ({ slug, value }) => ({ summary: `favorite = ${(await store.setFlag(slug, "favorite", value)).meta.favorite}` }),
    },
    {
      name: "set_hidden",
      description: "Hide or unhide a recipe from lists.",
      shape: { slug: z.string(), value: z.boolean().optional() },
      handler: async ({ slug, value }) => ({ summary: `hidden = ${(await store.setFlag(slug, "hidden", value)).meta.hidden}` }),
    },
    {
      name: "recalculate_nutrition",
      description: "Work out nutrition from the ingredients with the local AI model (can take a minute or two). Rows a person edited are kept.",
      shape: { slug: z.string() },
      handler: async ({ slug }) => {
        const { calculateNutrition } = await import("@mp/core");
        const res = await calculateNutrition(store, app.ollama, store.requireRecipe(slug), {});
        await store.mutateRecipe(slug, (meta) => ((meta.nutrition = res.nutrition), { meta }), { reason: `Nutrition for ${slug}` });
        return { summary: `${Math.round(res.nutrition.perServing.calories ?? 0)} kcal per serving (estimate, ${res.nutrition.confidence} confidence)`, data: { perServing: res.nutrition.perServing, warnings: res.warnings, newFoods: res.newFoods } };
      },
    },
    {
      name: "get_meal_plan",
      description: "Get a week's meal plan with people counts, warnings about leftovers, and daily calories.",
      shape: { week },
      handler: async ({ week: w }) => {
        const v = await planner.view(wk(w));
        const days = v.days.map((d) => ({
          date: d.date,
          people: d.people.value,
          caloriesPerPerson: d.totals.caloriesPerPerson,
          meals: Object.fromEntries(Object.entries(d.meals).filter(([, m]) => m).map(([slot, m]) => [slot, { recipe: m!.meal.recipe, title: m!.title, type: m!.meal.type, people: m!.people.value, peopleFrom: m!.people.from, portions: m!.meal.portions, cooked: m!.meal.cooked, leftoverFrom: m!.meal.leftoverFrom }])),
        }));
        return { summary: `Week ${v.week}: ${v.warnings.length} warning(s).`, data: { week: v.week, defaultPeople: v.defaultPeople ?? v.settingsPeople, days, warnings: v.warnings } };
      },
    },
    {
      name: "set_meal",
      description: "Put a meal in a slot (or clear it with clear:true). Existing fields are kept unless given. Use slot \"prep\" (or \"prep-2\"…) to cook ahead: food made that day that nobody eats then (give portions); later meals eat it via copy_meal with mode leftovers.",
      shape: { week, date: z.string(), slot: z.string(), clear: z.boolean().optional(), ...mealPatch },
      handler: async ({ week: w, date, slot, clear, ...patch }) => {
        const v = await planner.setMeal(wk(w ?? isoWeekOf(date)), date, slot, clear ? null : (patch as Partial<Meal>));
        return { summary: `${date} ${slot}: ${clear ? "cleared" : "set"}`, data: { warnings: v.warnings.filter((x) => x.date === date) } };
      },
    },
    {
      name: "set_people",
      description: "Set the number of people for a week (default), a day, or a single meal. value null clears the override so it inherits again.",
      shape: { week, date: z.string().optional(), slot: z.string().optional(), value: z.number().nullable() },
      handler: async ({ week: w, date, slot, value }) => {
        await planner.setPeople(wk(w), { date, slot }, value);
        return { summary: `people ${slot ? `${date}/${slot}` : date ?? "week default"} = ${value ?? "inherited"}` };
      },
    },
    {
      name: "mark_meal_cooked",
      description: "Mark a planned meal cooked: adds a line to the recipe's cook log.",
      shape: { week, date: z.string(), slot: z.string(), rating: z.number().min(1).max(5).optional() },
      handler: async ({ week: w, date, slot, rating }) => {
        await planner.markCooked(wk(w ?? isoWeekOf(date)), date, slot, { rating: rating ?? null });
        return { summary: "Marked cooked and logged" };
      },
    },
    {
      name: "list_available_leftovers",
      description: "Leftovers that can still be eaten on a date (stock left and within the fridge/freezer safe date).",
      shape: { date: z.string().optional() },
      handler: async ({ date }) => {
        const l = await planner.availableLeftovers(date ?? todayYmd());
        return { summary: `${l.length} leftover option(s)`, data: l };
      },
    },
    {
      name: "suggest_meal_plan",
      description: "Suggest dinners for empty slots (favourites, not recently cooked, uses leftovers). Returns a proposal; save:true applies it.",
      shape: { week, save: z.boolean().optional(), seed: z.number().optional() },
      handler: async ({ week: w, save, seed }) => {
        const r = await planner.suggest(wk(w), { save, seed });
        return { summary: `${r.notes.length} suggestion(s)${r.saved ? " (saved)" : " (not saved)"}`, data: r.notes };
      },
    },
    {
      name: "generate_shopping_list",
      description: "Build (or refresh) the week's shopping list from cook meals, scaled for the people count.",
      shape: { week },
      handler: async ({ week: w }) => {
        const l = await planner.generateShopping(wk(w));
        return { summary: `${l.items.length} items`, data: l.items.map((i) => ({ item: i.text, done: i.checked })) };
      },
    },
    { name: "get_settings", description: "Read the app settings.", shape: {}, handler: async () => ({ summary: "Settings", data: store.getSettings() }) },
    {
      name: "update_settings",
      description: "Change settings (defaultPeople, mealSlots, dailyCalorieTargetPerPerson, …).",
      shape: { patch: z.record(z.string(), z.unknown()) },
      handler: async ({ patch }) => ({ summary: "Settings updated", data: await store.updateSettings(patch) }),
    },
  ];
}

export { cookScale, resolvePeople };
