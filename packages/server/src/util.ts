import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  calculateNutrition,
  ConflictError,
  ImportError,
  NotFoundError,
  OllamaError,
  ValidationError,
  totalMinutes,
  type App,
  type Recipe,
} from "@mp/core";

/** Turn thrown errors into friendly JSON responses. */
export function installErrorHandler(server: FastifyInstance) {
  server.setErrorHandler((err: any, _req, reply) => {
    let status = 500;
    let message = err?.message ?? "Something went wrong";
    if (err instanceof ValidationError) status = 400;
    else if (err instanceof ZodError) {
      status = 400;
      message = err.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
    } else if (err instanceof NotFoundError) status = 404;
    else if (err instanceof ConflictError) {
      status = 409;
      message = `${message}. Reload to see the latest version, then re-apply your change.`;
    } else if (err instanceof ImportError) status = 422;
    else if (err instanceof OllamaError) status = 502;
    else if (err?.statusCode && err.statusCode < 500) status = err.statusCode;
    if (status >= 500) server.log.error(err);
    void reply.status(status).send({ error: message, code: err?.name ?? "Error" });
  });
}

export interface UploadedFile {
  field: string;
  name: string;
  data: Buffer;
}

/** Read a multipart request into plain fields and file buffers. */
export async function readMultipart(req: FastifyRequest): Promise<{ fields: Record<string, string>; files: UploadedFile[] }> {
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];
  for await (const part of (req as any).parts()) {
    if (part.type === "file") {
      const data: Buffer = await part.toBuffer();
      if (data.length) files.push({ field: part.fieldname, name: part.filename ?? "upload", data });
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }
  return { fields, files };
}

/** What the recipe list needs for each card. */
export function summarise(r: Recipe) {
  const m = r.meta;
  return {
    slug: r.slug,
    title: m.title,
    hero: m.images.hero,
    servings: m.servings,
    calories: m.nutrition.perServing.calories,
    nutritionSource: m.nutrition.source,
    nutritionAi: m.nutrition.source === "calculated" && m.nutrition.breakdown.some((b) => !b.excluded && b.source === "ai"),
    fridgeDays: m.leftovers.fridgeDays,
    freezable: m.leftovers.freezable,
    totalMinutes: totalMinutes(r),
    favorite: m.favorite,
    hidden: m.hidden,
    rating: m.rating,
    lastCooked: r.lastCooked,
    tags: m.tags,
    cuisine: m.cuisine,
    course: m.course,
    role: m.role,
    diet: m.diet,
    sourceType: m.source.type,
    updatedAt: m.updatedAt,
  };
}

export function fullRecipe(r: Recipe, parts: { ingredientsMd: string; methodMd: string; sourceNotes: string }) {
  return {
    slug: r.slug,
    meta: r.meta,
    ingredients: r.ingredients,
    method: r.method,
    notes: r.notes,
    sourceNotes: r.sourceNotes,
    cookLog: r.cookLog,
    lastCooked: r.lastCooked,
    mtimeMs: r.mtimeMs,
    totalMinutes: totalMinutes(r),
    parts,
  };
}

/** Start a background job that asks the local model to work out a recipe's nutrition and saves the result. */
export function startNutritionJob(app: App, slug: string, keepManual?: boolean) {
  const { store } = app;
  const title = store.requireRecipe(slug).meta.title;
  return app.jobs.start(`Calculating nutrition for ${title}`, async ({ progress }) => {
    const recipe = store.requireRecipe(slug);
    if (!recipe.ingredients.length) throw new ValidationError("This recipe has no ingredients to calculate from");
    const res = await calculateNutrition(store, app.ollama, recipe, { keepManual, onProgress: progress });
    await store.mutateRecipe(
      slug,
      (meta) => {
        meta.nutrition = res.nutrition;
        return { meta };
      },
      { reason: `Nutrition for ${slug}` },
    );
    progress(`Done — ${res.newFoods.length} new food${res.newFoods.length === 1 ? "" : "s"} added to the nutrition database`);
    return { warnings: res.warnings, newFoods: res.newFoods };
  });
}
