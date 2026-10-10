import { describe, expect, it } from "vitest";
import { parseRecipeMeta, type Recipe } from "../src/schemas";
import { RecipeSearch } from "../src/search";

const recipe = (slug: string, extra: Record<string, unknown>): Recipe => ({
  slug,
  meta: parseRecipeMeta({ id: slug, title: slug, ...extra }),
  body: "",
  ingredients: [],
  method: [],
  notes: [],
  sourceNotes: "",
  cookLog: [],
  lastCooked: null,
  mtimeMs: 0,
});

describe("recipe role", () => {
  it("infers role from course for recipes saved without one", () => {
    expect(parseRecipeMeta({ id: "a", title: "a" }).role).toEqual(["main"]);
    expect(parseRecipeMeta({ id: "a", title: "a", course: ["mains"] }).role).toEqual(["main"]);
    expect(parseRecipeMeta({ id: "a", title: "a", course: ["side dish"] }).role).toEqual(["side"]);
    expect(parseRecipeMeta({ id: "a", title: "a", course: ["dessert"] }).role).toEqual(["side"]);
  });

  it("keeps an explicit role", () => {
    expect(parseRecipeMeta({ id: "a", title: "a", course: ["side"], role: ["main", "side"] }).role).toEqual(["main", "side"]);
  });

  it("filters by role; a recipe that is both matches either", () => {
    const all = [recipe("steak", { role: ["main"] }), recipe("slaw", { role: ["side"] }), recipe("rice", { role: ["main", "side"] })];
    const slugs = (role: ("main" | "side")[]) => new RecipeSearch().search(all, 1, { role }).recipes.map((r) => r.slug).sort();
    expect(slugs(["main"])).toEqual(["rice", "steak"]);
    expect(slugs(["side"])).toEqual(["rice", "slaw"]);
    expect(slugs(["main", "side"])).toEqual(["rice", "slaw", "steak"]);
  });
});
