import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export class ConflictError extends Error {
  constructor(public file: string) {
    super(`${path.basename(path.dirname(file))}/${path.basename(file)} was changed on disk since it was loaded`);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(message: string, public details?: unknown) {
    super(message);
    this.name = "ValidationError";
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readIfExists(p: string): Promise<{ text: string; mtimeMs: number } | null> {
  try {
    const [text, st] = await Promise.all([fs.readFile(p, "utf8"), fs.stat(p)]);
    return { text, mtimeMs: st.mtimeMs };
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Write a file atomically (temp file + rename). If `expectedMtimeMs` is given and the file on disk has
 * a different modified time, nothing is written and a ConflictError is thrown.
 */
export async function atomicWrite(file: string, content: string | Buffer, expectedMtimeMs?: number | null): Promise<number> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (expectedMtimeMs !== undefined && expectedMtimeMs !== null) {
    try {
      const st = await fs.stat(file);
      if (Math.abs(st.mtimeMs - expectedMtimeMs) > 1) throw new ConflictError(file);
    } catch (e: any) {
      if (e instanceof ConflictError) throw e;
      if (e.code !== "ENOENT") throw e;
    }
  }
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, content);
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      await fs.rename(tmp, file);
      return (await fs.stat(file)).mtimeMs;
    } catch (e: any) {
      lastErr = e;
      // Windows can briefly lock the target (antivirus, file watchers)
      if (e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES") await new Promise((r) => setTimeout(r, 40 * (i + 1)));
      else break;
    }
  }
  await fs.rm(tmp, { force: true });
  throw lastErr;
}

/**
 * Move a folder. On Windows a folder that is open elsewhere (the file watcher, a thumbnail being read, antivirus) can refuse
 * to be renamed with EPERM/EBUSY, so: let go of it first (`release`), retry a few times, and as a last resort copy then delete.
 */
export async function moveDir(src: string, dest: string, release?: () => Promise<unknown> | unknown): Promise<void> {
  await release?.();
  let last: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (e: any) {
      last = e;
      if (!["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 60 * (i + 1)));
    }
  }
  try {
    await fs.cp(src, dest, { recursive: true, errorOnExist: true });
    await fs.rm(src, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => undefined); // don't leave half a copy behind
    throw last;
  }
}

export function slugify(input: string): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return s || "recipe";
}

/** Returns slug, slug-2, slug-3 ... whichever is not a folder in `dir` yet. */
export async function uniqueSlug(dir: string, base: string): Promise<string> {
  let slug = slugify(base);
  let n = 1;
  while (await exists(path.join(dir, slug))) {
    n++;
    slug = `${slugify(base)}-${n}`;
  }
  return slug;
}

export function safeFileName(name: string): string {
  const ext = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const base = slugify(path.basename(name, path.extname(name)));
  return `${base}${ext}`;
}

/** Make sure `child` is inside `parent` (blocks "../" tricks). */
export function insideDir(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Serialises async work per key (e.g. per recipe) so read-modify-write cycles don't interleave. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}

export function nowIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
