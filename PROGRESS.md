# Progress

_Latest:_ saved photos (name now, read later or type in), drag/extend/duplicate/move meals with leftovers across weeks, and Windows delete/rename while running fixed. See DECISIONS.md.

Status of the milestones in `recipe-planner-spec.md` §14. All automated tests pass (`npm run test:all`: 122 core, 13 server/API, 3 MCP, and 86 end-to-end browser tests) and `pnpm typecheck` is clean.

1. **Core data layer — done.** zod schemas; recipe/settings/plan/shopping/food files read and written; unchanged files are never rewritten; unknown fields preserved; atomic writes with modified-time conflict checks; file watcher; in-memory search index; git auto-commit.
2. **Manual recipes + web UI — done.** List, view, create, edit, favourite, hide, notes (add/edit/delete), photo upload (main, step, "I made this"), raw Markdown editor, version history/restore, rename folder, delete to `.trash`.
3. **URL import — done.** JSON-LD parser (single object / array / `@graph`), notes box, storage advice from notes and article, review screen, bulk import. Tested against 4 real RecipeTin Eats pages saved in `packages/core/test/fixtures`. robots.txt, rate limit and User-Agent covered by tests.
4. **Filtering & search — done** (all §9 filters, sort options, "N recipes left out because they lack calorie data").
5. **Meal planning — done.** Week grid (desktop) / day cards (phone); people per week/day/meal with the source shown; scaling; leftover tracking incl. freezer and expiry warnings across weeks; daily calories vs target; mark cooked → cook log; copy week.
6. **MCP server — done.** 19 tools, 3 resources, stdio; tested over a real stdio connection.
7. **Image import — done**, with a local vision model (default) or LightOnOCR + text model. Tested with a mock model response in unit tests and live against `qwen3-vl:8b` on a synthetic cookbook page (read correctly in ~24 s). **Not yet tried on a real photo of your cookbooks** — worth a go.
8. **Nutrition — done**, local model, per-ingredient "?" markers, editable nutrition database. Live run on Chicken Fried Rice: 512 kcal/serving vs the page's 441 (within the 15–25 % the spec warns about), ~75 s.
9. **Shopping list, copy week, suggest plan — done.**

## Known gaps / ideas
- HEIC photos aren't readable (see DECISIONS.md). 
- Only the Windows Edge was used for visual checks (phone-sized and desktop viewports); not tried on a real Pixel yet.
- LightOnOCR path is wired up and unit-tested only up to the process call; run it once on your machine to confirm `python ocr.py` works from the app (it loads the model each time, so it is slow).
- Drag-and-drop of recipes onto plan slots is desktop only.
