import { z } from "zod";

// ---------- Nutrition ----------

export const NUTRIENT_KEYS = [
  "calories",
  "proteinG",
  "carbsG",
  "fatG",
  "saturatedFatG",
  "fibreG",
  "sugarG",
  "sodiumMg",
] as const;
export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

export const NUTRIENT_LABELS: Record<NutrientKey, { label: string; unit: string }> = {
  calories: { label: "Calories", unit: "kcal" },
  proteinG: { label: "Protein", unit: "g" },
  carbsG: { label: "Carbs", unit: "g" },
  fatG: { label: "Fat", unit: "g" },
  saturatedFatG: { label: "Saturated fat", unit: "g" },
  fibreG: { label: "Fibre", unit: "g" },
  sugarG: { label: "Sugar", unit: "g" },
  sodiumMg: { label: "Sodium", unit: "mg" },
};

const num = z.number().nullable().default(null);

export const NutrientsSchema = z.object({
  calories: num,
  proteinG: num,
  carbsG: num,
  fatG: num,
  saturatedFatG: num,
  fibreG: num,
  sugarG: num,
  sodiumMg: num,
});
export type Nutrients = z.infer<typeof NutrientsSchema>;

export const emptyNutrients = (): Nutrients => ({
  calories: null,
  proteinG: null,
  carbsG: null,
  fatG: null,
  saturatedFatG: null,
  fibreG: null,
  sugarG: null,
  sodiumMg: null,
});

export const NutritionSourceSchema = z.enum(["page", "ocr", "calculated", "estimated", "manual"]);
export type NutritionSource = z.infer<typeof NutritionSourceSchema>;
export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** Where one ingredient's nutrition came from. "ai" rows show the "?" icon until a person edits them. */
export const RowSourceSchema = z.enum(["ai", "manual"]);
export type RowSource = z.infer<typeof RowSourceSchema>;

export const BreakdownRowSchema = z
  .object({
    ingredient: z.string(),
    /** id of an entry in the food database, if one was matched */
    food: z.string().nullable().default(null),
    grams: z.number().nullable().default(null),
    /** where the gram amount came from: the recipe's own units, an AI guess, or a person */
    gramsSource: z.enum(["unit", "ai", "manual"]).default("ai"),
    excluded: z.boolean().default(false),
    /** true once a person typed the nutrient numbers for this row directly */
    override: z.boolean().default(false),
    source: RowSourceSchema.default("ai"),
    /** nutrition for the whole ingredient amount (not per 100 g, not per serving) */
    total: NutrientsSchema.default(emptyNutrients),
  })
  .passthrough();
export type BreakdownRow = z.infer<typeof BreakdownRowSchema>;

export const RecipeNutritionSchema = z
  .object({
    perServing: NutrientsSchema.default(emptyNutrients),
    source: NutritionSourceSchema.nullable().default(null),
    confidence: ConfidenceSchema.nullable().default(null),
    calculatedAt: z.string().nullable().default(null),
    breakdown: z.array(BreakdownRowSchema).default([]),
  })
  .passthrough();
export type RecipeNutrition = z.infer<typeof RecipeNutritionSchema>;

// ---------- Recipe ----------

export const SourceSchema = z
  .object({
    type: z.enum(["web", "book", "manual"]).default("manual"),
    url: z.string().nullable().default(null),
    site: z.string().nullable().default(null),
    author: z.string().nullable().default(null),
    book: z
      .object({
        title: z.string().nullable().default(null),
        author: z.string().nullable().default(null),
        page: z.union([z.string(), z.number()]).nullable().default(null),
      })
      .nullable()
      .default(null),
    importedAt: z.string().nullable().default(null),
  })
  .passthrough();
export type RecipeSource = z.infer<typeof SourceSchema>;

export const LeftoversSchema = z
  .object({
    fridgeDays: z.number().nullable().default(null),
    freezerDays: z.number().nullable().default(null),
    freezable: z.boolean().nullable().default(null),
    reheatNotes: z.string().nullable().default(null),
    source: z.enum(["page", "estimated", "manual"]).default("estimated"),
  })
  .passthrough();
export type Leftovers = z.infer<typeof LeftoversSchema>;

export const GalleryItemSchema = z
  .object({
    file: z.string(),
    kind: z.enum(["step", "cooked", "source-page", "other"]).default("other"),
    step: z.number().nullable().optional(),
    caption: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
  })
  .passthrough();
export type GalleryItem = z.infer<typeof GalleryItemSchema>;

export const RecipeRoleSchema = z.enum(["main", "side"]);
export type RecipeRole = z.infer<typeof RecipeRoleSchema>;

/** Best guess at a recipe's role from its free-text course labels: only mains/dinners (or recipes with no course at all) count as mains. */
export function inferRole(course: string[] | undefined | null): RecipeRole[] {
  if (!course?.length || course.some((c) => /main|dinner/i.test(c))) return ["main"];
  return ["side"];
}

export const RecipeMetaSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    source: SourceSchema.default(() => SourceSchema.parse({})),
    servings: z.number().nullable().default(null),
    servingDescription: z.string().nullable().default(null),
    times: z
      .object({
        prepMinutes: z.number().nullable().default(null),
        cookMinutes: z.number().nullable().default(null),
        totalMinutes: z.number().nullable().default(null),
      })
      .passthrough()
      .default({ prepMinutes: null, cookMinutes: null, totalMinutes: null }),
    nutrition: RecipeNutritionSchema.default(() => RecipeNutritionSchema.parse({})),
    leftovers: LeftoversSchema.default(() => LeftoversSchema.parse({})),
    tags: z.array(z.string()).default([]),
    cuisine: z.string().nullable().default(null),
    course: z.array(z.string()).default([]),
    /** main, side, or both — a clean version of `course` used for filtering and meal suggestions */
    role: z.array(RecipeRoleSchema).min(1).default(["main"]),
    diet: z.array(z.string()).default([]),
    favorite: z.boolean().default(false),
    hidden: z.boolean().default(false),
    rating: z.number().min(1).max(5).nullable().default(null),
    images: z
      .object({
        hero: z.string().nullable().default(null),
        gallery: z.array(GalleryItemSchema).default([]),
      })
      .passthrough()
      .default({ hero: null, gallery: [] }),
    createdAt: z.string().nullable().default(null),
    updatedAt: z.string().nullable().default(null),
  })
  .passthrough();
export type RecipeMeta = z.infer<typeof RecipeMetaSchema>;

/** Parse recipe frontmatter; recipes saved before `role` existed get it inferred from their course. */
export function parseRecipeMeta(raw: Record<string, unknown>): RecipeMeta {
  const role = raw.role == null || (Array.isArray(raw.role) && !raw.role.length) ? inferRole(raw.course as string[] | undefined) : raw.role;
  return RecipeMetaSchema.parse({ ...raw, role });
}

/** A parsed ingredient line. Derived from the Markdown, never written back. */
export interface ParsedIngredient {
  raw: string;
  quantity: number | null;
  quantityMax: number | null;
  unit: string | null;
  name: string;
  prep: string | null;
  /** a metric amount found in brackets or after a slash, e.g. "1 cup (250ml)" */
  metric: { quantity: number; unit: "g" | "ml" } | null;
  group: string | null;
  /** "to taste", "for serving" etc. — skipped by nutrition and shopping */
  optional: boolean;
}

export interface MethodStep {
  n: number;
  text: string;
}

export interface NoteEntry {
  date: string;
  text: string;
}

export interface CookLogEntry {
  date: string;
  people: number | null;
  rating: number | null;
  raw: string;
}

/** A recipe as loaded from disk. */
export interface Recipe {
  slug: string;
  meta: RecipeMeta;
  /** the Markdown below the frontmatter */
  body: string;
  ingredients: ParsedIngredient[];
  method: MethodStep[];
  notes: NoteEntry[];
  sourceNotes: string;
  cookLog: CookLogEntry[];
  /** last time cooked (YYYY-MM-DD) from the cook log */
  lastCooked: string | null;
  mtimeMs: number;
}

// ---------- Settings ----------

/**
 * Tidy an Ollama address typed by a person: "192.168.0.66" → "http://192.168.0.66:11434".
 * A bare host gets Ollama's default port; an empty string means "use OLLAMA_URL from .env". Returns null if it isn't a usable address.
 */
export function normalizeOllamaUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "";
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
  let url: URL;
  try {
    url = new URL(hasScheme ? v : `http://${v}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
  if (!hasScheme && !url.port) url.port = "11434";
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export const SettingsSchema = z
  .object({
    /** where Ollama runs, e.g. another computer on the network; empty = OLLAMA_URL from .env */
    ollamaUrl: z
      .string()
      .transform((v, ctx) => {
        const url = normalizeOllamaUrl(v);
        if (url === null) {
          ctx.addIssue({ code: "custom", message: `"${v}" isn't a valid address for Ollama (try something like 192.168.0.10 or http://my-pc:11434)` });
          return z.NEVER;
        }
        return url;
      })
      .default(""),
    defaultPeople: z.number().default(2),
    weekStartsOn: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]).default("monday"),
    mealSlots: z
      .array(z.string().refine((n) => !/^prep(-\d+)?$/.test(n), { message: '"prep" is kept for make-ahead cooking, which has its own row' }))
      .default(["breakfast", "lunch", "dinner"]),
    units: z.enum(["metric", "imperial"]).default("metric"),
    dailyCalorieTargetPerPerson: z.number().nullable().default(null),
    defaultLeftoverFridgeDays: z.number().default(3),
    extraction: z
      .object({
        /** ollama = send photos straight to a local vision model; lightonocr = OCR first, then a text model structures it */
        provider: z.enum(["ollama", "lightonocr"]).default("ollama"),
        visionModel: z.string().default("qwen3-vl:8b"),
        textModel: z.string().default("qwen3.5:9b"),
      })
      .passthrough()
      .default(() => ({ provider: "ollama" as const, visionModel: "qwen3-vl:8b", textModel: "qwen3.5:9b" })),
    nutrition: z
      .object({
        provider: z.enum(["ollama", "none"]).default("ollama"),
        model: z.string().default("qwen3.5:9b"),
      })
      .passthrough()
      .default(() => ({ provider: "ollama" as const, model: "qwen3.5:9b" })),
  })
  .passthrough();
export type Settings = z.infer<typeof SettingsSchema>;

// ---------- Food database ----------

export const FoodSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    aliases: z.array(z.string()).default([]),
    per100g: NutrientsSchema.default(emptyNutrients),
    /** grams in one cup / tbsp / piece when known */
    gramsPerCup: z.number().nullable().default(null),
    gramsPerPiece: z.number().nullable().default(null),
    source: RowSourceSchema.default("ai"),
    updatedAt: z.string().nullable().default(null),
  })
  .passthrough();
export type Food = z.infer<typeof FoodSchema>;

// ---------- Meal plan ----------

export const MealTypeSchema = z.enum(["cook", "leftovers", "eat-out", "skip"]);
export type MealType = z.infer<typeof MealTypeSchema>;

export const FrozenPortionsSchema = z.object({
  date: z.string(),
  portions: z.number(),
});

export const MealSchema = z
  .object({
    recipe: z.string().nullable().default(null),
    people: z.number().nullable().default(null),
    type: MealTypeSchema.default("cook"),
    /** cook meals: total portions cooked (default = people) */
    portions: z.number().nullable().default(null),
    cooked: z.boolean().default(false),
    /** leftovers meals: "YYYY-MM-DD/slot" of the cook meal */
    leftoverFrom: z.string().nullable().default(null),
    leftoverStore: z.enum(["fridge", "freezer"]).default("fridge"),
    /** cook meals: portions moved to the freezer */
    frozen: z.array(FrozenPortionsSchema).default([]),
    note: z.string().nullable().default(null),
  })
  .passthrough();
export type Meal = z.infer<typeof MealSchema>;

export const DayPlanSchema = z
  .object({
    date: z.string(),
    people: z.number().nullable().default(null),
    meals: z.record(z.string(), MealSchema.nullable()).default({}),
  })
  .passthrough();
export type DayPlan = z.infer<typeof DayPlanSchema>;

export const MealPlanSchema = z
  .object({
    week: z.string(),
    startDate: z.string(),
    defaultPeople: z.number().nullable().default(null),
    days: z.array(DayPlanSchema).default([]),
  })
  .passthrough();
export type MealPlan = z.infer<typeof MealPlanSchema>;

// ---------- Shopping list ----------

export const ShoppingItemSchema = z.object({
  key: z.string(),
  text: z.string(),
  checked: z.boolean().default(false),
  manual: z.boolean().default(false),
  from: z.array(z.string()).default([]),
});
export type ShoppingItem = z.infer<typeof ShoppingItemSchema>;

export const ShoppingListSchema = z
  .object({
    week: z.string(),
    generatedAt: z.string().nullable().default(null),
    items: z.array(ShoppingItemSchema).default([]),
  })
  .passthrough();
export type ShoppingList = z.infer<typeof ShoppingListSchema>;

// ---------- Import draft ----------

export const FieldConfidenceSchema = z.record(z.string(), ConfidenceSchema).default({});

export interface RecipeDraft {
  title: string;
  servings: number | null;
  servingDescription: string | null;
  times: { prepMinutes: number | null; cookMinutes: number | null; totalMinutes: number | null };
  /** Markdown ingredient lines with optional "### group" headings */
  ingredientsMd: string;
  methodMd: string;
  sourceNotes: string;
  tags: string[];
  cuisine: string | null;
  course: string[];
  role?: RecipeRole[];
  diet: string[];
  nutrition: { perServing: Nutrients; source: NutritionSource | null; confidence: Confidence | null } | null;
  leftovers: Leftovers | null;
  source: RecipeSource;
  /** images already stored in a temp upload folder (.cache/uploads/<uploadId>), moved into the recipe on confirm */
  uploadId: string | null;
  uploadedImages: { file: string; kind: "hero" | "source-page" | "other" }[];
  /** a saved photo (data/photos/<id>) this draft was read from or is being typed from; its pages become the recipe's source pages */
  photoId?: string | null;
  /** per-field confidence, used to highlight uncertain fields on the review screen */
  confidence: Record<string, Confidence>;
  warnings: string[];
}

// ---------- Saved photos (recipe photos waiting to be read, or already read) ----------

export const PhotoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** waiting = nobody has turned it into a recipe yet; done = a recipe was saved from it */
    status: z.enum(["waiting", "done"]).default("waiting"),
    book: z
      .object({
        title: z.string().nullable().default(null),
        author: z.string().nullable().default(null),
        page: z.union([z.string(), z.number()]).nullable().default(null),
      })
      .nullable()
      .default(null),
    notes: z.string().default(""),
    /** slug of the recipe made from this photo */
    recipe: z.string().nullable().default(null),
    /** file names inside the photo's images/ folder, in page order */
    images: z.array(z.string()).default([]),
    createdAt: z.string().nullable().default(null),
    updatedAt: z.string().nullable().default(null),
  })
  .passthrough();
export type Photo = z.infer<typeof PhotoSchema>;
