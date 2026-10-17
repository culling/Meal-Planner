import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { windowStartFor } from "../src/dates";
import { Planner } from "../src/planner";
import { tempStore } from "./helpers";

// The plan page shows 7 days from today, crossing the week files the plan is saved in.

let ctx: Awaited<ReturnType<typeof tempStore>>;
let planner: Planner;
const SAT = "2026-10-17"; // window Sat 17 – Fri 23 Oct: the end of 2026-W42 and most of 2026-W43

beforeEach(async () => {
  ctx = await tempStore();
  planner = new Planner(ctx.store);
  await ctx.store.updateSettings({ defaultPeople: 2 });
  await ctx.store.createRecipe({ title: "Curry", servings: 2, ingredientsMd: "- 400 g lentils", methodMd: "1. Cook" });
  await ctx.store.createRecipe({ title: "Pasta", servings: 2, ingredientsMd: "- 200 g spaghetti", methodMd: "1. Boil", role: ["main"] });
});
afterEach(async () => ctx.cleanup());

describe("windows", () => {
  it("count whole weeks from today", () => {
    expect(windowStartFor("2026-10-17", SAT)).toBe(SAT);
    expect(windowStartFor("2026-10-23", SAT)).toBe(SAT);
    expect(windowStartFor("2026-10-24", SAT)).toBe("2026-10-24");
    expect(windowStartFor("2026-10-16", SAT)).toBe("2026-10-10");
  });

  it("show 7 days from any date, edited across two week files", async () => {
    await planner.setMeal(SAT, "2026-10-18", "dinner", { recipe: "curry", type: "cook", portions: 4 });
    const view = await planner.setMeal(SAT, "2026-10-19", "lunch", { type: "leftovers", leftoverFrom: "2026-10-18/dinner" });
    expect(view.days.map((d) => d.date)).toEqual(["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    expect([view.startDate, view.endDate, view.prevStart, view.nextStart]).toEqual([SAT, "2026-10-23", "2026-10-10", "2026-10-24"]);
    expect(view.days[1].meals.dinner?.meal.recipe).toBe("curry");
    expect(view.days[2].meals.lunch?.meal.recipe).toBe("curry"); // leftovers across the week boundary
    expect(view.warnings).toEqual([]);
    expect((await planner.view("2026-W42")).days[6].meals.dinner?.meal.recipe).toBe("curry"); // saved in Sunday's week
    expect((await planner.view("2026-W43")).days[0].meals.lunch?.meal.type).toBe("leftovers");
  });

  it("set people for every day shown, and clear back to the default", async () => {
    let view = await planner.setPeople(SAT, {}, 5);
    expect(view.days.every((d) => d.people.value === 5)).toBe(true);
    expect((await planner.view("2026-W42")).days[4].people.value).toBe(2); // Friday before the window is untouched
    view = await planner.setPeople(SAT, {}, null);
    expect(view.days.every((d) => d.people.value === 2 && d.people.from === "settings")).toBe(true);
  });

  it("copy the 7 days before, keeping leftovers linked", async () => {
    await planner.setMeal("2026-10-10", "2026-10-11", "dinner", { recipe: "curry", type: "cook", portions: 4 });
    await planner.setMeal("2026-10-10", "2026-10-12", "lunch", { type: "leftovers", leftoverFrom: "2026-10-11/dinner" });
    const view = await planner.copyDays("2026-10-10", SAT);
    expect(view.days[1].meals.dinner?.meal.recipe).toBe("curry");
    expect(view.days[2].meals.lunch?.meal.leftoverFrom).toBe("2026-10-18/dinner");
    await expect(planner.copyDays("2026-10-10", SAT)).rejects.toThrow(/already have meals/);
    await expect(planner.copyDays("2026-09-01", SAT, true)).rejects.toThrow();
  });

  it("suggest and shop for the days shown", async () => {
    await planner.setMeal(SAT, "2026-10-17", "dinner", { recipe: "curry", type: "cook" });
    await planner.setMeal(SAT, "2026-10-23", "dinner", { recipe: "pasta", type: "cook" });
    await planner.setMeal(SAT, "2026-10-24", "dinner", { recipe: "pasta", type: "cook" }); // the day after: not on the list
    const list = await planner.generateShopping(SAT);
    expect(list.week).toBe(SAT);
    expect(list.items.map((i) => i.text).sort()).toEqual(["200 g spaghetti", "400 g lentils"]);
    expect((await ctx.store.getShoppingList(SAT)).items).toHaveLength(2);
    expect(await ctx.store.listShoppingLists()).toEqual([SAT]);
  });
});
