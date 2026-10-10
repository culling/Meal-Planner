# Decisions

Changes from `recipe-planner-spec.md`, and judgement calls. Most recent answers from the owner are marked (owner).

## Answers to the spec's open decisions (§15)
1. **AI provider (owner):** local models via **Ollama** instead of the Anthropic API. Defaults: `qwen3-vl:8b` for photos, `qwen3.5:9b` for text/nutrition; all choosable in Settings. The OCR tool at `__AI__OCR__lightonocr` is supported as an alternative photo path (`python ocr.py <image>` → text → text model). Tesseract (§8.2) and the Anthropic/USDA providers were dropped. Nutrition sits behind one function so another provider can be added later.
2. **NZ food database:** not used; licence unchecked. The nutrition database is local and editable, so it can be filled from any source.
3. **Meal slots (owner):** breakfast, lunch, dinner (a setting; snacks can be added).
4. **Phone (owner):** mobile-first UI, LAN access, Pixel 7/8 (Chrome). Plan editing works on phone and desktop. No wake-lock "cooking mode": browsers only allow it on HTTPS, and the app is plain HTTP on the LAN.
5. **Git (owner):** the data folder is its own git repo, auto-committed ~4 s after changes (debounced). Per-recipe history and restore in the UI.
6. **Shopping list (owner):** one flat list, no aisle categories. Items come from `cook` meals, combined by name and unit class, scaled. Ticks and manual items survive regeneration.
7. **Security (owner):** none; binds `0.0.0.0` by default (change `HOST` to `127.0.0.1` to restrict).

## Nutrition ("?" icon) — owner's requirements
- Per-ingredient breakdown rows are stored in the recipe's frontmatter (`nutrition.breakdown`), each with `source: ai | manual`. AI rows show an orange **?**.
- A row becomes `manual` (icon gone) when a person types a nutrient number, taps the ?, or the underlying food is checked in the database *and* the row's gram amount wasn't an AI guess (a row with an AI-guessed amount keeps its ? until the grams are edited or the ? is tapped). Changing only grams re-works the row from the food and keeps its AI status.
- `nutrition-db.md` holds every food per 100 g (`source: ai | manual`), viewable/editable on the Nutrition data page. Editing a food re-totals every recipe that uses it. A food's AI values are reused for later recipes, so a corrected value stays corrected.
- Recalculating keeps rows a person edited. Typing per-serving numbers marks the recipe `manual` and freezes its rows.
- Sanity check on model output: calories are replaced by 4/4/9 × macros when they disagree by >35 %, with a warning.

## Technical
- **Run TypeScript directly with `tsx`** (no compile step for server/MCP); only the web app is built.
- **Frontmatter writing:** unchanged data keeps the original text byte-for-byte (comments survive). If data changes, the frontmatter is re-serialised and YAML comments inside it are lost; unknown fields are always kept. Dates stay plain text.
- **Edits are read-modify-write from disk**, serialised per recipe, with an optional `expectedMtimeMs` (409 on mismatch). The UI sends it for full-form saves and offers "keep mine / discard mine".
- **Weeks** start on a day you choose in Settings (Monday by default; Saturday suits cooking for the week from the weekend). A week's id is still `YYYY-Www`: the ISO week that contains its first day, so each id names exactly one week and the Monday default matches ISO numbering. Changing the day regroups the saved plan files by date (meals keep their dates, leftovers keep working); it also happens at start-up if `settings.md` was edited by hand. Shopping lists are per week and are rebuilt with "Update from the plan".
- **Hero crop** is a 16:9 display crop (CSS), not a destructive crop. Uploaded photos are rotated by EXIF and capped at 2400 px (3000 px for book pages) and stored as JPEG/PNG/WebP. **HEIC is not supported** (tested: the bundled `sharp` reads AVIF but not HEIC); an upload of one shows a clear error. Pixel phones save JPEG by default, so this shouldn't come up.
- **Storage advice** is read from the notes box, then from the article text (excluding comments and the recipe card), then — if storage is mentioned but unparsed — a local model asked to quote only what's written. Otherwise `defaultLeftoverFridgeDays` with `source: estimated`. Ranges use the lower number.
- **Real-page findings (RecipeTin Eats):** notes are `div.wprm-recipe-notes` with one block `<span>` per note; ingredient strings contain plugin noise like `(, full fat)` / `(Note 1)` which is cleaned; `recipeCategory` holds dish types (not courses) so unknown values become tags.
- **Local model quirk:** `qwen3-vl` puts structured answers in `thinking` when a JSON `format` is requested; the client falls back to that field.
- **Index:** in-memory (MiniSearch) rebuilt on change; no persisted `index.json` (not needed at this size).
- **Bulk import** saves nothing unless "save straight away" is ticked; otherwise each draft is reviewed.
- **Suggest plan** is a simple heuristic (favourites, rating, not-recently-cooked, double-cook for next-day leftover lunch); preview first, then accept.
- `playwright-core` (dev only) + the Windows Edge are used by `scripts/screenshots.mts` for visual checks.

## Saved photos
- A photo is **saved first** (as `photos/<name>/photo.md` + `images/page-N.jpg`) and read later, so a failed or poor reading never loses it and the model can change. Folder names follow the name when created and don't change on rename (like recipes).
- Reading remembers its draft in `.cache/drafts/` (derived, safe to delete); the model/provider can be chosen per reading without changing settings.
- When a photo becomes a recipe its pages are copied in as `source-page` images and the photo is marked `done` with a link; "use this photo again" reopens it.
- Camera-style file names (`IMG_2043`, `PXL_2026…`) aren't used as titles; real names like "Daal Curry.jpg" are. The camera button uses `capture="environment"`; HEIC is still unsupported.

## Planning by dragging
- Pointer events (not HTML5 drag-and-drop) so mouse, pen and touch behave the same. Handle drag: a slot of the **same meal** you cross is included; slots of **other meals** only if you pause ~⅓ s on them or let go on them. A plain click on the handle opens "choose slots" mode (tap slots, then Apply). The dialog's "Use this meal again" does the same with chips, for keyboards and precision.
- "Smart" mode: leftovers when every target is still inside the food's fridge life counted from the cook date, otherwise cook again. The toast offers Undo and "switch" to the other way.
- Leftovers can be placed in the adjacent weeks (a Sunday dinner feeding Monday lunch); the cook meal's portions are raised to cover everyone.

## Bugs found while testing this round (all fixed)
- **Deleting or renaming a recipe failed on Windows while the app was running** (`EPERM`: the file watcher holds the folder). The watcher is now paused around folder moves; covered by a test that runs with the watcher on.
- React crashed on every page change because an effect returned a value (the "blank screen, refresh fixes it" bug).

## Plan layout and week start
- Wide windows (≥ 1100 px): a table with **a column per day and a row per meal**. Phones and narrow windows keep **a card per day** — seven columns would be ~50 px wide on a phone, too small to read or drag. The same markup is used for both; only the CSS places things.
- The week's first day is a setting (any day); see "Weeks" above for how ids and files follow it.

## Cooking ahead ("make ahead")
- A make-ahead is stored like any cook meal, in a slot called `prep`, `prep-2`… on the day it is cooked, with `people: 0` (nobody eats it then) and an explicit `portions`. Nothing else needed a new concept: leftovers tracking, fridge/freezer expiry warnings, "cook enough for everyone", moving and the shopping list (whole batch) all follow. `prep…` can't be used as a normal meal name.
- It isn't counted in the day's calories (only eaten meals are). A make-ahead can only be eaten as leftovers (even beyond its fridge life — you get a warning and the freezer option, not a refusal), moved or cooked again onto another day's make-ahead row; it can't be "repeated" into a normal meal.
- Dragging out of the make-ahead row: the first meal you **pause on** becomes "the meal that eats it", then sweeping along that row picks up the rest (crossing another row on the way, e.g. dinner on the way up to lunch, picks nothing). A click opens the "choose the meals" list instead.
- Smoothies you drink tomorrow are just an ordinary meal. If they don't fit breakfast/lunch/dinner, add a "snack" meal in Settings.
