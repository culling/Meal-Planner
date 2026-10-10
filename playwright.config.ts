import { defineConfig, devices } from "@playwright/test";
// @ts-expect-error plain JS helper
import { ensureBuilt } from "./scripts/ensure-built.mjs";

// The e2e tests run against the built web app, so make sure it is up to date (once per run).
if (!process.env.MP_E2E_BUILT) {
  ensureBuilt(import.meta.dirname);
  process.env.MP_E2E_BUILT = "1";
}

export const DEMO_URL = "http://127.0.0.1:3470"; // demo recipes, plan and shopping list
export const EMPTY_URL = "http://127.0.0.1:3471"; // brand new, no data (like a first run)

// Uses the Microsoft Edge that ships with Windows, so no browser download is needed.
const phone = { ...devices["Pixel 7"], channel: "msedge" as const };
const desktop = { ...devices["Desktop Chrome"], channel: "msedge" as const, viewport: { width: 1280, height: 860 } };

export default defineConfig({
  testDir: "./e2e",
  outputDir: ".e2e/results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: { baseURL: DEMO_URL, trace: "retain-on-failure", screenshot: "only-on-failure", locale: "en-NZ", timezoneId: "Pacific/Auckland" },
  webServer: [
    { command: "node scripts/e2e-server.mjs 3470 .e2e/data-demo --seed", url: `${DEMO_URL}/api/status`, timeout: 120_000, reuseExistingServer: false, stdout: "ignore", stderr: "pipe" },
    { command: "node scripts/e2e-server.mjs 3471 .e2e/data-empty", url: `${EMPTY_URL}/api/status`, timeout: 120_000, reuseExistingServer: false, stdout: "ignore", stderr: "pipe" },
  ],
  projects: [
    // read-only checks first, then the tests that change data
    { name: "nav-phone", testMatch: "nav.spec.ts", use: phone },
    { name: "nav-desktop", testMatch: "nav.spec.ts", use: desktop },
    { name: "shots-phone", testMatch: "shots.spec.ts", use: phone },
    { name: "shots-desktop", testMatch: "shots.spec.ts", use: desktop },
    { name: "flows", testMatch: "flows.spec.ts", use: desktop, dependencies: ["nav-phone", "nav-desktop", "shots-phone", "shots-desktop"] },
    // these change data (photos, plans) in their own corners: blank future weeks and the saved-photos folder
    { name: "photos-desktop", testMatch: "photos.spec.ts", use: desktop, dependencies: ["flows"] },
    { name: "photos-phone", testMatch: "photos.spec.ts", use: phone, dependencies: ["photos-desktop"] },
    { name: "plan-desktop", testMatch: "plan-drag.spec.ts", use: desktop, dependencies: ["photos-phone"] },
    { name: "plan-phone", testMatch: "plan-drag.spec.ts", use: phone, dependencies: ["plan-desktop"] },
    { name: "makeahead-desktop", testMatch: "makeahead.spec.ts", use: desktop, dependencies: ["plan-phone"] },
    { name: "makeahead-phone", testMatch: "makeahead.spec.ts", use: phone, dependencies: ["makeahead-desktop"] },
    // last: it changes the week start (and puts it back) and checks the plan layout
    { name: "weeks-desktop", testMatch: "weekstart.spec.ts", use: desktop, dependencies: ["makeahead-phone"] },
    { name: "weeks-phone", testMatch: "weekstart.spec.ts", use: phone, dependencies: ["weeks-desktop"] },
  ],
});
