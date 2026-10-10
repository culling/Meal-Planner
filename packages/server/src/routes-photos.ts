import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MealPlanSchema, NotFoundError, ValidationError, isValidWeek, type App } from "@mp/core";
import { readMultipart } from "./util";

const SlotRef = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slot: z.string().min(1) });

export function registerPhotoRoutes(server: FastifyInstance, app: App) {
  const { store, importer } = app;
  const photos = store.photos;

  const withState = async (id: string) => {
    const photo = await photos.require(id);
    const draft = await importer.getPhotoDraft(id);
    return { photo, draft: draft ? { readAt: draft.readAt, model: draft.model, provider: draft.provider, title: draft.draft.title } : null };
  };

  const bookFrom = (f: Record<string, string>) => {
    const book = { title: f.bookTitle?.trim() || null, author: f.bookAuthor?.trim() || null, page: f.bookPage?.trim() || null };
    return book.title || book.author || book.page ? book : null;
  };

  server.get("/api/photos", async () => {
    const list = await photos.list();
    return { photos: await Promise.all(list.map(async (p) => ({ ...p, hasDraft: !!(await importer.getPhotoDraft(p.id)) }))) };
  });

  /** Save one or more photos with a name. Nothing is read yet — that can happen now or any time later. */
  server.post("/api/photos", async (req, reply) => {
    const { fields, files } = await readMultipart(req);
    const pages = files.filter((f) => f.field === "files" || f.field === "file");
    const photo = await photos.create({ name: fields.name, files: pages.map((f) => ({ data: f.data, name: f.name })), book: bookFrom(fields), notes: fields.notes ?? "" });
    void reply.status(201);
    return withState(photo.id);
  });

  server.get<{ Params: { id: string } }>("/api/photos/:id", async (req) => withState(req.params.id));

  server.patch<{ Params: { id: string } }>("/api/photos/:id", async (req) => {
    const b = z
      .object({
        name: z.string().optional(),
        notes: z.string().optional(),
        book: z.object({ title: z.string().nullable(), author: z.string().nullable(), page: z.union([z.string(), z.number()]).nullable() }).nullable().optional(),
      })
      .parse(req.body);
    await photos.update(req.params.id, b);
    return withState(req.params.id);
  });

  server.post<{ Params: { id: string } }>("/api/photos/:id/pages", async (req) => {
    const { files } = await readMultipart(req);
    if (!files.length) throw new ValidationError("No photo was uploaded");
    await photos.addPages(req.params.id, files.map((f) => ({ data: f.data, name: f.name })));
    return withState(req.params.id);
  });

  server.delete<{ Params: { id: string }; Querystring: { file: string } }>("/api/photos/:id/pages", async (req) => {
    await photos.removePage(req.params.id, String(req.query.file));
    return withState(req.params.id);
  });

  server.delete<{ Params: { id: string } }>("/api/photos/:id", async (req) => {
    await photos.delete(req.params.id);
    return { ok: true };
  });

  server.post<{ Params: { id: string } }>("/api/photos/:id/reopen", async (req) => {
    await photos.reopen(req.params.id);
    return withState(req.params.id);
  });

  /** Read the saved photo with the settings' model, or one chosen just for this go. */
  server.post<{ Params: { id: string } }>("/api/photos/:id/read", async (req) => {
    const { provider, model } = z.object({ provider: z.enum(["ollama", "lightonocr"]).optional(), model: z.string().min(1).optional() }).parse(req.body ?? {});
    await photos.require(req.params.id);
    return { jobId: importer.startPhotoRead(req.params.id, { provider, model }).id };
  });

  server.get<{ Params: { id: string } }>("/api/photos/:id/draft", async (req) => {
    await photos.require(req.params.id);
    return (await importer.getPhotoDraft(req.params.id)) ?? { draft: null };
  });

  server.post<{ Params: { id: string } }>("/api/photos/:id/blank-draft", async (req) => ({ draft: await importer.blankPhotoDraft(req.params.id) }));

  server.get<{ Params: { id: string; file: string }; Querystring: { w?: string } }>("/api/photos/:id/images/:file", async (req, reply) => {
    let full = photos.imagePath(req.params.id, req.params.file);
    if (!fs.existsSync(full)) throw new NotFoundError("Photo page");
    const w = Number(req.query.w);
    if (w > 0) full = await photos.thumbnail(req.params.id, req.params.file, w);
    const st = fs.statSync(full);
    void reply.header("content-type", "image/jpeg");
    void reply.header("cache-control", "private, max-age=3600");
    void reply.header("etag", `"${st.mtimeMs}-${st.size}"`);
    return reply.send(fs.createReadStream(full));
  });

  // ---------- meals: copy / fill / move, and undo ----------
  const week = (w: string) => {
    if (!isValidWeek(w)) throw new ValidationError(`Invalid week "${w}"`);
    return w;
  };

  server.post<{ Params: { week: string } }>("/api/meal-plans/:week/copy", async (req) => {
    const b = z.object({ from: SlotRef, to: z.array(SlotRef).min(1).max(40), mode: z.enum(["auto", "repeat", "leftovers", "move"]).optional() }).parse(req.body);
    return app.planner.copyMeals(week(req.params.week), b);
  });

  server.post<{ Params: { week: string } }>("/api/meal-plans/:week/restore", async (req) => {
    const { plans } = z.object({ plans: z.array(MealPlanSchema).min(1).max(3) }).parse(req.body);
    return { view: await app.planner.restorePlans(week(req.params.week), plans) };
  });
}
