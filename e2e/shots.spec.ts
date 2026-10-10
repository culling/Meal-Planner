import { appReady, expect, shot, test } from "./helpers";

// Takes a screenshot of every page and main dialog (phone and desktop projects) into .e2e/screenshots.
// After the run, scripts/compare-screenshots.mts copies the ones that changed by more than the threshold into docs/screenshots.

const draft = {
  title: "Lemon Garlic Chicken",
  servings: 4,
  servingDescription: null,
  times: { prepMinutes: 10, cookMinutes: 25, totalMinutes: 35 },
  ingredientsMd: "- 600 g chicken thigh fillets\n- 3 tbsp olive oil\n- 4 cloves garlic, crushed\n- 1 lemon, juiced\n- 1/2 cup chicken stock",
  methodMd: "1. Season the chicken.\n2. Brown it in the oil for 5 minutes each side.\n3. Add garlic, lemon and stock and simmer for 12 minutes.",
  sourceNotes: "Leftovers keep in the fridge for 3 days.",
  tags: ["chicken", "weeknight"],
  cuisine: "Western",
  course: [],
  diet: [],
  nutrition: null,
  leftovers: { fridgeDays: 3, freezerDays: null, freezable: null, reheatNotes: null, source: "page" },
  source: { type: "book", url: null, site: null, author: "Sample Author", book: { title: "The Family Cookbook", author: "Sample Author", page: 87 }, importedAt: null },
  uploadId: null,
  uploadedImages: [],
  confidence: { title: "high", servings: "medium", times: "high", ingredients: "low", method: "high", nutrition: "low" },
  warnings: ["No nutrition information found; it can be calculated from the ingredients after saving."],
};

test.describe("screenshots", () => {
  test("recipe list, search and filters", async ({ page }) => {
    await page.goto("/");
    await appReady(page);
    await expect(page.locator(".rcard").first()).toBeVisible();
    await shot(page, "recipes");
    await page.getByPlaceholder(/Search recipes/).fill("chicken");
    await expect(page.locator(".rcard", { hasText: "Butter Chicken" })).toBeVisible();
    await expect(page.locator(".rcard", { hasText: "Cheese on Toast" })).toHaveCount(0);
    await shot(page, "recipes-search");
    await page.getByPlaceholder(/Search recipes/).fill("");
    await page.getByRole("button", { name: /Filters/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "recipes-filters", { full: false });
  });

  test("a recipe: ingredients, method, nutrition, breakdown", async ({ page }) => {
    await page.goto("/recipes/butter-chicken");
    await expect(page.getByRole("heading", { level: 1, name: "Butter Chicken" })).toBeVisible();
    await shot(page, "recipe");
    await page.goto("/recipes/chicken-fried-rice");
    await page.getByRole("button", { name: "Show ingredient breakdown" }).click();
    await expect(page.locator(".tbl tr.ai").first()).toBeVisible();
    await shot(page, "recipe-nutrition-breakdown");
  });

  test("recipe dialogs: add to plan, cooked, leftovers", async ({ page }) => {
    await page.goto("/recipes/butter-chicken");
    await page.getByRole("button", { name: "Add to plan" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "recipe-add-to-plan", { full: false });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Cooked it" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "recipe-cooked", { full: false });
  });

  test("edit and new recipe forms", async ({ page }) => {
    await page.goto("/recipes/cheese-on-toast/edit");
    await expect(page.getByRole("heading", { level: 1, name: "Edit recipe" })).toBeVisible();
    await shot(page, "recipe-edit");
    await page.goto("/new");
    await expect(page.getByRole("heading", { level: 1, name: "New recipe" })).toBeVisible();
    await shot(page, "recipe-new");
  });

  test("meal plan, a meal, people", async ({ page }) => {
    await page.goto("/plan");
    await expect(page.locator(".meal-btn:not(.empty)").first()).toBeVisible();
    await shot(page, "plan");
    await page.locator(".meal-btn:not(.empty)").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "plan-meal", { full: false });
    await page.keyboard.press("Escape");
    await page.locator(".day-head .people-pill").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "plan-people", { full: false });
  });

  test("shopping list", async ({ page }) => {
    await page.goto("/shopping");
    await expect(page.locator(".shop-item").first()).toBeVisible();
    await shot(page, "shopping");
  });

  test("nutrition data and editing a food", async ({ page }) => {
    await page.goto("/nutrition");
    await expect(page.locator(".tbl tbody tr").first()).toBeVisible();
    await shot(page, "nutrition-data");
    await page.locator(".tbl tbody tr", { hasText: "butter" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "nutrition-food", { full: false });
  });

  test("adding recipes: link, several links, photos, review", async ({ page }) => {
    await page.goto("/import");
    await expect(page.getByRole("heading", { level: 1, name: "Add a recipe" })).toBeVisible();
    await shot(page, "import-link");
    await page.getByRole("tab", { name: "Several links" }).click();
    await shot(page, "import-links");
    await page.getByRole("tab", { name: "From photos" }).click();
    await shot(page, "import-photos");

    // the review screen, with a made-up page so no website is contacted
    await page.route("**/api/import/url", (route) => route.fulfill({ json: { draft, duplicateOf: null } }));
    await page.getByRole("tab", { name: "From a link" }).click();
    await page.getByPlaceholder(/https:\/\//).fill("https://example.com/lemon-garlic-chicken/");
    await page.getByRole("button", { name: /Get recipe/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Check the recipe" })).toBeVisible();
    await shot(page, "import-review");
  });

  test("settings, more", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByText("Ollama connected").or(page.getByText("Not connected"))).toBeVisible();
    // the address of this machine and the models installed vary, so hide them to keep the picture stable
    await page.addStyleTag({ content: "select, code { visibility: hidden !important; }" });
    await shot(page, "settings");
    await page.goto("/more");
    await expect(page.getByRole("heading", { level: 1, name: "More" })).toBeVisible();
    await shot(page, "more");
  });
});
