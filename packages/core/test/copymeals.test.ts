import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Planner } from "../src/planner";
import { tempStore } from "./helpers";

let ctx: Awaited<ReturnType<typeof tempStore>>;
let planner: Planner;
const W = "2026-W42"; // Mon 12 Oct – Sun 18 Oct 2026
const mon = "2026-10-12";
const sun = "2026-10-18";

beforeEach(async () => {
  ctx = await tempStore();
  planner = new Planner(ctx.store);
  await ctx.store.createRecipe({ title: "Curry", servings: 2, ingredientsMd: "- 400 g lentils", methodMd: "1. Cook", leftovers: { fridgeDays: 3, freezerDays: null, freezable: true, reheatNotes: null, source: "manual" } });
  await ctx.store.createRecipe({ title: "Sandwich", servings: 1, ingredientsMd: "- 2 slices bread", methodMd: "1. Make" });
  await planner.setMeal(W, mon, "lunch", { recipe: "sandwich", type: "cook" });
  await planner.setMeal(W, sun, "dinner", { recipe: "curry", type: "cook" });
  await ctx.store.updateSettings({ defaultPeople: 2 });
});
afterEach(async () => {
  await ctx.cleanup();
});

const meals = async (week: string) => (await ctx.store.getPlan(week)).days.flatMap((d) => Object.entries(d.meals).map(([slot, m]) => ({ date: d.date, slot, m: m! })));

describe("copying meals", () => {
  it("dinner on Sunday feeds Monday lunch and Tuesday dinner of NEXT week as leftovers, and cooks enough", async () => {
    const r = await planner.copyMeals(W, { from: { date: sun, slot: "dinner" }, to: [{ date: "2026-10-19", slot: "lunch" }, { date: "2026-10-20", slot: "dinner" }] });
    expect(r.result.mode).toBe("leftovers"); // both are within the curry's 3 day fridge life
    expect(r.result.cookMore).toMatchObject({ portions: 6 }); // 2 people now + 2 + 2
    expect(r.message).toContain("leftovers on Mon lunch, Tue dinner");
    expect(r.message).toContain("now cooking 6 portions");
    const next = await meals("2026-W43");
    expect(next.map((x) => [x.date, x.slot, x.m.type, x.m.leftoverFrom])).toEqual([
      ["2026-10-19", "lunch", "leftovers", `${sun}/dinner`],
      ["2026-10-20", "dinner", "leftovers", `${sun}/dinner`],
    ]);
    expect((await meals(W)).find((x) => x.slot === "dinner" && x.date === sun)!.m.portions).toBe(6);
    // the plan agrees: nothing is over-used or expired
    expect((await planner.view("2026-W43")).warnings).toEqual([]);
  });

  it("a lunch dragged down the week repeats (past the fridge life it can't be leftovers)", async () => {
    const days = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"];
    const r = await planner.copyMeals(W, { from: { date: mon, slot: "lunch" }, to: days.map((date) => ({ date, slot: "lunch" })) });
    expect(r.result.mode).toBe("repeat");
    const lunches = (await meals(W)).filter((x) => x.slot === "lunch");
    expect(lunches).toHaveLength(6);
    expect(lunches.every((x) => x.m.type === "cook" && x.m.recipe === "sandwich" && !x.m.cooked)).toBe(true);
  });

  it("can be forced either way, and only cooked meals can become leftovers", async () => {
    const r = await planner.copyMeals(W, { from: { date: sun, slot: "dinner" }, to: [{ date: "2026-10-19", slot: "dinner" }], mode: "repeat" });
    expect(r.result.mode).toBe("repeat");
    await planner.setMeal(W, "2026-10-14", "dinner", { type: "eat-out" });
    await expect(planner.copyMeals(W, { from: { date: "2026-10-14", slot: "dinner" }, to: [{ date: "2026-10-15", slot: "dinner" }], mode: "leftovers" })).rejects.toThrow(/cooked meal/);
  });

  it("keeps extending: more leftovers add to what is cooked", async () => {
    await planner.copyMeals(W, { from: { date: sun, slot: "dinner" }, to: [{ date: "2026-10-19", slot: "lunch" }] });
    const r = await planner.copyMeals(W, { from: { date: "2026-10-19", slot: "lunch" }, to: [{ date: "2026-10-20", slot: "lunch" }] }); // copy the leftovers meal itself
    expect(r.result.mode).toBe("leftovers");
    expect((await meals(W)).find((x) => x.date === sun)!.m.portions).toBe(6);
  });

  it("overwrites what is there, and says so", async () => {
    await planner.setMeal(W, "2026-10-13", "lunch", { type: "eat-out" });
    const r = await planner.copyMeals(W, { from: { date: mon, slot: "lunch" }, to: [{ date: "2026-10-13", slot: "lunch" }], mode: "repeat" });
    expect(r.result.replaced).toBe(1);
    expect(r.message).toContain("replaced 1");
  });

  it("undo puts everything back, including the next week", async () => {
    const before = JSON.stringify((await meals(W)).concat(await meals("2026-W43")));
    const r = await planner.copyMeals(W, { from: { date: sun, slot: "dinner" }, to: [{ date: "2026-10-19", slot: "lunch" }] });
    expect((await meals("2026-W43")).length).toBe(1);
    await planner.restorePlans(W, r.undo.plans);
    expect(JSON.stringify((await meals(W)).concat(await meals("2026-W43")))).toBe(before);
  });

  it("moving a cooked meal takes its leftovers with it", async () => {
    await planner.copyMeals(W, { from: { date: sun, slot: "dinner" }, to: [{ date: "2026-10-19", slot: "lunch" }] });
    await planner.copyMeals(W, { from: { date: sun, slot: "dinner" }, to: [{ date: "2026-10-17", slot: "dinner" }], mode: "move" });
    expect((await meals(W)).filter((x) => x.slot === "dinner").map((x) => x.date)).toEqual(["2026-10-17"]);
    expect((await meals("2026-W43"))[0].m.leftoverFrom).toBe("2026-10-17/dinner"); // follows the move
    expect((await planner.view("2026-W43")).warnings).toEqual([]);
  });

  it("refuses nonsense", async () => {
    await expect(planner.copyMeals(W, { from: { date: "2026-10-15", slot: "dinner" }, to: [{ date: "2026-10-16", slot: "dinner" }] })).rejects.toThrow(/no meal there/);
    await expect(planner.copyMeals(W, { from: { date: mon, slot: "lunch" }, to: [] })).rejects.toThrow(/somewhere/);
    await expect(planner.copyMeals(W, { from: { date: mon, slot: "lunch" }, to: [{ date: "2026-10-13", slot: "brunch" }] })).rejects.toThrow(/brunch/);
    await expect(planner.copyMeals(W, { from: { date: mon, slot: "lunch" }, to: [{ date: "2026-12-25", slot: "lunch" }] })).rejects.toThrow(/too far/);
  });
});

describe("removing a cooked meal", () => {
  it("also removes the leftovers planned from it, even in the next week, and nothing else", async () => {
    await planner.copyMeals(W, { from: { date: sun, slot: "dinner" }, to: [{ date: "2026-10-19", slot: "lunch" }, { date: "2026-10-20", slot: "dinner" }] });
    await planner.setMeal("2026-W43", "2026-10-21", "dinner", { recipe: "curry", type: "cook" }); // cooked again, not leftovers
    const view = await planner.setMeal(W, sun, "dinner", null);
    expect(view.days[6].meals.dinner).toBeFalsy();
    expect((await meals(W)).map((x) => [x.date, x.slot])).toEqual([[mon, "lunch"]]);
    expect((await meals("2026-W43")).map((x) => [x.date, x.slot, x.m.type])).toEqual([["2026-10-21", "dinner", "cook"]]);
  });

  it("removing a leftovers meal leaves the cooking alone", async () => {
    await planner.copyMeals(W, { from: { date: sun, slot: "dinner" }, to: [{ date: "2026-10-19", slot: "lunch" }] });
    await planner.setMeal("2026-W43", "2026-10-19", "lunch", null);
    expect((await meals(W)).find((x) => x.date === sun)?.m.type).toBe("cook");
  });
});
