import {
  addDays,
  dateRangeLabel,
  dayLabel,
  formatIngredient,
  baseSlot,
  freeExtraSlot,
  freePrepSlot,
  isPrepSlot,
  isoWeekOf,
  shiftWeek,
  todayYmd,
  type Meal,
  type MealType,
  type PeopleSource,
  type PlanView,
} from "@mp/core/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, useRecipe, useRecipes, usePlan, type LeftoverOption, type RecipeSummary } from "../api";
import { RecipePicker } from "../components/RecipePicker";
import { slotKey, usePlanDrag, type SlotRef } from "../components/planDrag";
import { Stars } from "../components/RecipeModals";
import { Alert, Cart, ChevL, ChevR, Copy, Flame, Refresh, Sparkle, Users } from "../icons";
import { Empty, ErrorBox, Loading, Modal, Seg, Spinner, Stepper, errMsg, fmtDate, useConfirm, useToast } from "../ui";

type Day = PlanView["days"][number];
type MealView = NonNullable<Day["meals"][string]>;

const TYPE_LABEL: Record<MealType, string> = { cook: "Cook", leftovers: "Leftovers", "eat-out": "Eat out", skip: "Skip" };
const SOURCE_LABEL: Record<PeopleSource, string> = { meal: "set for this meal", day: "set for this day", week: "this week's default", settings: "default from settings" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function PlanPage() {
  const { week: weekParam } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const today = todayYmd();
  const week = weekParam ?? isoWeekOf(today);
  const { data: view, error, isLoading, refetch } = usePlan(week);
  const [dialog, setDialog] = useState<{ date: string; slot: string } | null>(null);
  const [peopleEdit, setPeopleEdit] = useState<{ level: "week" | "day"; date?: string } | null>(null);
  const [suggest, setSuggest] = useState(false);

  const setView = (v: PlanView) => qc.setQueryData(["plan", week], v);

  // ----- copying, extending and moving meals -----
  type CopyMode = "auto" | "repeat" | "leftovers" | "move";
  interface CopyReply {
    view: PlanView;
    result: { mode: "repeat" | "leftovers" | "move" };
    undo: { plans: unknown[] };
    message: string;
    weeks: string[];
  }
  const [fill, setFill] = useState<{ from: SlotRef; targets: string[]; mode: CopyMode } | null>(null);

  const refreshPlans = () => {
    void qc.invalidateQueries({ queryKey: ["plan"] });
    void qc.invalidateQueries({ queryKey: ["shopping"] });
  };
  const undoCopy = async (r: CopyReply) => {
    try {
      setView((await api.post<{ view: PlanView }>(`/api/meal-plans/${week}/restore`, { plans: r.undo.plans })).view);
      refreshPlans();
      toast("Undone");
    } catch (e) {
      toast(errMsg(e), "bad");
    }
  };
  const runCopy = async (from: SlotRef, to: SlotRef[], mode: CopyMode) => {
    try {
      const r = await api.post<CopyReply>(`/api/meal-plans/${week}/copy`, { from, to, mode });
      setView(r.view);
      refreshPlans();
      const otherWeek = r.weeks.find((w) => w !== week);
      const actions: { label: string; onClick: () => void }[] = [{ label: "Undo", onClick: () => void undoCopy(r) }];
      if (mode === "auto" && (r.result.mode === "leftovers" || r.result.mode === "repeat")) {
        const other: CopyMode = r.result.mode === "leftovers" ? "repeat" : "leftovers";
        actions.push({
          label: other === "repeat" ? "Cook each time instead" : "Make them leftovers instead",
          onClick: () =>
            void (async () => {
              await api.post(`/api/meal-plans/${week}/restore`, { plans: r.undo.plans }).catch(() => undefined);
              await runCopy(from, to, other);
            })(),
        });
      }
      if (otherWeek) actions.push({ label: "Show that week", onClick: () => nav(`/plan/${otherWeek}`) });
      toast(r.message, "ok", { actions });
    } catch (e) {
      toast(errMsg(e), "bad");
    }
  };
  const { drag, handleProps, mealProps } = usePlanDrag({
    onFill: (from, targets) => void runCopy(from, targets, "auto"),
    onHandleTap: (from) => setFill({ from, targets: [], mode: "auto" }),
    onMove: (from, to, copy) => {
      // a make-ahead dropped on a meal is eaten there (as leftovers); between make-ahead rows it moves / is cooked again
      if (isPrepSlot(from.slot)) void runCopy(from, [to], isPrepSlot(to.slot) ? (copy ? "repeat" : "move") : "leftovers");
      else void runCopy(from, [to], copy ? "repeat" : "move");
    },
  });
  const act = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      toast(errMsg(e), "bad");
      return null;
    }
  };

  if (isLoading) return <Loading />;
  if (error || !view) return <ErrorBox error={error ?? new Error("Couldn't load the plan")} retry={() => refetch()} />;

  const empty = view.days.every((d) => d.prep.length === 0 && Object.values(d.meals).every((m) => !m));
  const warningFor = (date: string, slot: string) => view.warnings.filter((w) => w.date === date && w.slot === slot);
  const put = (date: string, slot: string, meal: Partial<Meal> | null) =>
    act(async () => {
      const v = await api.put<PlanView>(`/api/meal-plans/${week}/days/${date}/meals/${slot}`, { meal, expectedMtimeMs: undefined });
      setView(v);
      void qc.invalidateQueries({ queryKey: ["shopping"] });
      return v;
    });

  const copyLast = async () => {
    const from = shiftWeek(week, -1);
    let overwrite = false;
    if (!empty) {
      if (!(await confirm({ title: "Replace this week's plan?", message: `This week already has meals. Copying last week's plan replaces them.`, confirmLabel: "Replace", danger: true }))) return;
      overwrite = true;
    }
    const v = await act(() => api.post<PlanView>(`/api/meal-plans/${week}/copy-from`, { from, overwrite }), "Copied last week's plan");
    if (v) setView(v);
  };

  const slots = view.slots;
  return (
    <>
      <div className="week-nav">
        <button className="btn icon" onClick={() => nav(`/plan/${view.prevWeek}`)} aria-label="Previous week">
          <ChevL />
        </button>
        <div className="title">
          Week {Number(week.slice(6))}
          <small>{dateRangeLabel(week)}</small>
        </div>
        <button className="btn icon" onClick={() => nav(`/plan/${view.nextWeek}`)} aria-label="Next week">
          <ChevR />
        </button>
      </div>

      <div className="row wrap">
        {week !== isoWeekOf(today) && (
          <button className="btn sm" onClick={() => nav("/plan")}>
            This week
          </button>
        )}
        <button className="btn sm" onClick={() => setPeopleEdit({ level: "week" })}>
          <Users style={{ width: 17, height: 17 }} />
          {view.defaultPeople != null ? <b>{view.defaultPeople} people</b> : <span className="muted">{view.settingsPeople} people</span>}
          <span className="muted small">{view.defaultPeople != null ? "this week" : "(default)"}</span>
        </button>
        <span className="grow" />
        <button className="btn sm" onClick={copyLast}>
          <Copy /> Copy last week
        </button>
        <button className="btn sm" onClick={() => setSuggest(true)}>
          <Sparkle /> Suggest meals
        </button>
        <Link className="btn sm soft" to={`/shopping/${week}`}>
          <Cart /> Shopping list
        </Link>
      </div>

      {view.warnings.length > 0 && (
        <div className="notice warn">
          <Alert />
          <div>
            <b>Leftover check</b>
            <ul>
              {view.warnings.map((w, i) => (
                <li key={i}>
                  {dayLabel(w.date)} {w.slot}: {w.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {empty && (
        <div className="card center" style={{ padding: 24 }}>
          <div style={{ fontSize: "2rem" }}>🗓️</div>
          <b>Nothing planned for this week yet</b>
          <p className="muted small" style={{ margin: "4px 0 12px" }}>
            Tap any slot below to choose a meal, copy last week, or let it suggest some dinners.
          </p>
        </div>
      )}

      <div className="plan-days" style={{ ["--slots" as any]: slots.length }}>
        <div className="plan-corner" />
        {slots.map((s, r) => (
          <div className="row-label" key={s} style={{ ["--row" as any]: r + 2 }}>
            {s}
          </div>
        ))}
        <div className="row-label" style={{ ["--row" as any]: slots.length + 2 }}>
          Make ahead
        </div>
        {view.days.map((day, c) => (
          <div key={day.date} className={`day ${day.date === today ? "today" : ""}`} style={{ ["--col" as any]: c + 2 }}>
            <div className="day-head">
              <span className="name">{dayLabel(day.date)}</span>
              <button className={`people-pill ${day.dayOverride != null ? "set" : ""}`} onClick={() => setPeopleEdit({ level: "day", date: day.date })} title={`${day.people.value} people (${SOURCE_LABEL[day.people.from]})`}>
                <Users style={{ width: 13, height: 13 }} /> {day.people.value}
                {day.dayOverride == null ? "" : " ✎"}
              </button>
              <DayTotal day={day} />
            </div>
            {slots.map((slot, r) => {
              const mv = day.meals[slot];
              const extras = day.extras.filter((x) => x.base === slot);
              const entries = [{ slot, mv }, ...extras.map((x) => ({ slot: x.slot, mv: x as MealView | null }))];
              const stacked = !!mv || extras.length > 0;
              const warns = warningFor(day.date, slot);
              const key = slotKey({ date: day.date, slot });
              const isSource = drag?.from && slotKey(drag.from) === key;
              const isTarget = !!drag?.targets.includes(key) || (drag?.kind === "fill" && drag.hover === key && key !== slotKey(drag.from));
              const picked = !!fill?.targets.includes(key);
              const isFillSource = !!fill && slotKey(fill.from) === key;
              return (
                <div
                  className={`slot ${isSource ? "drag-source" : ""} ${isTarget ? (drag?.kind === "move" && !drag.copy ? "drop-move" : "drop-target") : ""} ${picked ? "fill-picked" : ""} ${isFillSource ? "fill-source" : ""} ${fill && !isFillSource ? "fill-choosing" : ""}`}
                  key={slot}
                  style={{ ["--row" as any]: r + 2 }}
                  data-slot-date={day.date}
                  data-slot-name={slot}
                  onClickCapture={(e) => {
                    if (!fill) return;
                    // in "choose slots" mode a tap on a slot picks or un-picks it instead of opening it
                    e.preventDefault();
                    e.stopPropagation();
                    if (isFillSource) return;
                    setFill({ ...fill, targets: picked ? fill.targets.filter((k) => k !== key) : [...fill.targets, key] });
                  }}
                  onDragOver={(e) => e.dataTransfer.types.includes("text/recipe") && e.preventDefault()}
                  onDrop={(e) => {
                    const slug = e.dataTransfer.getData("text/recipe");
                    if (slug) void put(day.date, slot, { recipe: slug, type: "cook" });
                  }}
                >
                  <div className="slot-label">{slot}</div>
                  <div className={`slot-body ${stacked ? "stack-body" : ""}`}>
                    {entries.map(({ slot: es, mv: emv }) => {
                      const ew = es === slot ? warns : warningFor(day.date, es);
                      return (
                        <div className="slot-item" key={es}>
                          <MealButton
                            mv={emv}
                            warns={ew.length > 0}
                            onClick={() => setDialog({ date: day.date, slot: es })}
                            dragProps={emv ? mealProps({ date: day.date, slot: es }, emv.title ?? es) : undefined}
                          />
                          {emv && !fill && (
                            <span
                              className="fill-handle"
                              role="button"
                              tabIndex={0}
                              aria-label={`Copy ${emv.title ?? "this meal"} to other meals: drag across the slots, or press to choose them`}
                              title="Drag across other slots to copy this meal there · click to choose slots"
                              {...handleProps({ date: day.date, slot: es }, emv.title ?? es)}
                            />
                          )}
                        </div>
                      );
                    })}
                    {stacked && !fill && (
                      <button className="prep-add" onClick={() => setDialog({ date: day.date, slot: freeExtraSlot({ meals: Object.fromEntries(extras.map((x) => [x.slot, 1])) }, slot) })}>
                        ＋ Add another
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <div
              className={`slot prep-cell ${fill ? "fill-choosing-off" : ""}`}
              style={{ ["--row" as any]: slots.length + 2 }}
              data-slot-date={day.date}
              data-slot-name="prep"
              onClickCapture={(e) => {
                if (fill) {
                  e.preventDefault(); // meals that eat a make-ahead go in the normal rows
                  e.stopPropagation();
                }
              }}
            >
              <div className="slot-label">Make ahead</div>
              <div className="slot-body prep-body">
                {day.prep.map((p) => {
                  const from = { date: day.date, slot: p.slot };
                  const warns = warningFor(day.date, p.slot);
                  return (
                    <div className="prep-item" key={p.slot}>
                      <button className={`meal-btn t-cook prep ${p.meal.cooked ? "cooked" : ""}`} onClick={() => setDialog(from)} {...mealProps(from, p.title ?? "Make ahead")}>
                        <RecipeThumb slug={p.meal.recipe} emoji="🥣" />
                        <span className="grow" style={{ minWidth: 0 }}>
                          <div className="t">{p.title ?? "Make ahead"}</div>
                          <div className="s">
                            <span>Makes {p.made}</span>
                            <span style={{ color: p.left > 0 ? "var(--ink-soft)" : "var(--green)" }}>{p.left > 0 ? `${p.left} not planned yet` : "all planned"}</span>
                            {p.frozenLeft > 0 && <span>❄ {p.frozenLeft}</span>}
                            {p.meal.cooked && <span style={{ color: "var(--green)" }}>✓ made</span>}
                            {warns.length > 0 && <span style={{ color: "var(--amber)" }}>⚠ check</span>}
                          </div>
                        </span>
                      </button>
                      {!fill && (
                        <span
                          className="fill-handle"
                          role="button"
                          tabIndex={0}
                          aria-label={`Plan meals to eat ${p.title ?? "this"}: drag across the meals that will eat it, or press to choose them`}
                          title="Drag across the meals that will eat this · click to choose them"
                          {...handleProps(from, p.title ?? "Make ahead")}
                        />
                      )}
                    </div>
                  );
                })}
                <button className="prep-add" onClick={() => setDialog({ date: day.date, slot: freePrepSlot({ meals: Object.fromEntries(day.prep.map((p) => [p.slot, 1])) }) })}>
                  ＋ Make ahead
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {drag && (
        <div className={`drag-ghost ${drag.kind === "move" && drag.copy ? "copying" : ""}`} style={{ left: drag.x + 14, top: drag.y + 14 }} aria-hidden="true">
          {drag.kind === "fill" ? "＋ " : drag.copy ? "⧉ copy " : "↔ "}
          {drag.label}
          {drag.kind === "fill" && drag.targets.length + (drag.hover && !drag.targets.includes(drag.hover) && drag.hover !== slotKey(drag.from) ? 1 : 0) > 1 ? ` ×${drag.targets.length + (drag.hover && !drag.targets.includes(drag.hover) && drag.hover !== slotKey(drag.from) ? 1 : 0)}` : ""}
        </div>
      )}

      {fill && (
        <div className="sticky-bar fill-bar" role="region" aria-label="Choose where to copy this meal">
          <div className="grow" style={{ minWidth: 0 }}>
            <b>{view.days.find((d) => d.date === fill.from.date)?.meals[fill.from.slot]?.title ?? "Meal"}</b>
            <div className="small muted">{fill.targets.length ? `${fill.targets.length} slot${fill.targets.length === 1 ? "" : "s"} chosen` : "Tap the slots to copy it to"}</div>
          </div>
          <Seg
            value={fill.mode}
            options={[
              { value: "auto", label: "Smart" },
              { value: "leftovers", label: "Leftovers" },
              { value: "repeat", label: "Cook again" },
            ]}
            onChange={(mode) => setFill({ ...fill, mode })}
          />
          <button className="btn" onClick={() => setFill(null)}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!fill.targets.length}
            onClick={() => {
              const f = fill;
              setFill(null);
              void runCopy(f.from, f.targets.map((k) => ({ date: k.slice(0, 10), slot: k.slice(11) })), f.mode);
            }}
          >
            Apply
          </button>
        </div>
      )}

      {!empty && !fill && (
        <p className="small muted center" style={{ margin: 0 }}>
          Tip: drag a meal’s round handle along a row of slots to copy it (pause on another meal’s slot to include it too) · hold Ctrl and drag a meal to duplicate it · drag a meal to move it.
        </p>
      )}

      <RecipeDock onPick={(r) => toast(`Drag “${r.title}” onto a meal slot`)} />

      {dialog && isPrepSlot(dialog.slot) && (
        <PrepDialog
          key={`${dialog.date}/${dialog.slot}`}
          view={view}
          date={dialog.date}
          slot={dialog.slot}
          warns={warningFor(dialog.date, dialog.slot).map((w) => w.message)}
          onClose={() => setDialog(null)}
          // saving keeps the dialog open so the "who eats it?" choices are right there
          onSave={async (meal) => void (await put(dialog.date, dialog.slot, meal))}
          onRemove={async () => {
            const v = await put(dialog.date, dialog.slot, null);
            if (v) setDialog(null);
          }}
          onCooked={async (cooked) => {
            const v = await act(() => api.post<PlanView>(`/api/meal-plans/${week}/days/${dialog.date}/meals/${dialog.slot}/cooked`, { cooked }), cooked ? "Logged in the recipe's cook log" : undefined);
            if (v) {
              setView(v);
              void qc.invalidateQueries({ queryKey: ["recipes"] });
              void qc.invalidateQueries({ queryKey: ["recipe"] });
            }
          }}
          onCopy={(from, to, mode) => {
            setDialog(null);
            void runCopy(from, to, mode);
          }}
        />
      )}
      {dialog && !isPrepSlot(dialog.slot) && (
        <MealDialog
          key={`${dialog.date}/${dialog.slot}`}
          view={view}
          date={dialog.date}
          slot={dialog.slot}
          warns={warningFor(dialog.date, dialog.slot).map((w) => w.message)}
          onClose={() => setDialog(null)}
          onSave={async (meal) => {
            const v = await put(dialog.date, dialog.slot, meal);
            if (v) setDialog(null);
          }}
          onRemove={async () => {
            const v = await put(dialog.date, dialog.slot, null);
            if (v) setDialog(null);
          }}
          onCooked={async (cooked, rating) => {
            const v = await act(() => api.post<PlanView>(`/api/meal-plans/${week}/days/${dialog.date}/meals/${dialog.slot}/cooked`, { cooked, rating }), cooked ? "Logged in the recipe's cook log" : undefined);
            if (v) {
              setView(v);
              void qc.invalidateQueries({ queryKey: ["recipes"] });
              void qc.invalidateQueries({ queryKey: ["recipe"] });
            }
          }}
          onCopy={(from, to, mode) => {
            setDialog(null);
            void runCopy(from, to, mode);
          }}
          onPeople={async (people) => {
            const v = await act(() => api.patch<PlanView>(`/api/meal-plans/${week}/days/${dialog.date}/meals/${dialog.slot}/people`, { people }));
            if (v) setView(v);
          }}
        />
      )}

      {peopleEdit && (
        <PeopleModal
          view={view}
          level={peopleEdit.level}
          date={peopleEdit.date}
          onClose={() => setPeopleEdit(null)}
          onSet={async (value) => {
            const v = await act(() => (peopleEdit.level === "week" ? api.patch<PlanView>(`/api/meal-plans/${week}`, { defaultPeople: value }) : api.patch<PlanView>(`/api/meal-plans/${week}/days/${peopleEdit.date}`, { people: value })));
            if (v) setView(v);
          }}
        />
      )}

      {suggest && (
        <SuggestModal
          week={week}
          onClose={() => setSuggest(false)}
          onApplied={(v) => {
            setView(v);
            setSuggest(false);
            toast("Plan filled in — tap any meal to change it");
          }}
        />
      )}
    </>
  );
}

function DayTotal({ day }: { day: Day }) {
  const t = day.totals;
  if (!t.mealsCounted && !t.mealsWithoutCalories) return null;
  const missing = t.mealsWithoutCalories;
  return (
    <span className="kcal" title="Calories per person, assuming one serving of each meal eaten that day">
      {t.mealsCounted > 0 && (
        <>
          <Flame style={{ width: 13, height: 13, verticalAlign: "-2px" }} /> {t.caloriesPerPerson} kcal
          {t.difference != null && (
            <span style={{ color: t.difference > 0 ? "var(--red)" : "var(--green)" }}>
              {" "}
              ({t.difference > 0 ? "+" : ""}
              {t.difference})
            </span>
          )}
        </>
      )}
      {missing > 0 && (
        <span className="muted">
          {t.mealsCounted > 0 ? " · " : ""}
          {t.mealsCounted > 0 ? `${missing} meal${missing > 1 ? "s" : ""} with no calorie data` : "no calorie data"}
        </span>
      )}
    </span>
  );
}

function MealButton({ mv, warns, onClick, dragProps }: { mv: MealView | null; warns: boolean; onClick: () => void; dragProps?: React.HTMLAttributes<HTMLButtonElement> }) {
  if (!mv)
    return (
      <button className="meal-btn empty" onClick={onClick}>
        <span className="thumb" style={{ background: "var(--surface-2)" }}>＋</span>
        <span>Add a meal</span>
      </button>
    );
  const m = mv.meal;
  const emoji = m.type === "eat-out" ? "🍴" : m.type === "skip" ? "⏭️" : m.type === "leftovers" ? "🥡" : "🍲";
  return (
    <button className={`meal-btn t-${m.type} ${m.cooked ? "cooked" : ""}`} onClick={onClick} {...dragProps}>
      <RecipeThumb slug={m.recipe} emoji={emoji} />
      <span className="grow" style={{ minWidth: 0 }}>
        <div className="t">{m.type === "eat-out" ? "Eating out" : m.type === "skip" ? "Skip" : mv.title ?? "Pick a recipe"}</div>
        <div className="s">
          <span>{TYPE_LABEL[m.type]}</span>
          {(m.type === "cook" || m.type === "leftovers") && (
            <span className={`people-pill ${mv.people.from === "meal" ? "set" : ""}`} title={SOURCE_LABEL[mv.people.from]}>
              <Users style={{ width: 12, height: 12 }} /> {mv.people.value}
            </span>
          )}
          {m.type === "cook" && (m.portions ?? 0) > mv.people.value && <span>+{(m.portions ?? 0) - mv.people.value} extra</span>}
          {m.type === "leftovers" && m.leftoverStore === "freezer" && <span>❄ freezer</span>}
          {m.cooked && <span style={{ color: "var(--green)" }}>✓ cooked</span>}
          {warns && <span style={{ color: "var(--amber)" }}>⚠ check</span>}
        </div>
      </span>
    </button>
  );
}

function RecipeThumb({ slug, emoji }: { slug: string | null; emoji: string }) {
  const { data } = useRecipe(slug ?? undefined);
  const hero = data?.meta.images.hero;
  if (slug && hero) return <img className="thumb" src={`/images/${slug}/${hero}?w=120`} alt="" />;
  return <span className="thumb">{emoji}</span>;
}

/** Desktop only: a rail of favourite recipes to drag onto the grid. */
function RecipeDock({ onPick }: { onPick: (r: RecipeSummary) => void }) {
  const [q, setQ] = useState("");
  const { data } = useRecipes({ q: q.trim() || undefined, sort: q.trim() ? undefined : "lastCooked", order: "asc" });
  return (
    <details className="card dock">
      <summary>Drag a recipe onto a slot</summary>
      <input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="row wrap" style={{ marginTop: 10 }}>
        {data?.recipes.slice(0, 24).map((r) => (
          <span key={r.slug} className="chip" draggable onDragStart={(e) => e.dataTransfer.setData("text/recipe", r.slug)} onClick={() => onPick(r)} style={{ cursor: "grab" }}>
            {r.title}
          </span>
        ))}
      </div>
    </details>
  );
}

function PeopleModal({ view, level, date, onClose, onSet }: { view: PlanView; level: "week" | "day"; date?: string; onClose: () => void; onSet: (v: number | null) => Promise<void> }) {
  const day = view.days.find((d) => d.date === date);
  const current = level === "week" ? view.defaultPeople : day?.dayOverride ?? null;
  const inherited = level === "week" ? view.settingsPeople : (view.defaultPeople ?? view.settingsPeople);
  const inheritedFrom = level === "week" ? "settings" : view.defaultPeople != null ? "this week's default" : "settings";
  const [v, setV] = useState(current ?? inherited);
  return (
    <Modal title={level === "week" ? "People this week" : `People on ${dayLabel(date!)}`} onClose={onClose}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          {level === "week" ? "Used for every meal this week unless a day or meal says otherwise." : "Used for every meal on this day unless a meal says otherwise."} Cooking amounts are scaled to match.
        </p>
        <div className="row">
          <Stepper value={v} onChange={setV} min={0} max={30} />
          <button
            className="btn primary"
            onClick={async () => {
              await onSet(v);
              onClose();
            }}
          >
            Set to {v}
          </button>
        </div>
        {current != null && (
          <button
            className="btn block"
            onClick={async () => {
              await onSet(null);
              onClose();
            }}
          >
            Go back to {inherited} (from {inheritedFrom})
          </button>
        )}
      </div>
    </Modal>
  );
}

function SuggestModal({ week, onClose, onApplied }: { week: string; onClose: () => void; onApplied: (v: PlanView) => void }) {
  const toast = useToast();
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const [notes, setNotes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async (s: number) => {
    setNotes(null);
    try {
      const res = await api.post<{ notes: string[] }>(`/api/meal-plans/${week}/suggest`, { seed: s });
      setNotes(res.notes);
    } catch (e) {
      toast(errMsg(e), "bad");
      onClose();
    }
  };
  useEffect(() => {
    void load(seed);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Suggest some dinners" onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          Fills empty dinner slots from the rest of today onward. Favourites and recipes you haven't cooked lately come first, and when a meal keeps well it cooks double for the next day's lunch. Nothing changes until you accept.
        </p>
        {!notes ? (
          <Loading />
        ) : notes.length === 0 ? (
          <p>There's nothing to fill in — every dinner from today is already planned.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        <div className="row">
          <button
            className="btn"
            onClick={() => {
              const s = Math.floor(Math.random() * 1e9);
              setSeed(s);
              void load(s);
            }}
          >
            <Refresh /> Shuffle
          </button>
          <button
            className="btn primary grow"
            disabled={!notes?.length || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await api.post<{ view: PlanView }>(`/api/meal-plans/${week}/suggest`, { seed, save: true });
                onApplied(res.view);
              } catch (e) {
                toast(errMsg(e), "bad");
                setBusy(false);
              }
            }}
          >
            Use this plan
          </button>
        </div>
      </div>
    </Modal>
  );
}

function MealDialog({
  view,
  date,
  slot,
  warns,
  onClose,
  onSave,
  onRemove,
  onCooked,
  onPeople,
  onCopy,
}: {
  view: PlanView;
  date: string;
  slot: string;
  warns: string[];
  onClose: () => void;
  onSave: (meal: Partial<Meal>) => Promise<void>;
  onRemove: () => Promise<void>;
  onCooked: (cooked: boolean, rating: number | null) => Promise<void>;
  onPeople: (people: number | null) => Promise<void>;
  onCopy: (from: SlotRef, to: SlotRef[], mode: "auto" | "repeat" | "leftovers") => void;
}) {
  const day = view.days.find((d) => d.date === date)!;
  const existing = day.meals[slot] ?? null;
  const m0 = existing?.meal;
  const [type, setType] = useState<MealType>(m0?.type ?? "cook");
  const [recipe, setRecipe] = useState<string | null>(m0?.recipe ?? null);
  const [people, setPeople] = useState<number | null>(m0?.people ?? null);
  const [portions, setPortions] = useState<number | null>(m0?.portions ?? null);
  const [frozen, setFrozen] = useState<number>(m0?.frozen.reduce((s, f) => s + f.portions, 0) ?? 0);
  const [from, setFrom] = useState<{ key: string | null; store: "fridge" | "freezer" }>({ key: m0?.leftoverFrom ?? null, store: m0?.leftoverStore ?? "fridge" });
  const [note, setNote] = useState(m0?.note ?? "");
  const [picker, setPicker] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: rec } = useRecipe(type === "cook" || type === "leftovers" ? recipe ?? undefined : undefined);
  const [options, setOptions] = useState<LeftoverOption[] | null>(null);

  useEffect(() => {
    if (type !== "leftovers") return;
    void api.get<{ leftovers: LeftoverOption[] }>(`/api/leftovers?date=${date}`).then((r) => setOptions(r.leftovers));
  }, [type, date]);

  const inherited = existing ? (existing.people.from === "meal" ? { value: day.people.value, from: day.people.from } : existing.people) : day.people;
  const effectivePeople = people ?? inherited.value;
  const eatingPortions = portions ?? effectivePeople;
  const extra = Math.max(0, eatingPortions - effectivePeople);
  const scale = rec?.meta.servings ? eatingPortions / rec.meta.servings : 1;

  const save = async () => {
    setBusy(true);
    const meal: Partial<Meal> = { type, people };
    if (type === "cook") {
      Object.assign(meal, { recipe, portions: portions && portions !== effectivePeople ? portions : null, frozen: frozen > 0 && extra > 0 ? [{ date, portions: Math.min(frozen, extra) }] : [] });
    } else if (type === "leftovers") {
      Object.assign(meal, { recipe, leftoverFrom: from.key, leftoverStore: from.store });
    } else {
      Object.assign(meal, { recipe: null, note: note || null });
    }
    await onSave(meal);
    setBusy(false);
  };

  const canSave = type === "eat-out" || type === "skip" || (type === "cook" && !!recipe) || (type === "leftovers" && !!from.key);

  return (
    <Modal title={`${dayLabel(date)} · ${cap(baseSlot(slot))}${baseSlot(slot) !== slot ? ` (${slot.slice(baseSlot(slot).length + 1)})` : ""}`} onClose={onClose} wide>
      <div className="stack">
        {warns.length > 0 && (
          <div className="notice warn">
            <Alert />
            <div>{warns.join(" · ")}</div>
          </div>
        )}
        <Seg fill value={type} options={(["cook", "leftovers", "eat-out", "skip"] as MealType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))} onChange={setType} />

        {type === "cook" && (
          <div className="stack tight">
            {recipe ? (
              <div className="card flat row">
                <RecipeThumb slug={recipe} emoji="🍲" />
                <div className="grow">
                  <Link to={`/recipes/${recipe}?servings=${eatingPortions}`} onClick={onClose} style={{ fontWeight: 800 }} title="Open the recipe">
                    {rec?.meta.title ?? recipe}
                  </Link>
                  <div className="small muted">{rec?.meta.servings ? `Makes ${rec.meta.servings}` : ""}</div>
                </div>
                <button className="btn sm" onClick={() => setPicker(true)}>
                  Change
                </button>
              </div>
            ) : (
              <button className="btn primary block" onClick={() => setPicker(true)}>
                Choose a recipe
              </button>
            )}
          </div>
        )}

        {type === "leftovers" && (
          <div className="stack tight">
            <div className="label">Which leftovers?</div>
            {options === null ? (
              <Spinner />
            ) : options.length === 0 ? (
              <div className="notice">
                <div>
                  Nothing in the plan has leftovers on this day. Cook a meal with extra portions earlier in the week (open a cook meal and raise “Portions to cook”), and it will show up here — as long as it's still within its safe date.
                </div>
              </div>
            ) : (
              options.map((o) => {
                const selected = from.key === o.key && from.store === o.store;
                return (
                  <button
                    key={`${o.key}-${o.store}`}
                    className={`card flat row ${selected ? "lowconf" : ""}`}
                    style={{ textAlign: "left", cursor: "pointer", outline: selected ? "2px solid var(--primary)" : undefined }}
                    onClick={() => {
                      setFrom({ key: o.key, store: o.store });
                      setRecipe(o.recipe);
                      // one portion per person: if fewer are left than people, eat as many as there are
                      if (effectivePeople > o.remaining) setPeople(o.remaining);
                    }}
                  >
                    <RecipeThumb slug={o.recipe} emoji="🥡" />
                    <div className="grow">
                      <div style={{ fontWeight: 800 }}>{o.title}</div>
                      <div className="small muted">
                        Cooked {fmtDate(o.cookDate)} · {o.remaining} portion{o.remaining === 1 ? "" : "s"} left in the {o.store}
                        {o.safeUntil ? ` · safe until ${fmtDate(o.safeUntil)}` : ""}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
            {from.key && recipe && (
              <Link to={`/recipes/${recipe}?servings=${effectivePeople}`} onClick={onClose} className="small" title="Open the recipe">
                Open {rec?.meta.title ?? recipe} ({effectivePeople} portion{effectivePeople === 1 ? "" : "s"})
              </Link>
            )}
            {from.key && !options?.some((o) => o.key === from.key && o.store === from.store) && options !== null && (
              <div className="notice warn">
                <Alert />
                <div>The current choice isn't available any more (used up or past its safe date). Pick another or leave it and check the warning.</div>
              </div>
            )}
          </div>
        )}

        {(type === "eat-out" || type === "skip") && (
          <div className="field">
            <label>Note (optional)</label>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={type === "eat-out" ? "Where?" : "Why?"} />
          </div>
        )}

        {(type === "cook" || type === "leftovers") && (
          <div className="stack tight">
            <div className="field">
              <label>How many people?</label>
              <div className="row wrap">
                <Stepper value={effectivePeople} onChange={setPeople} min={0} max={30} />
                {people != null ? (
                  <button
                    className="btn sm"
                    onClick={() => {
                      setPeople(null);
                      if (existing) void onPeople(null);
                    }}
                  >
                    Use {inherited.value} ({SOURCE_LABEL[inherited.from]})
                  </button>
                ) : (
                  <span className="small muted">{SOURCE_LABEL[inherited.from]}</span>
                )}
              </div>
            </div>
          </div>
        )}

        {type === "cook" && recipe && (
          <>
            <div className="field">
              <label>Portions to cook</label>
              <div className="row wrap">
                <Stepper value={eatingPortions} onChange={(n) => setPortions(n)} min={Math.max(effectivePeople, 1)} max={60} />
                <span className="small muted">
                  {extra > 0 ? `${extra} extra portion${extra === 1 ? "" : "s"} for leftovers` : "just enough for everyone — raise it to make leftovers"}
                </span>
              </div>
            </div>
            {extra > 0 && (
              <div className="field">
                <label>Freeze some of the extra?</label>
                <div className="row">
                  <Stepper value={Math.min(frozen, extra)} onChange={setFrozen} min={0} max={extra} />
                  <span className="small muted">
                    {rec?.meta.leftovers.freezable === false ? "⚠ This recipe is marked as not freezing well. " : ""}
                    {frozen > 0 ? `Keeps ${rec?.meta.leftovers.freezerDays ?? 90} days in the freezer` : `Fridge keeps ${rec?.meta.leftovers.fridgeDays ?? 3} days`}
                  </span>
                </div>
              </div>
            )}
            {rec && rec.ingredients.length > 0 && (
              <details>
                <summary>
                  Shopping amounts for {eatingPortions} portions {Math.abs(scale - 1) > 0.01 ? `(×${Math.round(scale * 100) / 100})` : ""}
                </summary>
                <ul style={{ margin: "6px 0", paddingLeft: 20 }}>
                  {rec.ingredients.map((ing, i) => (
                    <li key={i}>{formatIngredient(ing, scale)}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}

        {existing && (type === "cook" || type === "leftovers") && m0?.recipe && (
          <div className="card flat stack tight">
            {m0.cooked ? (
              <div className="row between">
                <span style={{ color: "var(--green)", fontWeight: 800 }}>✓ Cooked — it's in the recipe's cook log</span>
                <button className="btn sm" onClick={() => onCooked(false, null)}>
                  Not cooked
                </button>
              </div>
            ) : (
              <>
                <div className="row between wrap">
                  <b>Did you make it?</b>
                  <Stars value={rating} onChange={setRating} />
                </div>
                <button className="btn soft block" onClick={() => onCooked(true, rating)}>
                  ✓ Mark as cooked
                </button>
              </>
            )}
          </div>
        )}

        {existing && (type === "cook" || type === "leftovers") && m0?.recipe && <UseAgain view={view} date={date} slot={slot} onCopy={onCopy} />}

        <div className="row">
          {existing && (
            <button className="btn danger" onClick={onRemove}>
              Remove
            </button>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={!canSave || busy} onClick={save}>
            Save
          </button>
        </div>
      </div>

      {picker && (
        <RecipePicker
          title="Choose a recipe"
          onClose={() => setPicker(false)}
          onPick={(r) => {
            setRecipe(r.slug);
            setPicker(false);
          }}
        />
      )}
    </Modal>
  );
}

/** Pick the next few days' slots for this meal again — the keyboard- and tap-friendly twin of dragging the handle. */
function UseAgain({ view, date, slot, onCopy, prep }: { view: PlanView; date: string; slot: string; onCopy: (from: SlotRef, to: SlotRef[], mode: "auto" | "repeat" | "leftovers") => void; prep?: boolean }) {
  const [open, setOpen] = useState(!!prep);
  const [mode, setMode] = useState<"auto" | "repeat" | "leftovers">("auto");
  const [chosen, setChosen] = useState<string[]>([]);
  const days = Array.from({ length: 8 }, (_, i) => addDays(date, i));
  const toggle = (k: string) => setChosen((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));
  return (
    <details className="card flat" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{prep ? "Who eats it? Choose the meals" : "Use this meal again (leftovers or another cook)"}</summary>
      <div className="stack" style={{ marginTop: 10 }}>
        <p className="small muted" style={{ margin: 0 }}>
          {prep
            ? "Pick the meals that will eat this. Each takes portions from it (and it will make more if needed). Works across into next week too — and the plan warns if something would be eaten past its safe date."
            : "Pick the meals to fill. Leftovers use portions from this cook and it will cook enough for everyone. “Smart” makes them leftovers while the food is still good, and a new cook after that. Works across into next week too."}
        </p>
        {!prep && (
          <Seg
            fill
            value={mode}
            options={[
              { value: "auto", label: "Smart" },
              { value: "leftovers", label: "Leftovers" },
              { value: "repeat", label: "Cook again" },
            ]}
            onChange={setMode}
          />
        )}
        {days.map((d) => (
          <div className="row wrap" key={d} style={{ gap: 6 }}>
            <span className="small" style={{ width: 64, fontWeight: 800 }}>
              {dayLabel(d)}
            </span>
            {view.slots.map((s) => {
              const k = `${d}/${s}`;
              if (d === date && s === slot) return null;
              return (
                <button key={k} type="button" className={`chip ${chosen.includes(k) ? "on" : ""}`} style={{ cursor: "pointer" }} aria-pressed={chosen.includes(k)} aria-label={`${dayLabel(d)} ${s}`} onClick={() => toggle(k)}>
                  {s}
                </button>
              );
            })}
          </div>
        ))}
        <button className="btn primary" disabled={!chosen.length} onClick={() => onCopy({ date, slot }, chosen.map((k) => ({ date: k.slice(0, 10), slot: k.slice(11) })), prep ? "leftovers" : mode)}>
          Fill {chosen.length || ""} meal{chosen.length === 1 ? "" : "s"}
        </button>
      </div>
    </details>
  );
}

/** Cooking ahead: what to make, how much, and which meals will eat it. Nobody eats it on the day it's made. */
function PrepDialog({
  view,
  date,
  slot,
  warns,
  onClose,
  onSave,
  onRemove,
  onCooked,
  onCopy,
}: {
  view: PlanView;
  date: string;
  slot: string;
  warns: string[];
  onClose: () => void;
  onSave: (meal: Partial<Meal>) => Promise<void>;
  onRemove: () => Promise<void>;
  onCooked: (cooked: boolean) => Promise<void>;
  onCopy: (from: SlotRef, to: SlotRef[], mode: "auto" | "repeat" | "leftovers") => void;
}) {
  const day = view.days.find((d) => d.date === date)!;
  const existing = day.prep.find((p) => p.slot === slot) ?? null;
  const [recipe, setRecipe] = useState<string | null>(existing?.meal.recipe ?? null);
  const [portions, setPortions] = useState<number | null>(existing?.meal.portions ?? null);
  const [frozen, setFrozen] = useState<number>(existing?.meal.frozen.reduce((s, f) => s + f.portions, 0) ?? 0);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: rec } = useRecipe(recipe ?? undefined);

  const made = portions ?? rec?.meta.servings ?? 4;
  const dirty = !existing || recipe !== existing.meal.recipe || made !== existing.meal.portions || frozen !== existing.meal.frozen.reduce((s, f) => s + f.portions, 0);
  const save = async () => {
    setBusy(true);
    await onSave({ recipe, type: "cook", people: 0, portions: made, frozen: frozen > 0 ? [{ date, portions: Math.min(frozen, made) }] : [] });
    setBusy(false);
  };

  return (
    <Modal title={`Make ahead · ${dayLabel(date)}`} onClose={onClose} wide>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          Cook it on this day without anyone eating it today. Then choose the meals that will eat it.
        </p>
        {warns.length > 0 && (
          <div className="notice warn">
            <Alert />
            <div>{warns.join(" · ")}</div>
          </div>
        )}
        {recipe ? (
          <div className="card flat row">
            <RecipeThumb slug={recipe} emoji="🥣" />
            <div className="grow">
              <Link to={`/recipes/${recipe}?servings=${made}`} onClick={onClose} style={{ fontWeight: 800 }} title="Open the recipe">
                {rec?.meta.title ?? recipe}
              </Link>
              <div className="small muted">
                {rec?.meta.servings ? `The recipe makes ${rec.meta.servings}` : ""}
                {rec?.meta.leftovers.fridgeDays != null ? ` · keeps ${rec.meta.leftovers.fridgeDays} days in the fridge` : ""}
                {rec?.meta.leftovers.freezable ? " · freezes well" : rec?.meta.leftovers.freezable === false ? " · doesn't freeze well" : ""}
              </div>
            </div>
            <button className="btn sm" onClick={() => setPicker(true)}>
              Change
            </button>
          </div>
        ) : (
          <button className="btn primary block" onClick={() => setPicker(true)}>
            Choose what to make
          </button>
        )}

        {recipe && (
          <>
            <div className="field">
              <label>How many portions will it make?</label>
              <div className="row wrap">
                <Stepper value={made} onChange={setPortions} min={1} max={200} />
                <span className="small muted">
                  {rec?.meta.servings && made !== rec.meta.servings ? `(the recipe makes ${rec.meta.servings}: amounts are scaled by ×${Math.round((made / rec.meta.servings) * 100) / 100})` : "one portion = one serving as in the recipe"}
                </span>
              </div>
            </div>
            <div className="field">
              <label>Freeze some straight away?</label>
              <div className="row wrap">
                <Stepper value={Math.min(frozen, made)} onChange={setFrozen} min={0} max={made} />
                <span className="small muted">
                  {rec?.meta.leftovers.freezable === false ? "⚠ This recipe is marked as not freezing well. " : ""}
                  {frozen > 0 ? `Keeps ${rec?.meta.leftovers.freezerDays ?? 90} days in the freezer` : "Frozen portions last much longer than fridge ones"}
                </span>
              </div>
            </div>
            {existing && (
              <div className="small">
                {existing.made} made · <b>{existing.left}</b> in the fridge not planned yet{existing.frozenLeft ? ` · ${existing.frozenLeft} in the freezer` : ""}
              </div>
            )}
            <button className="btn primary" disabled={busy || !dirty} onClick={save}>
              {existing ? "Save changes" : "Save"}
            </button>
          </>
        )}

        {existing && <UseAgain prep view={view} date={date} slot={slot} onCopy={onCopy} />}

        {existing && (
          <div className="card flat row between wrap">
            {existing.meal.cooked ? <b style={{ color: "var(--green)" }}>✓ Made — it's in the recipe's cook log</b> : <b>Did you make it?</b>}
            <button className={`btn ${existing.meal.cooked ? "" : "soft"}`} onClick={() => onCooked(!existing.meal.cooked)}>
              {existing.meal.cooked ? "Not made" : "✓ Mark as made"}
            </button>
          </div>
        )}

        <div className="row">
          {existing && (
            <button className="btn danger" onClick={onRemove}>
              Remove
            </button>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {picker && (
        <RecipePicker
          title="What will you make?"
          onClose={() => setPicker(false)}
          onPick={(r) => {
            setRecipe(r.slug);
            setPortions(null);
            setPicker(false);
          }}
        />
      )}
    </Modal>
  );
}
