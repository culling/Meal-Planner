import { appReady, expect, test } from "./helpers";

// Real journeys through the app. These change the demo data, so they run after the read-only tests.

const h1 = (page: import("@playwright/test").Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });
const field = (page: import("@playwright/test").Page, label: string) => page.locator(".field", { has: page.locator("label", { hasText: label }) }).locator("input").first();

test.describe.configure({ mode: "serial" });

test("write a new recipe, find it, change its servings", async ({ page }) => {
  await page.goto("/new");
  await page.getByPlaceholder("Butter Chicken").fill("E2E Pancakes");
  await field(page, "Servings").fill("2");
  await page.locator("textarea.mono").nth(0).fill("- 200 g flour\n- 2 eggs\n- 300 ml milk\n- 1 tbsp butter");
  await page.locator("textarea.mono").nth(1).fill("1. Whisk everything together.\n2. Fry in the butter until golden.");
  await page.getByRole("button", { name: "Add recipe" }).click();

  await expect(page).toHaveURL(/\/recipes\/e2e-pancakes$/);
  await expect(h1(page, "E2E Pancakes")).toBeVisible();
  const flour = page.locator(".ing .txt").first();
  await expect(flour).toHaveText("200g flour");
  await page.locator(".card", { hasText: "Ingredients" }).getByRole("button", { name: "Increase" }).click();
  await expect(flour).toHaveText("300g flour"); // 2 -> 3 servings
  await page.reload();
  await expect(page.locator(".ing .txt").first()).toHaveText("200g flour"); // scaling is only for the screen

  await page.locator(".ing").first().click(); // tick off an ingredient
  await expect(page.locator(".ing.done")).toHaveCount(1);
});

test("search and filters narrow the list", async ({ page }) => {
  await page.goto("/");
  await appReady(page);
  await page.getByPlaceholder(/Search recipes/).fill("toast");
  await expect(page.locator(".rcard")).toHaveCount(1);
  await expect(page.locator(".rcard")).toContainText("Cheese on Toast");
  await page.getByPlaceholder(/Search recipes/).fill("");
  await expect(page.locator(".rcard").nth(1)).toBeVisible();

  await page.getByRole("button", { name: /Filters/ }).click();
  await field(page, "Calories up to").fill("300");
  await page.getByRole("button", { name: /^Show/ }).click();
  await expect(page).toHaveURL(/caloriesMax=300/);
  await expect(page.locator(".rcard")).toHaveCount(1);
  await expect(page.locator(".rcard")).toContainText("Chicken Fried Rice");
  await expect(page.getByText(/have no calorie info|has no calorie info/).first()).toBeVisible();
  await page.reload(); // filters survive a refresh
  await expect(page.locator(".rcard")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".rcard").nth(2)).toBeVisible();
});

test("favourite and hide", async ({ page }) => {
  await page.goto("/recipes/beef-stew");
  const fav = page.getByRole("button", { name: "Favourite" });
  await fav.click();
  await expect(fav).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /Hide from lists/ }).click();
  await page.goto("/");
  await expect(page.locator(".rcard", { hasText: "Beef Stew" })).toHaveCount(0);
  await page.goto("/?hidden=only");
  await expect(page.locator(".rcard", { hasText: "Beef Stew" })).toBeVisible();
  await page.goto("/recipes/beef-stew");
  await page.getByRole("button", { name: "Unhide" }).click();
  await page.goto("/");
  await expect(page.locator(".rcard", { hasText: "Beef Stew" })).toBeVisible();
});

test("plan a meal, change how many people, mark it cooked, see it in the cook log", async ({ page }) => {
  await page.goto("/recipes/spaghetti-bolognese");
  await page.getByRole("button", { name: "Add to plan" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Add to / }).click();
  await expect(page).toHaveURL(/\/plan\/\d{4}-W\d{2}$/);
  const today = page.locator(".day.today");
  await expect(today.locator(".meal-btn", { hasText: "Spaghetti Bolognese" })).toBeVisible();

  // people for the day: set, then go back to the inherited number
  await today.locator(".people-pill").first().click();
  await page.locator(".stepper input").fill("6");
  await page.getByRole("button", { name: "Set to 6" }).click();
  await expect(today.locator(".people-pill.set").first()).toContainText("6");
  await today.locator(".people-pill").first().click();
  await page.getByRole("button", { name: /^Go back to / }).click();
  await expect(today.locator(".people-pill.set")).toHaveCount(0);

  await today.locator(".meal-btn", { hasText: "Spaghetti Bolognese" }).click();
  await page.getByRole("button", { name: "✓ Mark as cooked" }).click();
  await expect(page.getByText("Cooked — it's in the recipe's cook log")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(today.locator(".meal-btn.cooked")).toBeVisible();

  await page.goto("/recipes/spaghetti-bolognese");
  await expect(page.getByRole("heading", { name: "Cook log" })).toBeVisible();
  await expect(page.getByText(/1× cooked/)).toBeVisible();
});

test("cook extra, then eat the leftovers on another day", async ({ page }) => {
  await page.goto("/plan");
  await page.getByRole("button", { name: "Next week" }).click(); // a blank week, whatever day it is today
  await expect(page.locator(".meal-btn:not(.empty)")).toHaveCount(0);
  const monday = page.locator(".day").nth(0);
  await monday.locator(".meal-btn.empty").nth(2).click(); // dinner
  await page.getByRole("button", { name: "Choose a recipe" }).click();
  await page.locator(".rcard", { hasText: "Butter Chicken" }).click();
  await page.locator(".field", { hasText: "Portions to cook" }).getByRole("button", { name: "Increase" }).click(); // one extra
  await expect(page.getByText(/1 extra portion/)).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(monday.locator(".meal-btn", { hasText: "+1 extra" })).toBeVisible();

  const tuesday = page.locator(".day").nth(1);
  await tuesday.locator(".meal-btn.empty").nth(1).click(); // lunch
  await page.getByRole("tab", { name: "Leftovers", exact: true }).click();
  await page.getByRole("dialog").locator("button.card", { hasText: "Butter Chicken" }).first().click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(tuesday.locator(".meal-btn", { hasText: "Leftovers" })).toBeVisible();
  await expect(page.locator(".notice.warn")).toHaveCount(0); // within the safe date: no warning

  // eat them too late (the fridge life is 3 days): the plan warns
  const sunday = page.locator(".day").nth(6);
  await sunday.locator(".meal-btn.empty").nth(1).click();
  await page.getByRole("tab", { name: "Leftovers", exact: true }).click();
  await expect(page.getByText(/Nothing in the plan has leftovers on this day/)).toBeVisible(); // not offered past the safe date
  await page.keyboard.press("Escape");
});

test("shopping list: build from the plan, tick, untick, add your own item", async ({ page }) => {
  await page.goto("/shopping");
  await page.getByRole("button", { name: /from the plan/ }).click();
  await expect(page.getByText("Updated from this week's plan")).toBeVisible(); // wait for the new list before reading it
  const first = page.locator(".shop-item").first();
  const text = await first.locator(".txt").innerText();
  await first.click();
  await expect(page.locator(".shop-item.done")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".shop-item.done .txt")).toHaveText(text);
  await page.getByRole("button", { name: /from the plan/ }).click(); // ticks survive an update
  await expect(page.getByText("Updated from this week's plan")).toBeVisible();
  await expect(page.locator(".shop-item.done .txt")).toHaveText(text);

  await page.getByPlaceholder(/Add something else/).fill("Bin bags");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".shop-item", { hasText: "Bin bags" })).toBeVisible();
  await page.getByRole("button", { name: "Untick everything" }).click();
  await expect(page.locator(".shop-item.done")).toHaveCount(0);
});

test("nutrition data: checking a food clears its ? in the database; a recipe row keeps its ? until the guessed grams are confirmed too", async ({ page }) => {
  await page.goto("/recipes/chicken-fried-rice");
  await page.getByRole("button", { name: "Show ingredient breakdown" }).click();
  const aiRows = page.locator(".tbl tr.ai");
  const before = await aiRows.count();
  expect(before).toBeGreaterThan(0);

  await page.goto("/nutrition");
  const row = page.locator(".tbl tbody tr", { hasText: "chicken breast" });
  await expect(row.locator(".ai-mark")).toBeVisible();
  await row.click();
  await page.getByRole("button", { name: "✓ Mark as checked" }).click();
  await expect(row.locator(".ai-mark")).toHaveCount(0);

  // the recipe's chicken row also had a guessed gram amount, so it still asks for a check
  await page.goto("/recipes/chicken-fried-rice");
  await page.getByRole("button", { name: "Show ingredient breakdown" }).click();
  await expect(aiRows).toHaveCount(before);
  const chicken = page.locator(".tbl tbody tr", { hasText: "chicken breast" });
  await chicken.locator("button.ai-mark").click(); // "this is right"
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Show ingredient breakdown" }).click();
  await expect(aiRows).toHaveCount(before - 1);
});

test("editing a number by hand in the breakdown removes that row's ?", async ({ page }) => {
  await page.goto("/recipes/chicken-fried-rice");
  await page.getByRole("button", { name: "Show ingredient breakdown" }).click();
  const aiRows = page.locator(".tbl tr.ai");
  const n = await aiRows.count();
  expect(n).toBeGreaterThan(0);
  await aiRows.first().getByLabel("Calories").fill("123");
  await expect(aiRows).toHaveCount(n - 1);
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Show ingredient breakdown" }).click();
  await expect(page.locator(".tbl tr.ai")).toHaveCount(n - 1);
});

test("add a food by hand to the nutrition database", async ({ page }) => {
  await page.goto("/nutrition");
  await page.getByRole("button", { name: /Add a food/ }).click();
  await page.getByPlaceholder("chicken thigh").fill("e2e flour");
  await field(page, "Calories").fill("364");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const row = page.locator(".tbl tbody tr", { hasText: "e2e flour" });
  await expect(row).toBeVisible();
  await expect(row.locator(".ai-mark")).toHaveCount(0);
});

test("a note, a rating and an edit are saved", async ({ page }) => {
  await page.goto("/recipes/cheese-on-toast");
  await page.getByPlaceholder(/Add a note/).fill("Better with mustard");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.locator(".note", { hasText: "Better with mustard" })).toBeVisible();
  await page.getByRole("button", { name: "4 stars" }).click();
  await page.reload();
  await expect(page.locator(".note", { hasText: "Better with mustard" })).toBeVisible();

  await page.getByRole("button", { name: "More", exact: true }).first().click();
  await page.getByRole("link", { name: /Edit recipe/ }).click();
  await page.getByPlaceholder("Butter Chicken").fill("Cheese on Toast (grilled)");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(h1(page, "Cheese on Toast (grilled)")).toBeVisible();
});

test("importing from a link: check the draft, change it, save it", async ({ page }) => {
  const draft = {
    title: "Imported Soup",
    servings: 4,
    servingDescription: null,
    times: { prepMinutes: 5, cookMinutes: 20, totalMinutes: 25 },
    ingredientsMd: "- 1 onion\n- 500 ml stock",
    methodMd: "1. Simmer.",
    sourceNotes: "",
    tags: ["soup"],
    cuisine: null,
    course: [],
    diet: [],
    nutrition: null,
    leftovers: { fridgeDays: 3, freezerDays: null, freezable: null, reheatNotes: null, source: "estimated" },
    source: { type: "web", url: "https://example.com/soup/", site: "Example", author: null, book: null, importedAt: null },
    uploadId: null,
    uploadedImages: [],
    confidence: { ingredients: "low" },
    warnings: ["Storage times are a default estimate."],
  };
  await page.route("**/api/import/url", (route) => route.fulfill({ json: { draft, duplicateOf: null } }));
  await page.goto("/import");
  await page.getByPlaceholder(/https:\/\//).fill("https://example.com/soup/");
  await page.getByRole("button", { name: /Get recipe/ }).click();
  await expect(h1(page, "Check the recipe")).toBeVisible();
  await expect(page.getByText("Storage times are a default estimate.")).toBeVisible();
  await expect(page.locator(".lowconf").first()).toBeVisible();
  await page.getByPlaceholder("Butter Chicken").fill("Imported Soup (checked)");
  await page.getByText(/Work out nutrition from the ingredients after saving/).click(); // untick: no AI call in tests
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/imported-soup-checked$/);
  await expect(h1(page, "Imported Soup (checked)")).toBeVisible();
  await expect(page.getByRole("link", { name: "Example" }).first()).toBeVisible(); // the source stays visible
});

test("settings can be changed and are kept", async ({ page }) => {
  await page.goto("/settings");
  await field(page, "People by default").fill("4");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.reload();
  await expect(field(page, "People by default")).toHaveValue("4");
});
