import type { RecipeFilters } from "@mp/core/shared";
import { Link } from "react-router-dom";
import { useFacets, type RecipeSummary } from "./api";
import { Clock, Flame, Fridge, Heart, Snow } from "./icons";
import { AiMark, fmtMinutes, NumField, Seg, TagInput } from "./ui";

export function RecipeCard({ r, onPick }: { r: RecipeSummary; onPick?: (r: RecipeSummary) => void }) {
  const inner = (
    <>
      <div className="pic">{r.hero ? <img loading="lazy" src={`/images/${r.slug}/${r.hero}?w=480`} alt="" /> : "🍽️"}</div>
      {r.favorite && (
        <span className="heart" aria-label="Favourite">
          <Heart filled />
        </span>
      )}
      <div className="body">
        <div className="title">{r.title}</div>
        <div className="meta">
          {r.totalMinutes != null && (
            <span className="row" style={{ gap: 4 }}>
              <Clock style={{ width: 14, height: 14 }} />
              {fmtMinutes(r.totalMinutes)}
            </span>
          )}
          {r.calories != null && (
            <span className="row" style={{ gap: 4 }}>
              <Flame style={{ width: 14, height: 14 }} />
              {r.nutritionSource === "calculated" ? "~" : ""}
              {Math.round(r.calories)} kcal
              {r.nutritionAi && <AiMark small />}
            </span>
          )}
          {r.fridgeDays != null && (
            <span className="row" style={{ gap: 4 }}>
              <Fridge style={{ width: 14, height: 14 }} />
              {r.fridgeDays}d
            </span>
          )}
          {r.freezable === true && <Snow style={{ width: 14, height: 14 }} aria-label="Freezable" />}
        </div>
      </div>
    </>
  );
  if (onPick)
    return (
      <button className={`rcard ${r.hidden ? "is-hidden" : ""}`} style={{ textAlign: "left", cursor: "pointer", padding: 0, font: "inherit" }} onClick={() => onPick(r)}>
        {inner}
      </button>
    );
  return (
    <Link className={`rcard ${r.hidden ? "is-hidden" : ""}`} to={`/recipes/${r.slug}`}>
      {inner}
    </Link>
  );
}

const SOURCES: { value: string; label: string }[] = [
  { value: "page", label: "From the recipe" },
  { value: "ocr", label: "From a photo" },
  { value: "calculated", label: "Calculated" },
  { value: "manual", label: "By hand" },
];

function ChipPicker({ title, options, value, onChange }: { title: string; options: { name: string; count: number }[]; value: string[]; onChange: (v: string[]) => void }) {
  if (!options.length) return null;
  const toggle = (n: string) => onChange(value.includes(n) ? value.filter((x) => x !== n) : [...value, n]);
  return (
    <div className="field">
      <label>{title}</label>
      <div className="chips">
        {options.slice(0, 40).map((o) => (
          <button type="button" key={o.name} className={`chip ${value.includes(o.name) ? "on" : ""}`} onClick={() => toggle(o.name)}>
            {o.name} <span className="muted tiny">{o.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Main / Side / Both switch for browsing recipes. */
export function RoleSeg({ value, onChange }: { value: RecipeFilters["role"]; onChange: (r: NonNullable<RecipeFilters["role"]>) => void }) {
  const cur = value?.length === 2 ? "both" : (value?.[0] ?? "main");
  return (
    <Seg
      value={cur}
      options={[
        { value: "main", label: "Mains" },
        { value: "side", label: "Sides" },
        { value: "both", label: "All" },
      ]}
      onChange={(v) => onChange(v === "both" ? ["main", "side"] : [v as "main" | "side"])}
    />
  );
}

/** All the filters from the spec in one panel. Used by the recipe list and the meal picker. */
export function FilterPanel({ value, onChange, compact }: { value: RecipeFilters; onChange: (f: RecipeFilters) => void; compact?: boolean }) {
  const { data: facets } = useFacets();
  const set = (patch: Partial<RecipeFilters>) => onChange({ ...value, ...patch });
  return (
    <div className="stack">
      <div className="grid2">
        <NumField label="Calories from" unit="per serving" value={value.caloriesMin} onChange={(n) => set({ caloriesMin: n ?? undefined })} />
        <NumField label="Calories up to" unit="per serving" value={value.caloriesMax} onChange={(n) => set({ caloriesMax: n ?? undefined })} />
      </div>
      <div className="grid2">
        <NumField label="Takes at most" unit="minutes" value={value.maxTotalMinutes} onChange={(n) => set({ maxTotalMinutes: n ?? undefined })} />
        <NumField label="Keeps in the fridge at least" unit="days" value={value.fridgeDaysMin} onChange={(n) => set({ fridgeDaysMin: n ?? undefined })} />
      </div>
      <div className="field">
        <label>Freezes well?</label>
        <Seg
          fill
          value={value.freezable ?? "any"}
          options={[
            { value: "any", label: "Any" },
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]}
          onChange={(v) => set({ freezable: v === "any" ? undefined : v })}
        />
      </div>
      <div className="grid2">
        <div className="field">
          <label>Rating at least</label>
          <select className="input" value={value.ratingMin ?? ""} onChange={(e) => set({ ratingMin: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">Any</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {"★".repeat(n)}
              </option>
            ))}
          </select>
        </div>
        <NumField label="Not cooked in the last" unit="days" value={value.notCookedInDays} onChange={(n) => set({ notCookedInDays: n ?? undefined })} />
      </div>
      {!compact && facets && (
        <>
          <ChipPicker title="Tags" options={facets.tags} value={value.tags ?? []} onChange={(v) => set({ tags: v })} />
          {(value.tags?.length ?? 0) > 1 && (
            <Seg
              value={value.tagsMode ?? "any"}
              options={[
                { value: "any", label: "Any of these" },
                { value: "all", label: "All of these" },
              ]}
              onChange={(v) => set({ tagsMode: v === "all" ? "all" : undefined })}
            />
          )}
          <div className="field">
            <label>Leave out tags</label>
            <TagInput value={value.excludeTags ?? []} onChange={(v) => set({ excludeTags: v })} suggestions={facets.tags.map((t) => t.name)} placeholder="e.g. spicy" />
          </div>
          <ChipPicker title="Cuisine" options={facets.cuisines} value={value.cuisine ?? []} onChange={(v) => set({ cuisine: v })} />
          <ChipPicker title="Course" options={facets.courses} value={value.course ?? []} onChange={(v) => set({ course: v })} />
          <ChipPicker title="Diet" options={facets.diets} value={value.diet ?? []} onChange={(v) => set({ diet: v })} />
        </>
      )}
      <div className="field">
        <label>Where the nutrition numbers came from</label>
        <div className="chips">
          {SOURCES.map((s) => {
            const on = value.nutritionSource?.includes(s.value);
            return (
              <button
                type="button"
                key={s.value}
                className={`chip ${on ? "on" : ""}`}
                onClick={() => {
                  const cur = value.nutritionSource ?? [];
                  set({ nutritionSource: on ? cur.filter((x) => x !== s.value) : [...cur, s.value] });
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={!!value.favoritesOnly} onChange={(e) => set({ favoritesOnly: e.target.checked || undefined })} />
        Favourites only
      </label>
      <div className="field">
        <label>Hidden recipes</label>
        <Seg
          fill
          value={value.hidden ?? "exclude"}
          options={[
            { value: "exclude", label: "Hide them" },
            { value: "include", label: "Show them too" },
            { value: "only", label: "Only hidden" },
          ]}
          onChange={(v) => set({ hidden: v === "exclude" ? undefined : v })}
        />
      </div>
    </div>
  );
}

export const SORTS: { value: NonNullable<RecipeFilters["sort"]>; label: string }[] = [
  { value: "title", label: "Name" },
  { value: "calories", label: "Calories" },
  { value: "time", label: "Time" },
  { value: "rating", label: "Rating" },
  { value: "lastCooked", label: "Last cooked" },
  { value: "added", label: "Date added" },
];

export const MISSING_LABELS: Record<string, string> = {
  calories: "calorie info",
  fridgeDays: "fridge storage info",
  freezable: "freezer info",
  time: "a cooking time",
  rating: "a rating",
  nutritionSource: "nutrition info",
};
