import MiniSearch from "minisearch";
import { diffDays, todayYmd } from "./dates";
import type { Recipe } from "./schemas";

export interface RecipeFilters {
  q?: string;
  caloriesMin?: number;
  caloriesMax?: number;
  /** minimum fridge life in days */
  fridgeDaysMin?: number;
  freezable?: "yes" | "no" | "any";
  maxTotalMinutes?: number;
  tags?: string[];
  tagsMode?: "any" | "all";
  excludeTags?: string[];
  cuisine?: string[];
  course?: string[];
  /** recipes that can serve as any of these (a recipe that is both matches either) */
  role?: ("main" | "side")[];
  diet?: string[];
  favoritesOnly?: boolean;
  hidden?: "exclude" | "include" | "only";
  nutritionSource?: string[];
  ratingMin?: number;
  /** only recipes not cooked in the last N days (never-cooked recipes count) */
  notCookedInDays?: number;
  sort?: "title" | "calories" | "time" | "rating" | "lastCooked" | "added";
  order?: "asc" | "desc";
}

export interface SearchResult {
  recipes: Recipe[];
  total: number;
  /** how many recipes were left out only because a value they lack was filtered on */
  excludedForMissing: Record<string, number>;
}

export function totalMinutes(r: Recipe): number | null {
  const t = r.meta.times;
  if (t.totalMinutes != null) return t.totalMinutes;
  if (t.prepMinutes != null || t.cookMinutes != null) return (t.prepMinutes ?? 0) + (t.cookMinutes ?? 0);
  return null;
}

const lc = (s: string) => s.toLowerCase();

export class RecipeSearch {
  private index: MiniSearch<{ id: string; title: string; ingredients: string; tags: string; notes: string }> | null = null;
  private indexVersion = -1;

  private ensureIndex(recipes: Recipe[], version: number) {
    if (this.index && this.indexVersion === version) return;
    const idx = new MiniSearch({
      fields: ["title", "ingredients", "tags", "notes"],
      storeFields: ["id"],
      searchOptions: { boost: { title: 3, tags: 2 }, prefix: true, fuzzy: 0.15, combineWith: "AND" },
    });
    idx.addAll(
      recipes.map((r) => ({
        id: r.slug,
        title: r.meta.title,
        ingredients: r.ingredients.map((i) => i.name).join(" "),
        tags: [...r.meta.tags, r.meta.cuisine ?? "", ...r.meta.course, ...r.meta.diet].join(" "),
        notes: r.notes.map((n) => n.text).join(" ") + " " + r.sourceNotes,
      })),
    );
    this.index = idx;
    this.indexVersion = version;
  }

  search(recipes: Recipe[], version: number, f: RecipeFilters = {}, today = todayYmd()): SearchResult {
    let list = recipes;
    const excluded: Record<string, number> = {};
    const miss = (key: string) => (excluded[key] = (excluded[key] ?? 0) + 1);

    let scoreById: Map<string, number> | null = null;
    if (f.q?.trim()) {
      this.ensureIndex(recipes, version);
      const hits = this.index!.search(f.q.trim());
      scoreById = new Map(hits.map((h) => [h.id as string, h.score]));
      list = list.filter((r) => scoreById!.has(r.slug));
    }

    const hiddenMode = f.hidden ?? "exclude";
    list = list.filter((r) => (hiddenMode === "include" ? true : hiddenMode === "only" ? r.meta.hidden : !r.meta.hidden));
    if (f.favoritesOnly) list = list.filter((r) => r.meta.favorite);

    if (f.caloriesMin != null || f.caloriesMax != null) {
      list = list.filter((r) => {
        const c = r.meta.nutrition.perServing.calories;
        if (c == null) return miss("calories"), false;
        return (f.caloriesMin == null || c >= f.caloriesMin) && (f.caloriesMax == null || c <= f.caloriesMax);
      });
    }
    if (f.fridgeDaysMin != null) {
      list = list.filter((r) => {
        const d = r.meta.leftovers.fridgeDays;
        if (d == null) return miss("fridgeDays"), false;
        return d >= f.fridgeDaysMin!;
      });
    }
    if (f.freezable && f.freezable !== "any") {
      const want = f.freezable === "yes";
      list = list.filter((r) => {
        const v = r.meta.leftovers.freezable;
        if (v == null) return miss("freezable"), false;
        return v === want;
      });
    }
    if (f.maxTotalMinutes != null) {
      list = list.filter((r) => {
        const t = totalMinutes(r);
        if (t == null) return miss("time"), false;
        return t <= f.maxTotalMinutes!;
      });
    }
    const anyAll = (have: string[], want: string[] | undefined, mode: "any" | "all") => {
      if (!want?.length) return true;
      const h = new Set(have.map(lc));
      return mode === "all" ? want.every((w) => h.has(lc(w))) : want.some((w) => h.has(lc(w)));
    };
    if (f.tags?.length) list = list.filter((r) => anyAll(r.meta.tags, f.tags, f.tagsMode ?? "any"));
    if (f.excludeTags?.length) {
      const ex = new Set(f.excludeTags.map(lc));
      list = list.filter((r) => !r.meta.tags.some((t) => ex.has(lc(t))));
    }
    if (f.cuisine?.length) list = list.filter((r) => r.meta.cuisine && f.cuisine!.some((c) => lc(c) === lc(r.meta.cuisine!)));
    if (f.course?.length) list = list.filter((r) => anyAll(r.meta.course, f.course, "any"));
    if (f.role?.length) list = list.filter((r) => r.meta.role.some((x) => f.role!.includes(x)));
    if (f.diet?.length) list = list.filter((r) => anyAll(r.meta.diet, f.diet, "all"));
    if (f.nutritionSource?.length) {
      list = list.filter((r) => {
        const s = r.meta.nutrition.source;
        if (!s) return miss("nutritionSource"), false;
        return f.nutritionSource!.includes(s);
      });
    }
    if (f.ratingMin != null) {
      list = list.filter((r) => {
        if (r.meta.rating == null) return miss("rating"), false;
        return r.meta.rating >= f.ratingMin!;
      });
    }
    if (f.notCookedInDays != null) {
      list = list.filter((r) => !r.lastCooked || diffDays(today, r.lastCooked) >= f.notCookedInDays!);
    }

    const dir = f.order === "desc" ? -1 : 1;
    const cmpNullLast = (a: number | string | null, b: number | string | null) => {
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return (a < b ? -1 : a > b ? 1 : 0) * dir;
    };
    const sort = f.sort ?? (scoreById ? undefined : "title");
    if (sort) {
      list = [...list].sort((a, b) => {
        switch (sort) {
          case "title":
            return a.meta.title.localeCompare(b.meta.title) * dir;
          case "calories":
            return cmpNullLast(a.meta.nutrition.perServing.calories, b.meta.nutrition.perServing.calories);
          case "time":
            return cmpNullLast(totalMinutes(a), totalMinutes(b));
          case "rating":
            return cmpNullLast(a.meta.rating, b.meta.rating);
          case "lastCooked":
            return cmpNullLast(a.lastCooked, b.lastCooked);
          case "added":
            return cmpNullLast(a.meta.createdAt, b.meta.createdAt);
        }
      });
    } else if (scoreById) {
      list = [...list].sort((a, b) => (scoreById!.get(b.slug) ?? 0) - (scoreById!.get(a.slug) ?? 0));
    }
    return { recipes: list, total: list.length, excludedForMissing: excluded };
  }
}

/** Parse filters from URL-style query values (strings) — shared by the REST API and MCP tools. */
export function filtersFromQuery(q: Record<string, unknown>): RecipeFilters {
  const num = (v: unknown) => (v === undefined || v === "" || v === null ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);
  const list = (v: unknown) =>
    v === undefined || v === "" || v === null ? undefined : (Array.isArray(v) ? v : String(v).split(",")).map((s) => String(s).trim()).filter(Boolean);
  const bool = (v: unknown) => (v === true || v === "true" || v === "1" ? true : undefined);
  return {
    q: typeof q.q === "string" ? q.q : undefined,
    caloriesMin: num(q.caloriesMin),
    caloriesMax: num(q.caloriesMax),
    fridgeDaysMin: num(q.fridgeDaysMin),
    freezable: q.freezable === "yes" || q.freezable === "no" ? q.freezable : undefined,
    maxTotalMinutes: num(q.maxTotalMinutes),
    tags: list(q.tags),
    tagsMode: q.tagsMode === "all" ? "all" : undefined,
    excludeTags: list(q.excludeTags),
    cuisine: list(q.cuisine),
    course: list(q.course),
    role: list(q.role)?.filter((x): x is "main" | "side" => x === "main" || x === "side"),
    diet: list(q.diet),
    favoritesOnly: bool(q.favoritesOnly),
    hidden: q.hidden === "include" || q.hidden === "only" ? q.hidden : undefined,
    nutritionSource: list(q.nutritionSource),
    ratingMin: num(q.ratingMin),
    notCookedInDays: num(q.notCookedInDays),
    sort: ["title", "calories", "time", "rating", "lastCooked", "added"].includes(String(q.sort)) ? (q.sort as RecipeFilters["sort"]) : undefined,
    order: q.order === "desc" ? "desc" : q.order === "asc" ? "asc" : undefined,
  };
}
