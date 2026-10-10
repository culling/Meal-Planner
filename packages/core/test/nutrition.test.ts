import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calculateNutrition, findFood, recomputeBreakdown, rowSource, sanitisePer100g, sumBreakdown, applyBreakdown } from "../src/nutrition";
import { emptyNutrients, type Food } from "../src/schemas";
import { tempStore } from "./helpers";

const n = (o: Partial<ReturnType<typeof emptyNutrients>>) => ({ ...emptyNutrients(), ...o });

describe("pure nutrition helpers", () => {
  it("fixes calories that disagree with macros", () => {
    const { value, suspicious } = sanitisePer100g(n({ calories: 50, proteinG: 20, carbsG: 0, fatG: 10 }));
    expect(value.calories).toBe(170);
    expect(suspicious).toBe(true);
  });
  it("accepts consistent values", () => {
    expect(sanitisePer100g(n({ calories: 165, proteinG: 31, carbsG: 0, fatG: 3.6 })).suspicious).toBe(false);
  });
  it("matches foods by name, alias and contained words", () => {
    const foods = [
      { id: "chicken-thigh", name: "chicken thigh", aliases: ["thigh fillets"] },
      { id: "oil", name: "oil", aliases: [] },
      { id: "olive-oil", name: "olive oil", aliases: [] },
    ] as Food[];
    expect(findFood(foods, "boneless skinless chicken thigh fillets")?.id).toBe("chicken-thigh");
    expect(findFood(foods, "Olive Oil")?.id).toBe("olive-oil");
    expect(findFood(foods, "extra virgin olive oil")?.id).toBe("olive-oil");
    expect(findFood(foods, "butter")).toBeUndefined();
  });
  it("shows the question icon for AI rows until a person edits them", () => {
    const aiFood = { source: "ai" } as Food;
    const manualFood = { source: "manual" } as Food;
    expect(rowSource({ override: false, gramsSource: "unit" }, aiFood)).toBe("ai");
    expect(rowSource({ override: false, gramsSource: "ai" }, manualFood)).toBe("ai");
    expect(rowSource({ override: false, gramsSource: "unit" }, manualFood)).toBe("manual");
    expect(rowSource({ override: true, gramsSource: "ai" }, aiFood)).toBe("manual");
  });
  it("recomputes totals from foods and keeps overridden rows", () => {
    const foods = [{ id: "rice", name: "rice", aliases: [], per100g: n({ calories: 130 }), source: "manual" }] as unknown as Food[];
    const rows = recomputeBreakdown(
      [
        { ingredient: "200 g rice", food: "rice", grams: 200, gramsSource: "unit", excluded: false, override: false, source: "ai", total: n({}) },
        { ingredient: "1 mystery", food: null, grams: 50, gramsSource: "manual", excluded: false, override: true, source: "ai", total: n({ calories: 100 }) },
        { ingredient: "salt to taste", food: null, grams: null, gramsSource: "unit", excluded: true, override: false, source: "manual", total: n({ calories: 999 }) },
      ],
      foods,
    );
    expect(rows[0].total.calories).toBe(260);
    expect(rows[0].source).toBe("manual");
    expect(rows[1].source).toBe("manual");
    expect(sumBreakdown(rows, 4).calories).toBe(90);
  });
});

describe("calculateNutrition with a stand-in model", () => {
  let ctx: Awaited<ReturnType<typeof tempStore>>;
  beforeEach(async () => {
    ctx = await tempStore();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  let calls = 0;
  const fakeOllama = {
    async chatJson(opts: { prompt: string }) {
      calls++;
      const lines = opts.prompt.split("\n").filter((l) => /^\d+\./.test(l));
      return {
        items: lines.map((l, i) => {
          const rice = /rice/i.test(l);
          return {
            index: i + 1,
            foodName: rice ? "rice" : "olive oil",
            grams: rice ? 200 : 14,
            per100g: rice ? n({ calories: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3 }) : n({ calories: 884, fatG: 100 }),
          };
        }),
      };
    },
  };

  it("calculates per serving, marks AI rows and reuses saved foods", async () => {
    const r = await ctx.store.createRecipe({ title: "Rice", servings: 2, ingredientsMd: "- 200 g rice\n- 1 tbsp olive oil\n- salt, to taste", methodMd: "1. Cook" });
    calls = 0;
    const res = await calculateNutrition(ctx.store, fakeOllama as any, r);
    expect(calls).toBe(1);
    expect(res.nutrition.source).toBe("calculated");
    expect(res.nutrition.breakdown).toHaveLength(3);
    expect(res.nutrition.breakdown.find((b) => b.excluded)?.ingredient).toContain("salt");
    const rice = res.nutrition.breakdown[0];
    expect(rice).toMatchObject({ food: "rice", grams: 200, gramsSource: "unit", source: "ai" });
    expect(res.nutrition.perServing.calories).toBe(Math.round(((260 + 123.76) / 2) * 10) / 10);
    expect(ctx.store.listFoods().map((f) => f.id).sort()).toEqual(["olive-oil", "rice"]);

    // a person corrects the rice entry; the next recipe uses it without asking the model about rice
    await ctx.store.upsertFoods([{ id: "rice", name: "rice", source: "manual", per100g: n({ calories: 150, proteinG: 3, carbsG: 32, fatG: 0.3 }) }]);
    const r2 = await ctx.store.createRecipe({ title: "More rice", servings: 1, ingredientsMd: "- 100 g rice", methodMd: "1. Cook" });
    calls = 0;
    const res2 = await calculateNutrition(ctx.store, fakeOllama as any, r2);
    expect(calls).toBe(0);
    expect(res2.nutrition.perServing.calories).toBe(150);
    expect(res2.nutrition.breakdown[0].source).toBe("manual");
  });

  it("keeps rows a person edited when recalculating", async () => {
    const r = await ctx.store.createRecipe({ title: "Rice", servings: 2, ingredientsMd: "- 200 g rice\n- 1 tbsp olive oil", methodMd: "1. Cook" });
    const first = await calculateNutrition(ctx.store, fakeOllama as any, r);
    const edited = first.nutrition.breakdown.map((b) => (b.food === "olive-oil" ? { ...b, override: true, total: n({ calories: 50 }) } : b));
    const saved = await applyBreakdown(ctx.store, r.slug, edited);
    const again = await calculateNutrition(ctx.store, fakeOllama as any, saved);
    expect(again.nutrition.breakdown.find((b) => b.food === "olive-oil")).toMatchObject({ override: true, source: "manual" });
    expect(again.nutrition.breakdown.find((b) => b.food === "olive-oil")?.total.calories).toBe(50);
  });
});
