import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { appReady, expect, isPhone, shot, test } from "./helpers";

// Saving photos of recipes (with a name), reading them now or later, and typing them in. No AI is used here:
// the reading step is replaced by a made-up answer so these tests are fast and don't need Ollama.
// Set LIVE_AI=1 to also run the one test that reads the real reference photo with your local model.

test.describe.configure({ mode: "serial" });

const picture = (title: string) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="100%" height="100%" fill="#f6f1e6"/><text x="60" y="140" font-size="56" font-family="Georgia">${title}</text><text x="60" y="260" font-size="34" font-family="Georgia">2 eggs · 200 g flour</text></svg>`)).jpeg().toBuffer();

const h1 = (page: import("@playwright/test").Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

const draft = (photoId: string, title: string) => ({
  title,
  servings: 4,
  servingDescription: null,
  times: { prepMinutes: null, cookMinutes: null, totalMinutes: null },
  ingredientsMd: "### Daal\n- 1 onion\n- 300g dried red split lentils",
  methodMd: "1. Blitz the veg.\n2. Add the lentils and simmer.",
  sourceNotes: "",
  tags: [],
  cuisine: "Indian",
  course: [],
  diet: [],
  nutrition: null,
  leftovers: { fridgeDays: 3, freezerDays: null, freezable: null, reheatNotes: null, source: "estimated" },
  source: { type: "book", url: null, site: null, author: null, book: { title: "The Veggie Book", author: null, page: 240 }, importedAt: null },
  uploadId: null,
  uploadedImages: [],
  photoId,
  confidence: { ingredients: "medium" },
  warnings: [],
});

// the phone project only repeats the parts that differ on a phone (camera button, More page); the rest is the same page
const desktopOnly = () => test.skip(isPhone(), "same screens as on the desktop");

/** Pretend Ollama is up with a vision model, so these tests don't depend on a real Ollama being reachable. */
async function ollamaUp(page: import("@playwright/test").Page) {
  await page.route("**/api/status", async (route) => {
    const status = await (await route.fetch()).json();
    await route.fulfill({ json: { ...status, ollama: { ...status.ollama, ok: true, error: undefined, models: [{ name: "qwen3-vl:8b", sizeGb: 6.1, vision: true }] } } });
  });
}
const title = () => (isPhone() ? "Gran's Scones" : "Gran's Pancakes");
const slug = () => (isPhone() ? "grans-scones" : "grans-pancakes");

test("take or choose a photo, it is named from the file, and saved for later", async ({ page }) => {
  await page.goto("/import?tab=photo");
  await expect(page.getByRole("tab", { name: "From photos" })).toHaveAttribute("aria-selected", "true");

  // the camera button exists on phones and opens the camera app; the gallery button picks existing pictures
  if (isPhone()) {
    await expect(page.locator("button", { hasText: "Take a photo" })).toBeVisible();
    await expect(page.getByLabel("Take a photo", { exact: true })).toHaveAttribute("capture", "environment");
    await expect(page.locator("button", { hasText: "Choose from gallery" })).toBeVisible();
  } else {
    await expect(page.locator("button", { hasText: "Take a photo" })).toHaveCount(0);
    await expect(page.locator("button", { hasText: "Choose pictures" })).toBeVisible();
  }

  const buffer = await picture("Pancakes from Gran");
  await page.getByLabel("Choose photos", { exact: true }).setInputFiles({ name: `${title()}.jpg`, mimeType: "image/jpeg", buffer });
  await expect(page.locator(".thumbs img")).toHaveCount(1);
  await expect(page.getByLabel("Name this recipe")).toHaveValue(title()); // from the file name
  await shot(page, "photos-intake");

  // a camera file name is not worth keeping: the box stays empty and the server names it with the date
  await page.getByRole("button", { name: "Remove page 1" }).click();
  await page.getByLabel("Choose photos", { exact: true }).setInputFiles({ name: "PXL_20261009_031522.jpg", mimeType: "image/jpeg", buffer });
  await expect(page.getByLabel("Name this recipe")).toHaveValue("");
  await page.getByLabel("Name this recipe").fill(title());
  await page.getByRole("button", { name: "Save for later" }).click();

  await expect(page).toHaveURL(new RegExp(`/photos/${slug()}$`));
  await expect(h1(page, title())).toBeVisible();
  await expect(page.getByText("Waiting").first()).toBeVisible();
  await page.reload();
  await expect(h1(page, title())).toBeVisible(); // it really is stored, not just on screen
});

test("saved photos are listed, renamed, given a book, and can have pages added and removed", async ({ page }) => {
  desktopOnly();
  await page.goto("/photos");
  await expect(page.locator(".rcard", { hasText: "Gran's Pancakes" })).toBeVisible();
  await expect(page.locator(".rcard", { hasText: "Daal Curry" })).toBeVisible();
  await shot(page, "photos");

  await page.locator(".rcard", { hasText: "Gran's Pancakes" }).click();
  await shot(page, "photo");
  await page.getByLabel("Choose photos", { exact: true }).setInputFiles({ name: "p2.jpg", mimeType: "image/jpeg", buffer: await picture("Page 2") });
  await expect(page.locator("figure img")).toHaveCount(2);
  await page.getByRole("button", { name: "Remove page 2" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.locator("figure img")).toHaveCount(1);

  await page.getByLabel("Name", { exact: true }).fill("Gran's Pancakes (thick)");
  await page.locator(".field", { hasText: "Book title" }).locator("input").fill("Family Favourites");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(h1(page, "Gran's Pancakes (thick)")).toBeVisible();
  await expect(page.locator(".field", { hasText: "Book title" }).locator("input")).toHaveValue("Family Favourites");
});

test("read later with a model you pick; the result is checked, saved, and the photo is linked to the recipe", async ({ page }) => {
  desktopOnly();
  await ollamaUp(page);
  let askedWith: unknown = null;
  await page.route("**/api/photos/daal-curry/read", async (route) => {
    askedWith = route.request().postDataJSON();
    await route.fulfill({ json: { jobId: "job1" } });
  });
  let polls = 0;
  await page.route("**/api/jobs/job1", async (route) => {
    polls++;
    const base = { id: "job1", label: "Reading", progress: ["Reading the photo with qwen3-vl:8b…"], error: null, startedAt: 0, finishedAt: null };
    await route.fulfill({ json: polls < 2 ? { ...base, status: "running", result: null } : { ...base, status: "done", result: { draft: draft("daal-curry", "Tasty Daal Curry") } } });
  });

  await page.goto("/photos/daal-curry");
  await expect(h1(page, "Daal Curry")).toBeVisible();
  const models = page.getByLabel("Read it with");
  await expect(models.locator("option").first()).toContainText("My setting");
  const options = await models.locator("option").allTextContents();
  expect(options.length).toBeGreaterThan(1); // the models installed in Ollama are offered
  await models.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Read it now" }).click();

  await expect(page).toHaveURL(/\/import\/review$/);
  expect(askedWith).toMatchObject({ provider: "ollama", model: expect.any(String) });
  await expect(h1(page, "Check the recipe")).toBeVisible();
  await expect(page.getByPlaceholder("Butter Chicken")).toHaveValue("Tasty Daal Curry");
  await expect(page.locator("img[alt^='Photo page']")).toBeVisible(); // the photo stays beside the form
  await shot(page, "photos-review");
  await page.getByText(/Work out nutrition from the ingredients after saving/).click();
  await page.getByRole("button", { name: "Save recipe" }).click();

  await expect(page).toHaveURL(/\/recipes\/tasty-daal-curry$/);
  await expect(page.locator(".gallery img")).toHaveCount(1); // the page photo came along as a source page
  await expect(page.getByText(/The Veggie Book/).first()).toBeVisible();

  await page.goto("/photos/daal-curry");
  await expect(page.getByText("This became a recipe")).toBeVisible();
  await page.getByRole("link", { name: "Open the recipe" }).click();
  await expect(h1(page, "Tasty Daal Curry")).toBeVisible();
});

test("a failed reading keeps the photo and says what happened", async ({ page }) => {
  desktopOnly();
  await page.route("**/api/photos/grans-pancakes/read", (route) => route.fulfill({ json: { jobId: "bad" } }));
  await page.route("**/api/jobs/bad", (route) =>
    route.fulfill({ json: { id: "bad", label: "Reading", status: "error", progress: [], result: null, error: "Couldn't reach Ollama at http://localhost:11434", startedAt: 0, finishedAt: 1 } }),
  );
  await ollamaUp(page);
  await page.goto("/photos/grans-pancakes");
  await page.getByRole("button", { name: "Read it now" }).click();
  await expect(page.getByText(/Reading didn't work: Couldn't reach Ollama/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Read it now" })).toBeEnabled(); // can try again, photo still there
  await expect(page.locator("figure img")).toHaveCount(1);
});

test("type it in yourself with the photo beside the form", async ({ page }) => {
  desktopOnly();
  await page.goto("/photos/grans-pancakes");
  await page.getByRole("button", { name: "I'll type it in" }).click();
  await expect(page).toHaveURL(/\/import\/review$/);
  await expect(page.getByPlaceholder("Butter Chicken")).toHaveValue("Gran's Pancakes (thick)");
  await expect(page.locator("img[alt^='Photo page']")).toBeVisible();
  await page.locator("textarea.mono").nth(0).fill("- 200 g flour\n- 2 eggs\n- 300 ml milk");
  await page.locator("textarea.mono").nth(1).fill("1. Whisk.\n2. Fry.");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/grans-pancakes-thick$/);
  await expect(page.locator(".gallery img")).toHaveCount(1);
  await page.goto("/photos");
  await page.getByRole("button", { name: /Show photos already made into recipes/ }).click();
  await expect(page.locator(".rcard", { hasText: "Gran's Pancakes (thick)" }).getByText("Recipe made")).toBeVisible();
});

test("a saved photo can be deleted", async ({ page }) => {
  desktopOnly();
  await page.goto("/import?tab=photo");
  await page.getByLabel("Choose photos", { exact: true }).setInputFiles({ name: "Throwaway.jpg", mimeType: "image/jpeg", buffer: await picture("Throwaway") });
  await page.getByRole("button", { name: "Save for later" }).click();
  await expect(h1(page, "Throwaway")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/photos$/);
  await expect(page.locator(".rcard", { hasText: "Throwaway" })).toHaveCount(0);
});

test("the sidebar / More page tell you how many photos are waiting", async ({ page, request }) => {
  // every photo so far has become a recipe, so save a new one that stays waiting
  const made = await request.post("/api/photos", { multipart: { name: `Waiting ${isPhone() ? "phone" : "desktop"}`, files: { name: "w.jpg", mimeType: "image/jpeg", buffer: await picture("Waiting") } } });
  expect(made.ok()).toBe(true);
  await page.goto("/");
  await appReady(page);
  if (isPhone()) {
    await page.locator(".tabbar").getByRole("link", { name: "More" }).click();
    await expect(page.getByRole("link", { name: /Saved photos/ })).toContainText(/waiting to be turned into recipes/);
  } else {
    await expect(page.locator(".sidebar").getByRole("link", { name: /Saved photos/ })).toBeVisible();
    await expect(page.locator(".sidebar .badge")).toBeVisible();
  }
});

test("LIVE: the real reference photo is read by the local model", async ({ page }) => {
  test.skip(!process.env.LIVE_AI, "set LIVE_AI=1 to read a real photo with your local Ollama model");
  test.setTimeout(300_000);
  const reference = path.resolve(import.meta.dirname, "..", "_reference", "Daal Curry.jpg");
  test.skip(!fs.existsSync(reference), "_reference/Daal Curry.jpg isn't here");
  await page.goto("/import?tab=photo");
  await page.getByLabel("Choose photos", { exact: true }).setInputFiles(reference);
  await expect(page.getByLabel("Name this recipe")).toHaveValue("Daal Curry");
  await page.getByRole("button", { name: "Save and read it now" }).click();
  await expect(h1(page, "Check the recipe")).toBeVisible({ timeout: 240_000 });
  await expect(page.getByPlaceholder("Butter Chicken")).toHaveValue(/daal curry/i);
  await expect(page.locator("textarea.mono").nth(0)).toHaveValue(/split lentils/);
  await expect(page.locator("textarea.mono").nth(1)).toHaveValue(/Put the peeled onion/);
});
