import { useQuery } from "@tanstack/react-query";
import type {
  BreakdownRow,
  CookLogEntry,
  Food,
  MethodStep,
  NoteEntry,
  ParsedIngredient,
  PlanView,
  RecipeDraft,
  RecipeFilters,
  RecipeMeta,
  Settings,
  ShoppingList,
} from "@mp/core/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined && !isForm ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the Meal Planner server. Is it still running on your computer?");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Something went wrong (${res.status})`);
  return data as T;
}

export const api = {
  get: <T,>(url: string) => request<T>("GET", url),
  post: <T,>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T,>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  patch: <T,>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}),
  del: <T,>(url: string) => request<T>("DELETE", url),
  upload: <T,>(url: string, form: FormData) => request<T>("POST", url, form),
};

// ---------- response types ----------

export interface RecipeSummary {
  slug: string;
  title: string;
  hero: string | null;
  servings: number | null;
  calories: number | null;
  nutritionSource: string | null;
  nutritionAi: boolean;
  fridgeDays: number | null;
  freezable: boolean | null;
  totalMinutes: number | null;
  favorite: boolean;
  hidden: boolean;
  rating: number | null;
  lastCooked: string | null;
  tags: string[];
  cuisine: string | null;
  course: string[];
  role: ("main" | "side")[];
  diet: string[];
  sourceType: string;
  updatedAt: string | null;
}

export interface RecipeList {
  recipes: RecipeSummary[];
  total: number;
  excludedForMissing: Record<string, number>;
  problems: { slug: string; error: string }[];
}

export interface RecipeFull {
  slug: string;
  meta: RecipeMeta;
  ingredients: ParsedIngredient[];
  method: MethodStep[];
  notes: NoteEntry[];
  sourceNotes: string;
  cookLog: CookLogEntry[];
  lastCooked: string | null;
  mtimeMs: number;
  totalMinutes: number | null;
  parts: { ingredientsMd: string; methodMd: string; sourceNotes: string };
}

export interface Facets {
  total: number;
  tags: { name: string; count: number }[];
  cuisines: { name: string; count: number }[];
  courses: { name: string; count: number }[];
  diets: { name: string; count: number }[];
}

export type FoodRow = Food & { usedIn: number };

export interface JobInfo {
  id: string;
  label: string;
  status: "running" | "done" | "error";
  progress: string[];
  result: any;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface Status {
  dataDir: string;
  recipes: number;
  problems: { slug: string; error: string }[];
  ollama: { url: string; envUrl: string; ok: boolean; error?: string; models: { name: string; sizeGb: number | null; vision: boolean }[] };
  lightOnOcr: boolean;
  git: { enabled: boolean; history: { hash: string; date: string; message: string }[] };
  today: string;
}

export interface LeftoverOption {
  key: string;
  recipe: string;
  title: string;
  cookDate: string;
  store: "fridge" | "freezer";
  remaining: number;
  safeUntil: string | null;
}

// ---------- filters <-> query string ----------

export function filtersToQuery(f: RecipeFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || (v as unknown) === "" || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return p.toString();
}

export function filtersFromParams(p: URLSearchParams): RecipeFilters {
  const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
  const list = (k: string) => (p.get(k) ? p.get(k)!.split(",").filter(Boolean) : undefined);
  return {
    q: p.get("q") ?? undefined,
    caloriesMin: num("caloriesMin"),
    caloriesMax: num("caloriesMax"),
    fridgeDaysMin: num("fridgeDaysMin"),
    freezable: (p.get("freezable") as RecipeFilters["freezable"]) ?? undefined,
    maxTotalMinutes: num("maxTotalMinutes"),
    tags: list("tags"),
    tagsMode: p.get("tagsMode") === "all" ? "all" : undefined,
    excludeTags: list("excludeTags"),
    cuisine: list("cuisine"),
    course: list("course"),
    role: list("role")?.filter((x): x is "main" | "side" => x === "main" || x === "side"),
    diet: list("diet"),
    favoritesOnly: p.get("favoritesOnly") === "true" ? true : undefined,
    hidden: (p.get("hidden") as RecipeFilters["hidden"]) ?? undefined,
    nutritionSource: list("nutritionSource"),
    ratingMin: num("ratingMin"),
    notCookedInDays: num("notCookedInDays"),
    sort: (p.get("sort") as RecipeFilters["sort"]) ?? undefined,
    order: (p.get("order") as RecipeFilters["order"]) ?? undefined,
  };
}

/** Browsing shows main dishes unless the person chooses otherwise. */
export const DEFAULT_ROLE: ("main" | "side")[] = ["main"];

/** Number of filters (not counting search text and sorting) that are switched on. */
export function activeFilterCount(f: RecipeFilters): number {
  const { q, sort, order, tagsMode, role, ...rest } = f;
  void q; void sort; void order; void tagsMode; void role;
  return Object.values(rest).filter((v) => v !== undefined && v !== null && (v as unknown) !== "" && !(Array.isArray(v) && !v.length)).length;
}

// ---------- query hooks ----------

export const useRecipes = (filters: RecipeFilters) =>
  useQuery({ queryKey: ["recipes", filters], queryFn: () => api.get<RecipeList>(`/api/recipes?${filtersToQuery(filters)}`), placeholderData: (prev) => prev });
export const useRecipe = (slug: string | undefined) => useQuery({ queryKey: ["recipe", slug], queryFn: () => api.get<RecipeFull>(`/api/recipes/${slug}`), enabled: !!slug });
export const useFacets = () => useQuery({ queryKey: ["facets"], queryFn: () => api.get<Facets>("/api/facets") });
export const usePlan = (week: string) => useQuery({ queryKey: ["plan", week], queryFn: () => api.get<PlanView>(`/api/meal-plans/${week}`) });
export const useShopping = (week: string) => useQuery({ queryKey: ["shopping", week], queryFn: () => api.get<ShoppingList & { mtimeMs: number | null }>(`/api/meal-plans/${week}/shopping-list`) });
export const useFoods = () => useQuery({ queryKey: ["foods"], queryFn: () => api.get<{ foods: FoodRow[] }>("/api/foods") });
export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings"), staleTime: 60_000 });
export const useStatus = () => useQuery({ queryKey: ["status"], queryFn: () => api.get<Status>("/api/status"), staleTime: 10_000 });

export interface PhotoInfo {
  id: string;
  name: string;
  status: "waiting" | "done";
  book: { title: string | null; author: string | null; page: string | number | null } | null;
  notes: string;
  recipe: string | null;
  images: string[];
  createdAt: string | null;
  updatedAt: string | null;
  hasDraft?: boolean;
}

export interface PhotoState {
  photo: PhotoInfo;
  /** the last reading, if any (the draft itself is fetched when you open it) */
  draft: { readAt: string; model: string | null; provider: string; title: string } | null;
}

export const usePhotos = () => useQuery({ queryKey: ["photos"], queryFn: () => api.get<{ photos: PhotoInfo[] }>("/api/photos") });
export const usePhoto = (id: string | undefined) => useQuery({ queryKey: ["photo", id], queryFn: () => api.get<PhotoState>(`/api/photos/${id}`), enabled: !!id });

export type { BreakdownRow, PlanView, RecipeDraft };
