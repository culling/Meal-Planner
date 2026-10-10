import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "@mp/core";
import { buildTools } from "../src/tools";

let app: App;
let dir: string;
let call: (name: string, args?: any) => Promise<{ summary: string; data?: any }>;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mp-mcp-"));
  app = await createApp({ dataDir: dir, gitAutocommit: false, watch: false });
  const tools = new Map(buildTools(app).map((t) => [t.name, t]));
  call = (name, args = {}) => tools.get(name)!.handler(args);
});
afterAll(async () => {
  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("MCP tools (through core, temp data folder)", () => {
  it("creates, searches, scales and updates recipes", async () => {
    await call("create_recipe", { title: "Butter Chicken", servings: 4, ingredientsMd: "- 600 g chicken\n- 2 tbsp butter", methodMd: "1. Cook", tags: ["curry"] });
    await call("update_recipe", { slug: "butter-chicken", patch: { nutrition: { perServing: { calories: 500 }, source: "manual" }, leftovers: { fridgeDays: 4 } } });
    expect((await call("search_recipes", { caloriesMax: 600, fridgeDaysMin: 3 })).data.recipes[0].slug).toBe("butter-chicken");
    expect((await call("search_recipes", { caloriesMax: 400 })).data.total).toBe(0);
    const r = await call("get_recipe", { slug: "butter-chicken", people: 8 });
    expect(r.data.ingredients[0]).toBe("1200g chicken");
    expect(r.data.ingredients[1]).toBe("4 tbsp butter");
    expect((await call("set_favorite", { slug: "butter-chicken", value: true })).summary).toContain("true");
    await call("add_recipe_note", { slug: "butter-chicken", text: "Great", date: "2026-10-01" });
    expect((await call("get_recipe", { slug: "butter-chicken" })).data.notes[0].text).toBe("Great");
  });

  it("plans meals, people, leftovers, cooked and shopping", async () => {
    await call("set_people", { week: "2026-W42", value: 3 });
    await call("set_meal", { date: "2026-10-12", slot: "dinner", recipe: "butter-chicken", type: "cook", portions: 6 });
    await call("set_meal", { date: "2026-10-13", slot: "lunch", recipe: "butter-chicken", type: "leftovers", leftoverFrom: "2026-10-12/dinner" });
    const plan = (await call("get_meal_plan", { week: "2026-W42" })).data;
    expect(plan.days[0].meals.dinner).toMatchObject({ people: 3, peopleFrom: "week", portions: 6 });
    expect(plan.warnings).toEqual([]);
    await call("set_people", { week: "2026-W42", date: "2026-10-12", slot: "dinner", value: 4 });
    expect((await call("get_meal_plan", { week: "2026-W42" })).data.days[0].meals.dinner.peopleFrom).toBe("meal");
    await call("set_people", { week: "2026-W42", date: "2026-10-12", slot: "dinner", value: null });
    expect((await call("list_available_leftovers", { date: "2026-10-14" })).data).toHaveLength(0); // 3 extra, 3 used
    await call("mark_meal_cooked", { date: "2026-10-12", slot: "dinner", rating: 5 });
    expect((await call("get_recipe", { slug: "butter-chicken" })).data.cookLog[0]).toMatchObject({ date: "2026-10-12", people: 3, rating: 5 });
    const list = await call("generate_shopping_list", { week: "2026-W42" });
    expect(list.data.some((i: any) => /chicken/.test(i.item))).toBe(true);
    expect((await call("suggest_meal_plan", { week: "2026-W50" })).summary).toMatch(/suggestion/);
    await call("update_settings", { patch: { defaultPeople: 5 } });
    expect((await call("get_settings")).data.defaultPeople).toBe(5);
  });
});
