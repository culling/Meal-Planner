import type { Locator, Page } from "@playwright/test";
import { expect, isPhone, mondayIn, shot, test } from "./helpers";

// Planning by dragging: extend a meal over other slots with the round handle, Ctrl+drag to duplicate, drag to move,
// and "use this meal again" for leftovers (also across into next week). Each test uses its own blank week.

test.describe.configure({ mode: "serial" });

const day = (page: Page, i: number) => page.locator(".day").nth(i);
const slotCell = (page: Page, d: number, s: number) => day(page, d).locator(".slot").nth(s); // s: 0 breakfast, 1 lunch, 2 dinner
const meals = (page: Page) => page.locator(".meal-btn:not(.empty)");

/** Open a blank week n weeks from now (the phone project uses weeks further out so it never meets the desktop's changes). */
async function weekAhead(page: Page, n: number) {
  await page.goto(`/plan/${mondayIn(n + (isPhone() ? 10 : 0))}`);
  await expect(page).toHaveURL(/\/plan\/\d{4}-\d{2}-\d{2}$/);
  await expect(page.locator(".day-head").first()).toBeVisible(); // the plan has loaded
  await expect(meals(page)).toHaveCount(0);
}

async function putMeal(page: Page, d: number, s: number, recipe: string) {
  await slotCell(page, d, s).locator(".meal-btn.empty").click();
  await page.getByRole("button", { name: "Choose a recipe" }).click();
  await page.getByRole("dialog").getByRole("tab", { name: "All" }).click(); // the picker starts on mains
  await page.locator(".rcard", { hasText: recipe }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(slotCell(page, d, s).locator(".meal-btn", { hasText: recipe })).toBeVisible();
}

async function center(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Press on `from`, sweep over each of `over`, and let go on the last one. */
async function sweep(page: Page, from: Locator, over: Locator[], opts: { ctrl?: boolean; dwell?: number } = {}) {
  const a = await center(from);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  if (opts.ctrl) await page.keyboard.down("Control");
  for (const o of over) {
    await o.scrollIntoViewIfNeeded();
    const c = await center(o);
    await page.mouse.move(c.x, c.y, { steps: 6 });
    if (opts.dwell && o !== over[over.length - 1]) await page.waitForTimeout(opts.dwell); // pause, to include a slot of another meal
  }
  await page.mouse.up();
  if (opts.ctrl) await page.keyboard.up("Control");
}

const handleOf = async (page: Page, cell: Locator) => {
  await cell.hover();
  return cell.locator(".fill-handle");
};

test.describe("with a mouse", () => {
  test.beforeEach(({}, info) => test.skip(isPhone(), "mouse drags are tested on the desktop project"));

  test("drag the handle down a column to repeat a lunch for the rest of the week, then undo", async ({ page }) => {
    await weekAhead(page, 2);
    await putMeal(page, 0, 1, "Cheese on Toast");
    await expect(meals(page)).toHaveCount(1);

    const handle = await handleOf(page, slotCell(page, 0, 1));
    await sweep(page, handle, [1, 2, 3, 4].map((d) => slotCell(page, d, 1)));
    await expect(meals(page)).toHaveCount(5);
    await expect(page.getByText(/Cheese on Toast.* repeated on 4 slots/)).toBeVisible(); // 4 days is too long to be leftovers
    for (let d = 1; d <= 4; d++) await expect(slotCell(page, d, 1).locator(".meal-btn", { hasText: "Cheese on Toast" })).toBeVisible();
    await shot(page, "plan-fill");

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(meals(page)).toHaveCount(1);
    await page.reload();
    await expect(meals(page)).toHaveCount(1); // undone for real, not just on screen
  });

  test("a short fill makes leftovers, and can be switched to cooking each time", async ({ page }) => {
    await weekAhead(page, 8);
    await putMeal(page, 0, 2, "Butter Chicken"); // Monday dinner
    const handle = await handleOf(page, slotCell(page, 0, 2));
    await sweep(page, handle, [slotCell(page, 1, 1), slotCell(page, 1, 2)], { dwell: 450 }); // Tuesday lunch (pause on it) and dinner
    await expect(page.getByText(/leftovers on Tue lunch, Tue dinner/)).toBeVisible();
    await expect(page.getByText(/now cooking \d+ portions/)).toBeVisible();
    await expect(slotCell(page, 1, 1).locator(".meal-btn", { hasText: "Leftovers" })).toBeVisible();
    await expect(slotCell(page, 0, 2).locator(".meal-btn", { hasText: /\+\d+ extra/ })).toBeVisible(); // Monday's dinner cooks the extra
    await expect(page.locator(".notice.warn")).toHaveCount(0); // plenty cooked, all within the fridge life

    await page.getByRole("button", { name: "Cook each time instead" }).click();
    await expect(slotCell(page, 1, 1).locator(".meal-btn", { hasText: "Cook" })).toBeVisible();
    await expect(slotCell(page, 1, 1).locator(".meal-btn", { hasText: "Leftovers" })).toHaveCount(0);
  });

  test("sweeping a mouse diagonally doesn't grab the slots in between", async ({ page }) => {
    await weekAhead(page, 12);
    await putMeal(page, 0, 1, "Cheese on Toast");
    const handle = await handleOf(page, slotCell(page, 0, 1));
    await sweep(page, handle, [slotCell(page, 0, 2), slotCell(page, 1, 0), slotCell(page, 1, 1)]); // no pauses
    await expect(page.getByText(/leftovers on Tue lunch/)).toBeVisible();
    await expect(meals(page)).toHaveCount(2);
  });

  test("Ctrl+drag duplicates a meal, a plain drag moves it", async ({ page }) => {
    await weekAhead(page, 3);
    await putMeal(page, 0, 1, "Cheese on Toast");
    const source = slotCell(page, 0, 1).locator(".meal-btn");

    await sweep(page, source, [slotCell(page, 2, 0).locator(".meal-btn")], { ctrl: true });
    await expect(meals(page)).toHaveCount(2);
    await expect(slotCell(page, 0, 1).locator(".meal-btn", { hasText: "Cheese on Toast" })).toBeVisible(); // still there
    await expect(slotCell(page, 2, 0).locator(".meal-btn", { hasText: "Cheese on Toast" })).toBeVisible(); // and a copy

    await sweep(page, slotCell(page, 2, 0).locator(".meal-btn"), [slotCell(page, 3, 0).locator(".meal-btn")]); // no Ctrl: move
    await expect(meals(page)).toHaveCount(2);
    await expect(slotCell(page, 2, 0).locator(".meal-btn.empty")).toBeVisible();
    await expect(slotCell(page, 3, 0).locator(".meal-btn", { hasText: "Cheese on Toast" })).toBeVisible();
    await expect(page.getByText(/^Moved to/)).toBeVisible();

    // a click (no drag) still opens the meal
    await slotCell(page, 0, 1).locator(".meal-btn").click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("click the handle to tap slots one by one, then apply", async ({ page }) => {
    await weekAhead(page, 4);
    await putMeal(page, 0, 2, "Butter Chicken");
    await (await handleOf(page, slotCell(page, 0, 2))).click();
    await expect(page.getByRole("region", { name: "Choose where to copy this meal" })).toBeVisible();
    await slotCell(page, 1, 1).click(); // Tuesday lunch
    await slotCell(page, 2, 2).click(); // Wednesday dinner
    await slotCell(page, 2, 2).click(); // changed my mind
    await slotCell(page, 1, 2).click(); // Tuesday dinner
    await expect(page.locator(".slot.fill-picked")).toHaveCount(2);
    await shot(page, "plan-fill-choose");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText(/leftovers on Tue lunch, Tue dinner/)).toBeVisible();
    await expect(slotCell(page, 2, 2).locator(".meal-btn.empty")).toBeVisible();
  });

  test("Escape cancels a drag and nothing changes", async ({ page }) => {
    await weekAhead(page, 5);
    await putMeal(page, 0, 1, "Cheese on Toast");
    const handle = await handleOf(page, slotCell(page, 0, 1));
    const a = await center(handle);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    const c = await center(slotCell(page, 1, 1));
    await page.mouse.move(c.x, c.y, { steps: 5 });
    await expect(page.locator(".drag-ghost")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator(".drag-ghost")).toHaveCount(0);
    await expect(meals(page)).toHaveCount(1);
  });
});

test.describe("with taps and the dialog (works on a phone too)", () => {
  test("the last day's dinner feeds lunch and dinner of the NEXT 7 days as leftovers", async ({ page }) => {
    await weekAhead(page, 6);
    await putMeal(page, 6, 2, "Butter Chicken"); // dinner on the last day shown
    const last = (await slotCell(page, 6, 2).getAttribute("data-slot-date"))!;
    const after = (n: number) => {
      const d = new Date(`${last}T12:00:00`);
      d.setDate(d.getDate() + n);
      return { day: d.toLocaleDateString("en-NZ", { weekday: "short" }), date: d.getDate() };
    };
    const [a, b] = [after(1), after(2)];
    await slotCell(page, 6, 2).locator(".meal-btn").click();
    await page.getByText("Use this meal again (leftovers or another cook)").click();
    await page.getByRole("button", { name: new RegExp(`${a.day} ${a.date} lunch`) }).click(); // the next two days, off the page
    await page.getByRole("button", { name: new RegExp(`${b.day} ${b.date} dinner`) }).click();
    await page.getByRole("button", { name: /^Fill 2 meals$/ }).click();

    await expect(page.getByText(new RegExp(`leftovers on ${a.day} lunch, ${b.day} dinner`))).toBeVisible();
    await expect(page.getByText(/now cooking \d+ portions/)).toBeVisible();
    await expect(slotCell(page, 6, 2).locator(".meal-btn", { hasText: /\+\d+ extra/ })).toBeVisible();

    await page.getByRole("button", { name: "Show those days" }).click();
    await expect(slotCell(page, 0, 1).locator(".meal-btn", { hasText: "Leftovers" })).toBeVisible();
    await expect(slotCell(page, 1, 2).locator(".meal-btn", { hasText: "Leftovers" })).toBeVisible();
    await expect(slotCell(page, 1, 1).locator(".meal-btn.empty")).toBeVisible(); // the second day's lunch was skipped, as asked
    await expect(page.locator(".notice.warn")).toHaveCount(0);
    await shot(page, "plan-leftovers-next-week");

    // and the cook meal in the 7 days before still has its leftovers accounted for
    await page.getByRole("button", { name: "Previous week" }).click();
    await expect(page.locator(".notice.warn")).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).isVisible().catch(() => false);
  });

  test("tap the handle, tap slots, apply (a phone has no mouse to drag)", async ({ page }) => {
    await weekAhead(page, 9);
    await putMeal(page, 0, 1, "Cheese on Toast");
    const handle = slotCell(page, 0, 1).locator(".fill-handle");
    await slotCell(page, 0, 1).hover().catch(() => undefined);
    await handle.dispatchEvent("pointerdown", { button: 0, pointerType: "touch", isPrimary: true });
    await handle.dispatchEvent("pointerup", { button: 0, pointerType: "touch", isPrimary: true });
    await expect(page.getByRole("region", { name: "Choose where to copy this meal" })).toBeVisible();
    for (const d of [1, 2]) await slotCell(page, d, 1).click();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(meals(page)).toHaveCount(3);
    if (isPhone()) await shot(page, "plan-fill-choose-touch");
  });
});

// Real touch events (finger down, move, up) sent through the browser, to check the phone interactions:
// the handle drags straight away; a meal is picked up by holding it for a moment (a quick swipe still scrolls).
async function touchDrag(page: Page, from: Locator, via: Locator[], opts: { holdMs?: number; dwellMs?: number } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const a = await center(from);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: a.x, y: a.y }] });
  if (opts.holdMs) await page.waitForTimeout(opts.holdMs);
  let last = a;
  for (const v of via) {
    const c = await center(v);
    for (let i = 1; i <= 4; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: last.x + ((c.x - last.x) * i) / 4, y: last.y + ((c.y - last.y) * i) / 4 }] });
    }
    last = c;
    if (opts.dwellMs && v !== via[via.length - 1]) await page.waitForTimeout(opts.dwellMs);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test.describe("with a finger", () => {
  test.beforeEach(() => test.skip(!isPhone(), "touch is tested on the phone project"));

  test("drag the round handle with a finger: pausing on another meal's slot includes it", async ({ page }) => {
    await weekAhead(page, 11);
    await putMeal(page, 0, 1, "Cheese on Toast");
    await touchDrag(page, slotCell(page, 0, 1).locator(".fill-handle"), [slotCell(page, 0, 2), slotCell(page, 1, 1)], { dwellMs: 450 });
    await expect(page.getByText(/leftovers on Mon dinner, Tue lunch/)).toBeVisible();
    await expect(meals(page)).toHaveCount(3);
    await shot(page, "plan-fill-touch");
  });

  test("sweeping past other meals' slots without stopping only picks the slot you let go on", async ({ page }) => {
    await weekAhead(page, 14);
    await putMeal(page, 0, 1, "Cheese on Toast");
    // Monday lunch → (over Monday dinner and Tuesday breakfast without stopping) → Tuesday lunch
    await touchDrag(page, slotCell(page, 0, 1).locator(".fill-handle"), [slotCell(page, 0, 2), slotCell(page, 1, 0), slotCell(page, 1, 1)]);
    await expect(page.getByText(/leftovers on Tue lunch/)).toBeVisible();
    await expect(page.getByText(/Mon dinner|Tue breakfast/)).toHaveCount(0);
    await expect(meals(page)).toHaveCount(2);
    await expect(slotCell(page, 0, 2).locator(".meal-btn.empty")).toBeVisible();
    await expect(slotCell(page, 1, 0).locator(".meal-btn.empty")).toBeVisible();
  });

  test("hold a meal to pick it up and drag it somewhere else", async ({ page }) => {
    await weekAhead(page, 12);
    await putMeal(page, 0, 1, "Cheese on Toast");
    await touchDrag(page, slotCell(page, 0, 1).locator(".meal-btn"), [slotCell(page, 1, 0)], { holdMs: 650 });
    await expect(page.getByText(/^Moved to/)).toBeVisible();
    await expect(slotCell(page, 0, 1).locator(".meal-btn.empty")).toBeVisible();
    await expect(slotCell(page, 1, 0).locator(".meal-btn", { hasText: "Cheese on Toast" })).toBeVisible();
  });

  test("a quick swipe over a meal does not move it (it scrolls the page)", async ({ page }) => {
    await weekAhead(page, 13);
    await putMeal(page, 0, 1, "Cheese on Toast");
    await touchDrag(page, slotCell(page, 0, 1).locator(".meal-btn"), [slotCell(page, 1, 0)], { holdMs: 0 });
    await expect(slotCell(page, 0, 1).locator(".meal-btn", { hasText: "Cheese on Toast" })).toBeVisible();
    await expect(meals(page)).toHaveCount(1);
  });
});
