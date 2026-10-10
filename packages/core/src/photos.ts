import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { parseDoc, stringifyDoc } from "./frontmatter";
import { KeyedMutex, NotFoundError, ValidationError, atomicWrite, exists, insideDir, moveDir, nowIso, readIfExists, slugify } from "./fsutil";
import { PhotoSchema, type Photo } from "./schemas";

/** "IMG_2043", "PXL_20261009_031522.jpg", "DSC00012" and similar camera names aren't worth keeping as a title. */
export function nameFromFile(file: string, now = new Date()): string {
  const base = path.basename(file, path.extname(file)).replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  const compact = base.toLowerCase().replace(/[\s._-]+/g, "");
  const cameraLike = !base || /^(img|pxl|dsc|dscn|image|photo|mvimg|screenshot|scan|pano|wp|signal)?\d{4,}[a-z]{0,6}$/.test(compact) || /^(image|photo|picture|untitled|scan|img)\d{0,3}$/.test(compact);
  if (!cameraLike) return base;
  return `Photo ${now.toLocaleDateString("en-NZ", { day: "numeric", month: "short" })} ${now.toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" })}`;
}

export interface PhotoFile {
  data: Buffer;
  name: string;
}

/**
 * Photos of recipes that are saved first and read later (or typed in by hand). Each lives in its own folder:
 *   photos/<id>/photo.md       name, book, notes, status (frontmatter) + a readable body
 *   photos/<id>/images/page-1.jpg …
 * Nothing here needs an AI model, so a photo is never lost if reading fails or the model changes.
 */
export class PhotoStore {
  private mutex = new KeyedMutex();

  constructor(
    private dir: string,
    private trashDir: string,
    private cacheDir: string,
    private onChange: (id: string, reason: string) => void,
    /** moves a folder (the data store pauses its file watcher around it, which Windows needs) */
    private move: (src: string, dest: string) => Promise<void> = (src, dest) => moveDir(src, dest),
  ) {}

  private folder(id: string) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new ValidationError(`Invalid photo id: ${id}`);
    return path.join(this.dir, id);
  }
  private file(id: string) {
    return path.join(this.folder(id), "photo.md");
  }

  imagePath(id: string, file: string): string {
    const full = path.join(this.folder(id), "images", file);
    if (!insideDir(path.join(this.folder(id), "images"), full)) throw new ValidationError("Bad image path");
    return full;
  }

  async list(): Promise<Photo[]> {
    const entries = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const out: Photo[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(e.name)) continue;
      const p = await this.get(e.name).catch(() => null);
      if (p) out.push(p);
    }
    return out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }

  async get(id: string): Promise<Photo | null> {
    const r = await readIfExists(this.file(id));
    if (!r) return null;
    const doc = parseDoc(r.text);
    const photo = PhotoSchema.parse({ ...doc.data, id, name: doc.data.name ?? id });
    // a page deleted from disk by hand shouldn't linger in the list
    const present: string[] = [];
    for (const f of photo.images) if (await exists(path.join(this.folder(id), "images", f))) present.push(f);
    return { ...photo, images: present };
  }

  async require(id: string): Promise<Photo> {
    const p = await this.get(id);
    if (!p) throw new NotFoundError(`Photo "${id}"`);
    return p;
  }

  private async savePages(id: string, files: PhotoFile[], existing: string[]): Promise<string[]> {
    const imagesDir = path.join(this.folder(id), "images");
    await fs.mkdir(imagesDir, { recursive: true });
    const names = [...existing];
    let n = names.reduce((m, f) => Math.max(m, Number(f.match(/^page-(\d+)/)?.[1] ?? 0)), 0);
    for (const f of files) {
      let jpg: Buffer;
      try {
        // rotate by the camera's orientation, cap the size (still plenty to read small print), store as JPEG
        jpg = await sharp(f.data, { failOn: "none" }).rotate().resize({ width: 3000, height: 3000, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
      } catch (e) {
        throw new ValidationError(`Couldn't read "${f.name}" as a picture (${(e as Error).message}). HEIC photos aren't supported — JPEG, PNG and WebP are.`);
      }
      const name = `page-${++n}.jpg`;
      await atomicWrite(path.join(imagesDir, name), jpg);
      names.push(name);
    }
    return names;
  }

  private async write(photo: Photo): Promise<Photo> {
    const body = [
      "<!-- A photo of a recipe, kept until it's turned into a recipe. Edit the frontmatter above; the text below is regenerated. -->",
      "",
      `# ${photo.name}`,
      "",
      ...photo.images.map((f) => `![${photo.name}](images/${f})`),
      "",
      photo.notes ? photo.notes : "",
    ].join("\n");
    const r = await readIfExists(this.file(photo.id));
    const doc = r ? parseDoc(r.text) : undefined;
    await atomicWrite(this.file(photo.id), stringifyDoc(photo as unknown as Record<string, unknown>, body, doc));
    return photo;
  }

  async create(input: { name?: string; files: PhotoFile[]; book?: Photo["book"]; notes?: string }): Promise<Photo> {
    if (!input.files.length) throw new ValidationError("Add at least one photo");
    const name = (input.name?.trim() || nameFromFile(input.files[0].name)).slice(0, 120);
    let id = slugify(name);
    for (let n = 2; await exists(this.folder(id)); n++) id = `${slugify(name)}-${n}`;
    return this.mutex.run(id, async () => {
      const images = await this.savePages(id, input.files, []);
      const now = nowIso();
      const photo = PhotoSchema.parse({ id, name, status: "waiting", book: input.book ?? null, notes: input.notes ?? "", recipe: null, images, createdAt: now, updatedAt: now });
      await this.write(photo);
      this.onChange(id, `Saved photo ${id}`);
      return photo;
    });
  }

  async update(id: string, patch: { name?: string; book?: Photo["book"]; notes?: string }): Promise<Photo> {
    return this.mutex.run(id, async () => {
      const cur = await this.require(id);
      const next = PhotoSchema.parse({
        ...cur,
        ...(patch.name !== undefined ? { name: patch.name.trim() || cur.name } : {}),
        ...(patch.book !== undefined ? { book: patch.book } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        updatedAt: nowIso(),
      });
      await this.write(next);
      this.onChange(id, `Edited photo ${id}`);
      return next;
    });
  }

  async addPages(id: string, files: PhotoFile[]): Promise<Photo> {
    return this.mutex.run(id, async () => {
      const cur = await this.require(id);
      const images = await this.savePages(id, files, cur.images);
      const next = await this.write({ ...cur, images, updatedAt: nowIso() });
      this.onChange(id, `Added pages to photo ${id}`);
      return next;
    });
  }

  async removePage(id: string, file: string): Promise<Photo> {
    return this.mutex.run(id, async () => {
      const cur = await this.require(id);
      if (!cur.images.includes(file)) throw new NotFoundError("That page");
      if (cur.images.length === 1) throw new ValidationError("A photo needs at least one page — delete the whole photo instead");
      await fs.rm(this.imagePath(id, file), { force: true });
      const next = await this.write({ ...cur, images: cur.images.filter((f) => f !== file), updatedAt: nowIso() });
      this.onChange(id, `Removed a page from photo ${id}`);
      return next;
    });
  }

  async markDone(id: string, recipe: string): Promise<Photo> {
    return this.mutex.run(id, async () => {
      const cur = await this.require(id);
      const next = await this.write({ ...cur, status: "done", recipe, updatedAt: nowIso() });
      this.onChange(id, `Photo ${id} became recipe ${recipe}`);
      return next;
    });
  }

  async reopen(id: string): Promise<Photo> {
    return this.mutex.run(id, async () => {
      const cur = await this.require(id);
      const next = await this.write({ ...cur, status: "waiting", recipe: null, updatedAt: nowIso() });
      this.onChange(id, `Photo ${id} set back to waiting`);
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutex.run(id, async () => {
      await this.require(id);
      await fs.mkdir(this.trashDir, { recursive: true });
      let dest = path.join(this.trashDir, `photo-${id}-${new Date().toISOString().slice(0, 10)}`);
      for (let n = 2; await exists(dest); n++) dest += `-${n}`;
      await this.move(this.folder(id), dest);
      await fs.rm(path.join(this.cacheDir, "thumbs", "photos", id), { recursive: true, force: true });
      await fs.rm(this.draftFile(id), { force: true });
      this.onChange(id, `Deleted photo ${id}`);
    });
  }

  /** The draft produced the last time this photo was read (derived data: safe to lose, just read it again). */
  draftFile(id: string) {
    return path.join(this.cacheDir, "drafts", `photo-${id}.json`);
  }

  async thumbnail(id: string, file: string, width: number): Promise<string> {
    const src = this.imagePath(id, file);
    const w = Math.min(Math.max(Math.round(width / 40) * 40, 80), 2000);
    const dest = path.join(this.cacheDir, "thumbs", "photos", id, `${w}-${file.replace(/\.[^.]+$/, "")}.jpg`);
    const [s, d] = await Promise.all([fs.stat(src), fs.stat(dest).catch(() => null)]);
    if (d && d.mtimeMs >= s.mtimeMs) return dest;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await sharp(src, { failOn: "none" }).resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(dest);
    return dest;
  }
}
