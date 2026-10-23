import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mealGroup } from "../src/mealplan";
import { Planner } from "../src/planner";
import { parseRecipeMeta } from "../src/schemas";
import { tempStore } from "./helpers";

// Several recipes served as one meal: salt and pepper tofu with rice and greens.
let ctx: Awaited<ReturnType<typeof tempStore>>;
let planner: Planner;
const W = "2026-W42"; // Mon 12 Oct – Sun 18 Oct 2026
const mon = "2026-10-12";
const tue = "2026-10-13";
const wed = "2026-10-14";

beforeEach(async () => {
  ctx = await tempStore();
  planner = new Planner(ctx.store);
  await ctx.store.updateSettings({ defaultPeople: 2 });
  const keeps = { fridgeDays: 3, freezerDays: null, freezable: true, reheatNotes: null, source: "manual" as const };
  await ctx.store.createRecipe({ title: "Tofu", servings: 2, ingredientsMd: "- 300 g tofu", methodMd: "1. Fry", leftovers: keeps });
  await ctx.store.createRecipe({ title: "Rice", servings: 4, ingredientsMd: "- 1 cup rice", methodMd: "1. Boil", leftovers: keeps });
  await ctx.store.createRecipe({ title: "Greens", servings: 2, ingredientsMd: "- 1 bunch bok choy", methodMd: "1. Steam", leftovers: { ...keeps, fridgeDays: 1 } });
});
afterEach(async () => {
  await ctx.cleanup();
});

const dayOf = async (date: string) => (await ctx.store.getPlan(W)).days.find((d) => d.date === date)!;
const slotsOf = async (date: string) => Object.fromEntries(Object.entries((await dayOf(date)).meals).map(([s, m]) => [s, m && { recipe: m.recipe, type: m.type, people: m.people, portions: m.portions, joined: m.joined, leftoverFrom: m.leftoverFrom }]));

describe("dishes served as one meal", () => {
  it("added dishes join the meal and take its people and portions; later edits reach every dish", async () => {
    await planner.setMeal(W, mon, "dinner", { recipe: "tofu", type: "cook", people: 3, portions: 5 });
    await planner.addDishes(W, mon, "dinner", ["rice", "greens"]);
    expect(await slotsOf(mon)).toEqual({
      dinner: { recipe: "tofu", type: "cook", people: 3, portions: 5, joined: false, leftoverFrom: null },
      "dinner-2": { recipe: "rice", type: "cook", people: 3, portions: 5, joined: true, leftoverFrom: null },
      "dinner-3": { recipe: "greens", type: "cook", people: 3, portions: 5, joined: true, leftoverFrom: null },
    });
    expect(mealGroup(await dayOf(mon), "dinner-2")).toEqual(["dinner", "dinner-2", "dinner-3"]);

    // changing the portions on any dish changes them all; so does the people count
    await planner.setMeal(W, mon, "dinner-2", { portions: 6, frozen: [{ date: mon, portions: 1 }] });
    await planner.setPeople(W, { date: mon, slot: "dinner-3" }, 4);
    const day = await dayOf(mon);
    expect(Object.values(day.meals).map((m) => [m!.people, m!.portions, m!.frozen.length])).toEqual([
      [4, 6, 1],
      [4, 6, 1],
      [4, 6, 1],
    ]);
  });

  it("an extra dish that isn't joined is left alone", async () => {
    await planner.setMeal(W, mon, "lunch", { recipe: "tofu", type: "cook" });
    await planner.setMeal(W, mon, "lunch-2", { recipe: "rice", type: "cook", portions: 6 });
    await planner.setMeal(W, mon, "lunch", { portions: 3 });
    expect((await dayOf(mon)).meals["lunch-2"]!.portions).toBe(6);
    // ticking "part of this meal" joins it, and both then cook the larger amount
    await planner.setMeal(W, mon, "lunch-2", { joined: true });
    expect(Object.values((await dayOf(mon)).meals).map((m) => m!.portions)).toEqual([6, 6]);
  });

  it("dropping a dish on another meal moves it in, and leftovers of it follow", async () => {
    await planner.setMeal(W, mon, "dinner", { recipe: "tofu", type: "cook", portions: 4 });
    await planner.setMeal(W, tue, "lunch", { recipe: "rice", type: "cook", portions: 4 });
    await planner.setMeal(W, wed, "lunch", { recipe: "rice", type: "leftovers", leftoverFrom: `${tue}/lunch` });
    const r = await planner.copyMeals(W, { from: { date: tue, slot: "lunch" }, to: [{ date: mon, slot: "dinner" }], mode: "join" });
    expect(r.result.mode).toBe("join");
    expect(r.message).toBe("Rice added to Tofu");
    expect((await dayOf(tue)).meals.lunch).toBeUndefined();
    expect((await dayOf(mon)).meals["dinner-2"]).toMatchObject({ recipe: "rice", joined: true, portions: 4 });
    expect((await dayOf(wed)).meals.lunch!.leftoverFrom).toBe(`${mon}/dinner-2`);
    expect(r.view.warnings).toEqual([]);
  });

  it("Ctrl+dropping (keep) adds a copy and leaves the original", async () => {
    await planner.setMeal(W, mon, "dinner", { recipe: "tofu", type: "cook" });
    await planner.setMeal(W, tue, "dinner", { recipe: "rice", type: "cook" });
    await planner.copyMeals(W, { from: { date: tue, slot: "dinner" }, to: [{ date: mon, slot: "dinner" }], mode: "join", keep: true });
    expect((await dayOf(tue)).meals.dinner!.recipe).toBe("rice");
    expect((await dayOf(mon)).meals["dinner-2"]).toMatchObject({ recipe: "rice", joined: true });
  });

  it("a dish already in the slot just becomes part of the meal", async () => {
    await planner.setMeal(W, mon, "dinner", { recipe: "tofu", type: "cook", people: 3 });
    await planner.setMeal(W, mon, "dinner-2", { recipe: "rice", type: "cook" });
    await planner.copyMeals(W, { from: { date: mon, slot: "dinner-2" }, to: [{ date: mon, slot: "dinner" }], mode: "join" });
    expect(await slotsOf(mon)).toMatchObject({ dinner: { recipe: "tofu" }, "dinner-2": { recipe: "rice", joined: true, people: 3 } });
  });

  it("can't add dishes to eating out or to make-ahead cooking", async () => {
    await planner.setMeal(W, mon, "dinner", { type: "eat-out" });
    await planner.setMeal(W, tue, "dinner", { recipe: "rice", type: "cook" });
    await expect(planner.copyMeals(W, { from: { date: tue, slot: "dinner" }, to: [{ date: mon, slot: "dinner" }], mode: "join" })).rejects.toThrow(/cooking or eating leftovers/);
    await expect(planner.addDishes(W, mon, "dinner", ["rice"])).rejects.toThrow(/cooking or eating leftovers/);
    await expect(planner.addDishes(W, wed, "dinner", ["rice"])).rejects.toThrow(/no meal there/);
  });

  describe("a meal of several dishes", () => {
    beforeEach(async () => {
      await planner.setMeal(W, mon, "dinner", { recipe: "tofu", type: "cook" });
      await planner.addDishes(W, mon, "dinner", ["rice", "greens"]);
    });

    it("turns into leftovers of every dish, and each cooks enough", async () => {
      const r = await planner.copyMeals(W, { from: { date: mon, slot: "dinner" }, to: [{ date: tue, slot: "lunch" }], mode: "leftovers" });
      expect(r.result.cookMore).toMatchObject({ portions: 4 });
      expect(await slotsOf(tue)).toEqual({
        lunch: { recipe: "tofu", type: "leftovers", people: null, portions: null, joined: false, leftoverFrom: `${mon}/dinner` },
        "lunch-2": { recipe: "rice", type: "leftovers", people: null, portions: null, joined: true, leftoverFrom: `${mon}/dinner-2` },
        "lunch-3": { recipe: "greens", type: "leftovers", people: null, portions: null, joined: true, leftoverFrom: `${mon}/dinner-3` },
      });
      expect(Object.values((await dayOf(mon)).meals).map((m) => m!.portions)).toEqual([4, 4, 4]);
      expect(r.view.warnings).toEqual([]);
    });

    it("keeps only as long as its quickest-to-spoil dish ('smart' cooks again after that)", async () => {
      // the greens keep 1 day, so Wednesday is too late for leftovers of the whole meal
      const r = await planner.copyMeals(W, { from: { date: mon, slot: "dinner" }, to: [{ date: wed, slot: "dinner" }] });
      expect(r.result.mode).toBe("repeat");
      expect(Object.values((await dayOf(wed)).meals).map((m) => [m!.recipe, m!.type, m!.joined])).toEqual([
        ["tofu", "cook", false],
        ["rice", "cook", true],
        ["greens", "cook", true],
      ]);
    });

    it("moves as a whole, with its leftovers following", async () => {
      await planner.copyMeals(W, { from: { date: mon, slot: "dinner" }, to: [{ date: tue, slot: "lunch" }], mode: "leftovers" });
      await planner.copyMeals(W, { from: { date: mon, slot: "dinner" }, to: [{ date: mon, slot: "breakfast" }], mode: "move" });
      expect(Object.keys((await dayOf(mon)).meals).sort()).toEqual(["breakfast", "breakfast-2", "breakfast-3"]);
      expect(Object.values((await dayOf(tue)).meals).map((m) => m!.leftoverFrom)).toEqual([`${mon}/breakfast`, `${mon}/breakfast-2`, `${mon}/breakfast-3`]);
    });

    it("a joined dish dragged elsewhere leaves the meal on its own", async () => {
      await planner.copyMeals(W, { from: { date: mon, slot: "dinner-2" }, to: [{ date: tue, slot: "dinner" }], mode: "move" });
      expect(Object.keys((await dayOf(mon)).meals)).toEqual(["dinner", "dinner-3"]);
      expect((await dayOf(tue)).meals.dinner).toMatchObject({ recipe: "rice", joined: false });
    });

    it("filling over a meal replaces all of its dishes", async () => {
      await planner.setMeal(W, tue, "dinner", { recipe: "rice", type: "cook" });
      await planner.addDishes(W, tue, "dinner", ["greens"]);
      await planner.copyMeals(W, { from: { date: mon, slot: "dinner" }, to: [{ date: tue, slot: "dinner" }], mode: "repeat" });
      expect(Object.values((await dayOf(tue)).meals).map((m) => m!.recipe)).toEqual(["tofu", "rice", "greens"]);
    });

    it("is marked cooked as a whole, logging each recipe", async () => {
      await planner.markCooked(W, mon, "dinner", { rating: 5 });
      expect(Object.values((await dayOf(mon)).meals).every((m) => m!.cooked)).toBe(true);
      expect(ctx.store.getRecipe("tofu")!.cookLog.map((c) => c.rating)).toEqual([5]);
      expect(ctx.store.getRecipe("rice")!.cookLog.map((c) => c.rating)).toEqual([null]);
      expect(ctx.store.getRecipe("greens")!.cookLog).toHaveLength(1);
    });

    it("removing the first dish keeps the rest: the next one moves up and its leftovers follow", async () => {
      await planner.copyMeals(W, { from: { date: mon, slot: "dinner" }, to: [{ date: tue, slot: "lunch" }], mode: "leftovers" });
      await planner.setMeal(W, mon, "dinner", null);
      expect(await slotsOf(mon)).toMatchObject({ dinner: { recipe: "rice", joined: false }, "dinner-3": { recipe: "greens", joined: true } });
      expect(mealGroup(await dayOf(mon), "dinner")).toEqual(["dinner", "dinner-3"]);
      // the tofu leftovers went with the tofu; the rice leftovers moved up too, and point at the rice's new slot
      expect(await slotsOf(tue)).toMatchObject({
        lunch: { recipe: "rice", joined: false, leftoverFrom: `${mon}/dinner` },
        "lunch-3": { recipe: "greens", joined: true, leftoverFrom: `${mon}/dinner-3` },
      });
      expect(Object.keys((await dayOf(tue)).meals)).toHaveLength(2);
      expect((await planner.window(mon)).warnings).toEqual([]);
    });
  });
});

describe("suggested recipes", () => {
  it("a recipe can't suggest itself, and each suggestion is kept once", () => {
    expect(parseRecipeMeta({ id: "tofu", title: "Tofu", suggested: ["rice", "tofu", "rice", "greens"] }).suggested).toEqual(["rice", "greens"]);
    expect(parseRecipeMeta({ id: "tofu", title: "Tofu" }).suggested).toEqual([]);
  });

  it("renaming a recipe keeps the suggestions pointing at it", async () => {
    await ctx.store.updateRecipe("tofu", { suggested: ["rice", "greens"] } as any);
    await ctx.store.renameSlug("rice", "white-rice");
    expect(ctx.store.getRecipe("tofu")!.meta.suggested).toEqual(["white-rice", "greens"]);
  });
});
