import { addDays, parseYmd, weekDates } from "./dates";
import { extraSlotBase, isPrepSlot } from "./mealplan";
import type { MealPlan, ShoppingList } from "./schemas";

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dayLabel(ymd: string): string {
  const d = parseYmd(ymd);
  return `${DAY[d.getDay()]} ${d.getDate()}`;
}

export function dateRangeLabel(week: string): string {
  const dates = weekDates(week);
  const a = parseYmd(dates[0]);
  const b = parseYmd(dates[6]);
  const sameMonth = a.getMonth() === b.getMonth();
  return `${a.getDate()}${sameMonth ? "" : " " + MONTH[a.getMonth()]}–${b.getDate()} ${MONTH[b.getMonth()]} ${b.getFullYear()}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The readable table written under the frontmatter. The frontmatter is the source of truth. */
export function renderPlanBody(plan: MealPlan, titleOf: (slug: string) => string, slots: string[]): string {
  const dates = weekDates(plan.week);
  const byDate = new Map(plan.days.map((d) => [d.date, d]));
  const prepOf = (date: string) =>
    Object.entries(byDate.get(date)?.meals ?? {})
      .filter(([slot, m]) => m && isPrepSlot(slot))
      .map(([, m]) => `${m!.recipe ? titleOf(m!.recipe) : "?"} (make ahead${m!.portions ? `, ${m!.portions}` : ""})`);
  // cooking ahead gets its own column, only when the week has some
  const hasPrep = dates.some((d) => prepOf(d).length > 0);
  const lines: string[] = [
    "<!-- Generated from the frontmatter above. Edits below this line are overwritten. -->",
    "",
    `# Week ${Number(plan.week.slice(6))} (${dateRangeLabel(plan.week)})`,
    "",
    `| Day | ${slots.map(cap).join(" | ")}${hasPrep ? " | Make ahead" : ""} |`,
    `|-----|${slots.map(() => "-----------").join("|")}${hasPrep ? "|-----------" : ""}|`,
  ];
  for (const date of dates) {
    const day = byDate.get(date);
    const describe = (meal: NonNullable<MealPlan["days"][number]["meals"][string]>) => {
      const people = meal.people ?? day?.people ?? plan.defaultPeople;
      const what = meal.type === "eat-out" ? "Eat out" : meal.type === "skip" ? "Skip" : meal.recipe ? titleOf(meal.recipe) : "?";
      const detail = [meal.type === "cook" || meal.type === "leftovers" ? meal.type : null, people ? String(people) : null].filter(Boolean);
      return detail.length ? `${what} (${detail.join(", ")})` : what;
    };
    const cells = slots.map((slot) => {
      const all = [day?.meals[slot], ...Object.entries(day?.meals ?? {}).filter(([k]) => extraSlotBase(k) === slot).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([, m]) => m)];
      const text = all.filter((m): m is NonNullable<typeof m> => !!m).map(describe);
      return text.length ? text.join("; ") : "—";
    });
    if (hasPrep) cells.push(prepOf(date).join("; ") || "—");
    lines.push(`| ${dayLabel(date)} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderShoppingBody(list: ShoppingList): string {
  const lines = [
    "<!-- Generated from the frontmatter above. Tick items in the app, or change [ ] to [x] here. -->",
    "",
    `# Shopping list — ${list.week}`,
    "",
  ];
  for (const item of list.items) {
    const from = item.from.length ? ` _(${item.from.join(", ")})_` : "";
    lines.push(`- [${item.checked ? "x" : " "}] ${item.text}${from} <!--${item.key}-->`);
  }
  lines.push("");
  return lines.join("\n");
}

export { addDays };
