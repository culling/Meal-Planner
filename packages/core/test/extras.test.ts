import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseSlot, extraSlotBase, freeExtraSlot } from "../src/mealplan";
import { Planner } from "../src/planner";
import { tempStore } from "./helpers";

// Several dishes in one meal slot: meatloaf with honey glazed carrots, or a few lunches cooked for meal prep.

let ctx: Awaited<ReturnType<typeof tempStore>>;
let planner: Planner;
const W = "2026-W42";
const day = "2026-10-12";

beforeEach(async () => {
  ctx = await tempStore();
  planner = new Planner(ctx.store);
  await ctx.store.createRecipe({ title: "Meatloaf", servings: 4, ingredientsMd: "- 500 g mince", methodMd: "1. Bake" });
  await ctx.store.createRecipe({ title: "Honey Glazed Carrots", servings: 4, ingredientsMd: "- 4 carrots", methodMd: "1. Roast" });
});
afterEach(async () => ctx.cleanup());

describe("extra dishes in a slot", () => {
  it("names them dinner-2, dinner-3 and tells them apart from make-ahead slots", () => {
    expect(extraSlotBase("dinner-2")).toBe("dinner");
    expect(["dinner", "prep", "prep-2", "dinner-1"].map(extraSlotBase)).toEqual([null, null, null, null]);
    expect(baseSlot("lunch-3")).toBe("lunch");
    expect(freeExtraSlot({ meals: { "dinner-2": 1 } }, "dinner")).toBe("dinner-3");
  });

  it("shows them beside the slot's main dish and lists both on the shopping list", async () => {
    await planner.setMeal(W, day, "dinner", { recipe: "meatloaf", type: "cook" });
    const v = await planner.setMeal(W, day, "dinner-2", { recipe: "honey-glazed-carrots", type: "cook" });
    const d = v.days.find((x) => x.date === day)!;
    expect(d.meals.dinner?.title).toBe("Meatloaf");
    expect(d.extras.map((e) => [e.slot, e.base, e.title])).toEqual([["dinner-2", "dinner", "Honey Glazed Carrots"]]);
    expect(Object.keys(d.meals)).not.toContain("dinner-2");
    const body = await ctx.store.getPlan(W);
    expect(Object.keys(body.days.find((x) => x.date === day)!.meals)).toEqual(["dinner", "dinner-2"]);
  });
});
