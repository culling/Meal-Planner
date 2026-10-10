// Save recipe pages as HTML fixtures for the import tests.
// Usage: pnpm --filter @mp/core exec tsx scripts/fetch-fixture.mts <url> [<url> ...]
// Uses the app's polite fetcher (robots.txt check, 2 s between requests, identifying User-Agent).
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { PoliteFetcher } from "../src/webfetch.ts";

const cfg = loadConfig();
const fetcher = new PoliteFetcher(cfg);
const dir = path.join(import.meta.dirname, "..", "test", "fixtures");
fs.mkdirSync(dir, { recursive: true });

for (const url of process.argv.slice(2)) {
  try {
    const html = await fetcher.html(url);
    const name = new URL(url).pathname.replace(/^\/|\/$/g, "").replace(/\//g, "_") + ".html";
    fs.writeFileSync(path.join(dir, name), html);
    console.log(`saved ${name} (${html.length} bytes)`);
  } catch (e) {
    console.log(`FAILED ${url}: ${(e as Error).message}`);
  }
}
