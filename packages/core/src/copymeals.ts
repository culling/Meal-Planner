// Copy, extend and move meals around a week's plan. Pure functions on plans (no file access) so they are easy to test.
import { addDays } from "./dates";
import { baseSlot, evenPortions, extraSlotBase, freeExtraSlot, freePrepSlot, isPrepSlot, mealGroup, mealKey, resolvePeople, splitMealKey } from "./mealplan";
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
 * join     = add it to the meal in the target slot, as a dish served with it (moved, or copied with `keep`)
 */
export type CopyMode = "auto" | "repeat" | "leftovers" | "move" | "join";

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
  /** join: add a copy and leave the original where it is (Ctrl+drag) */
  keep?: boolean;
}

/**
 * Put a meal's dishes at `to`: the first in that slot, the rest beside it (dinner-2…) joined to it. Whatever meal was in
 * the slot is replaced, with every dish of it. Returns where each dish went.
 */
function placeMeal(plans: PlanLike[], to: SlotRef, dishes: Meal[]): SlotRef[] {
  const day = dayOf(plans, to.date);
  if (!day) throw new ValidationError(`${to.date} isn't in the weeks being edited`);
  const slot = dishes.length > 1 ? baseSlot(to.slot) : to.slot;
  const old = !day.meals[slot] ? [] : extraSlotBase(slot) ? [slot] : mealGroup(day, slot);
  for (const s of old) delete day.meals[s];
  day.meals[slot] = { ...dishes[0], joined: false };
  const placed = [{ date: to.date, slot }];
  for (const d of dishes.slice(1)) {
    const extra = freeExtraSlot(day, baseSlot(slot));
    day.meals[extra] = { ...d, joined: true };
    placed.push({ date: to.date, slot: extra });
  }
  return placed;
}

/** Meals that ate the leftovers of the cook at `oldKey` follow it to `newKey`. */
function repoint(plans: PlanLike[], oldKey: string, newKey: string) {
  for (const p of plans) for (const d of p.days) for (const m of Object.values(d.meals)) if (m?.leftoverFrom === oldKey) m.leftoverFrom = newKey;
}

/**
 * Make sure each of these cook meals makes enough for everyone eating it (and the other dishes of its meal as many),
 * returning the first one that had to cook more.
 */
function cookEnough(plans: PlanLike[], cookKeys: string[], settings: Pick<Settings, "defaultPeople">): CopyResult["cookMore"] {
  let first: CopyResult["cookMore"] = null;
  for (const cookKey of cookKeys) {
    const cookRef = splitMealKey(cookKey)!;
    const cookPlan = plans.find((p) => p.days.some((d) => d.date === cookRef.date));
    const cook = cookPlan ? mealAt([cookPlan], cookRef) : null;
    if (!cook || !cookPlan || cook.type !== "cook") continue;
    const day = cookPlan.days.find((d) => d.date === cookRef.date)!;
    const needed = portionsNeeded(plans, cookKey, settings);
    const current = cook.portions ?? resolvePeople(cook, day, cookPlan, settings).value;
    if (needed > current) {
      cook.portions = needed;
      first ??= { key: cookKey, recipe: cook.recipe, portions: needed };
    }
    evenPortions(day, cookRef.slot, cookPlan, settings);
  }
  return first;
}

/**
 * Apply a copy/fill/move to `plans` (previous, current and next week, in any order; the one containing `from` is edited).
 * The first dish of a meal stands for the whole meal (its joined dishes go with it); a joined dish on its own goes alone.
 * Mutates the plans it is given. Throws ValidationError for impossible requests.
 */
export function applyCopy(
  plans: MealPlan[],
  req: CopyRequest,
  ctx: { slots: string[]; settings: Pick<Settings, "defaultPeople" | "defaultLeftoverFridgeDays">; fridgeDaysOf: (recipe: string | null) => number },
): CopyResult {
  const srcDay = dayOf(plans, req.from.date);
  if (!srcDay) throw new ValidationError("That day isn't in the plan");
  const src = mealAt(plans, req.from);
  if (!src) throw new ValidationError("There's no meal there to copy");
  const group = extraSlotBase(req.from.slot) ? [req.from.slot] : mealGroup(srcDay, req.from.slot);
  const dishes = group.map((s) => ({ slot: s, meal: srcDay.meals[s]! }));

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

  if (req.mode === "join") return joinMeal(plans, req, targets, dishes, ctx.settings);

  // make-ahead cooking lives in its own row: only another day's make-ahead row can hold it, and only it can go there
  const srcIsPrep = isPrepSlot(req.from.slot);
  const prepTargets = targets.filter((t) => isPrepSlot(t.slot));
  if (!srcIsPrep && prepTargets.length) throw new ValidationError("Make-ahead cooking has its own row — add it there, then give the meals that will eat it");
  if (srcIsPrep && prepTargets.length && prepTargets.length !== targets.length) throw new ValidationError("Put make-ahead cooking either on other days' make-ahead rows or on meals that will eat it, not both");

  const cookKeyOf = (slot: string, m: Meal) => (m.type === "cook" ? mealKey(req.from.date, slot) : m.type === "leftovers" ? m.leftoverFrom : null);
  let mode = req.mode ?? "auto";
  if (mode === "auto") {
    // make-ahead food is always eaten as leftovers by the meals you choose; put on another day's make-ahead row it is cooked again.
    // A meal of several dishes keeps as long as its quickest-to-spoil dish.
    const fridgeDays = Math.min(...dishes.map((d) => ctx.fridgeDaysOf(d.meal.recipe)));
    mode = srcIsPrep ? (prepTargets.length ? "repeat" : "leftovers") : resolveAutoMode(src, req.from, targets, fridgeDays);
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
    for (const d of dishes) setMeal(plans, { date: req.from.date, slot: d.slot }, null);
    const placed = placeMeal(plans, targets[0], dishes.map((d) => MealSchema.parse(structuredClone(d.meal))));
    // meals that eat this one's leftovers keep following it, in this week and the neighbours
    dishes.forEach((d, i) => {
      if (d.meal.type === "cook") repoint(plans, mealKey(req.from.date, d.slot), mealKey(placed[i].date, placed[i].slot));
    });
    return { mode: "move", placed: [placed[0]], replaced, cookMore: null };
  }

  if (mode === "leftovers") {
    const eaten = dishes.flatMap((d) => {
      const key = cookKeyOf(d.slot, d.meal);
      return key ? [{ recipe: d.meal.recipe, key }] : [];
    });
    if (!eaten.length) throw new ValidationError("Only a cooked meal (or its leftovers) can be turned into leftovers");
    const placed = targets.map(
      (t) =>
        placeMeal(
          plans,
          t,
          eaten.map((e) => MealSchema.parse({ type: "leftovers", recipe: e.recipe, leftoverFrom: e.key, leftoverStore: "fridge", people: null, portions: null, cooked: false })),
        )[0],
    );
    // make sure enough is cooked for everyone who will eat it
    return { mode: "leftovers", placed, replaced, cookMore: cookEnough(plans, [...new Set(eaten.map((e) => e.key))], ctx.settings) };
  }

  // repeat: the same meal again
  const placed = targets.map((t) => placeMeal(plans, t, dishes.map((d) => MealSchema.parse({ ...structuredClone(d.meal), cooked: false, frozen: [] })))[0]);
  // another helping of leftovers from the same batch: cook enough for it
  const batches = dishes.flatMap((d) => (d.meal.type === "leftovers" && d.meal.leftoverFrom ? [d.meal.leftoverFrom] : []));
  return { mode: "repeat", placed, replaced, cookMore: cookEnough(plans, [...new Set(batches)], ctx.settings) };
}

/**
 * Add a dish (or a whole meal's dishes) to the meal at the target, as dishes served with it: the rice dropped onto the
 * salt and pepper tofu. They take the meal's people count, and every dish cooks as many portions as the most of them.
 */
function joinMeal(plans: PlanLike[], req: CopyRequest, targets: SlotRef[], dishes: { slot: string; meal: Meal }[], settings: Pick<Settings, "defaultPeople">): CopyResult {
  if (targets.length !== 1) throw new ValidationError("A dish can only be added to one meal");
  const to = targets[0];
  if (isPrepSlot(req.from.slot) || isPrepSlot(to.slot)) throw new ValidationError("Make-ahead cooking can't be part of a meal");
  const toPlan = plans.find((p) => p.days.some((d) => d.date === to.date))!;
  const toDay = toPlan.days.find((d) => d.date === to.date)!;
  const base = baseSlot(to.slot);
  const head = toDay.meals[mealGroup(toDay, base)[0]];
  if (!head) throw new ValidationError("There's no meal there to add it to");
  if (head.type === "eat-out" || head.type === "skip") throw new ValidationError("Add dishes to a meal you're cooking or eating leftovers of");
  const sameSlot = (slot: string) => req.from.date === to.date && baseSlot(slot) === base;
  if (dishes.some((d) => d.slot === base && sameSlot(d.slot))) throw new ValidationError("That's already part of this meal");

  for (const d of dishes) {
    if (sameSlot(d.slot)) {
      // a dish already in this slot just becomes part of the meal
      d.meal.joined = true;
      d.meal.people = head.people;
      continue;
    }
    const slot = freeExtraSlot(toDay, base);
    const fresh = req.keep ? { cooked: false, frozen: [] } : {};
    toDay.meals[slot] = MealSchema.parse({ ...structuredClone(d.meal), ...fresh, people: head.people, joined: true });
    if (!req.keep) {
      setMeal(plans, { date: req.from.date, slot: d.slot }, null);
      if (d.meal.type === "cook") repoint(plans, mealKey(req.from.date, d.slot), mealKey(to.date, slot));
    }
  }
  evenPortions(toDay, base, toPlan, settings);
  return { mode: "join", placed: [{ date: to.date, slot: base }], replaced: 0, cookMore: null };
}
