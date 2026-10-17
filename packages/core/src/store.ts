import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import sharp from "sharp";
import { ZodError } from "zod";
import type { AppConfig } from "./config";
import { todayYmd, weekDates, weekStartDate, isValidWeek, isValidYmd, isoWeekOf, setWeekStart } from "./dates";
import { parseDoc, stringifyDoc, type ParsedDoc } from "./frontmatter";
import {
  ConflictError,
  KeyedMutex,
  NotFoundError,
  ValidationError,
  atomicWrite,
  exists,
  insideDir,
  moveDir,
  nowIso,
  readIfExists,
  safeFileName,
  slugify,
  uniqueSlug,
} from "./fsutil";
import { DataGit } from "./git";
import {
  addCookLog,
  addNote,
  bodyParts,
  buildBody,
  parseBody,
  setNotes,
  updateBodyParts,
  type BodyParts,
} from "./recipe-doc";
import {
  DayPlanSchema,
  FoodSchema,
  MealPlanSchema,
  RecipeMetaSchema,
  parseRecipeMeta,
  SettingsSchema,
  ShoppingListSchema,
  type Food,
  type GalleryItem,
  type MealPlan,
  type NoteEntry,
  type Recipe,
  type RecipeMeta,
  type Settings,
  type ShoppingList,
} from "./schemas";
import { PhotoStore } from "./photos";
import { renderPlanBody, renderShoppingBody } from "./render";

export function deepMerge<T>(target: T, patch: unknown): T {
  if (patch === undefined) return target;
  if (!isPlain(target) || !isPlain(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}
function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function zodMessage(e: ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

function validate<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ZodError) throw new ValidationError(zodMessage(e), e.issues);
    throw e;
  }
}

export interface NewRecipeInput extends Partial<Omit<RecipeMeta, "id" | "createdAt" | "updatedAt">>, Partial<BodyParts> {
  title: string;
}

export interface RecipePatch extends Partial<Omit<RecipeMeta, "id">>, Partial<BodyParts> {}

export type ChangeEvent = { kind: "recipe" | "settings" | "plan" | "shopping" | "foods" | "photo"; id: string };

const DEFAULT_SETTINGS_BODY = `# Settings

Edit the values above. They are read when the app starts and whenever this file changes.
API keys and server options belong in \`.env\`, not here.
`;

export class DataStore extends EventEmitter {
  readonly git: DataGit;
  private recipes = new Map<string, Recipe>();
  private problems = new Map<string, string>();
  private settings: Settings = SettingsSchema.parse({});
  private foods: Food[] = [];
  private mutex = new KeyedMutex();
  private watcher: FSWatcher | null = null;
  /** photos of recipes waiting to be read (or typed in) */
  readonly photos: PhotoStore;
  /** bumps on every change; used to invalidate search indexes */
  version = 0;

  constructor(readonly cfg: AppConfig) {
    super();
    this.git = new DataGit(cfg.dataDir, cfg.gitAutocommit);
    this.photos = new PhotoStore(path.join(cfg.dataDir, "photos"), path.join(cfg.dataDir, ".trash"), path.join(cfg.dataDir, ".cache"), (id, reason) => this.bump({ kind: "photo", id }, reason), (src, dest) => this.moveFolder(src, dest));
  }

  // ---------- paths ----------
  get dataDir() {
    return this.cfg.dataDir;
  }
  get recipesDir() {
    return path.join(this.dataDir, "recipes");
  }
  get plansDir() {
    return path.join(this.dataDir, "meal-plans");
  }
  get shoppingDir() {
    return path.join(this.dataDir, "shopping-lists");
  }
  get cacheDir() {
    return path.join(this.dataDir, ".cache");
  }
  get trashDir() {
    return path.join(this.dataDir, ".trash");
  }
  get settingsFile() {
    return path.join(this.dataDir, "settings.md");
  }
  get foodsFile() {
    return path.join(this.dataDir, "nutrition-db.md");
  }
  recipeDir(slug: string) {
    this.assertSlug(slug);
    return path.join(this.recipesDir, slug);
  }
  recipeFile(slug: string) {
    return path.join(this.recipeDir(slug), "recipe.md");
  }
  private assertSlug(slug: string) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new ValidationError(`Invalid recipe id: ${slug}`);
  }

  // ---------- lifecycle ----------
  async init(): Promise<void> {
    for (const d of [this.recipesDir, this.plansDir, this.shoppingDir, this.cacheDir, path.join(this.dataDir, "photos")]) await fs.mkdir(d, { recursive: true });
    await this.git.init();
    await this.loadSettings(true);
    await this.loadFoods();
    await this.loadAllRecipes();
    await this.rebucketPlans(); // no-op unless the saved plans were made for a different start day
    if (this.cfg.watch) this.startWatching();
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
    await this.git.commitNow();
  }

  private bump(ev: ChangeEvent, reason?: string) {
    this.version++;
    this.emit("change", ev);
    if (reason) this.git.schedule(reason);
  }

  private startWatching() {
    const rel = (p: string) => path.relative(this.dataDir, p).replace(/\\/g, "/");
    this.watcher = chokidar.watch(this.dataDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
      ignored: (p) => {
        const r = rel(p);
        return /(^|\/)(\.git|\.cache|\.trash)(\/|$)/.test(r) || r.endsWith(".tmp");
      },
    });
    const handle = async (file: string, removed: boolean) => {
      const r = rel(file);
      try {
        let m: RegExpMatchArray | null;
        if ((m = r.match(/^recipes\/([^/]+)\/recipe\.md$/))) {
          const slug = m[1];
          if (removed) {
            if (this.recipes.delete(slug)) this.bump({ kind: "recipe", id: slug }, `Removed ${slug}`);
            this.problems.delete(slug);
          } else {
            const st = await fs.stat(file).catch(() => null);
            if (st && this.recipes.get(slug)?.mtimeMs === st.mtimeMs) return; // our own write
            await this.reloadRecipe(slug);
            this.bump({ kind: "recipe", id: slug }, `Edited ${slug}`);
          }
        } else if (r === "settings.md") {
          await this.loadSettings(false);
          this.bump({ kind: "settings", id: "settings" }, "Edited settings");
        } else if (r === "nutrition-db.md") {
          await this.loadFoods();
          this.bump({ kind: "foods", id: "foods" }, "Edited nutrition database");
        } else if ((m = r.match(/^meal-plans\/(.+)\.md$/))) {
          this.bump({ kind: "plan", id: m[1] }, `Edited plan ${m[1]}`);
        } else if ((m = r.match(/^shopping-lists\/(.+)\.md$/))) {
          this.bump({ kind: "shopping", id: m[1] }, `Edited shopping list ${m[1]}`);
        } else if ((m = r.match(/^photos\/([^/]+)\/photo\.md$/))) {
          this.bump({ kind: "photo", id: m[1] }, `Edited photo ${m[1]}`);
        } else if (/^(recipes|photos)\/[^/]+\/images\//.test(r)) {
          this.git.schedule("Image change");
        }
      } catch (e) {
        this.emit("warning", `Could not reload ${r}: ${(e as Error).message}`);
      }
    };
    this.watcher.on("add", (f) => void handle(f, false));
    this.watcher.on("change", (f) => void handle(f, false));
    this.watcher.on("unlink", (f) => void handle(f, true));
  }

  /**
   * Move a folder. Windows won't rename a folder the file watcher has open, so the watcher is paused for the move
   * (and restarted straight after). Edits made in that instant are picked up the next time the file is touched.
   */
  async moveFolder(src: string, dest: string): Promise<void> {
    const wasWatching = !!this.watcher;
    if (wasWatching) {
      await this.watcher!.close();
      this.watcher = null;
    }
    try {
      await moveDir(src, dest);
    } finally {
      if (wasWatching) this.startWatching();
    }
  }

  // ---------- settings ----------
  getSettings(): Settings {
    return this.settings;
  }

  private async loadSettings(createIfMissing: boolean) {
    const r = await readIfExists(this.settingsFile);
    if (!r) {
      this.settings = SettingsSchema.parse({});
      setWeekStart(this.settings.weekStartsOn);
      if (createIfMissing) await this.writeSettings(this.settings);
      return;
    }
    try {
      const doc = parseDoc(r.text);
      const before = this.settings.weekStartsOn;
      this.settings = SettingsSchema.parse(doc.data);
      setWeekStart(this.settings.weekStartsOn);
      // changed by hand in a text editor while the app is running: regroup the plans to match
      if (!createIfMissing && before !== this.settings.weekStartsOn) await this.rebucketPlans();
    } catch (e) {
      this.emit("warning", `settings.md is invalid, using defaults: ${(e as Error).message}`);
    }
  }

  private async writeSettings(s: Settings) {
    const r = await readIfExists(this.settingsFile);
    const doc = r ? parseDoc(r.text) : undefined;
    await atomicWrite(this.settingsFile, stringifyDoc(s as Record<string, unknown>, doc?.body ?? DEFAULT_SETTINGS_BODY, doc));
  }

  async updateSettings(patch: unknown): Promise<Settings> {
    return this.mutex.run("settings", async () => {
      const next = validate(() => SettingsSchema.parse(deepMerge(this.settings, patch)));
      const startChanged = next.weekStartsOn !== this.settings.weekStartsOn;
      await this.writeSettings(next);
      this.settings = next;
      setWeekStart(next.weekStartsOn);
      if (startChanged) await this.rebucketPlans();
      this.bump({ kind: "settings", id: "settings" }, "Updated settings");
      return next;
    });
  }

  // ---------- recipes ----------
  private async loadAllRecipes() {
    this.recipes.clear();
    this.problems.clear();
    const entries = await fs.readdir(this.recipesDir, { withFileTypes: true }).catch(() => []);
    const slugs = entries.filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(e.name)).map((e) => e.name);
    for (let i = 0; i < slugs.length; i += 16) {
      await Promise.all(slugs.slice(i, i + 16).map((s) => this.reloadRecipe(s)));
    }
    this.version++;
  }

  private async reloadRecipe(slug: string): Promise<Recipe | null> {
    const r = await readIfExists(this.recipeFile(slug));
    if (!r) {
      this.recipes.delete(slug);
      this.problems.delete(slug);
      return null;
    }
    try {
      const recipe = this.buildRecipe(slug, parseDoc(r.text), r.mtimeMs);
      this.recipes.set(slug, recipe);
      this.problems.delete(slug);
      return recipe;
    } catch (e) {
      const msg = e instanceof ZodError ? zodMessage(e) : (e as Error).message;
      this.problems.set(slug, msg);
      this.recipes.delete(slug);
      return null;
    }
  }

  private buildRecipe(slug: string, doc: ParsedDoc, mtimeMs: number): Recipe {
    const meta = parseRecipeMeta({ ...doc.data, id: slug, title: doc.data.title ?? slug });
    return this.recipeFrom(slug, meta, doc.body, mtimeMs);
  }

  private recipeFrom(slug: string, meta: RecipeMeta, body: string, mtimeMs: number): Recipe {
    const parsed = parseBody(body);
    const lastCooked = parsed.cookLog.map((c) => c.date).sort().at(-1) ?? null;
    return { slug, meta, body, ...parsed, lastCooked, mtimeMs };
  }

  /** Recipes that exist on disk but could not be read (bad YAML etc). */
  getProblems(): { slug: string; error: string }[] {
    return [...this.problems].map(([slug, error]) => ({ slug, error }));
  }

  listRecipes(): Recipe[] {
    return [...this.recipes.values()];
  }

  getRecipe(slug: string): Recipe | undefined {
    return this.recipes.get(slug);
  }

  requireRecipe(slug: string): Recipe {
    const r = this.recipes.get(slug);
    if (!r) throw new NotFoundError(`Recipe "${slug}"`);
    return r;
  }

  /** Raw file text plus modified time, for the "edit raw Markdown" view. */
  async getRecipeRaw(slug: string): Promise<{ text: string; mtimeMs: number }> {
    const r = await readIfExists(this.recipeFile(slug));
    if (!r) throw new NotFoundError(`Recipe "${slug}"`);
    return r;
  }

  async createRecipe(input: NewRecipeInput): Promise<Recipe> {
    const title = input.title.trim();
    if (!title) throw new ValidationError("A recipe needs a title");
    const slug = await uniqueSlug(this.recipesDir, title);
    const { ingredientsMd, methodMd, sourceNotes, ...metaIn } = input;
    const now = nowIso();
    const meta = validate(() =>
      parseRecipeMeta({
        ...metaIn,
        id: slug,
        title,
        source: { type: "manual", ...(metaIn.source ?? {}) },
        createdAt: now,
        updatedAt: now,
      }),
    );
    const body = buildBody({ title, ingredientsMd: ingredientsMd ?? "", methodMd: methodMd ?? "", sourceNotes });
    return this.mutex.run(`recipe:${slug}`, async () => {
      await fs.mkdir(path.join(this.recipeDir(slug), "images"), { recursive: true });
      const mtime = await atomicWrite(this.recipeFile(slug), stringifyDoc(meta as Record<string, unknown>, body));
      const recipe = this.recipeFrom(slug, meta, body, mtime);
      this.recipes.set(slug, recipe);
      this.bump({ kind: "recipe", id: slug }, `Added ${slug}`);
      return recipe;
    });
  }

  /**
   * Read the file fresh, apply `fn`, write atomically. Edits made in a text editor a moment ago are never lost
   * because the new content is based on what is on disk right now.
   */
  async mutateRecipe(
    slug: string,
    fn: (meta: RecipeMeta, body: string) => { meta?: RecipeMeta; body?: string } | void,
    opts: { expectedMtimeMs?: number | null; reason?: string; touch?: boolean } = {},
  ): Promise<Recipe> {
    return this.mutex.run(`recipe:${slug}`, async () => {
      const file = this.recipeFile(slug);
      const r = await readIfExists(file);
      if (!r) throw new NotFoundError(`Recipe "${slug}"`);
      if (opts.expectedMtimeMs != null && Math.abs(r.mtimeMs - opts.expectedMtimeMs) > 1) throw new ConflictError(file);
      const doc = parseDoc(r.text);
      const current = validate(() => parseRecipeMeta({ ...doc.data, id: slug, title: doc.data.title ?? slug }));
      const out = fn(structuredClone(current), doc.body) ?? {};
      let meta = out.meta ?? current;
      const body = out.body ?? doc.body;
      if (opts.touch !== false) meta = { ...meta, updatedAt: nowIso() };
      meta = validate(() => parseRecipeMeta({ ...meta, id: slug }));
      const text = stringifyDoc(meta as Record<string, unknown>, body, doc);
      const mtime = text === r.text ? r.mtimeMs : await atomicWrite(file, text, r.mtimeMs);
      const recipe = this.recipeFrom(slug, meta, body, mtime);
      this.recipes.set(slug, recipe);
      this.bump({ kind: "recipe", id: slug }, opts.reason ?? `Updated ${slug}`);
      return recipe;
    });
  }

  async updateRecipe(slug: string, patch: RecipePatch, opts: { expectedMtimeMs?: number | null } = {}): Promise<Recipe> {
    const { ingredientsMd, methodMd, sourceNotes, ...metaPatch } = patch;
    return this.mutateRecipe(
      slug,
      (meta, body) => {
        let next = meta;
        for (const [k, v] of Object.entries(metaPatch)) {
          if (v === undefined) continue;
          (next as any)[k] = isPlain(v) && isPlain((next as any)[k]) ? deepMerge((next as any)[k], v) : v;
        }
        const parts: Partial<BodyParts> = {};
        if (ingredientsMd !== undefined) parts.ingredientsMd = ingredientsMd;
        if (methodMd !== undefined) parts.methodMd = methodMd;
        if (sourceNotes !== undefined) parts.sourceNotes = sourceNotes;
        if (patch.title !== undefined) parts.title = patch.title;
        const newBody = Object.keys(parts).length ? updateBodyParts(body, parts) : body;
        return { meta: next, body: newBody };
      },
      { ...opts, reason: `Edited ${slug}` },
    );
  }

  /** Replace the whole file with user-supplied text (raw Markdown editor). */
  async saveRecipeRaw(slug: string, text: string, expectedMtimeMs?: number | null): Promise<Recipe> {
    return this.mutex.run(`recipe:${slug}`, async () => {
      const file = this.recipeFile(slug);
      if (!(await exists(file))) throw new NotFoundError(`Recipe "${slug}"`);
      const doc = validate(() => parseDoc(text));
      const meta = validate(() => parseRecipeMeta({ ...doc.data, id: slug, title: doc.data.title ?? slug }));
      const mtime = await atomicWrite(file, text.endsWith("\n") ? text : `${text}\n`, expectedMtimeMs);
      const recipe = this.recipeFrom(slug, meta, doc.body, mtime);
      this.recipes.set(slug, recipe);
      this.bump({ kind: "recipe", id: slug }, `Edited ${slug} (raw)`);
      return recipe;
    });
  }

  async deleteRecipe(slug: string): Promise<void> {
    await this.mutex.run(`recipe:${slug}`, async () => {
      const dir = this.recipeDir(slug);
      if (!(await exists(dir))) throw new NotFoundError(`Recipe "${slug}"`);
      await fs.mkdir(this.trashDir, { recursive: true });
      let dest = path.join(this.trashDir, `${slug}-${new Date().toISOString().slice(0, 10)}`);
      let n = 1;
      while (await exists(dest)) dest = path.join(this.trashDir, `${slug}-${new Date().toISOString().slice(0, 10)}-${++n}`);
      await this.moveFolder(dir, dest);
      this.recipes.delete(slug);
      this.problems.delete(slug);
      this.bump({ kind: "recipe", id: slug }, `Deleted ${slug}`);
    });
  }

  /** Change a recipe's folder name and update every meal plan that mentions it. */
  async renameSlug(oldSlug: string, newSlugRaw: string): Promise<Recipe> {
    const newSlug = slugify(newSlugRaw);
    if (newSlug === oldSlug) return this.requireRecipe(oldSlug);
    if (await exists(this.recipeDir(newSlug))) throw new ValidationError(`A recipe called "${newSlug}" already exists`);
    await this.mutex.run(`recipe:${oldSlug}`, async () => {
      await this.moveFolder(this.recipeDir(oldSlug), this.recipeDir(newSlug));
    });
    this.recipes.delete(oldSlug);
    const recipe = await this.mutateRecipe(newSlug, () => undefined, { reason: `Renamed ${oldSlug} to ${newSlug}`, touch: false });
    for (const entry of await fs.readdir(this.plansDir).catch(() => [])) {
      if (!entry.endsWith(".md")) continue;
      const week = entry.slice(0, -3);
      const plan = await this.getPlan(week);
      let changed = false;
      for (const day of plan.days) for (const meal of Object.values(day.meals)) if (meal?.recipe === oldSlug) ((meal.recipe = newSlug), (changed = true));
      if (changed) await this.savePlan(plan);
    }
    this.bump({ kind: "recipe", id: newSlug });
    return recipe;
  }

  // ---------- recipe helpers ----------
  async addNoteToRecipe(slug: string, text: string, date = todayYmd()): Promise<Recipe> {
    if (!text.trim()) throw new ValidationError("Note is empty");
    return this.mutateRecipe(slug, (_m, body) => ({ body: addNote(body, date, text) }), { reason: `Note on ${slug}` });
  }

  async replaceNotes(slug: string, notes: NoteEntry[]): Promise<Recipe> {
    return this.mutateRecipe(slug, (_m, body) => ({ body: setNotes(body, notes) }), { reason: `Edited notes on ${slug}` });
  }

  async setFlag(slug: string, flag: "favorite" | "hidden", value?: boolean): Promise<Recipe> {
    return this.mutateRecipe(
      slug,
      (meta) => {
        meta[flag] = value ?? !meta[flag];
        return { meta };
      },
      { reason: `${flag} on ${slug}`, touch: false },
    );
  }

  /** Add to the cook log (and set a rating if given and none exists yet). */
  async logCooked(slug: string, opts: { date?: string; people?: number | null; rating?: number | null } = {}): Promise<Recipe> {
    const date = opts.date ?? todayYmd();
    const parts = [date, "—", opts.people ? `cooked for ${opts.people}` : "cooked"];
    let line = parts.join(" ");
    if (opts.rating) line += `, rating ${opts.rating}`;
    return this.mutateRecipe(
      slug,
      (meta, body) => {
        if (opts.rating && meta.rating == null) meta.rating = opts.rating;
        return { meta, body: addCookLog(body, line) };
      },
      { reason: `Cooked ${slug}`, touch: false },
    );
  }

  bodyParts(slug: string) {
    return bodyParts(this.requireRecipe(slug).body);
  }

  // ---------- images ----------
  imagePath(slug: string, file: string): string {
    const full = path.join(this.recipeDir(slug), file);
    if (!insideDir(this.recipeDir(slug), full)) throw new ValidationError("Bad image path");
    return full;
  }

  async addImage(
    slug: string,
    input: { data: Buffer; originalName: string; kind: GalleryItem["kind"] | "hero"; step?: number | null; caption?: string | null; date?: string | null; maxEdge?: number },
  ): Promise<{ recipe: Recipe; file: string }> {
    const ext0 = path.extname(input.originalName).toLowerCase();
    // rotate by EXIF, cap size, and normalise phone formats (JPEG/HEIC) to JPEG
    let pipeline = sharp(input.data, { failOn: "none" }).rotate();
    const maxEdge = input.maxEdge ?? (input.kind === "source-page" ? 3000 : 2400);
    pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
    let ext = ".jpg";
    if (ext0 === ".png") (pipeline = pipeline.png()), (ext = ".png");
    else if (ext0 === ".webp") (pipeline = pipeline.webp({ quality: 90 })), (ext = ".webp");
    else pipeline = pipeline.jpeg({ quality: 90 });
    let out: Buffer;
    try {
      out = await pipeline.toBuffer();
    } catch (e) {
      throw new ValidationError(`Could not read that image (${(e as Error).message}). If it is a HEIC photo, try JPEG instead.`);
    }
    const imagesDir = path.join(this.recipeDir(slug), "images");
    await fs.mkdir(imagesDir, { recursive: true });
    const date = input.date ?? todayYmd();
    let base: string;
    switch (input.kind) {
      case "hero":
        base = "hero";
        break;
      case "step":
        base = `step-${String(input.step ?? 0).padStart(2, "0")}`;
        break;
      case "cooked":
        base = `${date}-cooked`;
        break;
      case "source-page":
        base = "source-page";
        break;
      default:
        base = safeFileName(input.originalName).replace(/\.[a-z0-9]+$/, "") || "image";
    }
    // source pages are numbered from 1; a new hero replaces the old file; everything else gets a numeric suffix
    let n = input.kind === "source-page" ? 1 : 0;
    const nameFor = () => `${base}${n > 0 ? `-${n}` : ""}${ext}`;
    let name = nameFor();
    while (input.kind !== "hero" && (await exists(path.join(imagesDir, name)))) {
      n = Math.max(n + 1, 2);
      name = nameFor();
    }
    await atomicWrite(path.join(imagesDir, name), out);
    const rel = `images/${name}`;
    const recipe = await this.mutateRecipe(
      slug,
      (meta) => {
        if (input.kind === "hero") meta.images.hero = rel;
        else {
          const item: GalleryItem = { file: rel, kind: input.kind as GalleryItem["kind"] };
          if (input.step != null) item.step = input.step;
          if (input.caption) item.caption = input.caption;
          if (input.kind === "cooked") item.date = date;
          meta.images.gallery = [...meta.images.gallery.filter((g) => g.file !== rel), item];
        }
        return { meta };
      },
      { reason: `Image for ${slug}`, touch: false },
    );
    await this.clearThumbs(slug);
    return { recipe, file: rel };
  }

  async updateGalleryItem(slug: string, file: string, patch: Partial<GalleryItem>): Promise<Recipe> {
    return this.mutateRecipe(
      slug,
      (meta) => {
        meta.images.gallery = meta.images.gallery.map((g) => (g.file === file ? { ...g, ...patch, file } : g));
        return { meta };
      },
      { touch: false },
    );
  }

  async setHero(slug: string, file: string | null): Promise<Recipe> {
    return this.mutateRecipe(
      slug,
      (meta) => {
        meta.images.hero = file;
        return { meta };
      },
      { touch: false, reason: `Hero image for ${slug}` },
    );
  }

  async removeImage(slug: string, file: string): Promise<Recipe> {
    const full = this.imagePath(slug, file);
    const recipe = await this.mutateRecipe(
      slug,
      (meta) => {
        meta.images.gallery = meta.images.gallery.filter((g) => g.file !== file);
        if (meta.images.hero === file) meta.images.hero = null;
        return { meta };
      },
      { touch: false, reason: `Removed image from ${slug}` },
    );
    await fs.rm(full, { force: true });
    await this.clearThumbs(slug);
    return recipe;
  }

  /** Cached resized copy of an image (for lists on a phone). Returns the original path when no resize is needed. */
  async thumbnail(slug: string, file: string, width: number): Promise<string> {
    const src = this.imagePath(slug, file);
    const w = Math.min(Math.max(Math.round(width / 40) * 40, 80), 2000);
    const dest = path.join(this.cacheDir, "thumbs", slug, `${w}-${path.basename(file).replace(/\.[^.]+$/, "")}.jpg`);
    const [s, d] = await Promise.all([fs.stat(src), fs.stat(dest).catch(() => null)]);
    if (d && d.mtimeMs >= s.mtimeMs) return dest;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await sharp(src, { failOn: "none" }).rotate().resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(dest);
    return dest;
  }

  private async clearThumbs(slug: string) {
    await fs.rm(path.join(this.cacheDir, "thumbs", slug), { recursive: true, force: true });
  }

  // ---------- foods (nutrition database) ----------
  listFoods(): Food[] {
    return this.foods;
  }

  private async loadFoods() {
    const r = await readIfExists(this.foodsFile);
    if (!r) {
      this.foods = [];
      return;
    }
    try {
      const doc = parseDoc(r.text);
      const list = Array.isArray(doc.data.foods) ? doc.data.foods : [];
      this.foods = list.map((f) => FoodSchema.parse(f));
    } catch (e) {
      this.emit("warning", `nutrition-db.md is invalid: ${(e as Error).message}`);
    }
  }

  private async writeFoods(foods: Food[]) {
    const sorted = [...foods].sort((a, b) => a.name.localeCompare(b.name));
    const r = await readIfExists(this.foodsFile);
    const doc = r ? parseDoc(r.text) : undefined;
    await atomicWrite(this.foodsFile, stringifyDoc({ foods: sorted }, renderFoodsBody(sorted), doc));
    this.foods = sorted;
  }

  /** Create or replace foods (by id). */
  async upsertFoods(foods: (Partial<Food> & { id: string; name: string })[]): Promise<Food[]> {
    return this.mutex.run("foods", async () => {
      const map = new Map(this.foods.map((f) => [f.id, f]));
      for (const f of foods) {
        const parsed = validate(() => FoodSchema.parse({ ...map.get(f.id), ...f, updatedAt: nowIso() }));
        map.set(parsed.id, parsed);
      }
      await this.writeFoods([...map.values()]);
      this.bump({ kind: "foods", id: "foods" }, "Updated nutrition database");
      return this.foods;
    });
  }

  async deleteFood(id: string): Promise<void> {
    await this.mutex.run("foods", async () => {
      if (!this.foods.some((f) => f.id === id)) throw new NotFoundError(`Food "${id}"`);
      await this.writeFoods(this.foods.filter((f) => f.id !== id));
      this.bump({ kind: "foods", id: "foods" }, "Updated nutrition database");
    });
  }

  // ---------- meal plans ----------
  planFile(week: string) {
    if (!isValidWeek(week)) throw new ValidationError(`Invalid week "${week}" (expected e.g. 2026-W41)`);
    return path.join(this.plansDir, `${week}.md`);
  }

  async planMtime(week: string): Promise<number | null> {
    try {
      return (await fs.stat(this.planFile(week))).mtimeMs;
    } catch {
      return null;
    }
  }

  /** Load a plan, filling in all 7 days. A week with no file gives a blank (unsaved) plan. */
  async getPlan(week: string): Promise<MealPlan & { mtimeMs: number | null; saved: boolean }> {
    const file = this.planFile(week);
    const r = await readIfExists(file);
    const dates = weekDates(week);
    let plan: MealPlan;
    if (r) {
      const doc = parseDoc(r.text);
      plan = validate(() => MealPlanSchema.parse({ ...doc.data, week }));
    } else {
      plan = MealPlanSchema.parse({ week, startDate: weekStartDate(week) });
    }
    const byDate = new Map(plan.days.map((d) => [d.date, d]));
    plan.days = dates.map((date) => byDate.get(date) ?? { date, people: null, meals: {} });
    plan.startDate = dates[0];
    return { ...plan, mtimeMs: r?.mtimeMs ?? null, saved: !!r };
  }

  async savePlan(plan: MealPlan, expectedMtimeMs?: number | null): Promise<MealPlan & { mtimeMs: number | null; saved: boolean }> {
    return this.mutex.run(`plan:${plan.week}`, async () => {
      const clean = validate(() => MealPlanSchema.parse(plan));
      const slots = this.settings.mealSlots;
      // drop empty days so files stay short; keep days that have an override or a meal
      clean.days = clean.days
        .map((d) => ({ ...d, meals: Object.fromEntries(Object.entries(d.meals).filter(([, m]) => m !== null)) }))
        .filter((d) => d.people !== null || Object.keys(d.meals).length > 0);
      const file = this.planFile(clean.week);
      const r = await readIfExists(file);
      const doc = r ? parseDoc(r.text) : undefined;
      const body = renderPlanBody(clean, (slug) => this.recipes.get(slug)?.meta.title ?? slug, slots);
      const { mtimeMs, saved, ...data } = clean as any;
      void mtimeMs;
      void saved;
      await atomicWrite(file, stringifyDoc(data, body, doc), expectedMtimeMs ?? undefined);
      this.bump({ kind: "plan", id: clean.week }, `Updated plan ${clean.week}`);
      return this.getPlan(clean.week);
    });
  }

  /**
   * Plans are stored one file per week, so when the week's start day changes the meals have to move into the files of
   * their new weeks (a meal on Fri 9 Oct belongs to a different file once weeks start on Saturday). Meals keep their
   * dates, leftovers keep working, and nothing happens if the files already match. Shopping lists are per week too and are
   * rebuilt from the plan with "Update from the plan".
   */
  async rebucketPlans(): Promise<{ weeks: number; days: number }> {
    const ids = await this.listPlanWeeks();
    const files: { id: string; defaultPeople: number | null; days: ReturnType<typeof DayPlanSchema.parse>[] }[] = [];
    let needed = false;
    for (const id of ids) {
      const r = await readIfExists(this.planFile(id));
      if (!r) continue;
      let data: Record<string, unknown>;
      try {
        data = parseDoc(r.text).data;
      } catch {
        continue; // a file that can't be read is left exactly as it is
      }
      const days: ReturnType<typeof DayPlanSchema.parse>[] = [];
      for (const d of Array.isArray(data.days) ? data.days : []) {
        const parsed = DayPlanSchema.safeParse(d);
        if (parsed.success) days.push(parsed.data);
      }
      const inRange = new Set(weekDates(id));
      if (days.some((d) => !inRange.has(d.date)) || (typeof data.startDate === "string" && data.startDate !== weekStartDate(id))) needed = true;
      files.push({ id, defaultPeople: typeof data.defaultPeople === "number" ? data.defaultPeople : null, days });
    }
    if (!needed) return { weeks: 0, days: 0 };

    const groups = new Map<string, { days: Map<string, ReturnType<typeof DayPlanSchema.parse>>; votes: Map<number, number> }>();
    for (const f of files) {
      for (const day of f.days) {
        if (day.people === null && !Object.values(day.meals).some(Boolean)) continue;
        const week = isoWeekOf(day.date);
        const g = groups.get(week) ?? { days: new Map(), votes: new Map() };
        groups.set(week, g);
        g.days.set(day.date, day);
        if (f.defaultPeople !== null) g.votes.set(f.defaultPeople, (g.votes.get(f.defaultPeople) ?? 0) + 1);
      }
    }
    let moved = 0;
    for (const [week, g] of groups) {
      const winner = [...g.votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const days = [...g.days.values()].sort((a, b) => a.date.localeCompare(b.date));
      moved += days.length;
      await this.savePlan(MealPlanSchema.parse({ week, startDate: weekStartDate(week), defaultPeople: winner, days }));
    }
    // files that no longer hold any week of their own
    for (const f of files) if (!groups.has(f.id)) await fs.rm(this.planFile(f.id), { force: true });
    this.bump({ kind: "plan", id: "*" }, `Regrouped plans into weeks starting on ${this.settings.weekStartsOn}`);
    return { weeks: groups.size, days: moved };
  }

  async listPlanWeeks(): Promise<string[]> {
    const files = await fs.readdir(this.plansDir).catch(() => []);
    return files.filter((f) => /^\d{4}-W\d{2}\.md$/.test(f)).map((f) => f.slice(0, -3)).sort();
  }

  // ---------- shopping lists ----------
  // A list belongs to a week ("2026-W42") or to the 7 days starting on a date ("2026-10-17"); the field is still called week.
  shoppingFile(week: string) {
    if (!isValidWeek(week) && !isValidYmd(week)) throw new ValidationError(`Invalid week "${week}"`);
    return path.join(this.shoppingDir, `${week}.md`);
  }

  /** Ids of the saved shopping lists, sorted. */
  async listShoppingLists(): Promise<string[]> {
    const files = await fs.readdir(this.shoppingDir).catch(() => []);
    return files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).filter((id) => isValidWeek(id) || isValidYmd(id)).sort();
  }

  async getShoppingList(week: string): Promise<ShoppingList & { mtimeMs: number | null }> {
    const r = await readIfExists(this.shoppingFile(week));
    if (!r) return { ...ShoppingListSchema.parse({ week }), mtimeMs: null };
    const doc = parseDoc(r.text);
    // the body is a readable checklist; ticking a box in a text editor is honoured too
    const list = validate(() => ShoppingListSchema.parse({ ...doc.data, week }));
    const ticks = new Map<string, boolean>();
    for (const m of doc.body.matchAll(/^- \[([ xX])\] .*?<!--(.+?)-->\s*$/gm)) ticks.set(m[2], m[1] !== " ");
    list.items = list.items.map((i) => (ticks.has(i.key) ? { ...i, checked: ticks.get(i.key)! } : i));
    return { ...list, mtimeMs: r.mtimeMs };
  }

  async saveShoppingList(list: ShoppingList): Promise<ShoppingList & { mtimeMs: number | null }> {
    return this.mutex.run(`shopping:${list.week}`, async () => {
      const clean = validate(() => ShoppingListSchema.parse(list));
      const file = this.shoppingFile(clean.week);
      const r = await readIfExists(file);
      const doc = r ? parseDoc(r.text) : undefined;
      await atomicWrite(file, stringifyDoc(clean as Record<string, unknown>, renderShoppingBody(clean), doc));
      this.bump({ kind: "shopping", id: clean.week }, `Updated shopping list ${clean.week}`);
      return this.getShoppingList(clean.week);
    });
  }
}

function renderFoodsBody(foods: Food[]): string {
  const rows = foods.map((f) => {
    const n = f.per100g;
    const flag = f.source === "ai" ? " ?" : "";
    return `| ${f.name}${flag} | ${n.calories ?? "—"} | ${n.proteinG ?? "—"} | ${n.carbsG ?? "—"} | ${n.fatG ?? "—"} |`;
  });
  return [
    "<!-- Generated from the frontmatter above. Edit the `foods:` list (or use the app); edits below this line are overwritten. -->",
    "",
    "# Nutrition database",
    "",
    'Values are per 100 g. A "?" marks values filled in by an AI model that nobody has checked yet.',
    "",
    "| Food | kcal | Protein g | Carbs g | Fat g |",
    "|------|------|-----------|---------|-------|",
    ...rows,
    "",
  ].join("\n");
}
