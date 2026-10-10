import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Importer } from "../src/importer";
import { JobManager } from "../src/jobs";
import { nameFromFile } from "../src/photos";
import { tempStore } from "./helpers";

let ctx: Awaited<ReturnType<typeof tempStore>>;
let jpg: Buffer;
beforeEach(async () => {
  ctx = await tempStore();
  // a landscape picture tagged as rotated, like a phone photo
  jpg = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#eee" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
});
afterEach(async () => {
  await ctx.cleanup();
});

describe("naming photos", () => {
  it("keeps real names and replaces camera names", () => {
    expect(nameFromFile("Daal Curry.jpg")).toBe("Daal Curry");
    expect(nameFromFile("grandmas_apple_cake.png")).toBe("grandmas apple cake");
    for (const n of ["IMG_2043.jpg", "PXL_20261009_031522.jpg", "DSC00012.JPG", "20261009_031522.jpg", "image.jpeg"]) expect(nameFromFile(n)).toMatch(/^Photo /);
  });
});

describe("saved photos", () => {
  it("saves a photo with a name before anything is read, as plain files", async () => {
    const p = await ctx.store.photos.create({ name: "Daal Curry", files: [{ data: jpg, name: "x.jpg" }], book: { title: "Veggie", author: null, page: 240 } });
    expect(p).toMatchObject({ id: "daal-curry", name: "Daal Curry", status: "waiting", images: ["page-1.jpg"] });
    const md = await fs.readFile(path.join(ctx.dir, "photos", "daal-curry", "photo.md"), "utf8");
    expect(md).toContain("name: Daal Curry");
    expect(md).toContain("![Daal Curry](images/page-1.jpg)");
    const meta = await sharp(path.join(ctx.dir, "photos", "daal-curry", "images", "page-1.jpg")).metadata();
    expect(meta.width).toBe(400); // rotated upright using the camera's orientation
    expect(meta.height).toBe(800);
    expect((await ctx.store.photos.list()).map((x) => x.id)).toEqual(["daal-curry"]);
  });

  it("gives duplicate names their own folder, adds and removes pages, renames, deletes to the trash", async () => {
    const a = await ctx.store.photos.create({ name: "Soup", files: [{ data: jpg, name: "a.jpg" }] });
    const b = await ctx.store.photos.create({ name: "Soup", files: [{ data: jpg, name: "b.jpg" }] });
    expect([a.id, b.id]).toEqual(["soup", "soup-2"]);
    const two = await ctx.store.photos.addPages("soup", [{ data: jpg, name: "c.jpg" }]);
    expect(two.images).toEqual(["page-1.jpg", "page-2.jpg"]);
    expect((await ctx.store.photos.removePage("soup", "page-1.jpg")).images).toEqual(["page-2.jpg"]);
    await expect(ctx.store.photos.removePage("soup", "page-2.jpg")).rejects.toThrow(/at least one/);
    expect((await ctx.store.photos.update("soup", { name: "Pumpkin Soup", notes: "p. 12" })).name).toBe("Pumpkin Soup");
    await ctx.store.photos.delete("soup-2");
    expect(await ctx.store.photos.get("soup-2")).toBeNull();
    expect((await fs.readdir(path.join(ctx.dir, ".trash"))).some((f) => f.includes("soup-2"))).toBe(true);
  });

  it("rejects things that aren't pictures with a clear message", async () => {
    await expect(ctx.store.photos.create({ name: "x", files: [{ data: Buffer.from("not an image"), name: "x.heic" }] })).rejects.toThrow(/HEIC/);
  });

  it("is read later with a chosen model, remembered, and becomes a recipe with its pages attached", async () => {
    const calls: string[] = [];
    const ai = {
      title: "Tasty Daal Curry",
      servings: 4,
      prepMinutes: null,
      cookMinutes: null,
      totalMinutes: null,
      ingredientGroups: [{ group: "Daal", items: ["1 onion", "300g dried red split lentils"] }],
      methodSteps: ["Blitz the veg.", "Add the lentils."],
      notes: null,
      tags: [],
      cuisine: "Indian",
      nutritionPerServing: { calories: 696, proteinG: null, carbsG: null, fatG: null, saturatedFatG: null, fibreG: null, sugarG: null, sodiumMg: null },
      storage: null,
      confidence: { title: "high", servings: "high", times: "low", ingredients: "high", method: "high", nutrition: "high" },
    };
    const ollama = { chatJson: async (o: { model: string }) => (calls.push(o.model), ai) } as any;
    const jobs = new JobManager();
    const importer = new Importer(ctx.store, ollama, {} as any, jobs);
    await ctx.store.photos.create({ name: "Daal Curry", files: [{ data: jpg, name: "a.jpg" }], book: { title: "Veggie", author: "Someone", page: 240 } });

    const job = importer.startPhotoRead("daal-curry", { model: "my-better-model:9b" });
    for (let i = 0; i < 100 && jobs.get(job.id)!.status === "running"; i++) await new Promise((r) => setTimeout(r, 30));
    expect(jobs.get(job.id)!.error).toBeNull();
    expect(calls).toEqual(["my-better-model:9b"]); // not the saved setting
    const remembered = await importer.getPhotoDraft("daal-curry");
    expect(remembered?.draft.title).toBe("Tasty Daal Curry");
    expect(remembered?.draft.photoId).toBe("daal-curry");
    expect(remembered?.draft.source.book).toMatchObject({ title: "Veggie", page: 240 });
    expect(remembered?.model).toBe("my-better-model:9b");

    const recipe = await importer.confirm(remembered!.draft);
    expect(recipe.meta.images.gallery.map((g) => g.kind)).toEqual(["source-page"]);
    expect(recipe.meta.source.book?.title).toBe("Veggie");
    const photo = await ctx.store.photos.require("daal-curry");
    expect(photo).toMatchObject({ status: "done", recipe: recipe.slug });
    expect(await importer.getPhotoDraft("daal-curry")).toBeNull(); // the stored draft is cleaned up
  });

  it("can be typed in by hand beside the photo", async () => {
    const importer = new Importer(ctx.store, {} as any, {} as any, new JobManager());
    await ctx.store.photos.create({ name: "Grandma's Cake", files: [{ data: jpg, name: "a.jpg" }] });
    const draft = await importer.blankPhotoDraft("grandmas-cake");
    expect(draft).toMatchObject({ title: "Grandma's Cake", photoId: "grandmas-cake", ingredientsMd: "" });
    const recipe = await importer.confirm({ ...draft, ingredientsMd: "- 200 g flour", methodMd: "1. Bake" });
    expect(recipe.ingredients).toHaveLength(1);
    expect(recipe.meta.images.gallery).toHaveLength(1);
    expect((await ctx.store.photos.require("grandmas-cake")).recipe).toBe(recipe.slug);
  });
});
