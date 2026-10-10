import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { activeFilterCount, filtersFromParams, filtersToQuery, useRecipes } from "../api";
import { FilterPanel, MISSING_LABELS, RecipeCard, SORTS } from "../components";
import { Filter, Search, X } from "../icons";
import { Empty, ErrorBox, Loading, Modal, useDebounced } from "../ui";
import type { RecipeFilters } from "@mp/core/shared";

export function RecipesPage() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const [search, setSearch] = useState(filters.q ?? "");
  const debounced = useDebounced(search, 250);
  const [sheet, setSheet] = useState(false);

  // search text lives in the URL too, so Back and refresh keep your place
  const effective: RecipeFilters = { ...filters, q: debounced.trim() || undefined };
  const { data, error, isLoading, refetch } = useRecipes(effective);

  const update = (f: RecipeFilters) => {
    const next = new URLSearchParams(filtersToQuery({ ...f, q: search.trim() || undefined }));
    setParams(next, { replace: true });
  };
  const count = activeFilterCount(filters);
  const clear = () => {
    setSearch("");
    setParams(new URLSearchParams(), { replace: true });
  };

  return (
    <>
      <div className="page-head">
        <h1>Recipes</h1>
        <Link to="/import" className="btn primary">
          + Add recipe
        </Link>
      </div>

      <div className="row">
        <div className="grow" style={{ position: "relative" }}>
          <Search style={{ position: "absolute", left: 14, top: 12, width: 20, height: 20, color: "var(--ink-soft)" }} />
          <input
            className="input"
            style={{ paddingLeft: 42, paddingRight: search ? 40 : 14 }}
            type="search"
            placeholder="Search recipes, ingredients, tags…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              const next = new URLSearchParams(filtersToQuery({ ...filters, q: e.target.value.trim() || undefined }));
              setParams(next, { replace: true });
            }}
          />
          {search && (
            <button className="btn icon ghost sm" style={{ position: "absolute", right: 4, top: 5 }} onClick={() => {
                setSearch("");
                setParams(new URLSearchParams(filtersToQuery({ ...filters, q: undefined })), { replace: true });
              }}
              aria-label="Clear search"
            >
              <X />
            </button>
          )}
        </div>
        <button className={`btn ${count ? "soft" : ""}`} onClick={() => setSheet(true)}>
          <Filter /> Filters{count ? ` (${count})` : ""}
        </button>
      </div>

      <div className="row wrap">
        <button className={`chip ${filters.favoritesOnly ? "on" : ""}`} style={{ cursor: "pointer" }} onClick={() => update({ ...filters, favoritesOnly: filters.favoritesOnly ? undefined : true })}>
          ♥ Favourites
        </button>
        <span className="grow" />
        <label className="row small muted" style={{ gap: 6 }}>
          Sort
          <select
            className="input"
            style={{ width: "auto", minHeight: 34, padding: "2px 10px" }}
            value={filters.sort ?? "title"}
            onChange={(e) => update({ ...filters, sort: e.target.value as RecipeFilters["sort"] })}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <button className="btn sm" onClick={() => update({ ...filters, order: filters.order === "desc" ? "asc" : "desc" })} aria-label="Flip sort order">
            {filters.order === "desc" ? "↓" : "↑"}
          </button>
        </label>
      </div>

      {data?.problems.length ? (
        <div className="notice warn">
          <div>
            <b>
              {data.problems.length} recipe file{data.problems.length > 1 ? "s" : ""} couldn't be read:
            </b>
            <ul>
              {data.problems.map((p) => (
                <li key={p.slug}>
                  <code>{p.slug}</code> — {p.error}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {isLoading && <Loading />}
      {error && <ErrorBox error={error} retry={() => refetch()} />}

      {data && (
        <>
          <div className="small muted">
            {data.total} recipe{data.total === 1 ? "" : "s"}
            {count || debounced ? (
              <>
                {" "}
                ·{" "}
                <button className="btn ghost sm" style={{ minHeight: 24, padding: "0 6px" }} onClick={clear}>
                  Clear filters
                </button>
              </>
            ) : null}
          </div>
          {Object.entries(data.excludedForMissing).map(([k, n]) => (
            <div className="small muted" key={k}>
              {n} recipe{n === 1 ? " has" : "s have"} no {MISSING_LABELS[k] ?? k}, so {n === 1 ? "it isn't" : "they aren't"} shown with this filter.
            </div>
          ))}
          {data.recipes.length ? (
            <div className="cards">
              {data.recipes.map((r) => (
                <RecipeCard key={r.slug} r={r} />
              ))}
            </div>
          ) : count || debounced ? (
            <Empty emoji="🔍" title="Nothing matches">
              Try loosening a filter.
            </Empty>
          ) : (
            <Empty emoji="🥘" title="No recipes yet">
              <p>Add your first one from a web link, a photo of a cookbook page, or by typing it in.</p>
              <Link className="btn primary" to="/import">
                Add a recipe
              </Link>
            </Empty>
          )}
        </>
      )}

      {sheet && (
        <Modal title="Filters" onClose={() => setSheet(false)}>
          <FilterPanel value={filters} onChange={update} />
          <div className="row" style={{ marginTop: 18 }}>
            <button className="btn" onClick={clear}>
              Reset
            </button>
            <button className="btn primary grow" onClick={() => setSheet(false)}>
              Show {data?.total ?? ""} recipes
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
