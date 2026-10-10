# Meal Planner

A private recipe collection and weekly meal planner for home. Recipes, plans and shopping lists are plain Markdown files you can open in any text editor. It runs on your computer and is used from a phone or computer on your home Wi-Fi. AI features (reading cookbook photos, working out nutrition) use **local models through Ollama** — nothing leaves your machine.

## Start it

1. Double-click **`start.bat`** (first run builds the web app), or run `npm run start` (after a one-off `pnpm install`).
2. The window prints two addresses:
   - On the computer: `http://localhost:3456`
   - On your phone (same Wi-Fi): `http://<this-computer's-IP>:3456` — e.g. `http://192.168.0.66:3456`
3. If the phone can't connect, allow it through Windows Firewall (once, in an *administrator* PowerShell):
   ```powershell
   New-NetFirewallRule -DisplayName "Meal Planner" -Direction Inbound -Protocol TCP -LocalPort 3456 -Action Allow -Profile Private
   ```
   On Chrome (Pixel): ⋮ → **Add to Home screen**.
4. Keep Ollama running if you want the photo and nutrition features.

There is deliberately no login: the app is for your trusted home network. Don't expose the port to the internet.

## Where your data lives

`./data` in this folder (change with `DATA_DIR` in `.env`). It has its own git repository, auto-committed a few seconds after every change, so there is full version history (also visible per recipe in the app: ⋯ → Version history).

```
data/
  settings.md            people, meals, AI models…
  nutrition-db.md        every food's per-100 g nutrition (view/edit in the app)
  recipes/<slug>/recipe.md + images/
  photos/<name>/photo.md + images/   saved photos waiting to be read (or already used)
  meal-plans/2026-W41.md
  shopping-lists/2026-W41.md
  .trash/  .cache/       deleted recipes · thumbnails/uploads (safe to delete)
```

Edit any file in a text editor while the app runs — it reloads automatically, and the app never overwrites a file that changed under it without telling you.
Back up by copying the folder (or `git push` it somewhere private).

### Testing without touching real data
Point at another folder: `DATA_DIR=./test-data pnpm start` (PowerShell: `$env:DATA_DIR="./test-data"; pnpm start`). All automated tests use temporary folders. `packages/core/scripts/seed-demo.mts <empty-dir>` fills a scratch folder with demo recipes.

## Features

- **Saved photos**: take a photo with your phone's camera or pick pictures from the gallery/computer, give it a name, and **save it for later** — nothing needs the AI. Read it whenever you like (now, or later with a different model chosen just for that reading), or **type it in yourself with the photo beside the form**. Photos live in `data/photos/<name>/` as plain files; when one becomes a recipe its pages are kept as the recipe's source pages.
- **Import** a recipe from a link (reads the site's structured recipe data, notes and storage advice), from several pasted links, or from photos of a cookbook page (local vision model, or your LightOnOCR tool + a text model). You always review before anything is saved; uncertain fields are outlined.
- **Nutrition**: uses the page's numbers when present; otherwise the local AI works it out from the ingredients. Every AI-filled ingredient is marked with an orange **?** until someone edits it (then it becomes "entered by hand" and the ? disappears). The **Nutrition data** page lists/edits every food.
- **Leftovers**: fridge/freezer life from the recipe's notes; the plan tracks portions, warns when a leftovers meal is past its safe date or uses more than exists, and can freeze portions.
- **Filters**: calories, time, leftover days, freezable, tags/cuisine/course/diet, favourites, hidden, rating, "not cooked lately", nutrition source, free text.
- **Plan**: drag a meal's round handle along a row of slots to extend it (e.g. lunch for the rest of the week), Ctrl-drag a meal to duplicate it, drag to move it; dinner on Sunday can feed Monday's lunch and Tuesday's dinner (leftovers, even into next week — it cooks enough for everyone). Works with a finger too (hold a meal to pick it up) and with taps; every change has an Undo. The week can start on any day you choose in Settings (e.g. Saturday). On a wide screen the plan is a table with a column per day and a row per meal (breakfast, lunch, dinner); on a phone each day is a card. **Make ahead**: cook something on one day without eating it that day — a row under the meals — then choose which later meals eat it (muffins on Saturday for the week's lunches; it warns if a meal would eat it past its safe date, and portions can be frozen). Breakfast/lunch/dinner per day; people can be set per week, day and meal (the UI always shows where a number came from); quantities scale; daily calories per person; mark cooked → cook log; copy week; suggest dinners.
- **Shopping list** generated from the week's cook meals, combined and scaled, tickable on your phone.
- **MCP server** so Claude Desktop / Claude Code can search recipes, plan the week, etc.

## MCP (Claude Desktop / Claude Code)

It uses the same data folder as the web app and works without the web app running. Use the exact path of this folder.

Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "meal-planner": {
      "command": "node",
      "args": ["C:/Users/culli/code/Meal Planner/packages/mcp/run.mjs"]
    }
  }
}
```
Claude Code:
```
claude mcp add meal-planner -- node "C:/Users/culli/code/Meal Planner/packages/mcp/run.mjs"
```
Tools: `save_recipe_photo`, `list_recipe_photos`, `read_recipe_photo`, `copy_meal`, `search_recipes`, `get_recipe`, `create_recipe`, `update_recipe`, `import_recipe_from_url`, `import_recipe_from_image` (file paths on this computer), `add_recipe_note`, `set_favorite`, `set_hidden`, `recalculate_nutrition`, `get_meal_plan`, `set_meal`, `set_people`, `mark_meal_cooked`, `list_available_leftovers`, `suggest_meal_plan`, `generate_shopping_list`, `get_settings`, `update_settings`. Resources: `recipe://{slug}`, `mealplan://{week}`, `settings://`.

## Settings via `.env`

See `.env.example`: `DATA_DIR`, `PORT`, `HOST`, `OLLAMA_URL`, `LIGHTONOCR_DIR`, `GIT_AUTOCOMMIT`. Models are chosen in the app's Settings page.

## Development

```
pnpm dev            # API on :3456 + Vite on :5173 (hot reload; open :5173)
npm run test:unit   # unit + API + MCP tests
npm run test:e2e    # end-to-end browser tests (below)
npm run test:all    # both
pnpm typecheck
```
Packages: `core` (everything except HTTP), `server` (Fastify REST API + serves the web app), `web` (React + Vite), `mcp`.
Live model checks: `pnpm --filter @mp/core exec tsx scripts/live-check.mts nutrition|photo`.
Save fixture pages: `pnpm --filter @mp/core exec tsx scripts/fetch-fixture.mts <url>`.

### End-to-end tests and screenshots

`npm run test:e2e` drives a real browser (the Microsoft Edge that comes with Windows — nothing to download) against **throwaway copies of the app** on ports 3470 (demo recipes, a plan, a shopping list) and 3471 (empty, like a first run). Their data lives in `.e2e/` and is wiped each run; your real `data/` is never touched. It builds the web app first if it's out of date.

- `e2e/nav.spec.ts` — clicks through every page (phone tab bar and desktop sidebar), checks each page really shows (no blank screen), reloads, uses Back/Forward, deep links and unknown addresses — with data and on an empty install. Every e2e test also fails on any browser error.
- `e2e/flows.spec.ts` — real journeys: write a recipe, search/filters, favourite/hide, plan a meal, people overrides, cook extra + leftovers, mark cooked, shopping list ticks, the nutrition "?" markers, notes/rating/edit, importing from a link (mocked page), settings.
- `e2e/photos.spec.ts` — saving photos (camera and gallery buttons), naming, reading later with a chosen model, typing it in, failures, delete. Set `LIVE_AI=1` to also read the real `_reference/Daal Curry.jpg` with your local model.
- `e2e/weekstart.spec.ts` — the plan layout (measured on screen) and switching the week start to Saturday and back without losing a meal.
- `e2e/makeahead.spec.ts` — cooking ahead: smoothies drunk tomorrow, muffins cooked tomorrow and eaten later in the week, none eaten on the cooking day; freezing, too-late warnings, drag-to-eat, move, shopping.
- `e2e/plan-drag.spec.ts` — the fill handle, Ctrl-drag, move, choose-slots mode, leftovers across weeks, undo — with a real mouse and real touch events.
- `e2e/shots.spec.ts` — screenshots of every page and main dialog at phone (Pixel 7) and desktop size.

**Screenshots in `docs/screenshots/`** are refreshed after every run by `scripts/compare-screenshots.mts`, which only replaces an image when more than a threshold of its pixels changed (default **3 %**), so tiny rendering differences don't create noise. Change the limit with, in priority order: `--threshold N`, the `SCREENSHOT_THRESHOLD` environment variable, or `thresholdPercent` in `e2e/screenshot-config.json`.
```
npm run screenshots:compare -- --threshold 5      # run the comparison on its own
SCREENSHOT_THRESHOLD=1 npm run test:e2e           # stricter for one run
SKIP_SCREENSHOT_UPDATE=1 npm run test:e2e         # run the tests without touching docs/
```
To look at a failure: `npx playwright show-report` (traces and screenshots are kept for failed tests).

## Copyright

Imported recipes belong to their authors. The source (link or book + page) is stored with each and shown on the recipe. Only URLs you paste are fetched — never crawled — at most one request per 2 s per site, with an identifying User-Agent, after checking robots.txt. There is no sharing or publishing feature.
