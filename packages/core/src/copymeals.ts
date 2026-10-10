// Copy, extend and move meals around a week's plan. Pure functions on plans (no file access) so they are easy to test.
import { addDays } from "./dates";
import { baseSlot, extraSlotBase, freePrepSlot, isPrepSlot, mealKey, resolvePeople, splitMealKey } from "./mealplan";
import { MealSchema, type Meal, type MealPlan, type Settings } from "./schemas";
import { ValidationError } from "./fsutil";

export interface SlotRef {
  date: string;
  slot: string;
}

/**
 * repeat   = the same meal again (a new cook, or the same leftovers batch)
 * leftovers = eat the first meal's leftovers there (cooking extra portions as needed)
 * move     = take the meal out of its slot and put it in the target slot
 * auto     = leftovers when every target is still inside the food's fridge life, otherwise repeat
 */
export type CopyMode = "auto" | "repeat" | "leftovers" | "move";

export interface CopyResult {
  mode: Exclude<CopyMode, "auto">;
  placed: SlotRef[];
  replaced: number;
  /** the cook meal that was told to cook more, if any */
  cookMore: { key: string; recipe: string | null; portions: number } | null;
}

type PlanLike = Pick<MealPlan, "days" | "defaultPeople">;

const dayOf = (plans: PlanLike[], date: string) => plans.flatMap((p) => p.days).find((d) => d.date === date);
const mealAt = (plans: PlanLike[], r: SlotRef): Meal | null => dayOf(plans, r.date)?.meals[r.slot] ?? null;

function setMeal(plans: PlanLike[], r: SlotRef, meal: Meal | null) {
  const day = dayOf(plans, r.date);
  if (!day) throw new ValidationError(`${r.date} isn't in the weeks being edited`);
  if (meal) day.meals[r.slot] = meal;
  else delete day.meals[r.slot];
}

/** Portions a cook meal must make for its own people plus every leftovers meal (and frozen share) that draws on it. */
export function portionsNeeded(plans: PlanLike[], cookKey: string, settings: Pick<Settings, "defaultPeople">): number {
  const ref = splitMealKey(cookKey);
  if (!ref) return 0;
  let needed = 0;
  let cookPlan: PlanLike | undefined;
  for (const p of plans) {
    const day = p.days.find((d) => d.date === ref.date);
    const cook = day?.meals[ref.slot];
    if (cook?.type === "cook") {
      cookPlan = p;
      needed = resolvePeople(cook, day, p, settings).value + cook.frozen.reduce((s, f) => s + f.portions, 0);
    }
  }
  if (!cookPlan) return 0;
  for (const p of plans)
    for (const day of p.days)
      for (const m of Object.values(day.meals))
        if (m?.type === "leftovers" && m.leftoverFrom === cookKey && m.leftoverStore === "fridge") needed += resolvePeople(m, day, p, settings).value;
  return needed;
}

/** Which mode "auto" resolves to for these targets. */
export function resolveAutoMode(src: Meal, from: SlotRef, targets: SlotRef[], fridgeDays: number): "repeat" | "leftovers" {
  const cookKey = src.type === "cook" ? mealKey(from.date, from.slot) : src.type === "leftovers" ? src.leftoverFrom : null;
  const cook = cookKey ? splitMealKey(cookKey) : null;
  if (!cook) return "repeat";
  const last = addDays(cook.date, fridgeDays);
  return targets.every((t) => t.date >= cook.date && t.date <= last) ? "leftovers" : "repeat";
}

export interface CopyRequest {
  from: SlotRef;
  to: SlotRef[];
  mode?: CopyMode;
}

/**
 * Apply a copy/fill/move to `plans` (previous, current and next week, in any order; the one containing `from` is edited).
 * Mutates the plans it is given. Throws ValidationError for impossible requests.
 */
export function applyCopy(
  plans: MealPlan[],
  req: CopyRequest,
  ctx: { slots: string[]; settings: Pick<Settings, "defaultPeople" | "defaultLeftoverFridgeDays">; fridgeDaysOf: (recipe: string | null) => number },
): CopyResult {
  if (!dayOf(plans, req.from.date)) throw new ValidationError("That day isn't in the plan");
  const src = mealAt(plans, req.from);
  if (!src) throw new ValidationError("There's no meal there to copy");

  const order = (r: SlotRef) => `${r.date}|${String(ctx.slots.indexOf(baseSlot(r.slot))).padStart(3, "0")}`;
  const seen = new Set<string>([mealKey(req.from.date, req.from.slot)]);
  const targets = req.to
    .filter((t) => {
      const k = mealKey(t.date, t.slot);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => order(a).localeCompare(order(b)));
  for (const t of targets) {
    if (!dayOf(plans, t.date)) throw new ValidationError(`${t.date} is too far from this week to plan from here`);
    if (!ctx.slots.includes(t.slot) && !isPrepSlot(t.slot) && !ctx.slots.includes(extraSlotBase(t.slot) ?? "")) throw new ValidationError(`There's no "${t.slot}" meal in your settings`);
  }
  if (!targets.length) throw new ValidationError("Choose somewhere to put it");

  // make-ahead cooking lives in its own row: only another day's make-ahead row can hold it, and only it can go there
  const srcIsPrep = isPrepSlot(req.from.slot);
  const prepTargets = targets.filter((t) => isPrepSlot(t.slot));
  if (!srcIsPrep && prepTargets.length) throw new ValidationError("Make-ahead cooking has its own row — add it there, then give the meals that will eat it");
  if (srcIsPrep && prepTargets.length && prepTargets.length !== targets.length) throw new ValidationError("Put make-ahead cooking either on other days' make-ahead rows or on meals that will eat it, not both");

  const cookKey = src.type === "cook" ? mealKey(req.from.date, req.from.slot) : src.type === "leftovers" ? src.leftoverFrom : null;
  let mode = req.mode ?? "auto";
  if (mode === "auto") {
    // make-ahead food is always eaten as leftovers by the meals you choose; put on another day's make-ahead row it is cooked again
    mode = srcIsPrep ? (prepTargets.length ? "repeat" : "leftovers") : resolveAutoMode(src, req.from, targets, ctx.fridgeDaysOf(src.recipe));
  }
  if (mode === "leftovers" && prepTargets.length) throw new ValidationError("Leftovers are eaten at meals, not in the make-ahead row");
  if (srcIsPrep && !prepTargets.length && mode !== "leftovers") throw new ValidationError("Make-ahead food is eaten as leftovers — choose the meals that will eat it");

  // "prep" means "a free make-ahead slot that day"; several on one day get prep, prep-2…
  const taken = new Map<string, Set<string>>();
  for (const t of targets) {
    if (!isPrepSlot(t.slot)) continue;
    const used = taken.get(t.date) ?? new Set<string>();
    taken.set(t.date, used);
    const name = freePrepSlot(dayOf(plans, t.date)!, used);
    used.add(name);
    t.slot = name;
  }
  const replaced = targets.filter((t) => mealAt(plans, t)).length;

  if (mode === "move") {
    if (targets.length !== 1) throw new ValidationError("A meal can only be moved to one place");
    const to = targets[0];
    const moved = MealSchema.parse(structuredClone(src));
    setMeal(plans, req.from, null);
    setMeal(plans, to, moved);
    if (src.type === "cook") {
      // meals that eat this one's leftovers keep following it, in this week and the neighbours
      const oldKey = mealKey(req.from.date, req.from.slot);
      const newKey = mealKey(to.date, to.slot);
      for (const p of plans) for (const d of p.days) for (const m of Object.values(d.meals)) if (m?.leftoverFrom === oldKey) m.leftoverFrom = newKey;
    }
    return { mode: "move", placed: [to], replaced, cookMore: null };
  }

  if (mode === "leftovers") {
    if (!cookKey) throw new ValidationError("Only a cooked meal (or its leftovers) can be turned into leftovers");
    for (const t of targets) {
      setMeal(
        plans,
        t,
        MealSchema.parse({ type: "leftovers", recipe: src.recipe, leftoverFrom: cookKey, leftoverStore: "fridge", people: null, portions: null, cooked: false }),
      );
    }
    // make sure enough is cooked for everyone who will eat it
    const cookRef = splitMealKey(cookKey)!;
    const cookPlan = plans.find((p) => p.days.some((d) => d.date === cookRef.date));
    const cook = cookPlan ? mealAt([cookPlan], cookRef) : null;
    let cookMore: CopyResult["cookMore"] = null;
    if (cook && cookPlan && cook.type === "cook") {
      const needed = portionsNeeded(plans, cookKey, ctx.settings);
      const day = cookPlan.days.find((d) => d.date === cookRef.date)!;
      const current = cook.portions ?? resolvePeople(cook, day, cookPlan, ctx.settings).value;
      if (needed > current) {
        cook.portions = needed;
        cookMore = { key: cookKey, recipe: cook.recipe, portions: needed };
      }
    }
    return { mode: "leftovers", placed: targets, replaced, cookMore };
  }

  // repeat: the same meal again
  for (const t of targets) {
    const copy = MealSchema.parse({ ...structuredClone(src), cooked: false, frozen: [] });
    setMeal(plans, t, copy);
  }
  let cookMore: CopyResult["cookMore"] = null;
  if (src.type === "leftovers" && cookKey) {
    // another helping from the same batch: cook enough for it
    const cookRef = splitMealKey(cookKey)!;
    const cookPlan = plans.find((p) => p.days.some((d) => d.date === cookRef.date));
    const cook = cookPlan ? mealAt([cookPlan], cookRef) : null;
    if (cook && cookPlan && cook.type === "cook") {
      const needed = portionsNeeded(plans, cookKey, ctx.settings);
      const day = cookPlan.days.find((d) => d.date === cookRef.date)!;
      const current = cook.portions ?? resolvePeople(cook, day, cookPlan, ctx.settings).value;
      if (needed > current) {
        cook.portions = needed;
        cookMore = { key: cookKey, recipe: cook.recipe, portions: needed };
      }
    }
  }
  return { mode: "repeat", placed: targets, replaced, cookMore };
}
