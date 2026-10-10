import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDays, isoWeekOf, setWeekStart, shiftWeek, weekDates, weekStartDate, weekStartOf } from "../src/dates";
import { Planner } from "../src/planner";
import { tempStore } from "./helpers";

afterEach(() => setWeekStart("monday"));

describe("weeks that start on another day", () => {
  it("Monday is unchanged", () => {
    expect(isoWeekOf("2026-10-12")).toBe("2026-W42");
    expect(weekStartDate("2026-W42")).toBe("2026-10-12");
  });

  it("Saturday weeks run Saturday to Friday, each with its own id", () => {
    setWeekStart("saturday");
    expect(weekStartOf("2026-10-10")).toBe("2026-10-10"); // a Saturday starts its own week
    expect(weekStartOf("2026-10-16")).toBe("2026-10-10"); // Friday is the last day
    expect(weekStartOf("2026-10-17")).toBe("2026-10-17");
    expect(isoWeekOf("2026-10-10")).toBe("2026-W41");
    expect(isoWeekOf("2026-10-16")).toBe("2026-W41");
    expect(isoWeekOf("2026-10-17")).toBe("2026-W42");
    expect(weekStartDate("2026-W41")).toBe("2026-10-10");
    expect(weekDates("2026-W41")).toEqual(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
    expect(shiftWeek("2026-W41", 1)).toBe("2026-W42");
    expect(shiftWeek("2026-W41", -1)).toBe("2026-W40");
  });

  it("every date belongs to exactly one week, for every start day, across a year end", () => {
    for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const) {
      setWeekStart(day);
      const seen = new Map<string, string[]>();
      let d = "2025-12-01";
      for (let i = 0; i < 120; i++, d = addDays(d, 1)) {
        const w = isoWeekOf(d);
        expect(weekDates(w)).toContain(d); // the week it names really contains it
        seen.set(w, [...(seen.get(w) ?? []), d]);
      }
      // consecutive weeks are 7 days apart and ids are unique
      const ids = [...seen.keys()];
      for (let i = 1; i < ids.length; i++) expect(shiftWeek(ids[i - 1], 1)).toBe(ids[i]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("changing the start day with plans already saved", () => {
  let ctx: Awaited<ReturnType<typeof tempStore>>;
  let planner: Planner;
  beforeEach(async () => {
    ctx = await tempStore();
    planner = new Planner(ctx.store);
    await ctx.store.createRecipe({ title: "Curry", servings: 2, ingredientsMd: "- 400 g lentils", methodMd: "1. Cook" });
  });
  afterEach(async () => ctx.cleanup());

  it("moves meals into the new weeks without losing any, and leftovers keep working", async () => {
    // Monday-start plan: Fri 9 Oct dinner (cook) and Sat 10 Oct lunch (leftovers of it), 2026-W41 = Mon 5 – Sun 11
    await planner.setPeople("2026-W41", {}, 3);
    await planner.setMeal("2026-W41", "2026-10-09", "dinner", { recipe: "curry", type: "cook", portions: 6 });
    await planner.setMeal("2026-W41", "2026-10-10", "lunch", { recipe: "curry", type: "leftovers", leftoverFrom: "2026-10-09/dinner" });
    await planner.setMeal("2026-W42", "2026-10-13", "dinner", { type: "eat-out" });
    expect(await ctx.store.listPlanWeeks()).toEqual(["2026-W41", "2026-W42"]);

    await ctx.store.updateSettings({ weekStartsOn: "saturday" });

    // Saturday-start: Fri 9 Oct is the last day of the week Sat 3 – Fri 9 (W40); Sat 10 starts the next one (W41)
    const w40 = await planner.view("2026-W40");
    const w41 = await planner.view("2026-W41");
    expect(w40.days.map((d) => d.date)[0]).toBe("2026-10-03");
    expect(w40.days[6].meals.dinner?.meal.recipe).toBe("curry");
    expect(w41.days[0].date).toBe("2026-10-10");
    expect(w41.days[0].meals.lunch?.meal.type).toBe("leftovers");
    expect(w41.days[3].meals.dinner?.meal.type).toBe("eat-out"); // Tue 13 Oct
    expect(w41.warnings).toEqual([]); // the leftovers still find their cook meal in the neighbouring week
    expect(w41.defaultPeople ?? w40.defaultPeople).toBe(3);

    const files = (await fs.readdir(path.join(ctx.dir, "meal-plans"))).sort();
    expect(files).toEqual(["2026-W40.md", "2026-W41.md"]);
    expect(await fs.readFile(path.join(ctx.dir, "meal-plans", "2026-W41.md"), "utf8")).toContain("startDate: 2026-10-10");
  });

  it("switching back restores the original grouping", async () => {
    await planner.setMeal("2026-W41", "2026-10-09", "dinner", { recipe: "curry", type: "cook" });
    await planner.setMeal("2026-W41", "2026-10-10", "lunch", { recipe: "curry", type: "cook" });
    await ctx.store.updateSettings({ weekStartsOn: "saturday" });
    await ctx.store.updateSettings({ weekStartsOn: "monday" });
    expect(await ctx.store.listPlanWeeks()).toEqual(["2026-W41"]);
    const v = await planner.view("2026-W41");
    expect(v.days[0].date).toBe("2026-10-05");
    expect(v.days[4].meals.dinner).toBeTruthy();
    expect(v.days[5].meals.lunch).toBeTruthy();
  });

  it("fixes plans made for a different start day when the app starts", async () => {
    await planner.setMeal("2026-W41", "2026-10-09", "dinner", { recipe: "curry", type: "cook" });
    // settings.md edited by hand while the app was closed
    const file = path.join(ctx.dir, "settings.md");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("weekStartsOn: monday", "weekStartsOn: saturday"));
    const { DataStore } = await import("../src/store");
    const again = new DataStore(ctx.store.cfg);
    await again.init();
    expect((await again.getPlan("2026-W40")).days[6].meals.dinner?.recipe).toBe("curry");
    expect(await again.listPlanWeeks()).toEqual(["2026-W40"]);
    await again.close();
  });

  it("does nothing when the files already match", async () => {
    await planner.setMeal("2026-W41", "2026-10-09", "dinner", { recipe: "curry", type: "cook" });
    expect(await ctx.store.rebucketPlans()).toEqual({ weeks: 0, days: 0 });
  });

  it("copying a week and the plan view follow the start day", async () => {
    await ctx.store.updateSettings({ weekStartsOn: "saturday" });
    await planner.setMeal("2026-W41", "2026-10-10", "dinner", { recipe: "curry", type: "cook" }); // Saturday, first day
    const v = await planner.copyWeek("2026-W41", "2026-W42");
    expect(v.days[0].date).toBe("2026-10-17");
    expect(v.days[0].meals.dinner?.meal.recipe).toBe("curry");
  });
});
