import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, isPhone, mondayIn, shot, test } from "./helpers";

// "Tomorrow I'm making peanut butter smoothies to drink, and cheese muffins for the rest of the week (and not eating any tomorrow)."
// Cooking ahead gets its own row under breakfast / lunch / dinner; the meals that eat it are chosen separately.

test.describe.configure({ mode: "serial" });

const day = (page: Page, i: number) => page.locator(".day").nth(i);
const slotCell = (page: Page, d: number, s: number) => day(page, d).locator(".slot").nth(s); // 0 breakfast, 1 lunch, 2 dinner
const prepCell = (page: Page, d: number) => day(page, d).locator(".prep-cell");

async function ensureRecipe(request: APIRequestContext, title: string, body: Record<string, unknown>) {
  const slug = title.toLowerCase().replace(/ /g, "-");
  if ((await request.get(`/api/recipes/${slug}`)).ok()) return;
  const res = await request.post("/api/recipes", { data: { title, ...body } });
  expect(res.ok()).toBe(true);
}

test.beforeAll(async ({ request }) => {
  await request.put("/api/settings", { data: { defaultPeople: 2 } }); // the numbers below assume two people
  await ensureRecipe(request, "Peanut Butter Smoothie", { servings: 2, ingredientsMd: "- 2 bananas\n- 4 tbsp peanut butter", methodMd: "1. Blend" });
  await ensureRecipe(request, "Cheese Muffins", {
    servings: 12,
    ingredientsMd: "- 300 g flour\n- 150 g cheese",
    methodMd: "1. Bake",
    leftovers: { fridgeDays: 4, freezerDays: 90, freezable: true, reheatNotes: null, source: "manual" },
  });
});

async function weekAhead(page: Page, n: number, opts: { blank?: boolean } = {}) {
  await page.goto(`/plan/${mondayIn(n + (isPhone() ? 10 : 0))}`);
  await expect(page).toHaveURL(/\/plan\/\d{4}-\d{2}-\d{2}$/);
  await expect(page.locator(".day-head").first()).toBeVisible(); // the plan has loaded
  if (opts.blank !== false) await expect(page.locator(".meal-btn:not(.empty)")).toHaveCount(0);
}

async function center(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function addSmoothie(page: Page, d: number) {
  await slotCell(page, d, 0).locator(".meal-btn.empty").click();
  await page.getByRole("button", { name: "Choose a recipe" }).click();
  await page.getByRole("dialog").getByRole("tab", { name: "All" }).click(); // the picker starts on mains
  await page.locator(".rcard", { hasText: "Peanut Butter Smoothie" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(slotCell(page, d, 0).locator(".meal-btn", { hasText: "Peanut Butter Smoothie" })).toBeVisible();
}

async function makeMuffins(page: Page, d: number) {
  await prepCell(page, d).getByRole("button", { name: /Make ahead/ }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText(/Make ahead · /);
  await dlg.getByRole("button", { name: "Choose what to make" }).click();
  await page.locator(".rcard", { hasText: "Cheese Muffins" }).click();
  await expect(dlg).toContainText("The recipe makes 12");
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await expect(prepCell(page, d).locator(".prep-item", { hasText: "Cheese Muffins" })).toContainText("Makes 12");
  return dlg;
}

test("smoothies to drink tomorrow, muffins cooked tomorrow for the rest of the week, none eaten tomorrow", async ({ page }) => {
  await weekAhead(page, 30);
  const TUE = 1;
  await addSmoothie(page, TUE);

  // a "Make ahead" row exists, labelled, under the meals
  if (!isPhone()) {
    const labels = await page.locator(".row-label").allTextContents();
    expect(labels.map((l) => l.toLowerCase())).toEqual(["breakfast", "lunch", "dinner", "make ahead"]);
    const lunchRow = await page.locator(".row-label").nth(2).boundingBox();
    const prepRow = await page.locator(".row-label").nth(3).boundingBox();
    expect(prepRow!.y).toBeGreaterThan(lunchRow!.y + 50);
  }

  const dlg = await makeMuffins(page, TUE);
  // the dialog stays open on the saved make-ahead, with the "who eats it" choices right there
  await expect(dlg.getByText("Who eats it? Choose the meals")).toBeVisible();
  for (const d of ["Wed", "Thu", "Fri", "Sat"]) await dlg.getByRole("button", { name: new RegExp(`^${d} \\d+ lunch$`) }).click();
  await dlg.getByRole("button", { name: /^Fill 4 meals$/ }).click();

  await expect(page.getByText(/leftovers on Wed lunch, Thu lunch, Fri lunch, Sat lunch/)).toBeVisible();
  // tomorrow nobody eats muffins: Tuesday's lunch and dinner are empty, the smoothie is there, the muffins are in the make-ahead row
  await expect(slotCell(page, TUE, 1).locator(".meal-btn.empty")).toBeVisible();
  await expect(slotCell(page, TUE, 2).locator(".meal-btn.empty")).toBeVisible();
  await expect(slotCell(page, TUE, 0).locator(".meal-btn", { hasText: "Peanut Butter Smoothie" })).toBeVisible();
  for (let d = 2; d <= 5; d++) await expect(slotCell(page, d, 1).locator(".meal-btn", { hasText: "Leftovers" })).toBeVisible();
  // 12 made, 4 meals × 2 people = 8 planned: 4 still unplanned
  await expect(prepCell(page, TUE).locator(".prep-item")).toContainText("4 not planned yet");
  await shot(page, "plan-make-ahead");

  await page.reload();
  await expect(prepCell(page, TUE).locator(".prep-item", { hasText: "Cheese Muffins" })).toContainText("Makes 12");
  await expect(slotCell(page, 5, 1).locator(".meal-btn", { hasText: "Leftovers" })).toBeVisible();
});

test("open a make-ahead again: change how much it makes, freeze some, mark it made, remove it", async ({ page }) => {
  await weekAhead(page, 31);
  await makeMuffins(page, 1);
  const dlg = page.getByRole("dialog");
  // make 24 and freeze 12
  await dlg.locator(".field", { hasText: "How many portions will it make?" }).locator("input").fill("24");
  await dlg.locator(".field", { hasText: "Freeze some straight away?" }).locator("input").fill("12");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await expect(prepCell(page, 1).locator(".prep-item")).toContainText("Makes 24");
  await expect(prepCell(page, 1).locator(".prep-item")).toContainText("❄ 12");

  await dlg.getByRole("button", { name: "✓ Mark as made" }).click();
  await expect(dlg.getByText(/Made — it's in the recipe's cook log/)).toBeVisible();
  await dlg.locator("button", { hasText: /^Close$/ }).click();
  await expect(prepCell(page, 1).locator(".meal-btn.cooked")).toBeVisible();

  // a second make-ahead on the same day sits beside the first
  await prepCell(page, 1).getByRole("button", { name: /Make ahead/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Choose what to make" }).click();
  await page.locator(".rcard", { hasText: "Peanut Butter Smoothie" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(prepCell(page, 1).locator(".prep-item")).toHaveCount(2);
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(prepCell(page, 1).locator(".prep-item")).toHaveCount(1);
});

test("a meal that eats it too late says so (and the freezer is the answer)", async ({ page }) => {
  await weekAhead(page, 32);
  await makeMuffins(page, 0); // Monday: muffins keep 4 days
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: /^Sat \d+ lunch$/ }).click(); // 5 days later
  await dlg.getByRole("button", { name: /^Fill 1 meal$/ }).click();
  await expect(page.locator(".notice.warn")).toContainText(/past its fridge life/);
});

test("mouse: drag the make-ahead's handle to the meals that eat it (pause on the first one)", async ({ page }) => {
  test.skip(isPhone(), "mouse drag");
  await weekAhead(page, 33);
  await makeMuffins(page, 0);
  await page.getByRole("dialog").locator("button", { hasText: /^Close$/ }).click();

  await prepCell(page, 0).hover();
  const handle = prepCell(page, 0).locator(".fill-handle");
  const a = await center(handle);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  // up over Monday's dinner on the way (no pause there), then pause on Tuesday lunch, then along the lunch row
  for (const target of [slotCell(page, 0, 2), slotCell(page, 1, 1)]) {
    const c = await center(target);
    await page.mouse.move(c.x, c.y, { steps: 6 });
  }
  await page.waitForTimeout(500); // the pause picks lunch as the meal that eats it
  for (const d of [2, 3]) {
    const c = await center(slotCell(page, d, 1));
    await page.mouse.move(c.x, c.y, { steps: 6 });
  }
  await page.mouse.up();
  await expect(page.getByText(/leftovers on Tue lunch, Wed lunch, Thu lunch/)).toBeVisible();
  await expect(slotCell(page, 0, 2).locator(".meal-btn.empty")).toBeVisible(); // the dinner it flew over was not picked
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".meal-btn.t-leftovers")).toHaveCount(0);
});

test("a make-ahead can be moved to another day, and its meals follow", async ({ page }) => {
  test.skip(isPhone(), "mouse drag");
  await weekAhead(page, 34);
  await makeMuffins(page, 0);
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: /^Tue \d+ lunch$/ }).click();
  await dlg.getByRole("button", { name: /^Fill 1 meal$/ }).click();
  await expect(page.getByText(/leftovers on Tue lunch/)).toBeVisible();

  // drag the muffins from Monday's make-ahead cell to Wednesday's
  const item = prepCell(page, 0).locator(".prep-item .meal-btn");
  const from = await center(item);
  const to = await center(prepCell(page, 2));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText(/^Moved to Wed prep/)).toBeVisible();
  await expect(prepCell(page, 0).locator(".prep-item")).toHaveCount(0);
  await expect(prepCell(page, 2).locator(".prep-item", { hasText: "Cheese Muffins" })).toBeVisible();
  // Tuesday's lunch still finds its muffins (they are now made on Wednesday, which is after: the plan notices)
  await expect(page.locator(".notice.warn")).toContainText(/isn't cooked until/);
});

test("the make-ahead row works on a phone: each day card has it", async ({ page }) => {
  test.skip(!isPhone(), "phone layout");
  await weekAhead(page, 35);
  await expect(prepCell(page, 0)).toBeVisible();
  await expect(prepCell(page, 0).locator(".slot-label")).toContainText(/make ahead/i);
  await makeMuffins(page, 0);
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: /^Tue \d+ lunch$/ }).click();
  await dlg.getByRole("button", { name: /^Wed \d+ lunch$/ }).click();
  await dlg.getByRole("button", { name: /^Fill 2 meals$/ }).click();
  await expect(page.getByText(/leftovers on Tue lunch, Wed lunch/)).toBeVisible();
  await expect(prepCell(page, 0).locator(".prep-item")).toContainText("8 not planned yet"); // 12 made, 2 meals × 2 people
  await shot(page, "plan-make-ahead");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the shopping list buys the whole batch", async ({ page }) => {
  test.skip(isPhone(), "same data as desktop");
  await weekAhead(page, 30, { blank: false }); // the week with smoothie + muffins from the first test
  await page.getByRole("link", { name: "Shopping list" }).last().click();
  await page.getByRole("button", { name: /from the plan/ }).click();
  await expect(page.getByText("Updated from the plan")).toBeVisible();
  await expect(page.locator(".shop-item", { hasText: /flour/ })).toContainText(/300\s?g flour/); // the full batch of 12, not 2 people's worth
  await expect(page.locator(".shop-item", { hasText: /banana/ })).toBeVisible();
});
