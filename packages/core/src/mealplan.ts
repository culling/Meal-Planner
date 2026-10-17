// Pure meal-plan logic (no file access) so the web UI can use it too.
import { addDays, diffDays, shiftWeek, weekStartDate } from "./dates";
import { MASS_G, VOLUME_ML, formatQuantity } from "./ingredients";
import type { DayPlan, Meal, MealPlan, ParsedIngredient, Recipe, Settings, ShoppingItem } from "./schemas";

// ---------- make-ahead cooking ----------
// A "make ahead" is food cooked on a day without anyone eating it that day (a batch of muffins for the week's snacks).
// It is stored as a cook meal with 0 people and an explicit number of portions, in a slot named prep, prep-2, prep-3…
// beside the day's normal meals, so leftovers, expiry warnings, freezing and the shopping list all work unchanged.

export const PREP_SLOT = /^prep(-\d+)?$/;
export const isPrepSlot = (slot: string): boolean => PREP_SLOT.test(slot);

/** The first prep slot name a day doesn't use yet: prep, prep-2, prep-3… */
export function freePrepSlot(day: { meals: Record<string, unknown> }, alsoTaken: Iterable<string> = []): string {
  const taken = new Set(alsoTaken);
  for (let n = 1; ; n++) {
    const name = n === 1 ? "prep" : `prep-${n}`;
    if (!day.meals[name] && !taken.has(name)) return name;
  }
}

// ---------- extra meals in a slot ----------
// A slot can hold more than one dish (meatloaf with honey glazed carrots, or several lunches cooked for meal prep).
// The first stays in the slot's own name (dinner); the others are stored beside it as dinner-2, dinner-3…

const EXTRA_SLOT = /^(.+)-(\d+)$/;

/** "dinner-2" -> "dinner"; a slot's own name, and make-ahead slots, give null. */
export function extraSlotBase(slot: string): string | null {
  if (isPrepSlot(slot)) return null;
  const m = slot.match(EXTRA_SLOT);
  return m && Number(m[2]) >= 2 ? m[1] : null;
}

/** The slot a meal belongs to for display: dinner-2 -> dinner. */
export const baseSlot = (slot: string): string => extraSlotBase(slot) ?? slot;

/** The first extra slot name for `base` that a day doesn't use yet: base-2, base-3… */
export function freeExtraSlot(day: { meals: Record<string, unknown> }, base: string): string {
  for (let n = 2; ; n++) if (!day.meals[`${base}-${n}`]) return `${base}-${n}`;
}

// ---------- people ----------

export type PeopleSource = "meal" | "day" | "week" | "settings";

/** First non-null of meal, day, week default, settings default. */
export function resolvePeople(
  meal: Pick<Meal, "people"> | null | undefined,
  day: Pick<DayPlan, "people"> | null | undefined,
  plan: Pick<MealPlan, "defaultPeople"> | null | undefined,
  settings: Pick<Settings, "defaultPeople">,
): { value: number; from: PeopleSource } {
  if (meal?.people != null) return { value: meal.people, from: "meal" };
  if (day?.people != null) return { value: day.people, from: "day" };
  if (plan?.defaultPeople != null) return { value: plan.defaultPeople, from: "week" };
  return { value: settings.defaultPeople, from: "settings" };
}

/** How much to multiply the recipe's quantities by for a cook meal. */
export function cookScale(recipe: Pick<Recipe, "meta">, meal: Meal, people: number): number {
  const servings = recipe.meta.servings;
  const portions = meal.portions ?? people;
  return servings && servings > 0 ? portions / servings : 1;
}

export function mealKey(date: string, slot: string): string {
  return `${date}/${slot}`;
}

export function splitMealKey(key: string): { date: string; slot: string } | null {
  const m = key.match(/^(\d{4}-\d{2}-\d{2})\/(.+)$/);
  return m ? { date: m[1], slot: m[2] } : null;
}

// ---------- leftovers ----------

export interface LeftoverBatch {
  key: string;
  recipe: string;
  title: string;
  cookDate: string;
  slot: string;
  portionsCooked: number;
  servedAtMeal: number;
  /** extra portions after the cooking meal */
  extra: number;
  fridgeDays: number;
  fridgeUntil: string;
  frozen: { date: string; portions: number; until: string }[];
  fridgeUsed: number;
  freezerUsed: number;
  fridgeRemaining: number;
  freezerRemaining: number;
  freezable: boolean | null;
}

export interface PlanWarning {
  date: string;
  slot: string;
  code: "expired" | "overused" | "before-cooked" | "missing-source" | "no-recipe" | "not-freezable" | "freeze-too-many";
  message: string;
}

export interface LeftoverReport {
  batches: LeftoverBatch[];
  warnings: PlanWarning[];
}

type PlanLike = Pick<MealPlan, "defaultPeople" | "days">;

/**
 * Work out which cooked meals produced leftovers, how many portions are left, and when they expire.
 * Pass the current week plus the neighbouring weeks so leftovers can cross the week boundary.
 */
export function computeLeftovers(
  plans: PlanLike[],
  recipes: (slug: string) => Pick<Recipe, "meta"> | undefined,
  settings: Pick<Settings, "defaultPeople" | "defaultLeftoverFridgeDays">,
): LeftoverReport {
  type Entry = { date: string; slot: string; day: DayPlan; meal: Meal; plan: PlanLike; slotOrder: number };
  const entries: Entry[] = [];
  for (const plan of plans) {
    for (const day of plan.days) {
      let i = 0;
      for (const [slot, meal] of Object.entries(day.meals)) {
        if (meal) entries.push({ date: day.date, slot, day, meal, plan, slotOrder: i });
        i++;
      }
    }
  }
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.slotOrder - b.slotOrder);

  const warnings: PlanWarning[] = [];
  const batches = new Map<string, LeftoverBatch>();

  for (const e of entries) {
    if (e.meal.type !== "cook" || !e.meal.recipe) continue;
    const recipe = recipes(e.meal.recipe);
    const people = resolvePeople(e.meal, e.day, e.plan, settings).value;
    const portions = e.meal.portions ?? people;
    const extra = Math.max(0, portions - people);
    const fridgeDays = recipe?.meta.leftovers.fridgeDays ?? settings.defaultLeftoverFridgeDays;
    const freezerDays = recipe?.meta.leftovers.freezerDays ?? 90;
    const frozenTotal = e.meal.frozen.reduce((s, f) => s + f.portions, 0);
    if (frozenTotal > extra) {
      warnings.push({ date: e.date, slot: e.slot, code: "freeze-too-many", message: `Freezing ${frozenTotal} portions but only ${extra} are left over` });
    }
    if (frozenTotal > 0 && recipe?.meta.leftovers.freezable === false) {
      warnings.push({ date: e.date, slot: e.slot, code: "not-freezable", message: "This recipe is marked as not suitable for freezing" });
    }
    const key = mealKey(e.date, e.slot);
    batches.set(key, {
      key,
      recipe: e.meal.recipe,
      title: recipe?.meta.title ?? e.meal.recipe,
      cookDate: e.date,
      slot: e.slot,
      portionsCooked: portions,
      servedAtMeal: people,
      extra,
      fridgeDays,
      fridgeUntil: addDays(e.date, fridgeDays),
      frozen: e.meal.frozen.map((f) => ({ ...f, until: addDays(f.date, freezerDays) })),
      fridgeUsed: 0,
      freezerUsed: 0,
      fridgeRemaining: Math.max(0, extra - Math.min(frozenTotal, extra)),
      freezerRemaining: Math.min(frozenTotal, extra),
      freezable: recipe?.meta.leftovers.freezable ?? null,
    });
  }

  for (const e of entries) {
    if (e.meal.type !== "leftovers") continue;
    if (!e.meal.recipe && !e.meal.leftoverFrom) {
      warnings.push({ date: e.date, slot: e.slot, code: "no-recipe", message: "Pick which leftovers to eat" });
      continue;
    }
    const batch = e.meal.leftoverFrom ? batches.get(e.meal.leftoverFrom) : undefined;
    if (!batch) {
      warnings.push({ date: e.date, slot: e.slot, code: "missing-source", message: "These leftovers aren't from a meal in the plan" });
      continue;
    }
    const people = resolvePeople(e.meal, e.day, e.plan, settings).value;
    if (e.date < batch.cookDate) {
      warnings.push({ date: e.date, slot: e.slot, code: "before-cooked", message: `${batch.title} isn't cooked until ${batch.cookDate}` });
    }
    if (e.meal.leftoverStore === "freezer") {
      const frozen = batch.frozen.sort((a, b) => a.date.localeCompare(b.date))[0];
      batch.freezerUsed += people;
      batch.freezerRemaining -= people;
      if (batch.freezerRemaining < 0) {
        warnings.push({ date: e.date, slot: e.slot, code: "overused", message: `Only ${batch.frozen.reduce((s, f) => s + f.portions, 0)} frozen portions of ${batch.title}` });
      }
      if (frozen && e.date > frozen.until) {
        warnings.push({ date: e.date, slot: e.slot, code: "expired", message: `Frozen ${batch.title} is past its freezer life (${frozen.until})` });
      }
      if (!frozen) warnings.push({ date: e.date, slot: e.slot, code: "overused", message: `Nothing from ${batch.title} has been frozen` });
    } else {
      batch.fridgeUsed += people;
      batch.fridgeRemaining -= people;
      if (batch.fridgeRemaining < 0) {
        warnings.push({ date: e.date, slot: e.slot, code: "overused", message: `${batch.title}: using more leftover portions than were cooked` });
      }
      if (e.date > batch.fridgeUntil) {
        warnings.push({ date: e.date, slot: e.slot, code: "expired", message: `${batch.title} is past its fridge life (safe until ${batch.fridgeUntil})` });
      }
    }
  }
  return { batches: [...batches.values()], warnings };
}

/**
 * Batches that can still feed a leftovers meal on `date` (stock left and within the safe date).
 * `own` is the leftovers meal being edited: its portions are already counted as used, so they're given back
 * (otherwise a batch whose portions are all planned out shows as used up for the very meals eating it).
 */
export function availableLeftovers(
  batches: LeftoverBatch[],
  date: string,
  own?: { key: string; store: "fridge" | "freezer"; portions: number } | null,
): { batch: LeftoverBatch; store: "fridge" | "freezer"; remaining: number }[] {
  const out: { batch: LeftoverBatch; store: "fridge" | "freezer"; remaining: number }[] = [];
  const back = (b: LeftoverBatch, store: "fridge" | "freezer") => (own && own.key === b.key && own.store === store ? own.portions : 0);
  for (const b of batches) {
    if (b.cookDate > date) continue;
    const fridge = b.fridgeRemaining + back(b, "fridge");
    if (fridge > 0 && date <= b.fridgeUntil) out.push({ batch: b, store: "fridge", remaining: fridge });
    const frozenOk = b.frozen.length > 0 && b.frozen.every((f) => f.date <= date && date <= f.until);
    const freezer = b.freezerRemaining + back(b, "freezer");
    if (freezer > 0 && frozenOk) out.push({ batch: b, store: "freezer", remaining: freezer });
  }
  return out;
}

// ---------- daily totals ----------

export interface DayTotals {
  date: string;
  caloriesPerPerson: number;
  mealsCounted: number;
  mealsWithoutCalories: number;
  target: number | null;
  difference: number | null;
}

export function dailyTotals(
  day: DayPlan,
  recipes: (slug: string) => Pick<Recipe, "meta"> | undefined,
  settings: Pick<Settings, "dailyCalorieTargetPerPerson">,
): DayTotals {
  let calories = 0;
  let counted = 0;
  let missing = 0;
  for (const [slot, meal] of Object.entries(day.meals)) {
    // cooking ahead isn't eating: only the meals that are actually eaten count towards the day's calories
    if (!meal || isPrepSlot(slot) || (meal.type !== "cook" && meal.type !== "leftovers") || !meal.recipe) continue;
    const kcal = recipes(meal.recipe)?.meta.nutrition.perServing.calories;
    if (kcal == null) missing++;
    else (calories += kcal), counted++;
  }
  const target = settings.dailyCalorieTargetPerPerson;
  return {
    date: day.date,
    caloriesPerPerson: Math.round(calories),
    mealsCounted: counted,
    mealsWithoutCalories: missing,
    target,
    difference: target != null ? Math.round(calories - target) : null,
  };
}

// ---------- copy week ----------

/** Copy a plan to another week: dates shift, cooked/frozen state resets, people overrides stay. */
export function copyPlan(source: MealPlan, targetWeek: string): MealPlan {
  return {
    week: targetWeek,
    startDate: weekStartDate(targetWeek),
    defaultPeople: source.defaultPeople,
    days: shiftDays(source.days, diffDays(weekStartDate(targetWeek), weekStartDate(source.week))),
  };
}

/** Days moved `shift` days later as fresh, uncooked plans (leftovers keep pointing at the same, moved, cook). */
export function shiftDays(days: DayPlan[], shift: number): DayPlan[] {
  const shiftKey = (k: string | null) => {
    const p = k ? splitMealKey(k) : null;
    return p ? mealKey(addDays(p.date, shift), p.slot) : k;
  };
  return days.map((d) => ({
    ...d,
    date: addDays(d.date, shift),
    meals: Object.fromEntries(
      Object.entries(d.meals).map(([slot, m]) => [
        slot,
        m ? { ...m, cooked: false, frozen: [], leftoverFrom: shiftKey(m.leftoverFrom) } : m,
      ]),
    ),
  }));
}

// ---------- shopping list ----------

const FILLER = /^(large|small|medium|fresh|ripe|whole|extra|good quality|good|big|baby|boneless|skinless)\s+/;

export function normaliseIngredientName(name: string): string {
  let n = name.toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) n = n.replace(FILLER, "");
  n = n
    .replace(/ies$/, "y")
    .replace(/(o|ch|sh|x)es$/, "$1")
    .replace(/([^s])s$/, "$1");
  return n;
}

export interface ShoppingLine {
  key: string;
  name: string;
  parts: Map<string, number>; // unit ("" for count) -> quantity
  noQuantity: boolean;
  from: Set<string>;
}

export function aggregateShopping(
  meals: { recipe: Pick<Recipe, "meta" | "ingredients">; title: string; scale: number }[],
): ShoppingItem[] {
  const lines = new Map<string, ShoppingLine>();
  for (const { recipe, title, scale } of meals) {
    for (const ing of recipe.ingredients) {
      if (ing.optional) continue;
      const norm = normaliseIngredientName(ing.name);
      if (!norm) continue;
      const line = lines.get(norm) ?? { key: norm.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), name: ing.name, parts: new Map(), noQuantity: false, from: new Set<string>() };
      lines.set(norm, line);
      line.from.add(title);
      if (ing.quantity === null) {
        line.noQuantity = true;
        continue;
      }
      const q = (ing.quantityMax !== null ? (ing.quantity + ing.quantityMax) / 2 : ing.quantity) * scale;
      const unit = ing.unit ?? "";
      line.parts.set(unit, (line.parts.get(unit) ?? 0) + q);
    }
  }
  const items: ShoppingItem[] = [];
  for (const line of lines.values()) {
    items.push({ key: line.key, text: formatShoppingText(line), checked: false, manual: false, from: [...line.from].sort() });
  }
  return items.sort((a, b) => a.text.replace(/^[\d½⅓⅔¼¾⅛.\s–]+(g|kg|ml|l|tsp|tbsp|cups?)?\s*/i, "").localeCompare(b.text.replace(/^[\d½⅓⅔¼¾⅛.\s–]+(g|kg|ml|l|tsp|tbsp|cups?)?\s*/i, "")));
}

function formatShoppingText(line: ShoppingLine): string {
  const units = [...line.parts.keys()];
  if (units.length === 0) return line.name;
  // merge compatible units into grams / millilitres
  const parts = new Map(line.parts);
  const allIn = (table: Record<string, number>) => units.length > 1 && units.every((u) => u in table);
  if (allIn(MASS_G)) {
    const g = units.reduce((s, u) => s + parts.get(u)! * MASS_G[u], 0);
    parts.clear();
    parts.set("g", g);
  } else if (allIn(VOLUME_ML)) {
    const ml = units.reduce((s, u) => s + parts.get(u)! * VOLUME_ML[u], 0);
    parts.clear();
    parts.set("ml", ml);
  }
  const pieces = [...parts].map(([unit, qty]) => formatAmount(qty, unit));
  const label = parts.size === 1 && parts.has("") && (parts.get("") ?? 0) > 1 ? pluralise(line.name) : line.name;
  return `${pieces.join(" + ")} ${label}`.trim();
}

function formatAmount(qty: number, unit: string): string {
  if (unit === "g" && qty >= 1000) return `${Math.round(qty / 100) / 10} kg`;
  if (unit === "ml" && qty >= 1000) return `${Math.round(qty / 100) / 10} l`;
  if (unit === "g" || unit === "ml") return `${Math.round(qty / 5) * 5 || Math.round(qty)} ${unit}`;
  const plural = qty > 1 && ["cup", "clove", "can", "slice", "piece", "stick", "packet", "bunch", "sprig", "head", "stalk"].includes(unit) ? "s" : "";
  return `${formatQuantity(qty)}${unit ? " " + unit + plural : ""}`;
}

function pluralise(name: string): string {
  if (/s$/i.test(name)) return name;
  if (/(o|ch|sh|x)$/i.test(name)) return name + "es";
  if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + "ies";
  return name + "s";
}

/** Merge a freshly generated list into the existing one, keeping ticks and manual items. */
export function mergeShopping(existing: ShoppingItem[], fresh: ShoppingItem[]): ShoppingItem[] {
  const ticked = new Map(existing.map((i) => [i.key, i.checked]));
  const merged = fresh.map((i) => ({ ...i, checked: ticked.get(i.key) ?? false }));
  const manual = existing.filter((i) => i.manual);
  return [...merged, ...manual.filter((m) => !merged.some((i) => i.key === m.key))];
}

// ---------- suggestions ----------

export interface SuggestOptions {
  slots?: string[];
  seed?: number;
  /** recipe slugs to avoid (already used nearby) */
  avoid?: string[];
  today: string;
  candidates: Recipe[];
  /** days since last cooked below which a recipe is skipped when other options exist */
  recentDays?: number;
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fill empty dinner slots (and the next day's lunch with leftovers when they'd keep). Returns a proposal; nothing is saved. */
export function suggestPlan(plan: MealPlan, settings: Settings, opts: SuggestOptions): { plan: MealPlan; notes: string[] } {
  const rand = mulberry32(opts.seed ?? Date.now());
  const notes: string[] = [];
  const next: MealPlan = structuredClone(plan);
  const used = new Set(opts.avoid ?? []);
  for (const d of next.days) for (const m of Object.values(d.meals)) if (m?.recipe) used.add(m.recipe);
  const mainSlot = settings.mealSlots.includes("dinner") ? "dinner" : settings.mealSlots.at(-1)!;
  const lunchSlot = settings.mealSlots.includes("lunch") ? "lunch" : null;
  const recentDays = opts.recentDays ?? 14;

  const score = (r: Recipe) => {
    let s = rand();
    if (r.meta.favorite) s += 3;
    if (r.meta.rating) s += (r.meta.rating - 3) * 0.7;
    if (r.lastCooked) {
      const age = diffDays(opts.today, r.lastCooked);
      s += age < recentDays ? -4 : Math.min(age / 60, 1.5);
    } else s += 1; // never cooked: worth trying
    if (r.meta.nutrition.perServing.calories == null) s -= 0.2;
    return s;
  };
  const eligible = opts.candidates.filter((r) => !r.meta.hidden && r.ingredients.length > 0 && r.meta.role.includes("main"));
  const pool = eligible.length ? eligible : opts.candidates.filter((r) => !r.meta.hidden);

  for (let i = 0; i < next.days.length; i++) {
    const day = next.days[i];
    if (day.date < opts.today || day.meals[mainSlot]) continue;
    const choices = pool.filter((r) => !used.has(r.slug)).sort((a, b) => score(b) - score(a));
    const pick = choices[0];
    if (!pick) {
      notes.push("Ran out of recipes to suggest — add more recipes or relax the filters.");
      break;
    }
    used.add(pick.slug);
    const people = resolvePeople(null, day, next, settings).value;
    const tomorrow = next.days[i + 1];
    const keepsDays = pick.meta.leftovers.fridgeDays ?? settings.defaultLeftoverFridgeDays;
    const lunchFree = !!(lunchSlot && tomorrow && !tomorrow.meals[lunchSlot] && keepsDays >= 1);
    const portions = lunchFree ? people * 2 : people;
    day.meals[mainSlot] = { recipe: pick.slug, people: null, type: "cook", portions: lunchFree ? portions : null, cooked: false, leftoverFrom: null, leftoverStore: "fridge", frozen: [], note: null };
    notes.push(`${day.date}: ${pick.meta.title}${lunchFree ? " (cook double for tomorrow's lunch)" : ""}`);
    if (lunchFree && tomorrow && lunchSlot) {
      tomorrow.meals[lunchSlot] = { recipe: pick.slug, people: null, type: "leftovers", portions: null, cooked: false, leftoverFrom: mealKey(day.date, mainSlot), leftoverStore: "fridge", frozen: [], note: null };
    }
  }
  return { plan: next, notes };
}

export { shiftWeek };
export type { ParsedIngredient };
