import {
  NUTRIENT_KEYS,
  NUTRIENT_LABELS,
  emptyNutrients,
  parseIngredientSection,
  type Confidence,
  type Leftovers,
  type Nutrients,
  type RecipeDraft,
  type RecipeSource,
} from "@mp/core/shared";
import { useMemo, type ReactNode } from "react";
import { useFacets, type RecipeFull } from "../api";
import { Alert } from "../icons";
import { NumField, Seg, TagInput } from "../ui";

export interface FormState {
  title: string;
  servings: number | null;
  servingDescription: string;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  cuisine: string;
  tags: string[];
  course: string[];
  diet: string[];
  ingredientsMd: string;
  methodMd: string;
  sourceNotes: string;
  leftovers: Leftovers;
  /** null = leave nutrition alone (edit mode) */
  nutrition: { perServing: Nutrients; source: "page" | "ocr" | "calculated" | "manual" | null; confidence: Confidence | null } | null;
  source: RecipeSource;
}

const newLeftovers = (): Leftovers => ({ fridgeDays: null, freezerDays: null, freezable: null, reheatNotes: null, source: "estimated" });
const blankSource = (): RecipeSource => ({ type: "manual", url: null, site: null, author: null, book: null, importedAt: null });

export function blankForm(): FormState {
  return {
    title: "",
    servings: 4,
    servingDescription: "",
    prepMinutes: null,
    cookMinutes: null,
    totalMinutes: null,
    cuisine: "",
    tags: [],
    course: [],
    diet: [],
    ingredientsMd: "",
    methodMd: "",
    sourceNotes: "",
    leftovers: newLeftovers(),
    nutrition: { perServing: emptyNutrients(), source: null, confidence: null },
    source: blankSource(),
  };
}

export function formFromRecipe(r: RecipeFull): FormState {
  const m = r.meta;
  return {
    title: m.title,
    servings: m.servings,
    servingDescription: m.servingDescription ?? "",
    prepMinutes: m.times.prepMinutes,
    cookMinutes: m.times.cookMinutes,
    totalMinutes: m.times.totalMinutes,
    cuisine: m.cuisine ?? "",
    tags: m.tags,
    course: m.course,
    diet: m.diet,
    ingredientsMd: r.parts.ingredientsMd,
    methodMd: r.parts.methodMd,
    sourceNotes: r.parts.sourceNotes,
    leftovers: { ...m.leftovers },
    nutrition: null,
    source: m.source,
  };
}

export function formFromDraft(d: RecipeDraft): FormState {
  return {
    title: d.title,
    servings: d.servings,
    servingDescription: d.servingDescription ?? "",
    prepMinutes: d.times.prepMinutes,
    cookMinutes: d.times.cookMinutes,
    totalMinutes: d.times.totalMinutes,
    cuisine: d.cuisine ?? "",
    tags: d.tags,
    course: d.course,
    diet: d.diet,
    ingredientsMd: d.ingredientsMd,
    methodMd: d.methodMd,
    sourceNotes: d.sourceNotes,
    leftovers: d.leftovers ?? newLeftovers(),
    nutrition: d.nutrition ? { perServing: { ...emptyNutrients(), ...d.nutrition.perServing }, source: d.nutrition.source as any, confidence: d.nutrition.confidence } : { perServing: emptyNutrients(), source: null, confidence: null },
    source: d.source,
  };
}

/** The fields the recipe API understands (used for create and edit). */
export function formToRecipeInput(f: FormState, includeNutrition: boolean) {
  const hasNutrition = f.nutrition && NUTRIENT_KEYS.some((k) => f.nutrition!.perServing[k] != null);
  return {
    title: f.title.trim(),
    servings: f.servings,
    servingDescription: f.servingDescription.trim() || null,
    times: { prepMinutes: f.prepMinutes, cookMinutes: f.cookMinutes, totalMinutes: f.totalMinutes },
    cuisine: f.cuisine.trim() || null,
    tags: f.tags,
    course: f.course,
    diet: f.diet,
    ingredientsMd: f.ingredientsMd,
    methodMd: f.methodMd,
    sourceNotes: f.sourceNotes,
    leftovers: f.leftovers,
    source: f.source,
    ...(includeNutrition && hasNutrition ? { nutrition: { perServing: f.nutrition!.perServing, source: f.nutrition!.source ?? "manual", confidence: f.nutrition!.confidence ?? "high", calculatedAt: null, breakdown: [] } } : {}),
  };
}

export function formToDraft(f: FormState, base: RecipeDraft): RecipeDraft {
  const hasNutrition = f.nutrition && NUTRIENT_KEYS.some((k) => f.nutrition!.perServing[k] != null);
  return {
    ...base,
    title: f.title.trim(),
    servings: f.servings,
    servingDescription: f.servingDescription.trim() || null,
    times: { prepMinutes: f.prepMinutes, cookMinutes: f.cookMinutes, totalMinutes: f.totalMinutes },
    cuisine: f.cuisine.trim() || null,
    tags: f.tags,
    course: f.course,
    diet: f.diet,
    ingredientsMd: f.ingredientsMd,
    methodMd: f.methodMd,
    sourceNotes: f.sourceNotes,
    leftovers: f.leftovers,
    source: f.source,
    nutrition: hasNutrition ? { perServing: f.nutrition!.perServing, source: f.nutrition!.source ?? "manual", confidence: f.nutrition!.confidence ?? "high" } : null,
  };
}

function Flag({ level }: { level?: Confidence }) {
  if (level !== "low" && level !== "medium") return null;
  return <span className="lowconf-tag"> · {level === "low" ? "hard to read — please check" : "double-check"}</span>;
}

export function RecipeForm({ value, onChange, confidence = {}, mode }: { value: FormState; onChange: (f: FormState) => void; confidence?: Record<string, Confidence>; mode: "new" | "edit" | "review" }) {
  const { data: facets } = useFacets();
  const set = (patch: Partial<FormState>) => onChange({ ...value, ...patch });
  const parsed = useMemo(() => parseIngredientSection(value.ingredientsMd), [value.ingredientsMd]);
  const stepCount = useMemo(() => value.methodMd.split("\n").filter((l) => /^\s*(\d+[.)]|[-*+])\s+\S/.test(l)).length, [value.methodMd]);
  const low = (k: string) => (confidence[k] === "low" ? "lowconf" : "");
  const leftoverSet = (patch: Partial<Leftovers>) => set({ leftovers: { ...value.leftovers, ...patch, source: "manual" } });

  return (
    <div className="stack">
      <div className={`card stack ${low("title")}`}>
        <div className="field">
          <label>
            Title
            <Flag level={confidence.title} />
          </label>
          <input className="input" value={value.title} onChange={(e) => set({ title: e.target.value })} placeholder="Butter Chicken" autoFocus={mode === "new"} />
        </div>
        <div className="grid2">
          <div className={low("servings")}>
            <NumField label="Servings" value={value.servings} onChange={(n) => set({ servings: n })} hint="How many portions this makes" />
            <Flag level={confidence.servings} />
          </div>
          <div className="field">
            <label>What's a serving?</label>
            <input className="input" value={value.servingDescription} onChange={(e) => set({ servingDescription: e.target.value })} placeholder="1 cup curry + rice" />
          </div>
        </div>
        <div className={`grid3 ${low("times")}`}>
          <NumField label="Prep" unit="min" value={value.prepMinutes} onChange={(n) => set({ prepMinutes: n })} />
          <NumField label="Cook" unit="min" value={value.cookMinutes} onChange={(n) => set({ cookMinutes: n })} />
          <NumField label="Total" unit="min" value={value.totalMinutes} onChange={(n) => set({ totalMinutes: n })} />
        </div>
        <Flag level={confidence.times} />
      </div>

      <div className={`card stack ${low("ingredients")}`}>
        <div className="field">
          <label>
            Ingredients
            <Flag level={confidence.ingredients} />
          </label>
          <textarea
            className="input mono"
            style={{ minHeight: 200 }}
            value={value.ingredientsMd}
            onChange={(e) => set({ ingredientsMd: e.target.value })}
            placeholder={"- 600 g chicken thigh, cut into pieces\n- 2 tbsp butter\n\n### Sauce\n- 400 g crushed tomatoes"}
            spellCheck={false}
          />
          <div className="hint">One per line starting with “-”. Use “### Heading” to group (like Marinade or Sauce). Metric is best.</div>
        </div>
        {parsed.length > 0 && (
          <details>
            <summary>How the app reads these ({parsed.length})</summary>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="num">Amount</th>
                    <th>Unit</th>
                    <th>Ingredient</th>
                    <th>Prep</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.map((p, i) => (
                    <tr key={i}>
                      <td className="num">{p.quantity ?? "—"}{p.quantityMax ? `–${p.quantityMax}` : ""}</td>
                      <td>{p.unit ?? ""}</td>
                      <td>{p.name}</td>
                      <td className="muted">{p.prep ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>

      <div className={`card stack ${low("method")}`}>
        <div className="field">
          <label>
            Method
            <Flag level={confidence.method} />
          </label>
          <textarea className="input mono" style={{ minHeight: 200 }} value={value.methodMd} onChange={(e) => set({ methodMd: e.target.value })} placeholder={"1. Combine the marinade…\n2. Cook for 10 minutes…"} spellCheck={false} />
          <div className="hint">Numbered steps, one per line. {stepCount ? `${stepCount} step${stepCount === 1 ? "" : "s"} found.` : ""}</div>
        </div>
      </div>

      <div className="card stack">
        <h3>Tags</h3>
        <div className="field">
          <label>Cuisine</label>
          <input className="input" list="cuisines" value={value.cuisine} onChange={(e) => set({ cuisine: e.target.value })} placeholder="Indian" />
          <datalist id="cuisines">{facets?.cuisines.map((c) => <option key={c.name} value={c.name} />)}</datalist>
        </div>
        <div className="field">
          <label>Tags</label>
          <TagInput value={value.tags} onChange={(tags) => set({ tags })} suggestions={facets?.tags.map((t) => t.name)} placeholder="curry, weeknight…" />
        </div>
        <div className="grid2">
          <div className="field">
            <label>Course</label>
            <TagInput value={value.course} onChange={(course) => set({ course })} suggestions={["main", "side", "dessert", "breakfast", "snack", "soup"]} placeholder="main" />
          </div>
          <div className="field">
            <label>Diet</label>
            <TagInput value={value.diet} onChange={(diet) => set({ diet })} suggestions={["vegetarian", "vegan", "gluten-free", "dairy-free"]} placeholder="gluten-free" />
          </div>
        </div>
      </div>

      <div className="card stack">
        <h3>Leftovers</h3>
        <div className="grid2">
          <NumField label="Fridge" unit="days" value={value.leftovers.fridgeDays} onChange={(n) => leftoverSet({ fridgeDays: n })} />
          <NumField label="Freezer" unit="days" value={value.leftovers.freezerDays} onChange={(n) => leftoverSet({ freezerDays: n })} hint="90 days = 3 months" />
        </div>
        <div className="field">
          <label>Freezes well?</label>
          <Seg
            fill
            value={value.leftovers.freezable === null ? "unknown" : value.leftovers.freezable ? "yes" : "no"}
            options={[
              { value: "unknown", label: "Don't know" },
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ]}
            onChange={(x) => leftoverSet({ freezable: x === "unknown" ? null : x === "yes" })}
          />
        </div>
        <div className="field">
          <label>Reheating notes</label>
          <input className="input" value={value.leftovers.reheatNotes ?? ""} onChange={(e) => leftoverSet({ reheatNotes: e.target.value || null })} placeholder="Reheat gently on the stove" />
        </div>
        {value.leftovers.source === "estimated" && <div className="hint">These are default guesses until you set them.</div>}
      </div>

      {value.nutrition && (
        <div className={`card stack ${low("nutrition")}`}>
          <h3>
            Nutrition per serving
            <Flag level={confidence.nutrition} />
          </h3>
          <div className="hint" style={{ marginTop: -8 }}>
            {mode === "review" ? "Only filled in if the recipe itself printed it. Leave blank to work it out from the ingredients after saving." : "Optional. You can also work it out from the ingredients on the recipe page."}
          </div>
          <div className="grid4">
            {NUTRIENT_KEYS.map((k) => (
              <NumField
                key={k}
                label={NUTRIENT_LABELS[k].label}
                unit={NUTRIENT_LABELS[k].unit}
                value={value.nutrition!.perServing[k]}
                onChange={(n) => set({ nutrition: { ...value.nutrition!, perServing: { ...value.nutrition!.perServing, [k]: n }, source: value.nutrition!.source ?? "manual", confidence: value.nutrition!.confidence ?? "high" } })}
              />
            ))}
          </div>
        </div>
      )}

      <div className="card stack">
        <h3>Where it's from</h3>
        <Seg
          fill
          value={value.source.type}
          options={[
            { value: "web", label: "Website" },
            { value: "book", label: "Book" },
            { value: "manual", label: "My own" },
          ]}
          onChange={(type) => set({ source: { ...value.source, type } })}
        />
        {value.source.type === "web" && (
          <div className="stack tight">
            <div className="field">
              <label>Link</label>
              <input className="input" type="url" value={value.source.url ?? ""} onChange={(e) => set({ source: { ...value.source, url: e.target.value || null } })} />
            </div>
            <div className="grid2">
              <div className="field">
                <label>Site</label>
                <input className="input" value={value.source.site ?? ""} onChange={(e) => set({ source: { ...value.source, site: e.target.value || null } })} />
              </div>
              <div className="field">
                <label>Author</label>
                <input className="input" value={value.source.author ?? ""} onChange={(e) => set({ source: { ...value.source, author: e.target.value || null } })} />
              </div>
            </div>
          </div>
        )}
        {value.source.type === "book" && (
          <div className="stack tight">
            <div className="field">
              <label>Book title</label>
              <input className="input" value={value.source.book?.title ?? ""} onChange={(e) => set({ source: { ...value.source, book: { title: e.target.value || null, author: value.source.book?.author ?? null, page: value.source.book?.page ?? null } } })} />
            </div>
            <div className="grid2">
              <div className="field">
                <label>Author</label>
                <input className="input" value={value.source.book?.author ?? ""} onChange={(e) => set({ source: { ...value.source, author: e.target.value || null, book: { title: value.source.book?.title ?? null, author: e.target.value || null, page: value.source.book?.page ?? null } } })} />
              </div>
              <div className="field">
                <label>Page</label>
                <input className="input" value={value.source.book?.page ?? ""} onChange={(e) => set({ source: { ...value.source, book: { title: value.source.book?.title ?? null, author: value.source.book?.author ?? null, page: e.target.value || null } } })} />
              </div>
            </div>
          </div>
        )}
        <div className="field">
          <label>Notes from the original recipe</label>
          <textarea className="input" style={{ minHeight: 100 }} value={value.sourceNotes} onChange={(e) => set({ sourceNotes: e.target.value })} placeholder="Storage, substitutions, tips copied from the source…" />
        </div>
        <div className="hint">For your own private use. Credit stays with the original author.</div>
      </div>
    </div>
  );
}

export function WarningList({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="notice warn">
      <Alert />
      <div>
        <b>Worth a look before saving</b>
        <ul>
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function SaveBar({ children }: { children: ReactNode }) {
  return <div className="sticky-bar">{children}</div>;
}
