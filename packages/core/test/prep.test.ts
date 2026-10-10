import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freePrepSlot, isPrepSlot } from "../src/mealplan";
import { Planner } from "../src/planner";
import { SettingsSchema } from "../src/schemas";
import { tempStore } from "./helpers";

// Cooking ahead: "tomorrow I'm making peanut butter smoothies to drink, and cheese muffins for the rest of the week
// (and not eating any tomorrow)".

let ctx: Awaited<ReturnType<typeof tempStore>>;
let planner: Planner;
const W = "2026-W42"; // Mon 12 – Sun 18 Oct 2026
const tomorrow = "2026-10-12";

const nutrition = (calories: number) => ({ perServing: { calories, proteinG: null, carbsG: null, fatG: null, saturatedFatG: null, fibreG: null, sugarG: null, sodiumMg: null }, source: "manual" as const, confidence: "high" as const, calculatedAt: null, breakdown: [] });

beforeEach(async () => {
  ctx = await tempStore();
  planner = new Planner(ctx.store);
  await ctx.store.createRecipe({ title: "Peanut Butter Smoothie", servings: 2, ingredientsMd: "- 2 bananas\n- 4 tbsp peanut butter", methodMd: "1. Blend", nutrition: nutrition(300) });
  await ctx.store.createRecipe({
    title: "Cheese Muffins",
    servings: 12,
    ingredientsMd: "- 300 g flour\n- 150 g cheese",
    methodMd: "1. Bake",
    nutrition: nutrition(220),
    leftovers: { fridgeDays: 4, freezerDays: 90, freezable: true, reheatNotes: null, source: "manual" },
  });
  await ctx.store.updateSettings({ defaultPeople: 2 });
});
afterEach(async () => ctx.cleanup());

const meals = async (week: string) => (await ctx.store.getPlan(week)).days.flatMap((d) => Object.entries(d.meals).map(([slot, m]) => ({ date: d.date, slot, m: m! })));

describe("make-ahead cooking", () => {
  it("names the slots prep, prep-2, … and keeps them out of the normal meals", () => {
    expect(["prep", "prep-2", "prep-12"].every(isPrepSlot)).toBe(true);
    expect(["dinner", "preparation", "prep-", "my-prep"].some(isPrepSlot)).toBe(false);
    expect(freePrepSlot({ meals: {} })).toBe("prep");
    expect(freePrepSlot({ meals: { prep: {}, "prep-2": {} } })).toBe("prep-3");
    expect(() => SettingsSchema.parse({ mealSlots: ["breakfast", "prep"] })).toThrow(/make-ahead/);
  });

  it("muffins cooked tomorrow are eaten by nobody tomorrow, and feed later meals as leftovers", async () => {
    // tomorrow: smoothies to drink (an ordinary meal), and muffins made ahead
    await planner.setMeal(W, tomorrow, "breakfast", { recipe: "peanut-butter-smoothie", type: "cook" });
    let view = await planner.setMeal(W, tomorrow, "prep", { recipe: "cheese-muffins", type: "cook" });

    const day = view.days[0];
    expect(day.prep).toHaveLength(1);
    expect(day.prep[0]).toMatchObject({ slot: "prep", title: "Cheese Muffins", made: 12, left: 12 }); // 12 made, none eaten yet
    expect(day.prep[0].meal).toMatchObject({ type: "cook", people: 0, portions: 12 });
    expect(day.meals.breakfast?.meal.type).toBe("cook"); // the smoothies are a normal meal that is eaten
    expect(day.meals.lunch).toBeNull();

    // the day's calories count what is eaten (the smoothie), not the muffins that were only baked
    expect(day.totals.caloriesPerPerson).toBe(300);
    expect(day.totals.mealsCounted).toBe(1);

    // "...for the rest of the week": snack at lunch Tue–Sat. Past the fridge life they're leftovers all the same; it warns, it doesn't refuse
    const lunches = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"].map((date) => ({ date, slot: "lunch" }));
    const r = await planner.copyMeals(W, { from: { date: tomorrow, slot: "prep" }, to: lunches });
    expect(r.result.mode).toBe("leftovers");
    expect(r.message).toMatch(/leftovers on Tue lunch, Wed lunch, Thu lunch, Fri lunch, Sat lunch/);
    for (const l of lunches) expect((await ctx.store.getPlan(W)).days.find((d) => d.date === l.date)!.meals.lunch).toMatchObject({ type: "leftovers", leftoverFrom: `${tomorrow}/prep` });

    // 5 days × 2 people = 10 portions eaten out of the 12 made: 2 left over
    view = await planner.view(W);
    expect(view.days[0].prep[0]).toMatchObject({ made: 12, left: 2 });
    // Tue–Thu are within the muffins' 4 days; Fri and Sat are not
    expect(view.warnings.filter((w) => w.code === "expired").map((w) => w.date)).toEqual(["2026-10-17"]);
    // calories on a leftovers day = the muffin each person eats
    expect(view.days[1].totals.caloriesPerPerson).toBe(220);
  });

  it("cooks more when the meals that eat it need more than were made", async () => {
    await planner.setMeal(W, tomorrow, "prep", { recipe: "cheese-muffins", type: "cook", portions: 4 });
    const r = await planner.copyMeals(W, { from: { date: tomorrow, slot: "prep" }, to: ["2026-10-13", "2026-10-14", "2026-10-15"].map((date) => ({ date, slot: "lunch" })) });
    expect(r.result.cookMore).toMatchObject({ portions: 6 }); // 3 meals × 2 people
    expect((await ctx.store.getPlan(W)).days[0].meals.prep?.portions).toBe(6);
    expect(r.message).toContain("now cooking 6 portions");
  });

  it("can have several make-aheads on one day, each with its own key", async () => {
    await planner.setMeal(W, tomorrow, "prep", { recipe: "cheese-muffins", type: "cook" });
    const view = await planner.setMeal(W, tomorrow, "prep-2", { recipe: "peanut-butter-smoothie", type: "cook", portions: 4 });
    expect(view.days[0].prep.map((p) => [p.slot, p.title, p.made])).toEqual([
      ["prep", "Cheese Muffins", 12],
      ["prep-2", "Peanut Butter Smoothie", 4],
    ]);
  });

  it("is always a cook with nobody eating it, however it is saved", async () => {
    const view = await planner.setMeal(W, tomorrow, "prep", { recipe: "cheese-muffins", type: "eat-out", people: 5 });
    expect(view.days[0].prep[0].meal).toMatchObject({ type: "cook", people: 0 });
    await expect(planner.setMeal(W, tomorrow, "prep-2", { type: "cook" })).rejects.toThrow(/what to make ahead/);
  });

  it("can be frozen so it keeps beyond the fridge life", async () => {
    await planner.setMeal(W, tomorrow, "prep", { recipe: "cheese-muffins", type: "cook", portions: 12, frozen: [{ date: tomorrow, portions: 6 }] });
    const view = await planner.view(W);
    expect(view.days[0].prep[0]).toMatchObject({ made: 12, left: 6, frozenLeft: 6 });
    await planner.setMeal("2026-W43", "2026-10-20", "lunch", { recipe: "cheese-muffins", type: "leftovers", leftoverFrom: `${tomorrow}/prep`, leftoverStore: "freezer", people: 2 });
    expect((await planner.view("2026-W43")).warnings).toEqual([]); // 8 days later is fine from the freezer
  });

  it("the shopping list buys for the whole batch, not for the people eating on the day", async () => {
    await planner.setMeal(W, tomorrow, "prep", { recipe: "cheese-muffins", type: "cook" }); // 12 portions of a 12-serving recipe
    await planner.setMeal(W, tomorrow, "breakfast", { recipe: "peanut-butter-smoothie", type: "cook" }); // 2 people of 2 servings
    const list = await planner.generateShopping(W);
    const text = list.items.map((i) => i.text);
    expect(text.some((t) => /^300\s?g flour/.test(t))).toBe(true); // the whole batch (×1), not just the people eating today
    expect(text.some((t) => /^150\s?g cheese/.test(t))).toBe(true);
    expect(text.some((t) => /banana/.test(t))).toBe(true);
  });

  it("only make-ahead food can go on the make-ahead row, and it can't be 'repeated' into meals", async () => {
    await planner.setMeal(W, tomorrow, "prep", { recipe: "cheese-muffins", type: "cook" });
    await planner.setMeal(W, tomorrow, "dinner", { recipe: "peanut-butter-smoothie", type: "cook" });
    await expect(planner.copyMeals(W, { from: { date: tomorrow, slot: "dinner" }, to: [{ date: "2026-10-13", slot: "prep" }] })).rejects.toThrow(/own row/);
    await expect(planner.copyMeals(W, { from: { date: tomorrow, slot: "prep" }, to: [{ date: "2026-10-13", slot: "lunch" }], mode: "repeat" })).rejects.toThrow(/eaten as leftovers/);
    await expect(planner.copyMeals(W, { from: { date: tomorrow, slot: "prep" }, to: [{ date: "2026-10-13", slot: "prep" }, { date: "2026-10-13", slot: "lunch" }] })).rejects.toThrow(/not both/);
  });

  it("can be cooked again on another day's make-ahead row, or moved there", async () => {
    await planner.setMeal(W, tomorrow, "prep", { recipe: "cheese-muffins", type: "cook" });
    await planner.copyMeals(W, { from: { date: tomorrow, slot: "prep" }, to: [{ date: "2026-10-15", slot: "prep" }, { date: "2026-10-15", slot: "prep" }] }); // asked twice: one copy
    expect((await meals(W)).filter((x) => isPrepSlot(x.slot)).map((x) => `${x.date}/${x.slot}`)).toEqual([`${tomorrow}/prep`, "2026-10-15/prep"]);
    // eat some of the first batch, then move that batch to Wednesday: the meals eating it follow
    await planner.copyMeals(W, { from: { date: tomorrow, slot: "prep" }, to: [{ date: "2026-10-13", slot: "lunch" }] });
    await planner.copyMeals(W, { from: { date: tomorrow, slot: "prep" }, to: [{ date: "2026-10-14", slot: "prep" }], mode: "move" });
    const all = await meals(W);
    expect(all.find((x) => x.date === "2026-10-13" && x.slot === "lunch")!.m.leftoverFrom).toBe("2026-10-14/prep");
    expect(all.filter((x) => isPrepSlot(x.slot)).map((x) => x.date)).toEqual(["2026-10-14", "2026-10-15"]);
  });

  it("is written in the plan file and readable in its table", async () => {
    await planner.setMeal(W, tomorrow, "prep", { recipe: "cheese-muffins", type: "cook" });
    const text = await fs.readFile(path.join(ctx.dir, "meal-plans", `${W}.md`), "utf8");
    expect(text).toContain("| Day | Breakfast | Lunch | Dinner | Make ahead |");
    expect(text).toContain("Cheese Muffins (make ahead, 12)");
    expect(text).toContain("prep:"); // in the frontmatter, with the other meals
  });

  it("marking it cooked logs it in the recipe without inventing a number of people", async () => {
    await planner.setMeal(W, tomorrow, "prep", { recipe: "cheese-muffins", type: "cook" });
    await planner.markCooked(W, tomorrow, "prep", { rating: 5 });
    const log = ctx.store.getRecipe("cheese-muffins")!.cookLog;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ date: tomorrow, people: null, rating: 5 });
  });
});
