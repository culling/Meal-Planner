# Recipe & Meal Planner — Build Specification

This document is a build brief for a Claude Code session. It describes a personal, single-user app for storing recipes and building weekly meal plans. Read the whole document before writing code. Section 15 lists open decisions; ask the user about those before implementing the affected parts.

---

## 1. Summary

1. Store recipes as Markdown files (one folder per recipe, with its images).
2. Import recipes three ways:
   1. From a URL (primary target: RecipeTin Eats, by Nagi Maehashi).
   2. From one or more photos of a recipe book page (OCR + structured extraction).
   3. Manual entry.
3. Fill in missing nutrition data by calculating it from the ingredients.
4. Record how long leftovers keep (fridge and freezer).
5. Filter recipes by calories per serving, leftover life, time, tags, favourite, hidden.
6. Build weekly meal plans with a people count that can be set per week, per day and per meal.
7. Track leftovers produced by cooked meals and warn when a planned leftover meal is past its safe date.
8. Expose everything through a web UI, a REST API and an MCP server.
9. Language: TypeScript everywhere.

---

## 2. Glossary

1. **Markdown**: plain-text format with light formatting (`#` headings, `-` lists).
2. **Frontmatter**: a YAML block between `---` lines at the top of a Markdown file. Holds structured fields (numbers, booleans, lists).
3. **YAML**: a plain-text format for structured data (`key: value`).
4. **Slug**: a URL-safe identifier made from a title, e.g. `butter-chicken`.
5. **OCR (Optical Character Recognition)**: converting text in an image into machine-readable text.
6. **JSON-LD**: structured data embedded in a web page's HTML inside `<script type="application/ld+json">`. Many recipe sites publish a schema.org `Recipe` object this way.
7. **schema.org Recipe**: a standard vocabulary for recipe data (ingredients, steps, times, nutrition).
8. **MCP (Model Context Protocol)**: a protocol that lets AI clients (Claude Desktop, Claude Code) call an app's functions ("tools") and read its data ("resources").
9. **stdio transport**: MCP communication over a process's standard input/output; used when the client launches the server locally.
10. **REST API**: HTTP endpoints the web UI calls (`GET /api/recipes`, etc.).
11. **Serving**: one portion as defined by the recipe's yield.
12. **Index**: an in-memory or cached copy of recipe data used for fast search. Derived from the Markdown files; never the source of truth.
13. **ISO week**: week numbering standard (ISO 8601). Format `2026-W41`.

---

## 3. Constraints and principles

1. **Markdown files are the source of truth.** All user data must be readable and editable in a text editor. Any cache or index must be rebuildable from the files and must be safe to delete.
2. **External edits must be picked up.** If the user edits a file in a text editor while the app runs, the app reloads it (file watcher).
3. **Never silently overwrite user edits.** Write files atomically (write to temp file, then rename). Before writing, compare the file's modified time with the time it was read; if it changed, reload and re-apply or report a conflict.
4. **Secrets are not stored in Markdown.** API keys go in a `.env` file.
5. **Personal use.** Recipes imported from websites and books are copyrighted by their authors. The app is for private personal use. It must:
   1. Store the source URL / book title, author and page for every imported recipe and show it on the recipe page.
   2. Not include any "publish" or "share publicly" feature.
   3. Import only URLs the user supplies (single URL or a pasted list). Do not build a site-wide crawler.
   4. Rate-limit web requests (max 1 request per 2 seconds per domain) and send an identifying User-Agent.
   5. Check `robots.txt` before fetching and refuse disallowed paths.
6. **Every derived value records its origin.** Nutrition and leftover data carry a `source` field (`page`, `ocr`, `calculated`, `estimated`, `manual`) so the UI can show how trustworthy it is.
7. **Metric units by default** (user is in New Zealand). Keep original units in the recipe text.

---

## 4. Tech stack

Use these unless there is a concrete reason not to; record any change in `DECISIONS.md`.

1. Runtime: Node.js current LTS. TypeScript `strict: true`.
2. Package manager: pnpm with workspaces.
3. Packages (monorepo):
   1. `packages/core` — data model, Markdown read/write, validation, search, import pipelines, nutrition, meal-plan logic. No HTTP code. Both the server and the MCP server depend on this.
   2. `packages/server` — REST API (Fastify) + serves the built web UI + serves image files.
   3. `packages/web` — React + Vite + TypeScript UI.
   4. `packages/mcp` — MCP server using the official `@modelcontextprotocol/sdk`.
4. Libraries:
   1. `zod` — schema validation for frontmatter and API inputs.
   2. `gray-matter` (or `yaml`) — frontmatter parsing/serialising.
   3. `cheerio` — HTML parsing for URL import.
   4. `sharp` — image resizing, thumbnails, EXIF rotation.
   5. `chokidar` — file watching.
   6. `minisearch` — full-text search index.
   7. `@anthropic-ai/sdk` — vision extraction and nutrition estimation (optional provider, see §8).
   8. `tesseract.js` — local OCR fallback.
   9. `vitest` — tests.
5. Uncertain: whether `sharp` can read iPhone HEIC photos depends on how it was built. Test this early; if it fails, convert HEIC in the browser before upload or show a clear error.

---

## 5. Data folder layout

The data folder path is configurable (`DATA_DIR` in `.env`, default `./data`). Keep it separate from the code so it can be backed up or put in git on its own.

```
data/
  settings.md
  recipes/
    butter-chicken/
      recipe.md
      images/
        hero.jpg
        step-03.jpg
        2026-10-09-cooked.jpg
        source-page-1.jpg
  meal-plans/
    2026-W41.md
  shopping-lists/
    2026-W41.md
  .cache/                # derived; safe to delete; git-ignored
    index.json
    thumbs/
```

Rules:

1. Folder name = slug. If a slug already exists, append `-2`, `-3`.
2. Image file names are lowercase, no spaces. Keep originals; put resized versions in `.cache/thumbs/`.
3. Renaming a recipe title does not rename the folder (avoids breaking meal-plan references). Provide an explicit "rename slug" action that updates all meal plans.

---

## 6. File formats

### 6.1 Recipe file: `recipes/<slug>/recipe.md`

Frontmatter holds structured fields. The body holds human-readable content. Example:

```markdown
---
id: butter-chicken
title: Butter Chicken
source:
  type: web            # web | book | manual
  url: https://www.recipetineats.com/butter-chicken/
  site: RecipeTin Eats
  author: Nagi Maehashi
  book: null           # { title, author, page } when type is book
  importedAt: 2026-10-09T18:56:00+13:00
servings: 4
servingDescription: "1 cup curry + rice"
times:
  prepMinutes: 15
  cookMinutes: 25
  totalMinutes: 40
nutrition:
  perServing:
    calories: 523
    proteinG: 38
    carbsG: 12
    fatG: 35
    saturatedFatG: 18
    fibreG: 3
    sugarG: 8
    sodiumMg: 900
  source: page          # page | ocr | calculated | estimated | manual
  confidence: high      # high | medium | low
  calculatedAt: null
leftovers:
  fridgeDays: 3
  freezerDays: 90
  freezable: true
  reheatNotes: "Reheat gently on the stove"
  source: page          # page | estimated | manual
tags: [curry, chicken, indian, weeknight]
cuisine: Indian
course: [main]
diet: [gluten-free]
favorite: false
hidden: false
rating: null            # 1–5 or null
images:
  hero: images/hero.jpg
  gallery:
    - file: images/step-03.jpg
      kind: step        # step | cooked | source-page | other
      step: 3
      caption: "Sauce should look like this"
      date: 2026-10-09
    - file: images/source-page-1.jpg
      kind: source-page
createdAt: 2026-10-09T18:56:00+13:00
updatedAt: 2026-10-09T18:56:00+13:00
---

# Butter Chicken

## Ingredients

### Chicken marinade
- 600 g chicken thigh, cut into bite-size pieces
- 1/2 cup plain yoghurt

### Sauce
- 2 tbsp butter
- 400 g canned crushed tomatoes

## Method

1. Combine the marinade ingredients...
2. ...

## Source notes

(Notes copied from the original recipe: storage, substitutions.)

## My notes

### 2026-10-09
Used half the chilli. Kids liked it.

## Cook log

- 2026-10-09 — cooked for 4, rating 4
```

Rules:

1. **Ingredients**: one ingredient per `- ` line under `## Ingredients`. Optional `###` sub-groups. The parser extracts quantity, unit, name and preparation from each line for scaling and nutrition. Parsed results are cached in the index, not written back into the file.
2. **Method**: numbered list under `## Method`. Step numbers are used to link step images.
3. **My notes**: dated `###` sub-sections, newest first. The UI appends; the user may edit freely.
4. **Cook log**: one line per time cooked. Added automatically when a meal-plan meal is marked "cooked", or manually.
5. Unknown frontmatter fields must be preserved on write (the user may add their own).
6. Section headings are matched case-insensitively. If a heading is missing, treat the section as empty; do not fail.

### 6.2 Settings file: `settings.md`

```markdown
---
defaultPeople: 2
weekStartsOn: monday
mealSlots: [breakfast, lunch, dinner]
units: metric
dailyCalorieTargetPerPerson: null
defaultLeftoverFridgeDays: 3
extraction:
  provider: anthropic      # anthropic | tesseract
nutrition:
  provider: anthropic      # anthropic | usda | none
---

# Settings

Edit the values above. API keys belong in `.env`, not here.
```

### 6.3 Meal plan file: `meal-plans/2026-W41.md`

Frontmatter is the source of truth. The body is regenerated by the app on every save as a readable table. State this in a comment at the top of the body so the user knows body edits are overwritten.

```markdown
---
week: 2026-W41
startDate: 2026-10-12
defaultPeople: 2            # overrides settings.defaultPeople for this week; null = use settings
days:
  - date: 2026-10-12
    people: null            # null = use week default
    meals:
      dinner:
        recipe: butter-chicken
        people: 4           # null = use day value
        type: cook          # cook | leftovers | eat-out | skip
        cooked: false
      lunch: null
  - date: 2026-10-13
    people: 3
    meals:
      lunch:
        recipe: butter-chicken
        type: leftovers
        leftoverFrom: 2026-10-12/dinner
        people: 1
---

<!-- Generated from the frontmatter above. Edits below this line are overwritten. -->

# Week 41 (12–18 Oct 2026)

| Day | Breakfast | Lunch | Dinner |
|-----|-----------|-------|--------|
| Mon 12 | — | — | Butter Chicken (cook, 4) |
| Tue 13 | — | Butter Chicken (leftovers, 1) | — |
```

### 6.4 Shopping list file: `shopping-lists/2026-W41.md`

Generated from the meal plan (only meals with `type: cook`). Plain Markdown checklist grouped by aisle/category. User can tick items (`- [x]`). Regenerating asks before overwriting ticked items.

---

## 7. People-count rules

The number of people for a meal is resolved in this order. The first non-null value wins:

1. `meal.people`
2. `day.people`
3. `plan.defaultPeople`
4. `settings.defaultPeople`

The UI must show where the value came from (e.g. greyed text "2 (week default)" vs bold "4 (set for this meal)") and allow resetting an override back to inherited.

---

## 8. Import pipelines

All three pipelines produce the same intermediate object (`RecipeDraft`), shown to the user on a **review screen** before saving. Low-confidence fields are highlighted. Nothing is written until the user confirms.

### 8.1 Import from URL

Steps:

1. Validate URL. Check `robots.txt` (cache per domain for 24 h). Apply rate limit.
2. Fetch HTML.
3. Find all `<script type="application/ld+json">` blocks. Parse each. Handle three shapes: a single object, an array, and an object with `@graph`. Select the object whose `@type` is or includes `Recipe`.
4. Map schema.org fields to `RecipeDraft`:
   - `name` → title
   - `recipeYield` → servings (parse the first integer)
   - `prepTime`, `cookTime`, `totalTime` → minutes (these are ISO 8601 durations like `PT1H15M`)
   - `recipeIngredient` → ingredient lines
   - `recipeInstructions` → method steps (handle `HowToStep` and `HowToSection`; sections become `###` sub-groups is not needed for method, flatten with section name prefix)
   - `nutrition` → per-serving nutrition, `source: page`. Values are strings like `"523 kcal"`; strip units.
   - `image` → download the largest image as `hero.jpg`
   - `author`, `recipeCuisine`, `recipeCategory`, `keywords` → source/tags
5. Extract recipe notes from the HTML. On sites using the WP Recipe Maker plugin, notes are typically in an element with class `wprm-recipe-notes`. Uncertain: I believe RecipeTin Eats uses WP Recipe Maker, but verify against a live page and make the selector configurable per site.
6. Extract leftover data from the notes (see §8.4).
7. If no JSON-LD Recipe is found, fall back to sending cleaned page text to the extraction provider (§8.2 step 4).
8. Bulk import: accept a pasted list of URLs. Process sequentially with the rate limit, show progress, skip URLs already imported (match on `source.url`), and produce a summary of successes and failures.

### 8.2 Import from image (recipe book page)

Steps:

1. Upload 1–N images (a recipe may span two pages). Accept JPEG, PNG, WebP, HEIC (see §4.5).
2. Auto-rotate using EXIF data. Save originals as `images/source-page-<n>.<ext>` with `kind: source-page`.
3. Ask the user (optional fields) for book title, author and page number.
4. Run extraction through a `RecipeExtractor` interface with two implementations:
   1. `AnthropicExtractor` (default): send the image(s) to the Claude API with a vision-capable model and request JSON matching the `RecipeDraft` zod schema. Include per-field confidence. Requires `ANTHROPIC_API_KEY`. Costs money per call; show this in settings.
   2. `TesseractExtractor` (offline fallback): run `tesseract.js` OCR, then a heuristic parser (find "Ingredients"/"Method"/"Serves" headings, numbered lines). Lower quality; mark all fields `confidence: low`.
5. Store the raw OCR / extracted text in `.cache/` for debugging, not in the recipe file.
6. If the page has no nutrition, run §8.3. If it has no storage info, run §8.4.
7. Show the review screen with the source image beside the extracted fields.

### 8.3 Nutrition calculation

Runs when nutrition is missing, or when the user clicks "Recalculate".

Steps:

1. Parse each ingredient line into quantity, unit, food name.
2. Convert to grams. Volume units need a density per food; use a lookup table for common foods and the provider's portion data otherwise.
3. Look up nutrition per 100 g via a `NutritionProvider` interface:
   1. `AnthropicNutritionProvider`: ask the model for per-ingredient estimates in grams and nutrients, returned as JSON.
   2. `UsdaNutritionProvider`: USDA FoodData Central API (free API key). More traceable, but food matching is harder.
4. Sum all ingredients, divide by `servings`.
5. Save with `source: calculated`, a `confidence` value, and `calculatedAt`.
6. Show a per-ingredient breakdown table in the UI so the user can correct individual items. Corrections are stored as `manual`.
7. Ignore "to taste" / "for serving" items; list them as excluded in the breakdown.

Uncertainty: calculated nutrition is an estimate. Error of ±15–25 % is plausible for home recipes (oil absorption, cooking losses, vague quantities). The UI must label calculated values as estimates.

### 8.4 Leftover data

1. Search the source notes text for storage statements. Patterns to handle include phrases containing "fridge"/"refrigerator" or "freezer"/"freeze" near a number with "days", "months" or "weeks". Convert to days.
2. Words like "doesn't freeze well" / "not suitable for freezing" → `freezable: false`.
3. If patterns fail and an AI provider is configured, ask it to extract only from the given text (not to guess).
4. If nothing is found, set `fridgeDays` to `settings.defaultLeftoverFridgeDays` with `source: estimated`.
5. The user can always override (`source: manual`).

---

## 9. Search and filtering

Filters (all combinable):

1. Calories per serving: min / max.
2. Fridge leftover days: minimum (e.g. "at least 3 days").
3. Freezable: yes / no / any.
4. Total time: max minutes.
5. Tags, cuisine, course, diet: include any / include all / exclude.
6. Favourites only.
7. Hidden: excluded by default; toggle "show hidden" and "only hidden".
8. Nutrition source: e.g. "only recipes with page-sourced nutrition".
9. Rating: minimum.
10. Last cooked: "not cooked in the last N days" (from cook log).
11. Free-text search over title, ingredients, tags and notes.

Sort options: title, calories, total time, rating, last cooked, date added.

Recipes with missing values (e.g. no calories) are excluded by a filter on that value, and the UI shows a count of how many were excluded for that reason.

---

## 10. Meal planning features

1. **Week view**: grid of days × meal slots. Slots come from settings.
2. **Add meal**: pick from a filtered recipe list (same filters as §9), or drag from a side panel.
3. **Meal types**: `cook`, `leftovers`, `eat-out`, `skip`.
4. **People**: set week default, per-day override, per-meal override (rules in §7).
5. **Scaling**: for `cook` meals, ingredient quantities are scaled by `people / recipe.servings`. Display scaled quantities; never modify the recipe file.
6. **Leftover tracking**:
   1. A `cook` meal can be set to cook extra portions (`portions` field, default = people).
   2. Leftover portions = portions − people.
   3. Leftovers are available until `cookDate + fridgeDays`.
   4. When the user adds a `leftovers` meal, offer only leftovers that still have portions and are within their safe date.
   5. Show a warning if a leftovers meal is after the safe date, or if more leftover portions are used than exist.
   6. Offer "freeze remaining" which records the freeze date; frozen portions use `freezerDays`.
7. **Daily totals**: calories per person per day. If `dailyCalorieTargetPerPerson` is set, show the difference. Meals without calorie data are flagged in the total ("2 meals have no calorie data").
8. **Mark as cooked**: adds a line to the recipe's cook log, optional rating and photo (stored in gallery with `kind: cooked`).
9. **Copy week**: duplicate a previous week's plan into a new week.
10. **Suggest plan** (optional, later milestone): fill empty slots using filters, avoiding recipes cooked recently, preferring favourites, and using leftovers before they expire.
11. **Shopping list**: generate from `cook` meals, combine identical ingredients with the same unit, group by category.

---

## 11. Recipe page features

1. Hero image at top. Upload / replace / crop to a fixed aspect ratio (16:9 suggested).
2. Image gallery with kinds: step, cooked, source-page, other. Step images display inline next to the matching method step.
3. Serving scaler (change servings, ingredients rescale on screen).
4. Nutrition panel with source badge (page / calculated / manual) and confidence.
5. Leftover panel with source badge.
6. Favourite and hide toggles.
7. Add note (dated). Edit notes inline.
8. Cook log.
9. "Edit raw Markdown" view.
10. Link to original source (URL or book + page).

---

## 12. REST API (server)

All bodies validated with zod. JSON responses. Indicative list:

1. `GET /api/recipes?…filters` — list/search.
2. `GET /api/recipes/:slug` — full recipe.
3. `POST /api/recipes` — create (manual).
4. `PATCH /api/recipes/:slug` — partial update.
5. `DELETE /api/recipes/:slug` — move folder to `data/.trash/` (not permanent delete).
6. `POST /api/recipes/:slug/favorite` / `.../hide` — toggle.
7. `POST /api/recipes/:slug/notes` — append note.
8. `POST /api/recipes/:slug/images` — upload (multipart), with `kind`, `step`, `caption`.
9. `POST /api/recipes/:slug/nutrition/recalculate`
10. `POST /api/import/url` — returns `RecipeDraft`.
11. `POST /api/import/urls` — bulk; returns job id; `GET /api/jobs/:id` for progress.
12. `POST /api/import/image` — multipart; returns `RecipeDraft`.
13. `POST /api/import/confirm` — save a reviewed draft.
14. `GET/PUT /api/meal-plans/:week`
15. `PATCH /api/meal-plans/:week/days/:date` — people override.
16. `PUT /api/meal-plans/:week/days/:date/meals/:slot`
17. `POST /api/meal-plans/:week/shopping-list`
18. `GET/PUT /api/settings`
19. `GET /images/:slug/:file` — serve image; `?w=400` returns cached thumbnail.

The server binds to `127.0.0.1` by default. No authentication is needed for localhost. If the user later wants LAN/phone access, add a simple password and document it; do not expose to the internet.

---

## 13. MCP server

1. Transport: stdio (for Claude Desktop / Claude Code). Optional: Streamable HTTP transport behind a flag.
2. Uses `packages/core` directly (does not call the REST API), so it works without the web server running. Both processes share the data folder; the file-write rules in §3 prevent conflicts.
3. **Tools** (inputs validated with zod; outputs are concise JSON plus a short text summary):
   1. `search_recipes` — all filters from §9.
   2. `get_recipe` — by slug; option to include scaled ingredients for N people.
   3. `create_recipe` — from structured fields.
   4. `update_recipe` — partial.
   5. `import_recipe_from_url` — returns draft; `save: true` to save directly.
   6. `import_recipe_from_image` — takes a file path on disk (MCP clients cannot reliably upload binaries); returns draft.
   7. `add_recipe_note`
   8. `set_favorite`, `set_hidden`
   9. `recalculate_nutrition`
   10. `get_meal_plan` — by week (default: current week).
   11. `set_meal` — week, date, slot, recipe, type, people.
   12. `set_people` — week default, day or meal level; `null` clears an override.
   13. `mark_meal_cooked`
   14. `list_available_leftovers` — for a given date.
   15. `suggest_meal_plan` — fills empty slots; returns proposal without saving unless `save: true`.
   16. `generate_shopping_list`
   17. `get_settings`, `update_settings`
4. **Resources**:
   1. `recipe://{slug}` — raw Markdown.
   2. `mealplan://{week}` — raw Markdown.
   3. `settings://` — raw Markdown.
5. Hero images: `get_recipe` may return the hero image as MCP image content when `includeImage: true` (resize to ≤ 800 px first).
6. Provide a README section with the exact JSON config to add the server to Claude Desktop and to Claude Code.

---

## 14. Milestones (build in this order)

Each milestone ends with passing tests and a short note in `PROGRESS.md`.

1. **Core data layer**: zod schemas, recipe/settings/meal-plan read & write, round-trip tests (read → write → identical file, unknown fields preserved), atomic writes, file watcher, index.
2. **Manual recipes + web UI basics**: list, view, create, edit, favourite, hide, notes, image upload, hero image.
3. **URL import**: JSON-LD parser with fixtures (save 3–5 real RecipeTin Eats pages as HTML test fixtures), leftover-note extraction, review screen, bulk import.
4. **Filtering & search** (§9).
5. **Meal planning**: week grid, people rules, scaling, leftovers tracking, daily totals, mark cooked.
6. **MCP server** (§13).
7. **Image import**: Anthropic extractor, Tesseract fallback, review screen with image side-by-side.
8. **Nutrition calculation** (§8.3).
9. **Shopping list, copy week, suggest plan.**

---

## 15. Open decisions — ask the user before implementing

1. Which AI provider to use for extraction and nutrition (Anthropic API costs money per call; Tesseract/USDA are free but less accurate).
2. Whether to use the NZ Food Composition Database instead of USDA for nutrition. Uncertain: its licence terms for app use need checking.
3. Meal slots: breakfast/lunch/dinner only, or also snacks/dessert?
4. Will the UI be used on a phone (e.g. in the kitchen)? If yes, the layout must be mobile-first and LAN access needed (§12).
5. Should the data folder be a git repository with automatic commits (gives version history)?
6. Shopping list categories: fixed list or user-defined?

---

## 16. Testing requirements

1. Unit tests for: frontmatter round-trip, ingredient line parser, ISO duration parser, people-count resolution, leftover availability/expiry, scaling, nutrition summing.
2. Fixture tests for URL import using saved HTML (no live network calls in tests).
3. Fixture tests for image import using a stored mock model response.
4. One end-to-end test: import → add to plan → mark cooked → cook log updated.
5. MCP: test each tool's handler through `packages/core` with a temporary data folder.

---

## 17. Non-goals

1. Multi-user accounts.
2. Cloud hosting or public sharing.
3. Site-wide crawling of any recipe website.
4. Native mobile app (a responsive web UI is enough).
