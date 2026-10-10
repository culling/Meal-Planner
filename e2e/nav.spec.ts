import type { Locator, Page } from "@playwright/test";
import { appReady, expect, isPhone, test } from "./helpers";

// Clicking a link must show the page straight away (never a blank screen with only the URL changing),
// and refreshing must show the same page. Every test also fails on any browser error (see helpers.ts).

interface Dest {
  name: string;
  /** reach it by clicking, from wherever we are */
  go: (page: Page) => Promise<void>;
  url: RegExp;
  /** something that must be on screen when the page is showing properly */
  shows: (page: Page) => Locator;
}

const heading = (page: Page, text: string) => page.getByRole("heading", { level: 1, name: text, exact: true });
const weekTitle = (page: Page, text: RegExp) => page.locator(".week-nav .title").filter({ hasText: text });

function nav(page: Page, name: string): Locator {
  const bar = isPhone() ? page.locator(".tabbar") : page.locator(".sidebar");
  return bar.getByRole("link", { name, exact: true });
}

/** Phone: the less-used pages are listed on the More tab. */
const viaMore = (link: RegExp) => async (page: Page) => {
  if (!/\/more$/.test(page.url())) await nav(page, "More").click();
  await page.locator(".main").getByRole("link", { name: link }).click();
};

function destinations(): Dest[] {
  const phone = isPhone();
  const main: Dest[] = [
    { name: "Recipes", go: (p) => nav(p, "Recipes").click(), url: /\/$/, shows: (p) => heading(p, "Recipes") },
    { name: "Plan", go: (p) => nav(p, "Plan").click(), url: /\/plan$/, shows: (p) => weekTitle(p, /Week \d+/) },
    { name: "Add recipe", go: (p) => nav(p, phone ? "Add" : "Add recipe").click(), url: /\/import$/, shows: (p) => heading(p, "Add a recipe") },
    { name: "Shopping list", go: (p) => nav(p, phone ? "Shop" : "Shopping list").click(), url: /\/shopping$/, shows: (p) => weekTitle(p, /Shopping list/) },
  ];
  const more: Dest[] = phone
    ? [
        { name: "More", go: (p) => nav(p, "More").click(), url: /\/more$/, shows: (p) => heading(p, "More") },
        { name: "Nutrition data", go: viaMore(/Nutrition data/), url: /\/nutrition$/, shows: (p) => heading(p, "Nutrition data") },
        { name: "Settings", go: viaMore(/Settings/), url: /\/settings$/, shows: (p) => heading(p, "Settings") },
        { name: "Write a recipe", go: viaMore(/Write a recipe/), url: /\/new$/, shows: (p) => heading(p, "New recipe") },
      ]
    : [
        { name: "Nutrition data", go: (p) => nav(p, "Nutrition data").click(), url: /\/nutrition$/, shows: (p) => heading(p, "Nutrition data") },
        { name: "Settings", go: (p) => nav(p, "Settings").click(), url: /\/settings$/, shows: (p) => heading(p, "Settings") },
        { name: "Write a recipe", go: (p) => nav(p, "Write a recipe").click(), url: /\/new$/, shows: (p) => heading(p, "New recipe") },
      ];
  return [...main, ...more];
}

async function expectShowing(page: Page, d: Dest) {
  await expect(page, `${d.name}: URL`).toHaveURL(d.url);
  await expect(d.shows(page), `${d.name}: page content (a blank screen fails here)`).toBeVisible();
  await expect(page.locator("#root"), `${d.name}: blank screen`).not.toBeEmpty();
  expect((await page.locator(".main").innerText()).trim().length, `${d.name}: page text`).toBeGreaterThan(10);
}

for (const [label, base] of [
  ["with recipes", undefined],
  ["on a brand-new empty install", "http://127.0.0.1:3471"],
] as const) {
  test.describe(`navigation ${label}`, () => {
    if (base) test.use({ baseURL: base });

    test("clicking through every page shows each page, and a refresh shows the same page", async ({ page }) => {
      await page.goto("/");
      await appReady(page);
      const dests = destinations();

      // forwards, then backwards: every page is left for a different page both ways
      for (const d of [...dests, ...[...dests].reverse()]) {
        await d.go(page);
        await expectShowing(page, d);
        await page.reload();
        await appReady(page);
        await expectShowing(page, d);
      }
    });

    test("the browser Back and Forward buttons work", async ({ page }) => {
      await page.goto("/");
      await appReady(page);
      const dests = destinations().slice(0, 4);
      for (const d of dests.slice(1)) {
        await d.go(page);
        await expectShowing(page, d);
      }
      for (const d of [...dests.slice(0, -1)].reverse()) {
        await page.goBack();
        await expectShowing(page, d);
      }
      await page.goForward();
      await expectShowing(page, dests[1]);
    });

    test("opening an address directly shows the page (no blank screen on a deep link)", async ({ page }) => {
      for (const [url, shows] of [
        ["/plan", (p: Page) => weekTitle(p, /Week \d+/)],
        ["/shopping", (p: Page) => weekTitle(p, /Shopping list/)],
        ["/nutrition", (p: Page) => heading(p, "Nutrition data")],
        ["/settings", (p: Page) => heading(p, "Settings")],
        ["/import", (p: Page) => heading(p, "Add a recipe")],
        ["/new", (p: Page) => heading(p, "New recipe")],
        ["/more", (p: Page) => heading(p, "More")],
      ] as const) {
        await page.goto(url);
        await expect(shows(page), url).toBeVisible();
      }
    });

    test("an unknown address shows a friendly message, not a blank page", async ({ page }) => {
      await page.goto("/no/such/page");
      await expect(page.getByText("Nothing here")).toBeVisible();
      await page.getByRole("link", { name: "Back to recipes" }).click();
      await expect(heading(page, "Recipes")).toBeVisible();
    });
  });
}

test.describe("navigation inside the demo recipes", () => {
  test("recipe card → recipe → back → plan week arrows → shopping week arrows", async ({ page }) => {
    await page.goto("/");
    await page.locator(".rcard", { hasText: "Butter Chicken" }).click();
    await expect(page).toHaveURL(/\/recipes\/butter-chicken$/);
    await expect(heading(page, "Butter Chicken")).toBeVisible();
    await page.reload();
    await expect(heading(page, "Butter Chicken")).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(heading(page, "Recipes")).toBeVisible();

    await nav(page, "Plan").click();
    const title = page.locator(".week-nav .title");
    const week = Number((await title.innerText()).match(/Week (\d+)/)![1]);
    await page.getByRole("button", { name: "Next week" }).click();
    await expect(page).toHaveURL(/\/plan\/\d{4}-W\d{2}$/);
    await expect(title).toContainText(`Week ${week + 1}`);
    await page.getByRole("button", { name: "Previous week" }).click();
    await expect(title).toContainText(`Week ${week}`);
    await page.getByRole("button", { name: "Next week" }).click();
    await page.reload();
    await expect(weekTitle(page, /Week \d+/)).toBeVisible();

    await page.locator(".main").getByRole("link", { name: "Shopping list", exact: true }).click();
    await expect(page).toHaveURL(/\/shopping\/\d{4}-W\d{2}$/);
    await expect(weekTitle(page, /Shopping list/)).toBeVisible();
  });

  test("recipe → Edit → Cancel returns to the recipe; tag chip opens a filtered list", async ({ page }) => {
    await page.goto("/recipes/cheese-on-toast");
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("link", { name: /Edit recipe/ }).click();
    await expect(page).toHaveURL(/\/recipes\/cheese-on-toast\/edit$/);
    await expect(heading(page, "Edit recipe")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(heading(page, "Cheese on Toast")).toBeVisible();
    await page.getByRole("link", { name: "#quick" }).click();
    await expect(page).toHaveURL(/\/\?tags=quick/);
    await expect(page.locator(".rcard")).toHaveCount(1);
  });
});
