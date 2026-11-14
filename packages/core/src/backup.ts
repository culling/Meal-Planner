import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

/** Folders inside the data folder that are rebuilt automatically or are history, not your data. */
const SKIP = new Set([".git", ".cache", ".trash"]);
/** Already-compressed files are stored as-is; deflating them again only costs time. */
const STORED = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".avif", ".zip", ".pdf", ".mp4"]);

export interface BackupOptions {
  /** the app's .env file (server options); included under config/ when it exists */
  envFile?: string | null;
  /** used for the folder name inside the zip and the readme; defaults to now */
  now?: Date;
}

export interface BackupResult {
  /** suggested download name, e.g. meal-planner-backup-2026-11-15.zip */
  fileName: string;
  zip: Buffer;
  counts: { recipes: number; mealPlans: number; shoppingLists: number; photos: number; files: number };
}

interface Entry {
  name: string;
  data: Buffer;
  mtime: Date;
}

/**
 * Zip up everything you'd need to restore the app: recipes (with their images), meal plans, shopping lists,
 * saved photos, the nutrition database, settings, and the .env config. Laid out as
 *   meal-planner-backup-YYYY-MM-DD/README.txt
 *   meal-planner-backup-YYYY-MM-DD/data/...      (same layout as the data folder)
 *   meal-planner-backup-YYYY-MM-DD/config/.env
 */
export async function buildBackup(dataDir: string, opts: BackupOptions = {}): Promise<BackupResult> {
  const now = opts.now ?? new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const root = `meal-planner-backup-${stamp}`;
  const entries: Entry[] = [];

  const walk = async (dir: string, rel: string) => {
    let items: import("node:fs").Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) {
      if (!rel && SKIP.has(it.name)) continue;
      if (it.name.endsWith(".tmp")) continue;
      const full = path.join(dir, it.name);
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) await walk(full, r);
      else if (it.isFile()) {
        const [data, st] = await Promise.all([fs.readFile(full), fs.stat(full)]);
        entries.push({ name: `${root}/data/${r}`, data, mtime: st.mtime });
      }
    }
  };
  await walk(dataDir, "");

  const dataNames = entries.map((e) => e.name.slice(root.length + "/data/".length));
  const counts = {
    recipes: dataNames.filter((n) => /^recipes\/[^/]+\/recipe\.md$/.test(n)).length,
    mealPlans: dataNames.filter((n) => /^meal-plans\/[^/]+\.md$/.test(n)).length,
    shoppingLists: dataNames.filter((n) => /^shopping-lists\/[^/]+\.md$/.test(n)).length,
    photos: dataNames.filter((n) => /^photos\/[^/]+\/photo\.md$/.test(n)).length,
    files: 0,
  };

  let hasEnv = false;
  if (opts.envFile) {
    try {
      const [data, st] = await Promise.all([fs.readFile(opts.envFile), fs.stat(opts.envFile)]);
      entries.push({ name: `${root}/config/.env`, data, mtime: st.mtime });
      hasEnv = true;
    } catch {
      /* no .env — the app runs on defaults */
    }
  }

  const readme = [
    `Meal Planner backup - made ${now.toLocaleString("en-NZ")}`,
    "",
    `  ${counts.recipes} recipes`,
    `  ${counts.mealPlans} meal plans (weeks)`,
    `  ${counts.shoppingLists} shopping lists`,
    `  ${counts.photos} saved photos`,
    "",
    "What's inside",
    "  data/                  everything from the app's data folder, in the same layout:",
    "    recipes/<name>/        recipe.md (the recipe) and images/",
    "    meal-plans/            one file per week, e.g. 2026-W42.md",
    "    shopping-lists/        one file per week",
    "    photos/                photos of recipes saved to read later",
    "    nutrition-db.md        the nutrition database",
    "    settings.md            the choices from the Settings page",
    hasEnv ? "  config/.env            server options (data folder, port, Ollama address)" : "  (there was no .env file, so the app was using its default server options)",
    "",
    "To restore",
    "  1. Stop the app.",
    "  2. Copy the contents of data/ into the app's data folder (by default the \"data\" folder next to start.bat).",
    ...(hasEnv ? ["  3. If you need the server options back, copy config/.env next to start.bat."] : []),
    `  ${hasEnv ? 4 : 3}. Start the app again.`,
    "",
    "Everything is plain text (Markdown) and images, so you can also open the files in any editor.",
    "Not included: the version history (.git), deleted items (.trash) and caches (.cache); none are needed to restore.",
    "",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\r\n");
  entries.unshift({ name: `${root}/README.txt`, data: Buffer.from(readme, "utf8"), mtime: now });

  counts.files = entries.length;
  return { fileName: `${root}.zip`, zip: writeZip(entries), counts };
}

// ---------- a minimal zip writer (no dependencies) ----------

function dosDateTime(d: Date) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function writeZip(entries: Entry[]): Buffer {
  if (entries.length > 0xffff) throw new Error("Too many files for one backup zip");
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const store = STORED.has(path.extname(e.name).toLowerCase());
    const body = store ? e.data : zlib.deflateRawSync(e.data, { level: 6 });
    const method = store ? 0 : 8;
    const crc = zlib.crc32(e.data) >>> 0;
    const { time, date } = dosDateTime(e.mtime);
    if (offset + body.length > 0xfffffff0) throw new Error("Backup is too large for a zip file");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);

    chunks.push(local, name, body);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

/** Read a zip made by buildBackup back into { name: contents } (used by tests). */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error("Not a zip file");
  const count = zip.readUInt16LE(endAt + 10);
  let p = zip.readUInt32LE(endAt + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(dataAt, dataAt + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
