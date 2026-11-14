import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBackup, readZip } from "../src/backup";

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function put(rel: string, data: string | Buffer) {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}

describe("buildBackup", () => {
  it("zips the data folder and .env into one organised folder, skipping history and caches", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mp-backup-"));
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
    await put("data/recipes/soup/recipe.md", "---\ntitle: Soup ✓\n---\n");
    await put("data/recipes/soup/images/hero.jpg", jpg);
    await put("data/meal-plans/2026-W42.md", "plan");
    await put("data/shopping-lists/2026-W42.md", "list");
    await put("data/photos/page/photo.md", "photo");
    await put("data/nutrition-db.md", "foods");
    await put("data/settings.md", "settings");
    await put("data/.git/HEAD", "ref");
    await put("data/.cache/thumbs/x.jpg", jpg);
    await put("data/.trash/old/recipe.md", "gone");
    await put("data/recipes/soup/recipe.md.tmp", "partial");
    await put(".env", "PORT=3456\n");

    const res = await buildBackup(path.join(dir, "data"), { envFile: path.join(dir, ".env"), now: new Date(2026, 10, 15, 9, 30) });
    expect(res.fileName).toBe("meal-planner-backup-2026-11-15.zip");
    expect(res.counts).toMatchObject({ recipes: 1, mealPlans: 1, shoppingLists: 1, photos: 1 });

    const files = readZip(res.zip);
    const root = "meal-planner-backup-2026-11-15/";
    expect([...files.keys()].sort()).toEqual(
      [
        "README.txt",
        "config/.env",
        "data/meal-plans/2026-W42.md",
        "data/nutrition-db.md",
        "data/photos/page/photo.md",
        "data/recipes/soup/images/hero.jpg",
        "data/recipes/soup/recipe.md",
        "data/settings.md",
        "data/shopping-lists/2026-W42.md",
      ].map((n) => root + n).sort(),
    );
    expect(files.get(root + "data/recipes/soup/recipe.md")!.toString("utf8")).toContain("Soup ✓");
    expect(files.get(root + "data/recipes/soup/images/hero.jpg")!.equals(jpg)).toBe(true);
    expect(files.get(root + "config/.env")!.toString()).toBe("PORT=3456\n");
    expect(files.get(root + "README.txt")!.toString()).toContain("1 recipes");
  });

  it("works without a .env file", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mp-backup-"));
    await put("data/settings.md", "settings");
    const res = await buildBackup(path.join(dir, "data"), { envFile: path.join(dir, "missing.env") });
    const names = [...readZip(res.zip).keys()];
    expect(names.some((n) => n.endsWith("config/.env"))).toBe(false);
    expect(names.some((n) => n.endsWith("data/settings.md"))).toBe(true);
  });
});
