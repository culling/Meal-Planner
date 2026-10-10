import { describe, expect, it } from "vitest";
import {
  aggregateShopping,
  availableLeftovers,
  computeLeftovers,
  copyPlan,
  cookScale,
  dailyTotals,
  mergeShopping,
  resolvePeople,
  suggestPlan,
} from "../src/mealplan";
import { MealPlanSchema, MealSchema, RecipeMetaSchema, SettingsSchema, type MealPlan, type Recipe } from "../src/schemas";
import { parseBody } from "../src/recipe-doc";
import { weekDates } from "../src/dates";

const settings = SettingsSchema.parse({ defaultPeople: 2 });

function recipe(slug: string, extra: Record<string, unknown> = {}, ingredients = "- 600 g chicken\n- 2 tbsp butter"): Recipe {
  const meta = RecipeMetaSchema.parse({ id: slug, title: slug.toUpperCase(), servings: 4, ...extra });
  const body = `## Ingredients\n\n${ingredients}\n\n## Method\n\n1. Cook\n`;
  return { slug, meta, body, ...parseBody(body), lastCooked: null, mtimeMs: 0 };
}

const meal = (patch: Record<string, unknown>) => MealSchema.parse(patch);

function plan(week: string, days: Record<number, Record<string, ReturnType<typeof meal>>>, extra: Partial<MealPlan> = {}): MealPlan {
  const dates = weekDates(week);
  return MealPlanSchema.parse({
    week,
    startDate: dates[0],
    ...extra,
    days: dates.map((date, i) => ({ date, people: null, meals: days[i] ?? {} })),
  });
}

describe("people resolution", () => {
  it("uses meal, then day, then week, then settings", () => {
    const p = { defaultPeople: 3 };
    expect(resolvePeople({ people: 5 }, { people: 4 }, p, settings)).toEqual({ value: 5, from: "meal" });
    expect(resolvePeople({ people: null }, { people: 4 }, p, settings)).toEqual({ value: 4, from: "day" });
    expect(resolvePeople({ people: null }, { people: null }, p, settings)).toEqual({ value: 3, from: "week" });
    expect(resolvePeople(null, null, { defaultPeople: null }, settings)).toEqual({ value: 2, from: "settings" });
  });
  it("treats 0 as a real override", () => {
    expect(resolvePeople({ people: 0 }, { people: 4 }, { defaultPeople: 3 }, settings).value).toBe(0);
  });
});

describe("scaling", () => {
  it("scales by people over servings, or by portions when cooking extra", () => {
    const r = recipe("a");
    expect(cookScale(r, meal({ type: "cook" }), 2)).toBe(0.5);
    expect(cookScale(r, meal({ type: "cook", portions: 8 }), 2)).toBe(2);
  });
});

describe("leftovers", () => {
  const recipes = new Map([["curry", recipe("curry", { leftovers: { fridgeDays: 3, freezerDays: 90, freezable: true } })]]);
  const lookup = (s: string) => recipes.get(s);

  it("tracks extra portions and the safe date", () => {
    const p = plan("2026-W42", {
      0: { dinner: meal({ recipe: "curry", type: "cook", portions: 4 }) },
      1: { lunch: meal({ recipe: "curry", type: "leftovers", leftoverFrom: "2026-10-12/dinner" }) },
    });
    const r = computeLeftovers([p], lookup, settings);
    expect(r.batches).toHaveLength(1);
    expect(r.batches[0]).toMatchObject({ extra: 2, fridgeUntil: "2026-10-15", fridgeRemaining: 0, fridgeUsed: 2 });
    expect(r.warnings).toEqual([]);
  });

  it("warns when leftovers are past their safe date", () => {
    const p = plan("2026-W42", {
      0: { dinner: meal({ recipe: "curry", type: "cook", portions: 4 }) },
      4: { lunch: meal({ recipe: "curry", type: "leftovers", leftoverFrom: "2026-10-12/dinner" }) },
    });
    const w = computeLeftovers([p], lookup, settings).warnings;
    expect(w.map((x) => x.code)).toEqual(["expired"]);
    expect(w[0].message).toContain("2026-10-15");
  });

  it("warns when more portions are used than exist", () => {
    const p = plan("2026-W42", {
      0: { dinner: meal({ recipe: "curry", type: "cook" }) },
      1: { lunch: meal({ recipe: "curry", type: "leftovers", leftoverFrom: "2026-10-12/dinner" }) },
    });
    expect(computeLeftovers([p], lookup, settings).warnings.map((x) => x.code)).toEqual(["overused"]);
  });

  it("warns when leftovers are eaten before they are cooked", () => {
    const p = plan("2026-W42", {
      2: { dinner: meal({ recipe: "curry", type: "cook", portions: 4 }) },
      0: { lunch: meal({ recipe: "curry", type: "leftovers", leftoverFrom: "2026-10-14/dinner" }) },
    });
    expect(computeLeftovers([p], lookup, settings).warnings.map((x) => x.code)).toContain("before-cooked");
  });

  it("finds leftovers across the week boundary", () => {
    const prev = plan("2026-W41", { 6: { dinner: meal({ recipe: "curry", type: "cook", portions: 4 }) } });
    const cur = plan("2026-W42", { 0: { lunch: meal({ recipe: "curry", type: "leftovers", leftoverFrom: "2026-10-11/dinner" }) } });
    const r = computeLeftovers([prev, cur], lookup, settings);
    expect(r.warnings).toEqual([]);
    expect(r.batches[0].fridgeUsed).toBe(2);
  });

  it("offers only batches with stock inside their safe date", () => {
    const p = plan("2026-W42", { 0: { dinner: meal({ recipe: "curry", type: "cook", portions: 4 }) } });
    const { batches } = computeLeftovers([p], lookup, settings);
    expect(availableLeftovers(batches, "2026-10-13")).toHaveLength(1);
    expect(availableLeftovers(batches, "2026-10-16")).toHaveLength(0);
    expect(availableLeftovers(batches, "2026-10-11")).toHaveLength(0);
  });

  it("moves portions to the freezer with a longer life", () => {
    const p = plan("2026-W42", {
      0: { dinner: meal({ recipe: "curry", type: "cook", portions: 4, frozen: [{ date: "2026-10-13", portions: 2 }] }) },
      6: { dinner: meal({ recipe: "curry", type: "leftovers", leftoverStore: "freezer", leftoverFrom: "2026-10-12/dinner" }) },
    });
    const r = computeLeftovers([p], lookup, settings);
    expect(r.batches[0]).toMatchObject({ fridgeRemaining: 0, freezerRemaining: 0, freezerUsed: 2 });
    expect(r.warnings).toEqual([]);
  });

  it("flags freezing a recipe that doesn't freeze", () => {
    const noFreeze = new Map([["soup", recipe("soup", { leftovers: { fridgeDays: 3, freezable: false } })]]);
    const p = plan("2026-W42", { 0: { dinner: meal({ recipe: "soup", type: "cook", portions: 4, frozen: [{ date: "2026-10-13", portions: 2 }] }) } });
    expect(computeLeftovers([p], (s) => noFreeze.get(s), settings).warnings.map((w) => w.code)).toContain("not-freezable");
  });
});

describe("daily totals", () => {
  it("sums calories per person and flags meals without data", () => {
    const rs = new Map([
      ["a", recipe("a", { nutrition: { perServing: { calories: 500 } } })],
      ["b", recipe("b")],
    ]);
    const p = plan("2026-W42", { 0: { lunch: meal({ recipe: "a" }), dinner: meal({ recipe: "b" }) } });
    const t = dailyTotals(p.days[0], (s) => rs.get(s), { dailyCalorieTargetPerPerson: 2000 });
    expect(t).toMatchObject({ caloriesPerPerson: 500, mealsWithoutCalories: 1, difference: -1500 });
  });
});

describe("copy week", () => {
  it("shifts dates and resets cooked state", () => {
    const src = plan("2026-W41", {
      0: { dinner: meal({ recipe: "curry", type: "cook", cooked: true, portions: 4 }) },
      1: { lunch: meal({ recipe: "curry", type: "leftovers", leftoverFrom: "2026-10-05/dinner" }) },
    });
    const copy = copyPlan(src, "2026-W42");
    expect(copy.days[0].date).toBe("2026-10-12");
    expect(copy.days[0].meals.dinner?.cooked).toBe(false);
    expect(copy.days[1].meals.lunch?.leftoverFrom).toBe("2026-10-12/dinner");
  });
});

describe("shopping list", () => {
  it("scales, combines identical items and converts units", () => {
    const a = recipe("a", {}, "- 600 g chicken thigh\n- 2 tbsp butter\n- 1 onion");
    const b = recipe("b", {}, "- 1 kg chicken thigh\n- 1 tbsp butter\n- 2 onions\n- Salt, to taste");
    const items = aggregateShopping([
      { recipe: a, title: "A", scale: 1 },
      { recipe: b, title: "B", scale: 0.5 },
    ]);
    const text = items.map((i) => i.text);
    expect(text).toContain("1.1 kg chicken thigh");
    expect(text).toContain("2½ tbsp butter");
    expect(text).toContain("2 onions");
    expect(text.some((t) => /salt/i.test(t))).toBe(false);
  });
  it("keeps ticks and manual items when regenerated", () => {
    const merged = mergeShopping(
      [
        { key: "milk", text: "milk", checked: true, manual: false, from: [] },
        { key: "bin-bags", text: "bin bags", checked: false, manual: true, from: [] },
      ],
      [{ key: "milk", text: "2 l milk", checked: false, manual: false, from: ["A"] }],
    );
    expect(merged.find((i) => i.key === "milk")).toMatchObject({ checked: true, text: "2 l milk" });
    expect(merged.some((i) => i.key === "bin-bags")).toBe(true);
  });
});

describe("suggest plan", () => {
  it("fills empty dinners without repeating recipes", () => {
    const rs = ["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => recipe(s));
    const p = plan("2026-W42", {});
    const { plan: out } = suggestPlan(p, settings, { today: "2026-10-12", candidates: rs, seed: 1 });
    const dinners = out.days.map((d) => d.meals.dinner?.recipe).filter(Boolean);
    expect(dinners.length).toBe(7);
    expect(new Set(dinners).size).toBe(7);
  });
  it("leaves existing meals alone and skips past days", () => {
    const rs = ["a", "b", "c"].map((s) => recipe(s));
    const p = plan("2026-W42", { 3: { dinner: meal({ recipe: "x", type: "eat-out" }) } });
    const { plan: out } = suggestPlan(p, settings, { today: "2026-10-14", candidates: rs, seed: 2 });
    expect(out.days[0].meals.dinner).toBeUndefined();
    expect(out.days[3].meals.dinner?.type).toBe("eat-out");
  });
});
