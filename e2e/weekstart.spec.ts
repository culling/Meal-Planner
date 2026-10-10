import type { APIRequestContext, Page } from "@playwright/test";
import { expect, isPhone, shot, test } from "./helpers";

// Plan layout (days across, meals down) and choosing which day the week starts on (e.g. Saturday).
// The start day is put back to Monday afterwards so nothing else is affected.

test.describe.configure({ mode: "serial" });

const box = async (l: ReturnType<Page["locator"]>) => (await l.boundingBox())!;

/** every planned meal in every saved week, as "date/slot/recipe" — what must survive a change of start day */
async function allMeals(request: APIRequestContext): Promise<string[]> {
  const { weeks } = await (await request.get("/api/meal-plans")).json();
  const out: string[] = [];
  for (const w of weeks) {
    const view = await (await request.get(`/api/meal-plans/${w}`)).json();
    for (const d of view.days) for (const [slot, m] of Object.entries<any>(d.meals)) if (m) out.push(`${d.date}/${slot}/${m.meal.recipe ?? m.meal.type}/${m.meal.type}`);
  }
  return out.sort();
}

test("wide screens: one column per day, one row per meal", async ({ page }) => {
  test.skip(isPhone(), "the wide layout is for desktop-sized windows");
  await page.goto("/plan");
  await expect(page.locator(".day-head").first()).toBeVisible();

  const heads = await Promise.all((await page.locator(".day-head").all()).map(box));
  expect(heads).toHaveLength(7);
  // all seven days sit on one line, left to right
  for (const h of heads) expect(Math.abs(h.y - heads[0].y)).toBeLessThan(2);
  for (let i = 1; i < 7; i++) expect(heads[i].x).toBeGreaterThan(heads[i - 1].x + 50);

  // meals are rows labelled down the left edge: breakfast above lunch above dinner
  const labels = await Promise.all((await page.locator(".row-label").all()).map(box));
  expect((await page.locator(".row-label").allTextContents()).map((t) => t.toLowerCase())).toEqual(["breakfast", "lunch", "dinner", "make ahead"]);
  for (let i = 1; i < 4; i++) {
    expect(labels[i].y).toBeGreaterThan(labels[i - 1].y + 50);
    expect(Math.abs(labels[i].x - labels[0].x)).toBeLessThan(2);
  }

  // a cell is where its day's column meets its meal's row
  for (let d = 0; d < 7; d++) {
    for (let s = 0; s < 3; s++) {
      const cell = await box(page.locator(".day").nth(d).locator(".slot").nth(s));
      expect(Math.abs(cell.x - heads[d].x), `day ${d} meal ${s}: column`).toBeLessThan(3);
      expect(Math.abs(cell.y - labels[s].y), `day ${d} meal ${s}: row`).toBeLessThan(3);
    }
  }
  // the whole table fits the window: no sideways scrolling
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("phones keep readable day cards (a seven-column table would be too narrow)", async ({ page }) => {
  test.skip(!isPhone(), "phone layout");
  await page.goto("/plan");
  const heads = await Promise.all((await page.locator(".day-head").all()).map(box));
  for (let i = 1; i < 7; i++) {
    expect(heads[i].y).toBeGreaterThan(heads[i - 1].y + 100); // stacked down the page
    expect(Math.abs(heads[i].x - heads[0].x)).toBeLessThan(2);
  }
  await expect(page.locator(".row-label").first()).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("choose Saturday as the first day: the plan regroups, nothing is lost, and it can be undone", async ({ page, request }) => {
  test.skip(isPhone(), "changed once, on the desktop project");
  const before = await allMeals(request);
  expect(before.length).toBeGreaterThan(5); // the earlier tests left meals in several weeks

  await page.goto("/settings");
  await page.locator("#week-start").selectOption("saturday");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Start each week on Saturday?");
  await page.getByRole("dialog").getByRole("button", { name: "Change it" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();

  await page.goto("/plan");
  await expect(page.locator(".day-head").first()).toContainText(/^Sat/);
  await expect(page.locator(".day-head").last()).toContainText(/^Fri/);
  await expect(page.locator(".day.today")).toHaveCount(1); // today is inside the week that is shown
  const title = await page.locator(".week-nav .title small").innerText();
  expect(title).toMatch(/\d/);
  await shot(page, "plan-saturday");

  // the same meals on the same dates, just filed under different weeks
  expect(await allMeals(request)).toEqual(before);

  // the next week starts a week later, on a Saturday again
  const firstDay = (await page.locator(".day-head .name").first().innerText()).trim();
  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page.locator(".day-head").first()).toContainText(/^Sat/);
  expect((await page.locator(".day-head .name").first().innerText()).trim()).not.toBe(firstDay);

  // the shopping list follows the same week
  await page.goto("/shopping");
  await expect(page.locator(".week-nav .title small")).toBeVisible();

  // back to Monday: everything returns to where it was
  await page.goto("/settings");
  await page.locator("#week-start").selectOption("monday");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Change it" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.goto("/plan");
  await expect(page.locator(".day-head").first()).toContainText(/^Mon/);
  expect(await allMeals(request)).toEqual(before);
});

test.afterAll(async ({ request }) => {
  await request.put("/api/settings", { data: { weekStartsOn: "monday" } }); // never leave the demo on Saturday
});
