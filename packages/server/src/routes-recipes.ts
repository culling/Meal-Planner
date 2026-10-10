import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BreakdownRowSchema,
  NutrientsSchema,
  NotFoundError,
  ValidationError,
  applyBreakdown,
  filtersFromQuery,
  nowIso,
  type App,
} from "@mp/core";
import { fullRecipe, readMultipart, startNutritionJob, summarise } from "./util";

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

const RecipeBodySchema = z.object({}).passthrough();

export function registerRecipeRoutes(server: FastifyInstance, app: App) {
  const { store } = app;

  const load = (slug: string) => {
    const r = store.requireRecipe(slug);
    return fullRecipe(r, store.bodyParts(slug));
  };

  server.get("/api/recipes", async (req) => {
    const result = app.searchRecipes(filtersFromQuery(req.query as Record<string, unknown>));
    return { recipes: result.recipes.map(summarise), total: result.total, excludedForMissing: result.excludedForMissing, problems: store.getProblems() };
  });

  /** Everything the filter drawer needs: all tags, cuisines etc. with counts. */
  server.get("/api/facets", async () => {
    const count = (list: string[][]) => {
      const m = new Map<string, number>();
      for (const arr of list) for (const v of arr) m.set(v, (m.get(v) ?? 0) + 1);
      return [...m].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    };
    const all = store.listRecipes();
    return {
      total: all.length,
      tags: count(all.map((r) => r.meta.tags)),
      cuisines: count(all.map((r) => (r.meta.cuisine ? [r.meta.cuisine] : []))),
      courses: count(all.map((r) => r.meta.course)),
      diets: count(all.map((r) => r.meta.diet)),
    };
  });

  server.get<{ Params: { slug: string } }>("/api/recipes/:slug", async (req) => load(req.params.slug));

  server.post("/api/recipes", async (req, reply) => {
    const body = RecipeBodySchema.parse(req.body) as any;
    const recipe = await store.createRecipe(body);
    void reply.status(201);
    return load(recipe.slug);
  });

  server.patch<{ Params: { slug: string } }>("/api/recipes/:slug", async (req) => {
    const { expectedMtimeMs, ...patch } = RecipeBodySchema.parse(req.body) as any;
    const r = await store.updateRecipe(req.params.slug, patch, { expectedMtimeMs });
    return load(r.slug);
  });

  server.delete<{ Params: { slug: string } }>("/api/recipes/:slug", async (req) => {
    await store.deleteRecipe(req.params.slug);
    return { ok: true };
  });

  server.post<{ Params: { slug: string } }>("/api/recipes/:slug/rename", async (req) => {
    const { slug } = z.object({ slug: z.string().min(1) }).parse(req.body);
    const r = await store.renameSlug(req.params.slug, slug);
    return load(r.slug);
  });

  for (const flag of ["favorite", "hide"] as const) {
    server.post<{ Params: { slug: string } }>(`/api/recipes/:slug/${flag}`, async (req) => {
      const { value } = z.object({ value: z.boolean().optional() }).parse(req.body ?? {});
      const r = await store.setFlag(req.params.slug, flag === "hide" ? "hidden" : "favorite", value);
      return load(r.slug);
    });
  }

  server.post<{ Params: { slug: string } }>("/api/recipes/:slug/notes", async (req) => {
    const { text, date } = z.object({ text: z.string().min(1), date: z.string().optional() }).parse(req.body);
    return load((await store.addNoteToRecipe(req.params.slug, text, date)).slug);
  });

  server.put<{ Params: { slug: string } }>("/api/recipes/:slug/notes", async (req) => {
    const { notes } = z.object({ notes: z.array(z.object({ date: z.string(), text: z.string() })) }).parse(req.body);
    return load((await store.replaceNotes(req.params.slug, notes)).slug);
  });

  server.post<{ Params: { slug: string } }>("/api/recipes/:slug/cooked", async (req) => {
    const b = z.object({ date: z.string().optional(), people: z.number().nullable().optional(), rating: z.number().min(1).max(5).nullable().optional() }).parse(req.body ?? {});
    return load((await store.logCooked(req.params.slug, b)).slug);
  });

  server.get<{ Params: { slug: string } }>("/api/recipes/:slug/raw", async (req) => store.getRecipeRaw(req.params.slug));

  server.put<{ Params: { slug: string } }>("/api/recipes/:slug/raw", async (req) => {
    const { text, expectedMtimeMs } = z.object({ text: z.string().min(1), expectedMtimeMs: z.number().nullable().optional() }).parse(req.body);
    return load((await store.saveRecipeRaw(req.params.slug, text, expectedMtimeMs)).slug);
  });

  server.get<{ Params: { slug: string } }>("/api/recipes/:slug/history", async (req) => {
    store.requireRecipe(req.params.slug);
    return { commits: await store.git.log(30, `recipes/${req.params.slug}/recipe.md`) };
  });

  server.get<{ Params: { slug: string; hash: string } }>("/api/recipes/:slug/history/:hash", async (req) => {
    const text = await store.git.show(req.params.hash, `recipes/${req.params.slug}/recipe.md`);
    if (text == null) throw new NotFoundError("That version");
    return { text };
  });

  // ---------- images ----------

  server.post<{ Params: { slug: string } }>("/api/recipes/:slug/images", async (req) => {
    store.requireRecipe(req.params.slug);
    const { fields, files } = await readMultipart(req);
    if (!files.length) throw new ValidationError("No image was uploaded");
    const kind = z.enum(["hero", "step", "cooked", "source-page", "other"]).parse(fields.kind || "other");
    let last: Awaited<ReturnType<typeof store.addImage>> | null = null;
    for (const f of files) {
      last = await store.addImage(req.params.slug, {
        data: f.data,
        originalName: f.name,
        kind,
        step: fields.step ? Number(fields.step) : null,
        caption: fields.caption || null,
        date: fields.date || null,
      });
    }
    return { ...load(req.params.slug), file: last!.file };
  });

  server.patch<{ Params: { slug: string } }>("/api/recipes/:slug/images", async (req) => {
    const b = z.object({ file: z.string(), caption: z.string().nullable().optional(), step: z.number().nullable().optional(), kind: z.enum(["step", "cooked", "source-page", "other"]).optional() }).parse(req.body);
    const { file, ...patch } = b;
    return load((await store.updateGalleryItem(req.params.slug, file, patch)).slug);
  });

  server.delete<{ Params: { slug: string }; Querystring: { file: string } }>("/api/recipes/:slug/images", async (req) => {
    return load((await store.removeImage(req.params.slug, String(req.query.file))).slug);
  });

  server.post<{ Params: { slug: string } }>("/api/recipes/:slug/hero", async (req) => {
    const { file } = z.object({ file: z.string().nullable() }).parse(req.body);
    return load((await store.setHero(req.params.slug, file)).slug);
  });

  server.get<{ Params: { slug: string; "*": string }; Querystring: { w?: string } }>("/images/:slug/*", async (req, reply) => {
    const file = req.params["*"];
    let full = store.imagePath(req.params.slug, file);
    if (!fs.existsSync(full)) throw new NotFoundError("Image");
    const w = Number(req.query.w);
    if (w > 0) full = await store.thumbnail(req.params.slug, file, w);
    const st = fs.statSync(full);
    void reply.header("content-type", MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream");
    void reply.header("cache-control", "private, max-age=3600");
    void reply.header("etag", `"${st.mtimeMs}-${st.size}"`);
    return reply.send(fs.createReadStream(full));
  });

  // ---------- nutrition ----------

  /** Ask the local model to work out nutrition from the ingredients (runs as a background job). */
  server.post<{ Params: { slug: string } }>("/api/recipes/:slug/nutrition/recalculate", async (req) => {
    const { keepManual } = z.object({ keepManual: z.boolean().optional() }).parse(req.body ?? {});
    return { jobId: startNutritionJob(app, req.params.slug, keepManual).id };
  });

  /** Save edited breakdown rows (grams, foods, hand-typed numbers) and re-total. */
  server.put<{ Params: { slug: string } }>("/api/recipes/:slug/nutrition/breakdown", async (req) => {
    const { rows } = z.object({ rows: z.array(BreakdownRowSchema) }).parse(req.body);
    return load((await applyBreakdown(store, req.params.slug, rows)).slug);
  });

  /** Type the per-serving numbers by hand. This replaces any calculated values and removes the "?" markers. */
  server.put<{ Params: { slug: string } }>("/api/recipes/:slug/nutrition/manual", async (req) => {
    const { perServing } = z.object({ perServing: NutrientsSchema }).parse(req.body);
    const r = await store.mutateRecipe(
      req.params.slug,
      (meta) => {
        meta.nutrition = { ...meta.nutrition, perServing, source: "manual", confidence: "high", calculatedAt: nowIso(), breakdown: meta.nutrition.breakdown.map((b) => ({ ...b, override: true, source: "manual" as const })) };
        return { meta };
      },
      { reason: `Nutrition for ${req.params.slug} (manual)` },
    );
    return load(r.slug);
  });
}
