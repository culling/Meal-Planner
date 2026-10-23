import type { Locator, Page } from "@playwright/test";
import { expect, isPhone, mondayIn, shot, test } from "./helpers";

// Recipes that go together (salt and pepper tofu with rice and greens): suggested on the recipe page, planned as one meal,
// and made into one meal on the plan by dropping a dish onto another. Each project uses its own recipes and blank weeks.

test.describe.configure({ mode: "serial" });

const day = (page: Page, i: number) => page.locator(".day").nth(i);
const slotCell = (page: Page, d: number, s: number) => day(page, d).locator(".slot").nth(s); // s: 0 breakfast, 1 lunch, 2 dinner
const meals = (page: Page) => page.locator(".meal-btn:not(.empty)");
const sfx = () => (isPhone() ? "P" : "D");

async function weekAhead(page: Page, n: number) {
  await page.goto(`/plan/${mondayIn(n + (isPhone() ? 10 : 0))}`);
  await expect(page.locator(".day-head").first()).toBeVisible();
  await expect(meals(page)).toHaveCount(0);
}

/** Open an empty slot, pick a recipe by searching for it, and return the dialog (not saved yet). */
async function chooseIn(page: Page, cell: Locator, title: string) {
  await cell.locator(".meal-btn.empty").click();
  await page.getByRole("button", { name: "Choose a recipe" }).click();
  await page.getByPlaceholder("Search…").last().fill(title);
  await page.locator(".rcard", { hasText: title }).first().click();
  return page.getByRole("dialog");
}

async function center(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function drag(page: Page, from: Locator, to: Locator) {
  const a = await center(from);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await to.scrollIntoViewIfNeeded();
  const c = await center(to);
  await page.mouse.move(c.x, c.y, { steps: 8 });
  await page.mouse.up();
}

test("suggest recipes on the recipe page, then plan them as one meal", async ({ page }) => {
  const make = async (title: string, role: string) => {
    const res = await page.request.post("/api/recipes", { data: { title, servings: 2, role: [role], ingredientsMd: "- 1 cup something", methodMd: "1. Cook it" } });
    expect(res.ok()).toBe(true);
    return (await res.json()).slug as string;
  };
  const tofu = `Salt and Pepper Tofu ${sfx()}`;
  const rice = `Cooked White Rice ${sfx()}`;
  const greens = `Steamed Asian Greens ${sfx()}`;
  const tofuSlug = await make(tofu, "main");
  const riceSlug = await make(rice, "side");
  await make(greens, "side");

  await page.goto(`/recipes/${tofuSlug}`);
  const goesWith = page.locator(".card", { has: page.getByRole("heading", { name: "Goes with" }) });
  for (const side of [rice, greens]) {
    await page.getByRole("button", { name: "＋ Add a suggested recipe" }).click();
    await page.getByRole("dialog").getByPlaceholder("Search…").fill(side);
    await page.getByRole("dialog").locator(".rcard", { hasText: side }).click();
    await expect(goesWith.getByRole("link", { name: side })).toBeVisible();
  }
  await shot(page, "recipe-goes-with");

  // the rice's page shows what it goes with
  await goesWith.getByRole("link", { name: rice }).click();
  await expect(page.getByRole("heading", { name: rice, level: 1 })).toBeVisible();
  await expect(page.locator(".card", { has: page.getByRole("heading", { name: "Goes with" }) }).getByRole("link", { name: tofu })).toBeVisible();
  void riceSlug;

  // choosing the tofu for a meal offers its sides, already ticked
  await weekAhead(page, 46);
  const dialog = await chooseIn(page, slotCell(page, 0, 2), tofu);
  await expect(dialog.getByRole("button", { name: `✓ ${rice}` })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: `✓ ${greens}` })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const group = slotCell(page, 0, 2).locator(".meal-group");
  await expect(group.locator(".meal-btn")).toHaveCount(3);
  await shot(page, "plan-meal-group");

  // more people on one dish: every dish of the meal follows
  const pills = group.locator(".people-pill");
  const before = Number((await pills.first().innerText()).trim());
  await group.locator(".meal-btn", { hasText: rice }).click();
  await expect(page.getByRole("dialog").getByText(/Served with/)).toContainText(tofu);
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: /Part of the meal with/ })).toBeChecked();
  await page.getByRole("dialog").locator(".field", { hasText: "How many people?" }).getByRole("button", { name: "Increase" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(pills).toHaveText([String(before + 1), String(before + 1), String(before + 1)].map((n) => new RegExp(`^\\s*${n}\\s*$`)));

  // and the whole meal can go in one go
  await group.locator(".meal-btn", { hasText: tofu }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove the meal" }).click();
  await expect(meals(page)).toHaveCount(0);
});

test.describe("with a mouse", () => {
  test.beforeEach(() => test.skip(isPhone(), "mouse drags are tested on the desktop project"));

  test("drop a meal on another to serve them together; the meal then becomes leftovers together", async ({ page }) => {
    await weekAhead(page, 47);
    for (const [d, s, title] of [[0, 2, "Butter Chicken"], [1, 1, "Cheese on Toast"]] as const) {
      const dialog = await chooseIn(page, slotCell(page, d, s), title);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(slotCell(page, d, s).locator(".meal-btn", { hasText: title })).toBeVisible();
    }

    await drag(page, slotCell(page, 1, 1).locator(".meal-btn"), slotCell(page, 0, 2).locator(".meal-btn"));
    await expect(page.getByText("Cheese on Toast added to Butter Chicken")).toBeVisible();
    await expect(slotCell(page, 1, 1).locator(".meal-btn.empty")).toBeVisible();
    await expect(slotCell(page, 0, 2).locator(".meal-group .meal-btn")).toHaveCount(2);

    // the meal's handle copies both dishes: Tuesday dinner eats the leftovers of each, and each cooks enough
    const cell = slotCell(page, 0, 2);
    await cell.hover();
    await drag(page, cell.locator(".fill-handle"), slotCell(page, 1, 2));
    await expect(page.getByText(/leftovers on Tue dinner/)).toBeVisible();
    await expect(slotCell(page, 1, 2).locator(".meal-group .meal-btn", { hasText: "Leftovers" })).toHaveCount(2);
    await expect(cell.locator(".meal-btn", { hasText: /\+\d+ extra/ })).toHaveCount(2);
    await expect(page.locator(".notice.warn")).toHaveCount(0);

    // undo (on the newest toast) puts it back
    await page.getByRole("button", { name: "Undo" }).last().click();
    await expect(slotCell(page, 1, 2).locator(".meal-btn.empty")).toBeVisible();
  });
});
