import fs from "node:fs";
import path from "node:path";
import { expect, test as base, type Page } from "@playwright/test";

export const SHOT_DIR = path.resolve(import.meta.dirname, "..", ".e2e", "screenshots");

/** Every test fails if the page threw an error, logged a console error, or the API answered with a server error. */
export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
      page.on("console", (m) => m.type() === "error" && problems.push(`console error: ${m.text()}`));
      page.on("response", (r) => r.status() >= 500 && problems.push(`HTTP ${r.status()} ${r.url()}`));
      await use(problems);
      expect(problems, "errors seen in the browser").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export const isPhone = () => test.info().project.name.endsWith("phone");

/**
 * Save a screenshot as <phone|desktop>-<name>.png for the compare script. Full pages are captured by making the window
 * as tall as the page, so fixed bars (the tab bar) sit at the bottom instead of floating mid-image.
 */
export async function shot(page: Page, name: string, opts: { full?: boolean } = {}) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const label = isPhone() ? "phone" : "desktop";
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts?.ready);
  const size = page.viewportSize()!;
  const full = opts.full ?? true;
  if (full) {
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: size.width, height: Math.min(Math.max(h, size.height), 6000) });
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: path.join(SHOT_DIR, `${label}-${name}.png`), animations: "disabled", caret: "hide" });
  if (full) await page.setViewportSize(size);
}

/** Wait for the app to finish its first render (not a blank page). */
export async function appReady(page: Page) {
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.locator(".main")).toBeVisible();
}
