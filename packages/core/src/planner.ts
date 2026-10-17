import { addDays, diffDays, isValidYmd, isoWeekOf, shiftWeek, todayYmd, weekStartDate, weeksOf, windowDates } from "./dates";
import { NotFoundError, ValidationError } from "./fsutil";
import {
  aggregateShopping,
  availableLeftovers,
  computeLeftovers,
  cookScale,
  copyPlan,
  dailyTotals,
  extraSlotBase,
  isPrepSlot,
  mealKey,
  mergeShopping,
  resolvePeople,
  splitMealKey,
  suggestPlan,
  shiftDays,
  type DayTotals,
  type LeftoverBatch,
  type PeopleSource,
  type PlanWarning,
} from "./mealplan";
import { applyCopy, type CopyMode, type CopyResult, type SlotRef } from "./copymeals";
import { MealSchema, type DayPlan, type Meal, type MealPlan, type ShoppingList } from "./schemas";
import type { DataStore } from "./store";

export interface MealView {
  meal: Meal;
  people: { value: number; from: PeopleSource };
  /** quantity multiplier for cook meals */
  scale: number | null;
  title: string | null;
  caloriesPerServing: number | null;
}

/** Food cooked this day for later (nobody eats it today). */
export interface PrepView extends MealView {
  /** the slot name: prep, prep-2… */
  slot: string;
  /** portions made, and how many are still unplanned in the fridge / freezer */
  made: number;
  left: number;
  frozenLeft: number;
}

/** A second (third…) dish in a meal slot, e.g. the carrots beside the meatloaf. */
export interface ExtraView extends MealView {
  /** the slot name: dinner-2… */
  slot: string;
  /** the slot it sits in: dinner */
  base: string;
}

export interface DayView {
  date: string;
  people: { value: number; from: PeopleSource };
  dayOverride: number | null;
  /** the default of the week file this day is saved in (older plans set people per week) */
  weekPeople: number | null;
  meals: Record<string, MealView | null>;
  /** make-ahead cooking for this day, in slot order */
  prep: PrepView[];
  /** additional dishes in the meal slots, in slot order */
  extras: ExtraView[];
  totals: DayTotals;
}

export interface PlanView {
  /** the stored week the first day belongs to */
  week: string;
  startDate: string;
  endDate: string;
  prevWeek: string;
  nextWeek: string;
  /** first days of the 7-day windows before and after this one */
  prevStart: string;
  nextStart: string;
  /** the first day's week's default; a window can span two weeks, so the plan page doesn't use it */
  defaultPeople: number | null;
  settingsPeople: number;
  slots: string[];
  mtimeMs: number | null;
  saved: boolean;
  days: DayView[];
  warnings: PlanWarning[];
  batches: LeftoverBatch[];
}

const blankMeal = (): Meal => MealSchema.parse({});

/**
 * Most methods take `at`: either a stored week ("2026-W42") or the first day of a 7-day window ("2026-10-17"), which is
 * what the plan page shows. Days are always saved in the week file they belong to; `at` only decides what view comes back.
 */
const isWindow = (at: string) => isValidYmd(at);
const startOf = (at: string) => (isWindow(at) ? at : weekStartDate(at));

export class Planner {
  constructor(private store: DataStore) {}

  private recipeLookup = (slug: string) => this.store.getRecipe(slug);

  async view(week: string): Promise<PlanView> {
    return this.window(weekStartDate(week));
  }

  private viewOf(at: string): Promise<PlanView> {
    return isWindow(at) ? this.window(at) : this.view(at);
  }

  /** The week file a day lives in. Asked by week, a date outside it is an error, as it always was. */
  private weekFor(at: string, date: string): string {
    return isWindow(at) ? isoWeekOf(date) : at;
  }

  /** The weeks around a window: a week either side, so leftovers crossing its edges are counted. */
  private nearbyWeeks(start: string): string[] {
    return weeksOf([...windowDates(addDays(start, -7)), ...windowDates(start), ...windowDates(addDays(start, 7))]);
  }

  /** Seven days from `start`, read from whichever week files hold them. */
  async window(start: string): Promise<PlanView> {
    const settings = this.store.getSettings();
    const plans = await Promise.all(this.nearbyWeeks(start).map((w) => this.store.getPlan(w)));
    const report = computeLeftovers(plans, this.recipeLookup, settings);
    const dates = windowDates(start);
    const inWindow = new Set(dates);
    const planOf = (date: string) => plans.find((p) => p.days.some((d) => d.date === date))!;
    const first = planOf(start);
    const days: DayView[] = dates.map((date) => {
      const cur = planOf(date);
      const day = cur.days.find((d) => d.date === date)!;
      const meals: Record<string, MealView | null> = {};
      for (const slot of settings.mealSlots) {
        const meal = day.meals[slot];
        if (!meal) {
          meals[slot] = null;
          continue;
        }
        const people = resolvePeople(meal, day, cur, settings);
        const recipe = meal.recipe ? this.store.getRecipe(meal.recipe) : undefined;
        meals[slot] = {
          meal,
          people,
          scale: meal.type === "cook" && recipe ? cookScale(recipe, meal, people.value) : null,
          title: recipe?.meta.title ?? meal.recipe,
          caloriesPerServing: recipe?.meta.nutrition.perServing.calories ?? null,
        };
      }
      const prep: PrepView[] = [];
      for (const [slot, meal] of Object.entries(day.meals)) {
        if (!meal || !isPrepSlot(slot)) continue;
        const recipe = meal.recipe ? this.store.getRecipe(meal.recipe) : undefined;
        const batch = report.batches.find((b) => b.key === mealKey(day.date, slot));
        prep.push({
          slot,
          meal,
          people: { value: 0, from: "meal" },
          scale: recipe ? cookScale(recipe, meal, 0) : null,
          title: recipe?.meta.title ?? meal.recipe,
          caloriesPerServing: recipe?.meta.nutrition.perServing.calories ?? null,
          made: meal.portions ?? 0,
          left: batch?.fridgeRemaining ?? 0,
          frozenLeft: batch?.freezerRemaining ?? 0,
        });
      }
      prep.sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }));
      const extras: ExtraView[] = [];
      // meals in slots that are no longer in settings still show up so nothing is hidden
      for (const [slot, meal] of Object.entries(day.meals)) {
        const base = extraSlotBase(slot);
        if (meal && base && settings.mealSlots.includes(base)) {
          const people = resolvePeople(meal, day, cur, settings);
          const recipe = meal.recipe ? this.store.getRecipe(meal.recipe) : undefined;
          extras.push({
            slot,
            base,
            meal,
            people,
            scale: meal.type === "cook" && recipe ? cookScale(recipe, meal, people.value) : null,
            title: recipe?.meta.title ?? meal.recipe,
            caloriesPerServing: recipe?.meta.nutrition.perServing.calories ?? null,
          });
        } else if (meal && !(slot in meals) && !isPrepSlot(slot)) {
          const recipe = meal.recipe ? this.store.getRecipe(meal.recipe) : undefined;
          meals[slot] = { meal, people: resolvePeople(meal, day, cur, settings), scale: null, title: recipe?.meta.title ?? meal.recipe, caloriesPerServing: recipe?.meta.nutrition.perServing.calories ?? null };
        }
      }
      return {
        date: day.date,
        people: resolvePeople(null, day, cur, settings),
        dayOverride: day.people,
        weekPeople: cur.defaultPeople,
        meals,
        prep,
        extras: extras.sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true })),
        totals: dailyTotals(day, this.recipeLookup, settings),
      };
    });
    return {
      week: first.week,
      startDate: start,
      endDate: dates[6],
      prevWeek: shiftWeek(first.week, -1),
      nextWeek: shiftWeek(first.week, 1),
      prevStart: addDays(start, -7),
      nextStart: addDays(start, 7),
      defaultPeople: first.defaultPeople,
      settingsPeople: settings.defaultPeople,
      slots: settings.mealSlots,
      mtimeMs: first.mtimeMs,
      saved: first.saved,
      days,
      warnings: report.warnings.filter((w) => inWindow.has(w.date)),
      batches: report.batches.filter((b) => b.cookDate <= addDays(start, 6 + 7) && b.fridgeUntil >= addDays(start, -7)),
    };
  }

  /** The days of a window (or week) as plan data, with the week files they came from. */
  private async daysOf(at: string): Promise<{ plans: (MealPlan & { mtimeMs: number | null })[]; days: DayPlan[] }> {
    const dates = windowDates(startOf(at));
    const plans = await Promise.all(weeksOf(dates).map((w) => this.store.getPlan(w)));
    return { plans, days: dates.map((date) => plans.flatMap((p) => p.days).find((d) => d.date === date)!) };
  }

  /** Save days back into the week files they belong to. */
  private async saveDays(days: DayPlan[]): Promise<void> {
    for (const w of weeksOf(days.map((d) => d.date))) {
      const plan = await this.store.getPlan(w);
      plan.days = plan.days.map((d) => days.find((x) => x.date === d.date) ?? d);
      await this.store.savePlan(plan, plan.mtimeMs ?? undefined);
    }
  }

  /** Leftovers that can still be eaten on `date`; pass `slot` when editing that meal so its own portions count as available. */
  async availableLeftovers(date: string, slot?: string) {
    const week = isoWeekOf(date);
    const view = await this.view(week);
    let own: { key: string; store: "fridge" | "freezer"; portions: number } | null = null;
    if (slot) {
      const plan = await this.store.getPlan(week);
      const day = plan.days.find((d) => d.date === date);
      const meal = day?.meals[slot];
      if (meal?.type === "leftovers" && meal.leftoverFrom) {
        own = { key: meal.leftoverFrom, store: meal.leftoverStore, portions: resolvePeople(meal, day, plan, this.store.getSettings()).value };
      }
    }
    return availableLeftovers(view.batches, date, own).map((a) => ({
      key: a.batch.key,
      recipe: a.batch.recipe,
      title: a.batch.title,
      cookDate: a.batch.cookDate,
      store: a.store,
      remaining: a.remaining,
      safeUntil: a.store === "fridge" ? a.batch.fridgeUntil : a.batch.frozen[0]?.until ?? null,
    }));
  }

  private async mutatePlan(week: string, fn: (plan: MealPlan & { mtimeMs: number | null }) => void, expectedMtimeMs?: number | null, at = week): Promise<PlanView> {
    const plan = await this.store.getPlan(week);
    fn(plan);
    await this.store.savePlan(plan, expectedMtimeMs ?? undefined);
    return this.viewOf(at);
  }

  private dayOf(plan: MealPlan, date: string) {
    const day = plan.days.find((d) => d.date === date);
    if (!day) throw new ValidationError(`${date} isn't in week ${plan.week}`);
    return day;
  }

  async setMeal(at: string, date: string, slot: string, patch: Partial<Meal> | null, expectedMtimeMs?: number | null): Promise<PlanView> {
    if (patch === null) return this.removeMeal(at, date, slot, expectedMtimeMs);
    const week = this.weekFor(at, date);
    // leftovers of something cooked in another week (Sunday's roast for Monday's lunch) need that week's file
    const from = patch.leftoverFrom ? splitMealKey(patch.leftoverFrom) : null;
    const otherWeek = from && isoWeekOf(from.date) !== week ? await this.store.getPlan(isoWeekOf(from.date)) : null;
    return this.mutatePlan(
      week,
      (plan) => {
        const day = this.dayOf(plan, date);
        const existing = day.meals[slot] ?? blankMeal();
        const merged: Meal = MealSchema.parse({ ...existing, ...patch });
        if (merged.recipe && !this.store.getRecipe(merged.recipe) && merged.type !== "leftovers") throw new NotFoundError(`Recipe "${merged.recipe}"`);
        if (merged.type === "eat-out" || merged.type === "skip") {
          merged.cooked = false;
        }
        if (merged.type !== "leftovers") {
          merged.leftoverFrom = null;
          merged.leftoverStore = "fridge";
        }
        if (merged.type !== "cook") {
          merged.portions = null;
          merged.frozen = [];
          merged.cooked = false;
        }
        if (isPrepSlot(slot)) {
          // cooking ahead: always a cook, nobody eats it today, and it needs to say how much is made
          const recipe = merged.recipe ? this.store.getRecipe(merged.recipe) : undefined;
          if (!recipe) throw new ValidationError("Choose what to make ahead");
          merged.type = "cook";
          merged.people = 0;
          merged.leftoverFrom = null;
          if (!merged.portions || merged.portions < 1) merged.portions = recipe.meta.servings && recipe.meta.servings > 0 ? recipe.meta.servings : 4;
        }
        if (merged.type === "leftovers" && merged.leftoverFrom && !patch.recipe) {
          const src = splitMealKey(merged.leftoverFrom);
          const source = src ? (src.date === date ? null : this.findMeal(otherWeek ?? plan, src.date, src.slot)) : null;
          if (source?.recipe) merged.recipe = source.recipe;
        }
        day.meals[slot] = merged;
      },
      expectedMtimeMs,
      at,
    );
  }

  /** Remove a meal. Removing something that was cooked also removes the planned meals that eat its leftovers, in any later week. */
  private async removeMeal(at: string, date: string, slot: string, expectedMtimeMs?: number | null): Promise<PlanView> {
    const week = this.weekFor(at, date);
    const plan = await this.store.getPlan(week);
    const day = this.dayOf(plan, date);
    const removed = day.meals[slot];
    delete day.meals[slot];
    await this.store.savePlan(plan, expectedMtimeMs ?? undefined);
    if (removed?.type === "cook") {
      const key = mealKey(date, slot);
      // leftovers come after the cooking, so only this week and later can hold them
      const weeks = (await this.store.listPlanWeeks()).filter((w) => w >= week);
      for (const w of weeks) {
        const p = await this.store.getPlan(w);
        let changed = false;
        for (const d of p.days)
          for (const [s, m] of Object.entries(d.meals))
            if (m?.type === "leftovers" && m.leftoverFrom === key) {
              delete d.meals[s];
              changed = true;
            }
        if (changed) await this.store.savePlan(p);
      }
    }
    return this.viewOf(at);
  }

  private findMeal(plan: MealPlan, date: string, slot: string): Meal | null {
    return plan.days.find((d) => d.date === date)?.meals[slot] ?? null;
  }

  /**
   * Set (or clear with null) a people override at week, day or meal level. For a window, the "week" level sets every day
   * shown; clearing it also clears the defaults of the weeks those days are in, so they fall back to the settings.
   */
  async setPeople(at: string, level: { date?: string; slot?: string }, value: number | null): Promise<PlanView> {
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 50)) throw new ValidationError("People must be between 0 and 50");
    if (isWindow(at) && !level.date) {
      const { plans, days } = await this.daysOf(at);
      for (const d of days) d.people = value;
      await this.saveDays(days);
      if (value === null) for (const p of plans) if (p.defaultPeople != null) await this.mutatePlan(p.week, (plan) => void (plan.defaultPeople = null));
      return this.window(at);
    }
    return this.mutatePlan(level.date ? this.weekFor(at, level.date) : at, (plan) => {
      if (!level.date) {
        plan.defaultPeople = value;
        return;
      }
      const day = this.dayOf(plan, level.date);
      if (!level.slot) {
        day.people = value;
        return;
      }
      const meal = day.meals[level.slot];
      if (!meal) throw new NotFoundError(`Meal ${level.date}/${level.slot}`);
      meal.people = value;
    }, undefined, at);
  }

  async markCooked(at: string, date: string, slot: string, opts: { cooked?: boolean; rating?: number | null; cookDate?: string } = {}): Promise<PlanView> {
    const settings = this.store.getSettings();
    const plan = await this.store.getPlan(this.weekFor(at, date));
    const day = this.dayOf(plan, date);
    const meal = day.meals[slot];
    if (!meal) throw new NotFoundError(`Meal ${date}/${slot}`);
    const cooked = opts.cooked ?? true;
    if (cooked && !meal.cooked && meal.recipe && this.store.getRecipe(meal.recipe)) {
      const people = resolvePeople(meal, day, plan, settings).value;
      await this.store.logCooked(meal.recipe, { date: opts.cookDate ?? date, people, rating: opts.rating ?? null });
    }
    meal.cooked = cooked;
    await this.store.savePlan(plan);
    return this.viewOf(at);
  }

  /** Move all remaining fridge portions of a cooked batch into the freezer. */
  async freezeRemaining(at: string, key: string, onDate = todayYmd()): Promise<PlanView> {
    const src = splitMealKey(key);
    if (!src) throw new ValidationError("Bad leftover key");
    const srcWeek = isoWeekOf(src.date);
    const view = await this.view(srcWeek);
    const batch = view.batches.find((b) => b.key === key);
    if (!batch) throw new NotFoundError("Leftover batch");
    if (batch.fridgeRemaining <= 0) throw new ValidationError("There are no fridge portions left to freeze");
    await this.mutatePlan(srcWeek, (plan) => {
      const meal = this.findMeal(plan, src.date, src.slot);
      if (!meal) throw new NotFoundError("Cooked meal");
      meal.frozen = [...meal.frozen, { date: onDate, portions: batch.fridgeRemaining }];
    });
    return this.viewOf(at);
  }

  /** Plans as plain data (no read-only bookkeeping), for undo snapshots. */
  private plain(plan: MealPlan & { mtimeMs?: number | null; saved?: boolean }): MealPlan {
    const { mtimeMs, saved, ...rest } = plan as any;
    void mtimeMs;
    void saved;
    return structuredClone(rest) as MealPlan;
  }

  /**
   * Copy, extend or move a meal to other slots shown, or up to a week either side (see copymeals.ts). Returns the new view
   * plus snapshots of everything that was changed, so the change can be undone with restorePlans().
   */
  async copyMeals(at: string, req: { from: SlotRef; to: SlotRef[]; mode?: CopyMode }): Promise<{ view: PlanView; result: CopyResult; undo: { plans: MealPlan[] }; message: string; weeks: string[] }> {
    const settings = this.store.getSettings();
    const loaded = await Promise.all(this.nearbyWeeks(startOf(at)).map((w) => this.store.getPlan(w)));
    const before = loaded.map((p) => this.plain(p));
    const working = loaded.map((p) => this.plain(p));
    const result = applyCopy(working, { ...req }, {
      slots: settings.mealSlots,
      settings,
      fridgeDaysOf: (slug) => (slug ? this.store.getRecipe(slug)?.meta.leftovers.fridgeDays : null) ?? settings.defaultLeftoverFridgeDays,
    });
    const changed: MealPlan[] = [];
    for (const [i, p] of working.entries()) {
      if (JSON.stringify(p) !== JSON.stringify(before[i])) {
        await this.store.savePlan(p, loaded[i].mtimeMs ?? undefined);
        changed.push(before[i]);
      }
    }
    const title = (slug: string | null) => (slug ? this.store.getRecipe(slug)?.meta.title ?? slug : "meal");
    const src = before.flatMap((p) => p.days).find((d) => d.date === req.from.date)?.meals[req.from.slot];
    const n = result.placed.length;
    const where = result.placed.map((t) => `${new Date(t.date + "T12:00:00").toLocaleDateString("en-NZ", { weekday: "short" })} ${t.slot}`).join(", ");
    let message =
      result.mode === "move"
        ? `Moved to ${where}`
        : result.mode === "leftovers"
          ? `${title(src?.recipe ?? null)} leftovers on ${where}`
          : `${title(src?.recipe ?? null)} repeated on ${n} slot${n === 1 ? "" : "s"}`;
    if (result.cookMore) message += ` — now cooking ${result.cookMore.portions} portions`;
    if (result.replaced) message += ` (replaced ${result.replaced})`;
    return { view: await this.viewOf(at), result, undo: { plans: changed }, message, weeks: changed.map((p) => p.week) };
  }

  /** Put plans back as they were (undo). */
  async restorePlans(at: string, plans: MealPlan[]): Promise<PlanView> {
    for (const p of plans) await this.store.savePlan(p);
    return this.viewOf(at);
  }

  async copyWeek(fromWeek: string, toWeek: string, overwrite = false): Promise<PlanView> {
    const source = await this.store.getPlan(fromWeek);
    if (!source.saved) throw new NotFoundError(`Plan for ${fromWeek}`);
    const existing = await this.store.getPlan(toWeek);
    const hasMeals = existing.days.some((d) => Object.values(d.meals).some(Boolean));
    if (hasMeals && !overwrite) throw new ValidationError(`${toWeek} already has meals planned. Choose overwrite to replace them.`);
    const copy = copyPlan(source, toWeek);
    await this.store.savePlan(copy, existing.mtimeMs ?? undefined);
    return this.view(toWeek);
  }

  /** Copy the 7 days from `fromStart` onto the 7 days from `toStart` (the window version of copyWeek). */
  async copyDays(fromStart: string, toStart: string, overwrite = false): Promise<PlanView> {
    const source = (await this.daysOf(fromStart)).days;
    if (!source.some((d) => Object.values(d.meals).some(Boolean))) throw new NotFoundError(`Meals planned for the 7 days from ${fromStart}`);
    const target = (await this.daysOf(toStart)).days;
    if (!overwrite && target.some((d) => Object.values(d.meals).some(Boolean))) throw new ValidationError("These days already have meals planned. Choose overwrite to replace them.");
    await this.saveDays(shiftDays(source, diffDays(toStart, fromStart)));
    return this.window(toStart);
  }

  async suggest(at: string, opts: { save?: boolean; seed?: number } = {}): Promise<{ plan: MealPlan; notes: string[]; saved: boolean }> {
    const start = startOf(at);
    const { plans, days } = await this.daysOf(at);
    const first = plans.find((p) => p.days.some((d) => d.date === start))!;
    const plan: MealPlan = isWindow(at) ? { week: first.week, startDate: start, defaultPeople: first.defaultPeople, days } : first;
    const before = (await this.daysOf(addDays(start, -7))).days;
    const avoid = before.flatMap((d) => Object.values(d.meals)).flatMap((m) => (m?.recipe ? [m.recipe] : []));
    const { plan: proposal, notes } = suggestPlan(plan, this.store.getSettings(), {
      today: todayYmd(),
      candidates: this.store.listRecipes(),
      avoid,
      seed: opts.seed,
    });
    if (opts.save) await this.saveDays(proposal.days);
    return { plan: proposal, notes, saved: !!opts.save };
  }

  // ---------- shopping ----------

  /** Build the shopping list for a week or a 7-day window, saved under that id. */
  async generateShopping(at: string): Promise<ShoppingList & { mtimeMs: number | null }> {
    const settings = this.store.getSettings();
    const { plans, days } = await this.daysOf(at);
    const meals: Parameters<typeof aggregateShopping>[0] = [];
    for (const day of days) {
      const plan = plans.find((p) => p.days.includes(day))!;
      for (const meal of Object.values(day.meals)) {
        if (!meal || meal.type !== "cook" || !meal.recipe) continue;
        const recipe = this.store.getRecipe(meal.recipe);
        if (!recipe) continue;
        const people = resolvePeople(meal, day, plan, settings).value;
        meals.push({ recipe, title: recipe.meta.title, scale: cookScale(recipe, meal, people) });
      }
    }
    const existing = await this.store.getShoppingList(at);
    const fresh = aggregateShopping(meals);
    return this.store.saveShoppingList({
      week: at,
      generatedAt: new Date().toISOString(),
      items: mergeShopping(existing.items, fresh),
    });
  }
}

export { mealKey };
