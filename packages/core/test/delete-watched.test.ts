import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { sleep, tempStore } from "./helpers";

// On Windows a folder that the file watcher is watching can refuse to be renamed. Deleting and renaming must still work
// while the app is running (watching), not only in tests where the watcher is off.

let ctx: Awaited<ReturnType<typeof tempStore>>;
afterEach(async () => ctx?.cleanup());

const jpg = () => sharp({ create: { width: 200, height: 200, channels: 3, background: "#cc5533" } }).jpeg().toBuffer();

describe("moving folders while the watcher is running", () => {
  it("deletes a recipe that has images", async () => {
    ctx = await tempStore({ watch: true });
    const r = await ctx.store.createRecipe({ title: "Soup", ingredientsMd: "- 1 onion", methodMd: "1. Boil" });
    await ctx.store.addImage(r.slug, { data: await jpg(), originalName: "a.jpg", kind: "hero" });
    await sleep(700); // let the watcher settle on the new folder
    await ctx.store.deleteRecipe(r.slug);
    expect(ctx.store.getRecipe(r.slug)).toBeUndefined();
    await expect(fs.stat(path.join(ctx.dir, "recipes", r.slug))).rejects.toThrow();
    expect((await fs.readdir(path.join(ctx.dir, ".trash"))).length).toBe(1);
  });

  it("renames a recipe folder", async () => {
    ctx = await tempStore({ watch: true });
    const r = await ctx.store.createRecipe({ title: "Soup", ingredientsMd: "- 1 onion", methodMd: "1. Boil" });
    await sleep(700);
    const moved = await ctx.store.renameSlug(r.slug, "pumpkin-soup");
    expect(moved.slug).toBe("pumpkin-soup");
    expect(ctx.store.getRecipe("soup")).toBeUndefined();
  });

  it("deletes a saved photo", async () => {
    ctx = await tempStore({ watch: true });
    const p = await ctx.store.photos.create({ name: "Throwaway", files: [{ data: await jpg(), name: "t.jpg" }] });
    await ctx.store.photos.thumbnail(p.id, "page-1.jpg", 200); // as the list page does
    await sleep(700);
    await ctx.store.photos.delete(p.id);
    expect(await ctx.store.photos.get(p.id)).toBeNull();
    expect((await fs.readdir(path.join(ctx.dir, ".trash"))).length).toBe(1);
  });
});
