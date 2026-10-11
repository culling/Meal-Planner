import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MealPlanSchema,
  MealSchema,
  NotFoundError,
  NutrientsSchema,
  ShoppingItemSchema,
  ValidationError,
  applyBreakdown,
  estimateFood,
  isValidWeek,
  isoWeekOf,
  slugify,
  todayYmd,
  type App,
  type RecipeDraft,
} from "@mp/core";
import { readMultipart, startNutritionJob } from "./util";

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

export function registerOtherRoutes(server: FastifyInstance, app: App) {
  const { store, planner, importer } = app;

  // ---------- jobs ----------
  server.get<{ Params: { id: string } }>("/api/jobs/:id", async (req) => {
    const job = app.jobs.get(req.params.id);
    if (!job) throw new NotFoundError("Job");
    return job;
  });

  // ---------- import ----------
  server.post("/api/import/url", async (req) => {
    const { url } = z.object({ url: z.string().min(4) }).parse(req.body);
    return importer.fromUrl(url);
  });

  server.post("/api/import/urls", async (req) => {
    const { urls, saveDirectly } = z.object({ urls: z.array(z.string()).min(1).max(100), saveDirectly: z.boolean().optional() }).parse(req.body);
    return { jobId: importer.startBulk(urls, { saveDirectly: !!saveDirectly }).id };
  });

  server.post("/api/import/image", async (req) => {
    const { fields, files } = await readMultipart(req);
    const job = importer.startImageImport(
      files.filter((f) => f.field === "files" || f.field === "file").map((f) => ({ data: f.data, name: f.name })),
      { title: fields.bookTitle || null, author: fields.bookAuthor || null, page: fields.bookPage || null },
    );
    return { jobId: job.id };
  });

  server.post("/api/import/confirm", async (req, reply) => {
    const { draft, calculateNutrition } = z.object({ draft: z.object({ title: z.string() }).passthrough(), calculateNutrition: z.boolean().optional() }).parse(req.body);
    const recipe = await importer.confirm(draft as unknown as RecipeDraft);
    let jobId: string | null = null;
    if (calculateNutrition && !recipe.meta.nutrition.perServing.calories && recipe.ingredients.length && store.getSettings().nutrition.provider !== "none") {
      jobId = startNutritionJob(app, recipe.slug).id;
    }
    void reply.status(201);
    return { slug: recipe.slug, jobId };
  });

  server.get<{ Params: { id: string; file: string } }>("/api/uploads/:id/:file", async (req, reply) => {
    const full = importer.uploadPath(req.params.id, req.params.file);
    if (!fs.existsSync(full)) throw new NotFoundError("Upload");
    void reply.header("content-type", MIME[path.extname(full).toLowerCase()] ?? "image/jpeg");
    return reply.send(fs.createReadStream(full));
  });

  // ---------- meal plans ----------
  const week = (w: string) => {
    if (!isValidWeek(w)) throw new ValidationError(`Invalid week "${w}"`);
    return w;
  };

  server.get("/api/meal-plans", async () => ({ weeks: await store.listPlanWeeks(), current: isoWeekOf(todayYmd()) }));

  server.get<{ Params: { week: string } }>("/api/meal-plans/:week", async (req) => planner.view(week(req.params.week)));

  /** Replace a whole plan (raw frontmatter structure). The UI mostly uses the finer-grained routes below. */
  server.put<{ Params: { week: string } }>("/api/meal-plans/:week", async (req) => {
    const { plan, expectedMtimeMs } = z.object({ plan: MealPlanSchema, expectedMtimeMs: z.number().nullable().optional() }).parse(req.body);
    await store.savePlan({ ...plan, week: week(req.params.week) }, expectedMtimeMs);
    return planner.view(req.params.week);
  });

  server.patch<{ Params: { week: string } }>("/api/meal-plans/:week", async (req) => {
    const { defaultPeople } = z.object({ defaultPeople: z.number().nullable() }).parse(req.body);
    return planner.setPeople(week(req.params.week), {}, defaultPeople);
  });

  server.patch<{ Params: { week: string; date: string } }>("/api/meal-plans/:week/days/:date", async (req) => {
    const { people } = z.object({ people: z.number().nullable() }).parse(req.body);
    return planner.setPeople(week(req.params.week), { date: req.params.date }, people);
  });

  server.put<{ Params: { week: string; date: string; slot: string } }>("/api/meal-plans/:week/days/:date/meals/:slot", async (req) => {
    const { meal, expectedMtimeMs } = z.object({ meal: MealSchema.partial().nullable(), expectedMtimeMs: z.number().nullable().optional() }).parse(req.body);
    return planner.setMeal(week(req.params.week), req.params.date, req.params.slot, meal, expectedMtimeMs);
  });

  server.delete<{ Params: { week: string; date: string; slot: string } }>("/api/meal-plans/:week/days/:date/meals/:slot", async (req) =>
    planner.setMeal(week(req.params.week), req.params.date, req.params.slot, null),
  );

  server.patch<{ Params: { week: string; date: string; slot: string } }>("/api/meal-plans/:week/days/:date/meals/:slot/people", async (req) => {
    const { people } = z.object({ people: z.number().nullable() }).parse(req.body);
    return planner.setPeople(week(req.params.week), { date: req.params.date, slot: req.params.slot }, people);
  });

  server.post<{ Params: { week: string; date: string; slot: string } }>("/api/meal-plans/:week/days/:date/meals/:slot/cooked", async (req) => {
    const b = z.object({ cooked: z.boolean().optional(), rating: z.number().min(1).max(5).nullable().optional() }).parse(req.body ?? {});
    return planner.markCooked(week(req.params.week), req.params.date, req.params.slot, b);
  });

  server.post<{ Params: { week: string } }>("/api/meal-plans/:week/freeze", async (req) => {
    const { key, date } = z.object({ key: z.string(), date: z.string().optional() }).parse(req.body);
    return planner.freezeRemaining(week(req.params.week), key, date);
  });

  server.post<{ Params: { week: string } }>("/api/meal-plans/:week/copy-from", async (req) => {
    const { from, overwrite } = z.object({ from: z.string(), overwrite: z.boolean().optional() }).parse(req.body);
    return planner.copyWeek(week(from), week(req.params.week), !!overwrite);
  });

  server.post<{ Params: { week: string } }>("/api/meal-plans/:week/suggest", async (req) => {
    const { save, seed } = z.object({ save: z.boolean().optional(), seed: z.number().optional() }).parse(req.body ?? {});
    const res = await planner.suggest(week(req.params.week), { save, seed });
    return { notes: res.notes, saved: res.saved, view: res.saved ? await planner.view(req.params.week) : null, plan: res.plan };
  });

  server.get<{ Querystring: { date?: string; slot?: string } }>("/api/leftovers", async (req) => ({
    leftovers: await planner.availableLeftovers(req.query.date ?? todayYmd(), req.query.slot || undefined),
  }));

  // ---------- shopping list ----------
  server.get<{ Params: { week: string } }>("/api/meal-plans/:week/shopping-list", async (req) => store.getShoppingList(week(req.params.week)));
  server.post<{ Params: { week: string } }>("/api/meal-plans/:week/shopping-list", async (req) => planner.generateShopping(week(req.params.week)));
  server.put<{ Params: { week: string } }>("/api/meal-plans/:week/shopping-list", async (req) => {
    const { items } = z.object({ items: z.array(ShoppingItemSchema) }).parse(req.body);
    const current = await store.getShoppingList(week(req.params.week));
    return store.saveShoppingList({ week: req.params.week, generatedAt: current.generatedAt, items });
  });

  // ---------- settings ----------
  server.get("/api/settings", async () => store.getSettings());
  server.put("/api/settings", async (req) => store.updateSettings(req.body ?? {}));

  // ---------- nutrition database ----------
  server.get("/api/foods", async () => {
    const usage = new Map<string, number>();
    for (const r of store.listRecipes()) for (const b of r.meta.nutrition.breakdown) if (b.food) usage.set(b.food, (usage.get(b.food) ?? 0) + 1);
    return { foods: store.listFoods().map((f) => ({ ...f, usedIn: usage.get(f.id) ?? 0 })) };
  });

  // no schema defaults here: a field that isn't sent must stay untouched, and a hand edit counts as "manual"
  const FoodPatch = z.object({
    name: z.string().min(1).optional(),
    aliases: z.array(z.string()).optional(),
    per100g: NutrientsSchema.optional(),
    gramsPerCup: z.number().nullable().optional(),
    gramsPerPiece: z.number().nullable().optional(),
    source: z.enum(["ai", "manual"]).optional(),
  });

  server.post("/api/foods", async (req) => {
    const f = FoodPatch.extend({ name: z.string().min(1) }).parse(req.body);
    const id = slugify(f.name);
    if (store.listFoods().some((x) => x.id === id)) throw new ValidationError(`"${f.name}" is already in the database`);
    await store.upsertFoods([{ ...f, id, source: f.source ?? "manual" }]);
    return { foods: store.listFoods() };
  });

  /** Saving a food by hand marks it as checked (source "manual"), which clears the "?" icon everywhere it is used. */
  server.put<{ Params: { id: string } }>("/api/foods/:id", async (req) => {
    const f = FoodPatch.parse(req.body);
    if (!store.listFoods().some((x) => x.id === req.params.id)) throw new NotFoundError("Food");
    await store.upsertFoods([{ ...f, id: req.params.id, name: f.name ?? req.params.id, source: f.source ?? "manual" }]);
    // refresh every recipe whose breakdown uses this food
    const touched: string[] = [];
    for (const r of store.listRecipes()) {
      if (r.meta.nutrition.breakdown.some((b) => b.food === req.params.id)) {
        await applyBreakdown(store, r.slug, r.meta.nutrition.breakdown);
        touched.push(r.slug);
      }
    }
    return { foods: store.listFoods(), updatedRecipes: touched };
  });

  server.delete<{ Params: { id: string } }>("/api/foods/:id", async (req) => {
    await store.deleteFood(req.params.id);
    return { foods: store.listFoods() };
  });

  /** Ask the local model for a food's per-100 g values (nothing is saved; the form fills in and a person confirms). */
  server.post("/api/foods/estimate", async (req) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
    const per100g = await estimateFood(app.ollama, store.getSettings().nutrition.model, name);
    return { per100g: NutrientsSchema.parse(per100g) };
  });

  // ---------- system ----------
  server.get("/api/status", async () => {
    const [ollama, history] = await Promise.all([app.ollama.status(), store.git.log(15)]);
    return {
      dataDir: store.dataDir,
      recipes: store.listRecipes().length,
      problems: store.getProblems(),
      ollama: { url: app.cfg.ollamaUrl, ...ollama },
      lightOnOcr: app.cfg.lightOnOcrDir ? fs.existsSync(path.join(app.cfg.lightOnOcrDir, "ocr.py")) : false,
      git: { enabled: store.git.ready, history },
      today: todayYmd(),
    };
  });

  /** Server-sent events: tells open pages when a file changes (in the app or in a text editor). */
  server.get("/api/events", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 3000\n\n");
    const send = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    store.on("change", send);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      store.off("change", send);
    });
  });
}
