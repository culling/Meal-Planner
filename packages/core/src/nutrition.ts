import { z } from "zod";
import { knownGrams, knownMl, parseIngredient } from "./ingredients";
import { slugify, nowIso } from "./fsutil";
import type { OllamaClient } from "./ollama";
import {
  NUTRIENT_KEYS,
  NutrientsSchema,
  emptyNutrients,
  type BreakdownRow,
  type Confidence,
  type Food,
  type Nutrients,
  type ParsedIngredient,
  type Recipe,
  type RecipeNutrition,
} from "./schemas";
import type { DataStore } from "./store";

// ---------- pure helpers (shared with the web UI via shared.ts) ----------

export function scaleNutrients(n: Nutrients, factor: number): Nutrients {
  const out = emptyNutrients();
  for (const k of NUTRIENT_KEYS) out[k] = n[k] == null ? null : round1(n[k]! * factor);
  return out;
}

export function sumNutrients(list: Nutrients[]): Nutrients {
  const out = emptyNutrients();
  for (const k of NUTRIENT_KEYS) {
    const vals = list.map((n) => n[k]).filter((v): v is number => v != null);
    out[k] = vals.length ? round1(vals.reduce((a, b) => a + b, 0)) : null;
  }
  return out;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** A row shows the "?" icon while an AI guess is still in it and nobody has confirmed it. */
export function rowSource(row: Pick<BreakdownRow, "override" | "gramsSource"> & { source?: "ai" | "manual" }, food: Pick<Food, "source"> | undefined): "ai" | "manual" {
  if (row.override) return "manual";
  if (!food && row.source) return row.source; // no linked food to judge by: keep what the row already says
  if (food?.source === "ai" || row.gramsSource === "ai") return "ai";
  return "manual";
}

/** Recompute each row's total from its food and grams (rows a person overrode are kept as typed). */
export function recomputeBreakdown(rows: BreakdownRow[], foods: Food[]): BreakdownRow[] {
  const byId = new Map(foods.map((f) => [f.id, f]));
  return rows.map((row) => {
    const food = row.food ? byId.get(row.food) : undefined;
    let total = row.total;
    if (!row.override && food && row.grams != null) total = scaleNutrients(food.per100g, row.grams / 100);
    return { ...row, total, source: rowSource(row, food) };
  });
}

export function sumBreakdown(rows: BreakdownRow[], servings: number | null): Nutrients {
  const counted = rows.filter((r) => !r.excluded);
  return scaleNutrients(sumNutrients(counted.map((r) => r.total)), 1 / Math.max(servings ?? 1, 1));
}

/** Words that don't change which food it is. */
const NAME_FILLER = /\b(fresh|freshly|large|small|medium|ripe|whole|finely|roughly|thinly|chopped|diced|sliced|minced|grated|crushed|ground|boneless|skinless|good quality|extra|packed|plain|cooked|raw|uncooked)\b/g;

export function foodNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(NAME_FILLER, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singular(w: string): string {
  return w.replace(/ies$/, "y").replace(/(o|ch|sh|x)es$/, "$1").replace(/([^s])s$/, "$1");
}

export function findFood(foods: Food[], ingredientName: string): Food | undefined {
  const key = singular(foodNameKey(ingredientName));
  if (!key) return undefined;
  const id = slugify(key);
  const exact = foods.find((f) => f.id === id || singular(foodNameKey(f.name)) === key || f.aliases.some((a) => singular(foodNameKey(a)) === key));
  if (exact) return exact;
  // fall back to a food whose words are all in the ingredient name ("chicken thigh" in "chicken thigh fillets")
  const words = new Set(key.split(" ").map(singular));
  let best: Food | undefined;
  let bestLen = 0;
  for (const f of foods) {
    const fw = singular(foodNameKey(f.name)).split(" ").map(singular);
    if (fw.length < 2 && fw[0] !== key) continue;
    if (fw.every((w) => words.has(w)) && fw.length > bestLen) (best = f), (bestLen = fw.length);
  }
  return best;
}

// ---------- AI estimation ----------

const AiItemSchema = z.object({
  index: z.number(),
  foodName: z.string(),
  grams: z.number(),
  per100g: NutrientsSchema,
});
const AiResultSchema = z.object({ items: z.array(AiItemSchema) });

const SYSTEM = `You are a careful nutrition assistant. For each numbered recipe ingredient you give:
- foodName: the generic food, singular, lowercase, no preparation words (e.g. "chicken thigh", "olive oil", "plain yoghurt").
- grams: the total weight in grams of the amount listed in the recipe. If "known grams" is given, use exactly that number. Otherwise estimate using typical weights (1 cup flour ~125 g, 1 cup rice ~185 g, 1 cup milk ~245 g, 1 tbsp oil ~14 g, 1 medium onion ~110 g, 1 clove garlic ~3 g, 1 egg ~50 g).
- per100g: calories (kcal), proteinG, carbsG, fatG, saturatedFatG, fibreG, sugarG and sodiumMg for 100 g of the food as listed (uncooked/raw unless the recipe says cooked or canned).
Use typical values from food composition tables. Never leave a number out; use 0 where a nutrient is absent. Answer only with JSON.`;

export interface CalcOptions {
  /** also recompute rows a person set by hand (default: keep them) */
  keepManual?: boolean;
  model?: string;
  onProgress?: (msg: string) => void;
}

/** Make a macro-consistent, plausible per-100g record out of whatever a model returned. */
export function sanitisePer100g(n: Nutrients): { value: Nutrients; suspicious: boolean } {
  const v = { ...n };
  let suspicious = false;
  for (const k of NUTRIENT_KEYS) if (v[k] != null && (v[k]! < 0 || !isFinite(v[k]!))) ((v[k] = 0), (suspicious = true));
  const p = v.proteinG ?? 0;
  const c = v.carbsG ?? 0;
  const f = v.fatG ?? 0;
  const macroKcal = 4 * p + 4 * c + 9 * f;
  if (v.calories == null) {
    v.calories = Math.round(macroKcal);
  } else if (Math.abs(v.calories - macroKcal) > 0.35 * Math.max(macroKcal, 20) + 30) {
    // the calorie figure disagrees with the macros: trust the macros, flag it
    v.calories = Math.round(macroKcal);
    suspicious = true;
  }
  if (v.calories > 900) ((v.calories = 900), (suspicious = true));
  if (v.saturatedFatG != null && v.saturatedFatG > f) v.saturatedFatG = f;
  if (v.sugarG != null && v.sugarG > c) v.sugarG = c;
  if (v.fibreG != null && v.fibreG > c) v.fibreG = c;
  return { value: v, suspicious };
}

export interface NutritionResult {
  nutrition: RecipeNutrition;
  newFoods: string[];
  warnings: string[];
}

/**
 * Calculate per-serving nutrition from the ingredient list.
 * Foods already in the database are reused (so a value a person corrected stays corrected);
 * only unknown foods or unknown gram amounts go to the local model.
 */
export async function calculateNutrition(store: DataStore, ollama: OllamaClient, recipe: Recipe, opts: CalcOptions = {}): Promise<NutritionResult> {
  const settings = store.getSettings();
  if (settings.nutrition.provider === "none") throw new Error("Nutrition calculation is turned off in settings");
  const model = opts.model ?? settings.nutrition.model;
  const warnings: string[] = [];
  const foods = [...store.listFoods()];
  const previous = new Map(recipe.meta.nutrition.breakdown.map((r) => [r.ingredient, r]));

  type Work = { ing: ParsedIngredient; grams: number | null; gramsSource: "unit" | "ai"; food: Food | undefined };
  const rows: BreakdownRow[] = [];
  const todo: Work[] = [];
  const order: ({ kind: "row"; row: BreakdownRow } | { kind: "work"; w: Work })[] = [];

  for (const ing of recipe.ingredients) {
    const prev = previous.get(ing.raw);
    if (prev && (prev.override || prev.gramsSource === "manual") && opts.keepManual !== false) {
      order.push({ kind: "row", row: prev });
      continue;
    }
    if (ing.optional && ing.quantity === null) {
      order.push({ kind: "row", row: { ingredient: ing.raw, food: null, grams: null, gramsSource: "unit", excluded: true, override: false, source: "manual", total: emptyNutrients() } });
      continue;
    }
    const food = findFood(foods, ing.name);
    let grams = knownGrams(ing);
    let gramsSource: "unit" | "ai" = "unit";
    if (grams == null && food) {
      const ml = knownMl(ing);
      if (ml != null && food.gramsPerCup) grams = (ml / 250) * food.gramsPerCup;
      else if (ing.quantity != null && !ing.unit && food.gramsPerPiece) grams = ing.quantity * food.gramsPerPiece;
    }
    if (grams == null) gramsSource = "ai";
    const w: Work = { ing, grams, gramsSource, food };
    order.push({ kind: "work", w });
    if (!food || grams == null) todo.push(w);
  }

  // ask the model in small batches so a 4–9B model stays accurate
  const newFoods = new Map<string, Food>();
  const BATCH = 8;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    opts.onProgress?.(`Asking ${model} about ${chunk.length} ingredient${chunk.length === 1 ? "" : "s"}…`);
    const prompt =
      `Recipe: ${recipe.meta.title}\nIngredients:\n` +
      chunk.map((w, j) => `${j + 1}. ${w.ing.raw.replace(/^[-*]\s*/, "")}${w.grams != null ? `   [known grams: ${Math.round(w.grams)}]` : ""}`).join("\n");
    const res = await ollama.chatJson({ model, system: SYSTEM, prompt, schema: AiResultSchema, timeoutMs: 240_000 });
    for (const item of res.items) {
      const w = chunk[item.index - 1];
      if (!w) continue;
      const { value, suspicious } = sanitisePer100g(item.per100g);
      if (suspicious) warnings.push(`Check "${item.foodName}": the model's numbers didn't add up, so calories were recalculated from the macros.`);
      const name = foodNameKey(item.foodName) || foodNameKey(w.ing.name) || item.foodName.toLowerCase();
      if (!w.food) {
        const existing = findFood([...foods, ...newFoods.values()], name);
        if (existing) w.food = existing;
        else {
          const alias = foodNameKey(w.ing.name);
          const food: Food = {
            id: slugify(name),
            name,
            aliases: alias && alias !== name ? [alias] : [],
            per100g: value,
            gramsPerCup: null,
            gramsPerPiece: null,
            source: "ai",
            updatedAt: nowIso(),
          };
          newFoods.set(food.id, food);
          foods.push(food);
          w.food = food;
        }
      }
      if (w.grams == null) w.grams = Math.max(0, item.grams);
    }
  }
  if (newFoods.size) await store.upsertFoods([...newFoods.values()]);

  const byId = new Map(foods.map((f) => [f.id, f]));
  for (const entry of order) {
    if (entry.kind === "work") {
      const { ing, grams, gramsSource, food } = entry.w;
      if (!food || grams == null) {
        warnings.push(`Couldn't work out "${ing.raw}" — add it by hand.`);
        rows.push({ ingredient: ing.raw, food: null, grams: null, gramsSource: "ai", excluded: false, override: false, source: "ai", total: emptyNutrients() });
        continue;
      }
      const f = byId.get(food.id) ?? food;
      const row: BreakdownRow = {
        ingredient: ing.raw,
        food: f.id,
        grams: Math.round(grams),
        gramsSource,
        excluded: false,
        override: false,
        source: "ai",
        total: scaleNutrients(f.per100g, grams / 100),
      };
      row.source = rowSource(row, f);
      rows.push(row);
    } else rows.push(entry.row);
  }

  const recomputed = recomputeBreakdown(rows, foods);
  const aiGrams = recomputed.filter((r) => !r.excluded && r.gramsSource === "ai").length;
  const counted = recomputed.filter((r) => !r.excluded).length || 1;
  const confidence: Confidence = recomputed.some((r) => !r.excluded && r.grams == null) ? "low" : aiGrams / counted > 0.4 ? "low" : "medium";
  return {
    nutrition: {
      perServing: sumBreakdown(recomputed, recipe.meta.servings),
      source: "calculated",
      confidence,
      calculatedAt: nowIso(),
      breakdown: recomputed,
    },
    newFoods: [...newFoods.keys()],
    warnings,
  };
}

/** Estimate a single new food (used by the nutrition database page's "ask AI" button). */
export async function estimateFood(ollama: OllamaClient, model: string, name: string): Promise<Nutrients> {
  const res = await ollama.chatJson({
    model,
    system: SYSTEM,
    prompt: `Recipe: (lookup)\nIngredients:\n1. 100 g ${name}   [known grams: 100]`,
    schema: AiResultSchema,
    timeoutMs: 120_000,
  });
  const item = res.items[0];
  if (!item) throw new Error("The model returned nothing");
  return sanitisePer100g(item.per100g).value;
}

/** Re-sum a recipe's breakdown after the food database or a row changed. */
export async function applyBreakdown(store: DataStore, slug: string, rows: BreakdownRow[], extra: Partial<RecipeNutrition> = {}): Promise<Recipe> {
  return store.mutateRecipe(
    slug,
    (meta) => {
      const recomputed = recomputeBreakdown(rows, store.listFoods());
      const anyAi = recomputed.some((r) => !r.excluded && r.source === "ai");
      meta.nutrition = {
        ...meta.nutrition,
        ...extra,
        breakdown: recomputed,
        perServing: sumBreakdown(recomputed, meta.servings),
        source: "calculated",
        confidence: anyAi ? "low" : "medium",
        calculatedAt: nowIso(),
      };
      return { meta };
    },
    { reason: `Nutrition for ${slug}` },
  );
}

export { parseIngredient };
