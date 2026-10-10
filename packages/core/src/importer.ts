import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { cleanPageText, draftFromHtml } from "./jsonld";
import { draftFromAi, ocrWithLightOn, storageFromNotesWithAi, structureFromImages, structureFromText } from "./extract";
import { ValidationError, nowIso } from "./fsutil";
import { mentionsStorage, parseStorageNotes, leftoversFromFacts } from "./leftover-notes";
import type { JobManager } from "./jobs";
import type { OllamaClient } from "./ollama";
import type { Photo, Recipe, RecipeDraft } from "./schemas";
import type { DataStore } from "./store";
import { ImportError, type PoliteFetcher } from "./webfetch";

export interface UrlImportResult {
  draft: RecipeDraft;
  /** slug of an existing recipe with the same source URL */
  duplicateOf: string | null;
}

export interface BookInfo {
  title?: string | null;
  author?: string | null;
  page?: string | number | null;
}

/** Pick a different way of reading for one go (the saved settings are not changed). */
export interface ReadOptions {
  provider?: "ollama" | "lightonocr";
  /** vision model for "ollama", text model for "lightonocr" */
  model?: string;
}

export interface BulkResultItem {
  url: string;
  status: "draft" | "saved" | "skipped" | "failed";
  message?: string;
  slug?: string;
  draft?: RecipeDraft;
}

function normaliseUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.hash = "";
  return u.toString();
}

export class Importer {
  constructor(
    private store: DataStore,
    private ollama: OllamaClient,
    private fetcher: PoliteFetcher,
    private jobs: JobManager,
  ) {}

  private get uploadsDir() {
    return path.join(this.store.cacheDir, "uploads");
  }

  uploadPath(uploadId: string, file: string): string {
    if (!/^[a-f0-9]{8,32}$/.test(uploadId) || file.includes("/") || file.includes("\\") || file.includes("..")) throw new ValidationError("Bad upload path");
    return path.join(this.uploadsDir, uploadId, file);
  }

  findBySourceUrl(url: string): Recipe | undefined {
    let norm: string;
    try {
      norm = normaliseUrl(url);
    } catch {
      return undefined;
    }
    return this.store.listRecipes().find((r) => r.meta.source.url && safeNorm(r.meta.source.url) === norm);
  }

  // ---------- URL ----------

  async fromUrl(rawUrl: string): Promise<UrlImportResult> {
    let url: string;
    try {
      url = normaliseUrl(rawUrl);
    } catch {
      throw new ImportError(`That doesn't look like a URL: ${rawUrl}`);
    }
    const dup = this.findBySourceUrl(url);
    const settings = this.store.getSettings();
    const html = await this.fetcher.html(url);

    let draft: RecipeDraft;
    let imageUrl: string | null = null;
    const parsed = draftFromHtml(html, url, { fridgeDays: settings.defaultLeftoverFridgeDays });
    if (parsed) {
      draft = parsed.draft;
      imageUrl = parsed.imageUrl;
      // patterns found nothing but the notes talk about storage: ask the local model to read it (no guessing)
      if (draft.sourceNotes && draft.leftovers?.source === "estimated" && mentionsStorage(draft.sourceNotes)) {
        const facts = await storageFromNotesWithAi(this.ollama, settings.extraction.textModel, draft.sourceNotes);
        if (facts && (facts.fridgeDays != null || facts.freezerDays != null || facts.freezable != null)) {
          draft.leftovers = leftoversFromFacts({ ...facts, reheatNotes: parseStorageNotes(draft.sourceNotes).reheatNotes }, settings.defaultLeftoverFridgeDays);
          draft.warnings = draft.warnings.filter((w) => !/leftovers keep|storage times/.test(w));
          draft.warnings.push("Storage times were read from the notes by the local AI model — worth a glance.");
        }
      }
    } else {
      // no structured data: let the local model read the page text
      const text = cleanPageText(html);
      if (text.length < 200) throw new ImportError("That page doesn't look like it contains a recipe.");
      const ai = await structureFromText(this.ollama, settings.extraction.textModel, text, "a recipe web page");
      draft = draftFromAi(
        ai,
        { source: { type: "web", url, site: new URL(url).hostname.replace(/^www\./, ""), author: null, book: null, importedAt: null }, uploadId: null, uploadedImages: [] },
        settings,
        "page",
      );
      draft.warnings.unshift("This page has no recipe data, so the local AI model read the text — check everything carefully.");
      for (const k of Object.keys(draft.confidence)) draft.confidence[k] = "low";
    }
    draft.source.importedAt = nowIso();

    if (imageUrl) {
      try {
        const uploadId = crypto.randomBytes(6).toString("hex");
        const buf = await this.fetcher.binary(new URL(imageUrl, url).toString());
        const jpg = await sharp(buf, { failOn: "none" }).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
        await fs.mkdir(path.join(this.uploadsDir, uploadId), { recursive: true });
        await fs.writeFile(path.join(this.uploadsDir, uploadId, "hero.jpg"), jpg);
        draft.uploadId = uploadId;
        draft.uploadedImages = [{ file: "hero.jpg", kind: "hero" }];
      } catch (e) {
        draft.warnings.push(`Couldn't download the photo (${(e as Error).message}).`);
      }
    }
    if (dup) draft.warnings.unshift(`This URL was already imported as "${dup.meta.title}".`);
    return { draft, duplicateOf: dup?.slug ?? null };
  }

  /** Import a pasted list of URLs, one at a time, politely. */
  startBulk(urls: string[], opts: { saveDirectly: boolean }) {
    const list = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
    return this.jobs.start(`Importing ${list.length} URL${list.length === 1 ? "" : "s"}`, async ({ progress }) => {
      const results: BulkResultItem[] = [];
      for (const [i, url] of list.entries()) {
        progress(`(${i + 1}/${list.length}) ${url}`);
        try {
          const dup = this.findBySourceUrl(url);
          if (dup) {
            results.push({ url, status: "skipped", message: `Already imported as "${dup.meta.title}"`, slug: dup.slug });
            continue;
          }
          const { draft } = await this.fromUrl(url);
          if (opts.saveDirectly) {
            const recipe = await this.confirm(draft);
            results.push({ url, status: "saved", slug: recipe.slug, message: draft.title });
          } else {
            results.push({ url, status: "draft", draft, message: draft.title });
          }
        } catch (e) {
          results.push({ url, status: "failed", message: (e as Error).message });
        }
      }
      const count = (s: string) => results.filter((r) => r.status === s).length;
      progress(`Done: ${count("saved") + count("draft")} imported, ${count("skipped")} skipped, ${count("failed")} failed`);
      return { results };
    });
  }

  // ---------- photos ----------

  /** Turn page images into structured recipe data with the chosen (or configured) model. */
  private async extract(buffers: Buffer[], progress: (m: string) => void, opts: ReadOptions = {}, id = "page") {
    const settings = this.store.getSettings();
    const provider = opts.provider ?? settings.extraction.provider;
    if (provider === "lightonocr") {
      const ocrDir = this.store.cfg.lightOnOcrDir;
      if (!ocrDir) throw new ValidationError("LIGHTONOCR_DIR isn't set in .env");
      const texts: string[] = [];
      for (const [i, b] of buffers.entries()) {
        progress(`Running LightOnOCR on page ${i + 1} of ${buffers.length}…`);
        texts.push(await ocrWithLightOn(ocrDir, b));
      }
      const text = texts.join("\n\n--- next page ---\n\n");
      await fs.mkdir(path.join(this.store.cacheDir, "ocr"), { recursive: true });
      await fs.writeFile(path.join(this.store.cacheDir, "ocr", `${id}.txt`), text);
      const model = opts.model ?? settings.extraction.textModel;
      progress(`Structuring the text with ${model}…`);
      return structureFromText(this.ollama, model, text, "OCR of a cookbook recipe (may contain recognition errors)");
    }
    const model = opts.model ?? settings.extraction.visionModel;
    progress(`Reading the photo${buffers.length > 1 ? "s" : ""} with ${model}… (this can take a minute or two)`);
    return structureFromImages(this.ollama, model, buffers);
  }

  /** Read one or more photos handed in directly (nothing is kept unless you save the result). Used by the MCP tool. */
  startImageImport(files: { data: Buffer; name: string }[], book: BookInfo, opts: ReadOptions = {}) {
    if (!files.length) throw new ValidationError("Add at least one photo");
    return this.jobs.start("Reading recipe photo" + (files.length > 1 ? "s" : ""), async ({ progress }) => {
      const settings = this.store.getSettings();
      const uploadId = crypto.randomBytes(6).toString("hex");
      const dir = path.join(this.uploadsDir, uploadId);
      await fs.mkdir(dir, { recursive: true });
      const saved: { file: string; kind: "source-page" }[] = [];
      for (const [i, f] of files.entries()) {
        const jpg = await sharp(f.data, { failOn: "none" })
          .rotate()
          .resize({ width: 3000, height: 3000, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 90 })
          .toBuffer()
          .catch((e) => {
            throw new ValidationError(`Couldn't read "${f.name}" as an image (${e.message}). HEIC photos may need converting to JPEG first.`);
          });
        const file = `source-page-${i + 1}.jpg`;
        await fs.writeFile(path.join(dir, file), jpg);
        saved.push({ file, kind: "source-page" });
      }
      const buffers = await Promise.all(saved.map((s) => fs.readFile(path.join(dir, s.file))));
      const ai = await this.extract(buffers, progress, opts, uploadId);
      progress("Building the draft…");
      const hasBook = book.title || book.author || book.page;
      const draft = draftFromAi(
        ai,
        { source: { type: "book", url: null, site: null, author: book.author ?? null, book: hasBook ? { title: book.title ?? null, author: book.author ?? null, page: book.page ?? null } : null, importedAt: nowIso() }, uploadId, uploadedImages: saved },
        settings,
        "ocr",
      );
      if (!hasBook) draft.warnings.push("Add the book title and page so you can find the original later.");
      return { draft };
    });
  }

  private bookSource(photo: Photo) {
    return {
      type: "book" as const,
      url: null,
      site: null,
      author: photo.book?.author ?? null,
      book: photo.book && (photo.book.title || photo.book.author || photo.book.page) ? { title: photo.book.title, author: photo.book.author, page: photo.book.page } : null,
      importedAt: nowIso(),
    };
  }

  /** Read a saved photo (now or whenever you like), with the configured model or one you choose. The draft is remembered. */
  startPhotoRead(photoId: string, opts: ReadOptions = {}) {
    return this.jobs.start(`Reading “${photoId}”`, async ({ progress }) => {
      const photo = await this.store.photos.require(photoId);
      const settings = this.store.getSettings();
      const buffers = await Promise.all(photo.images.map((f) => fs.readFile(this.store.photos.imagePath(photoId, f))));
      const ai = await this.extract(buffers, progress, opts, `photo-${photoId}`);
      progress("Building the draft…");
      const draft = draftFromAi(ai, { source: this.bookSource(photo), uploadId: null, uploadedImages: [] }, settings, "ocr");
      draft.photoId = photoId;
      if (photo.notes.trim()) draft.sourceNotes = [draft.sourceNotes, photo.notes.trim()].filter(Boolean).join("\n\n");
      if (!draft.source.book) draft.warnings.push("Add the book title and page so you can find the original later.");
      await fs.mkdir(path.dirname(this.store.photos.draftFile(photoId)), { recursive: true });
      await fs.writeFile(this.store.photos.draftFile(photoId), JSON.stringify({ draft, readAt: nowIso(), model: opts.model ?? null, provider: opts.provider ?? settings.extraction.provider }));
      return { draft };
    });
  }

  /** The draft from the last time this photo was read, if there is one. */
  async getPhotoDraft(photoId: string): Promise<{ draft: RecipeDraft; readAt: string; model: string | null; provider: string } | null> {
    try {
      return JSON.parse(await fs.readFile(this.store.photos.draftFile(photoId), "utf8"));
    } catch {
      return null;
    }
  }

  /** An empty recipe to type into, with the photo shown beside it. */
  async blankPhotoDraft(photoId: string): Promise<RecipeDraft> {
    const photo = await this.store.photos.require(photoId);
    return {
      title: photo.name,
      servings: null,
      servingDescription: null,
      times: { prepMinutes: null, cookMinutes: null, totalMinutes: null },
      ingredientsMd: "",
      methodMd: "",
      sourceNotes: photo.notes,
      tags: [],
      cuisine: null,
      course: [],
      diet: [],
      nutrition: null,
      leftovers: null,
      source: this.bookSource(photo),
      uploadId: null,
      uploadedImages: [],
      photoId,
      confidence: {},
      warnings: ["Type the recipe in, using the photo beside the form."],
    };
  }

  // ---------- save ----------

  async confirm(draft: RecipeDraft): Promise<Recipe> {
    if (!draft.title?.trim()) throw new ValidationError("The recipe needs a title");
    const now = nowIso();
    const recipe = await this.store.createRecipe({
      title: draft.title,
      servings: draft.servings,
      servingDescription: draft.servingDescription,
      times: draft.times,
      tags: draft.tags,
      cuisine: draft.cuisine,
      course: draft.course,
      diet: draft.diet,
      source: { ...draft.source, importedAt: draft.source.importedAt ?? now },
      nutrition: draft.nutrition
        ? { perServing: draft.nutrition.perServing, source: draft.nutrition.source, confidence: draft.nutrition.confidence, calculatedAt: null, breakdown: [] }
        : undefined,
      leftovers: draft.leftovers ?? undefined,
      ingredientsMd: draft.ingredientsMd,
      methodMd: draft.methodMd,
      sourceNotes: draft.sourceNotes,
    });
    let result = recipe;
    if (draft.uploadId) {
      for (const img of draft.uploadedImages) {
        try {
          const data = await fs.readFile(this.uploadPath(draft.uploadId, img.file));
          const r = await this.store.addImage(recipe.slug, { data, originalName: img.file, kind: img.kind === "hero" ? "hero" : img.kind, maxEdge: img.kind === "source-page" ? 3000 : 2400 });
          result = r.recipe;
        } catch {
          /* a missing temp image shouldn't lose the recipe */
        }
      }
      await fs.rm(path.join(this.uploadsDir, draft.uploadId), { recursive: true, force: true });
    }
    if (draft.photoId) {
      const photo = await this.store.photos.get(draft.photoId);
      if (photo) {
        for (const file of photo.images) {
          try {
            result = (await this.store.addImage(recipe.slug, { data: await fs.readFile(this.store.photos.imagePath(photo.id, file)), originalName: file, kind: "source-page", maxEdge: 3000 })).recipe;
          } catch {
            /* keep the recipe even if a page can't be copied */
          }
        }
        await this.store.photos.markDone(photo.id, recipe.slug);
        await fs.rm(this.store.photos.draftFile(photo.id), { force: true });
      }
    }
    return result;
  }
}

function safeNorm(u: string): string | null {
  try {
    return normaliseUrl(u);
  } catch {
    return null;
  }
}
