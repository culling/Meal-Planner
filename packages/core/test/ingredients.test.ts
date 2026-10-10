import { describe, expect, it } from "vitest";
import { formatIngredient, formatQuantity, knownGrams, knownMl, parseIngredient, parseIngredientSection } from "../src/ingredients";

describe("parseIngredient", () => {
  it("reads quantity, unit and name", () => {
    const i = parseIngredient("- 600 g chicken thigh, cut into bite-size pieces");
    expect(i).toMatchObject({ quantity: 600, unit: "g", name: "chicken thigh", prep: "cut into bite-size pieces" });
  });
  it("handles mixed fractions and unicode fractions", () => {
    expect(parseIngredient("1 1/2 cups plain yoghurt")).toMatchObject({ quantity: 1.5, unit: "cup", name: "plain yoghurt" });
    expect(parseIngredient("½ tsp salt")).toMatchObject({ quantity: 0.5, unit: "tsp", name: "salt" });
    expect(parseIngredient("1½ cups flour")).toMatchObject({ quantity: 1.5, unit: "cup" });
  });
  it("handles ranges", () => {
    expect(parseIngredient("2-3 cloves garlic, minced")).toMatchObject({ quantity: 2, quantityMax: 3, unit: "clove", name: "garlic" });
  });
  it("captures a metric amount in brackets or after a slash", () => {
    expect(parseIngredient("1 cup (250ml) milk")).toMatchObject({ quantity: 1, unit: "cup", name: "milk", metric: { quantity: 250, unit: "ml" } });
    expect(parseIngredient("400 g / 14 oz canned crushed tomatoes")).toMatchObject({ quantity: 400, unit: "g", name: "canned crushed tomatoes" });
    const cans = parseIngredient("2 (400g) cans chickpeas");
    expect(cans).toMatchObject({ quantity: 2, unit: "can", name: "chickpeas" });
    expect(cans.metric).toEqual({ quantity: 800, unit: "g" });
  });
  it("copes with lines that have no quantity", () => {
    const i = parseIngredient("Salt and pepper, to taste");
    expect(i.quantity).toBeNull();
    expect(i.optional).toBe(true);
  });
  it("treats counts without units as counts", () => {
    expect(parseIngredient("3 large eggs")).toMatchObject({ quantity: 3, unit: null, name: "large eggs" });
  });
  it("splits sections into groups", () => {
    const list = parseIngredientSection("### Marinade\n- 1 tbsp oil\n- 2 tsp cumin\n\n### Sauce\n- 1 onion");
    expect(list.map((i) => [i.group, i.name])).toEqual([
      ["Marinade", "oil"],
      ["Marinade", "cumin"],
      ["Sauce", "onion"],
    ]);
  });
});

describe("grams and formatting", () => {
  it("knows grams for mass units only", () => {
    expect(knownGrams(parseIngredient("2 kg potatoes"))).toBe(2000);
    expect(knownGrams(parseIngredient("1 cup flour"))).toBeNull();
    expect(knownMl(parseIngredient("2 tbsp oil"))).toBe(30);
  });
  it("scales and formats nicely", () => {
    expect(formatQuantity(0.5)).toBe("½");
    expect(formatQuantity(1.25)).toBe("1¼");
    expect(formatQuantity(2.99)).toBe("3");
    expect(formatIngredient(parseIngredient("2 tbsp butter"), 2)).toBe("4 tbsp butter");
    expect(formatIngredient(parseIngredient("1 cup milk"), 2)).toBe("2 cups milk");
    expect(formatIngredient(parseIngredient("600 g chicken thigh, diced"), 0.5)).toBe("300g chicken thigh, diced");
  });
});
