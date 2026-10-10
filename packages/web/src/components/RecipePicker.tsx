import type { RecipeFilters } from "@mp/core/shared";
import { useState } from "react";
import { useRecipes, type RecipeSummary } from "../api";
import { FilterPanel, RecipeCard } from "../components";
import { Filter, Search } from "../icons";
import { Empty, Loading, Modal, useDebounced } from "../ui";

/** Choose a recipe, with the same filters as the main list (calories, time, leftovers, tags…). */
export function RecipePicker({ onPick, onClose, title = "Pick a recipe", initial }: { onPick: (r: RecipeSummary) => void; onClose: () => void; title?: string; initial?: RecipeFilters }) {
  const [filters, setFilters] = useState<RecipeFilters>(initial ?? {});
  const [q, setQ] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const dq = useDebounced(q, 250);
  const { data, isLoading } = useRecipes({ ...filters, q: dq.trim() || undefined });
  const active = Object.entries(filters).filter(([k, v]) => !["sort", "order", "q"].includes(k) && v !== undefined && !(Array.isArray(v) && !v.length)).length;
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="stack">
        <div className="row">
          <div className="grow" style={{ position: "relative" }}>
            <Search style={{ position: "absolute", left: 14, top: 12, width: 20, height: 20, color: "var(--ink-soft)" }} />
            <input className="input" style={{ paddingLeft: 42 }} type="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </div>
          <button className={`btn ${active ? "soft" : ""}`} onClick={() => setShowFilters((s) => !s)}>
            <Filter /> {active ? `(${active})` : "Filters"}
          </button>
        </div>
        <div className="row wrap">
          <button className={`chip ${filters.favoritesOnly ? "on" : ""}`} style={{ cursor: "pointer" }} onClick={() => setFilters({ ...filters, favoritesOnly: filters.favoritesOnly ? undefined : true })}>
            ♥ Favourites
          </button>
          <button className={`chip ${filters.notCookedInDays ? "on" : ""}`} style={{ cursor: "pointer" }} onClick={() => setFilters({ ...filters, notCookedInDays: filters.notCookedInDays ? undefined : 14 })}>
            Not cooked lately
          </button>
          <button className={`chip ${filters.fridgeDaysMin ? "on" : ""}`} style={{ cursor: "pointer" }} onClick={() => setFilters({ ...filters, fridgeDaysMin: filters.fridgeDaysMin ? undefined : 3 })}>
            Keeps 3+ days
          </button>
          <button className={`chip ${filters.maxTotalMinutes === 30 ? "on" : ""}`} style={{ cursor: "pointer" }} onClick={() => setFilters({ ...filters, maxTotalMinutes: filters.maxTotalMinutes === 30 ? undefined : 30 })}>
            Under 30 min
          </button>
        </div>
        {showFilters && (
          <div className="card tint">
            <FilterPanel value={filters} onChange={setFilters} />
          </div>
        )}
        {isLoading && <Loading />}
        {data && Object.entries(data.excludedForMissing).map(([k, n]) => (
          <div className="small muted" key={k}>
            {n} recipe{n === 1 ? " has" : "s have"} no {k === "calories" ? "calorie" : k} data and {n === 1 ? "isn't" : "aren't"} shown.
          </div>
        ))}
        {data && data.recipes.length === 0 && <Empty emoji="🔍" title="Nothing matches" />}
        <div className="cards">
          {data?.recipes.map((r) => (
            <RecipeCard key={r.slug} r={r} onPick={onPick} />
          ))}
        </div>
      </div>
    </Modal>
  );
}
