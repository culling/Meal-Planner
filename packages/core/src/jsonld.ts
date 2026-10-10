import * as cheerio from "cheerio";
import { parseIsoDuration } from "./dates";
import { leftoversFromFacts, parseStorageNotes, type StorageFacts } from "./leftover-notes";
import { emptyNutrients, type Nutrients, type RecipeDraft } from "./schemas";

type Json = any;

/** Per-site CSS selectors for the recipe notes box. WP Recipe Maker (used by many food blogs) is the default. */
export const NOTE_SELECTORS: Record<string, string[]> = {
  "recipetineats.com": [".wprm-recipe-notes", ".wprm-recipe-notes-container"],
  default: [".wprm-recipe-notes", ".tasty-recipes-notes", ".recipe-notes", ".mv-create-notes", "[class*='recipe-notes']"],
};

const decode = (s: unknown): string => {
  if (s == null) return "";
  const str = String(s);
  if (!/[&<]/.test(str)) return str.trim();
  return cheerio.load(`<div>${str}</div>`)("div").text().replace(/\s+/g, " ").trim();
};

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function isRecipe(node: Json): boolean {
  const t = node?.["@type"];
  return Array.isArray(t) ? t.includes("Recipe") : t === "Recipe";
}

/** Collect every object from all ld+json blocks: single object, array, or @graph. */
export function findJsonLdRecipe(html: string): Json | null {
  const $ = cheerio.load(html);
  const found: Json[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    let data: Json;
    try {
      data = JSON.parse(raw);
    } catch {
      try {
        data = JSON.parse(raw.replace(/[\u0000-\u001f]+/g, " "));
      } catch {
        return;
      }
    }
    const walk = (node: Json) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        if (isRecipe(node)) found.push(node);
        if (node["@graph"]) walk(node["@graph"]);
      }
    };
    walk(data);
  });
  return found[0] ?? null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const m = String(v).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function parseServings(v: unknown): number | null {
  for (const item of asArray(v as Json)) {
    const m = String(item).match(/\d+/);
    if (m) return Number(m[0]);
  }
  return null;
}

function mapNutrition(n: Json): Nutrients | null {
  if (!n || typeof n !== "object") return null;
  const out = emptyNutrients();
  out.calories = num(n.calories);
  out.proteinG = num(n.proteinContent);
  out.carbsG = num(n.carbohydrateContent);
  out.fatG = num(n.fatContent);
  out.saturatedFatG = num(n.saturatedFatContent);
  out.fibreG = num(n.fiberContent ?? n.fibreContent);
  out.sugarG = num(n.sugarContent);
  let sodium = num(n.sodiumContent);
  if (sodium != null && /\bg\b/i.test(String(n.sodiumContent)) && !/mg/i.test(String(n.sodiumContent))) sodium *= 1000;
  out.sodiumMg = sodium;
  return out.calories == null && out.proteinG == null && out.carbsG == null && out.fatG == null ? null : out;
}

interface Step {
  section: string | null;
  text: string;
}

function flattenInstructions(v: Json): Step[] {
  const steps: Step[] = [];
  const walk = (node: Json, section: string | null) => {
    if (node == null) return;
    if (typeof node === "string") {
      // a single string may hold several lines
      for (const line of node.split(/\r?\n+/)) if (decode(line)) steps.push({ section, text: decode(line) });
    } else if (Array.isArray(node)) node.forEach((n) => walk(n, section));
    else if (typeof node === "object") {
      const type = asArray(node["@type"]);
      if (type.includes("HowToSection")) {
        const name = decode(node.name) || null;
        const items = asArray(node.itemListElement);
        items.forEach((it, i) => walkStepInSection(it, name, i === 0));
      } else if (node.text) steps.push({ section, text: decode(node.text) });
      else if (node.name) steps.push({ section, text: decode(node.name) });
      else if (node.itemListElement) walk(node.itemListElement, section);
    }
  };
  const walkStepInSection = (node: Json, name: string | null, first: boolean) => {
    const before = steps.length;
    walk(node, null);
    if (name && first && steps.length > before) steps[before] = { section: name, text: steps[before].text };
  };
  walk(v, null);
  return steps;
}

function pickImage(v: Json): string | null {
  const candidates: { url: string; area: number }[] = [];
  for (const it of asArray(v)) {
    if (typeof it === "string") candidates.push({ url: it, area: 0 });
    else if (it && typeof it === "object") {
      if (it.url) candidates.push({ url: String(it.url), area: (num(it.width) ?? 0) * (num(it.height) ?? 0) });
      else if (it.contentUrl) candidates.push({ url: String(it.contentUrl), area: 0 });
    }
  }
  if (!candidates.length) return null;
  // prefer an explicit biggest size; otherwise the first (sites list their main image first)
  return candidates.sort((a, b) => b.area - a.area)[0].url;
}

function textList(v: unknown): string[] {
  return asArray(v as Json)
    .flatMap((x) => (typeof x === "string" ? x.split(",") : x?.name ? [x.name] : []))
    .map((s: string) => decode(s))
    .filter(Boolean);
}

function dietFrom(v: unknown): string[] {
  return asArray(v as Json)
    .map((x) => String(x).split("/").pop() ?? "")
    .map((x) => x.replace(/Diet$/, "").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase())
    .filter(Boolean);
}

export function extractNotes(html: string, host: string): string {
  const $ = cheerio.load(html);
  const key = Object.keys(NOTE_SELECTORS).find((k) => k !== "default" && host.endsWith(k));
  const selectors = [...(key ? NOTE_SELECTORS[key] : []), ...NOTE_SELECTORS.default];
  for (const sel of selectors) {
    const el = $(sel).first();
    if (!el.length) continue;
    // WP Recipe Maker puts each note in its own block-level <span>; other plugins use <p> or <li>
    const isBlock = "li, p, span[style*='block'], div:not(.wprm-spacer)";
    const blocks = el.find(isBlock).filter((_, n) => $(n).find(isBlock).length === 0);
    const clean = (t: string) => t.replace(/ /g, " ").replace(/\s+/g, " ").trim();
    const lines: string[] = [];
    blocks.each((_, node) => {
      const t = clean($(node).text());
      if (t) lines.push(node.tagName === "li" ? `- ${t}` : t);
    });
    if (!lines.length) {
      const t = clean(el.text());
      if (t) lines.push(t);
    }
    if (lines.length) return lines.join("\n\n");
  }
  return "";
}

/**
 * Many sites put "how long does it keep" in the article rather than the notes box. Read only the
 * article's own paragraphs (not the recipe card, not reader comments), and only sentences about storing food.
 */
export function articleStorageFacts(html: string): StorageFacts {
  const $ = cheerio.load(html);
  // drop reader comments, the recipe card itself (its method says "refrigerate overnight"), and page chrome
  $("script, style, nav, footer, aside, form, #comments, #respond, .comments-area, .comment-list, .comment-respond, li.comment, .wprm-recipe-container").remove();
  const root = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body");
  const clean = (t: string) => t.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  const keep = (t: string) => t && /freez|fridge|refrigerat/i.test(t);
  // FAQ accordions / <details>: the question and its answer go together ("How long will leftovers keep? 4 days in the fridge")
  root.find(".accordion-item, details").each((_, el) => {
    const t = clean($(el).text());
    if (keep(t)) lines.push(t);
  });
  root.find("p, li").each((_, el) => {
    const t = clean($(el).text());
    if (keep(t)) lines.push(t);
  });
  // a heading like "Storage" followed by its paragraph
  root.find("h2, h3, h4").each((_, el) => {
    const head = clean($(el).text());
    if (!STORAGE_HEADING.test(head)) return;
    const next = clean($(el).nextUntil("h2, h3, h4").slice(0, 3).text());
    if (keep(next)) lines.push(`${head}. ${next}`);
  });
  return parseStorageNotes(lines.join("\n"), { requireContext: true });
}

const STORAGE_HEADING = /\b(storage|store|storing|leftovers?|keep|keeping|make[- ]ahead|freezing)\b/i;

const KNOWN_COURSES = new Set(["breakfast", "brunch", "lunch", "dinner", "main", "main course", "mains", "side", "side dish", "dessert", "snack", "starter", "appetizer", "appetiser", "drink", "drinks", "soup", "salad", "sauce"]);

/** Clean up recipe-plugin leftovers like "(, full fat)" and "((Note 1))". */
export function cleanIngredientText(s: string): string {
  return s
    .replace(/\s*\(\s*notes?\s*[\d,\s&]*\)/gi, "")
    .replace(/\(\s*,\s*/g, "(")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface JsonLdResult {
  draft: RecipeDraft;
  imageUrl: string | null;
  notesFound: boolean;
}

/** Build a draft from a page's schema.org Recipe data. Returns null when the page has none. */
export function draftFromHtml(html: string, url: string, defaults: { fridgeDays: number }): JsonLdResult | null {
  const r = findJsonLdRecipe(html);
  if (!r) return null;
  const u = new URL(url);
  const $ = cheerio.load(html);
  const steps = flattenInstructions(r.recipeInstructions);
  let n = 0;
  const methodLines = steps.map((s) => {
    n++;
    return `${n}. ${s.section ? `**${s.section}:** ` : ""}${s.text}`;
  });

  const site =
    $('meta[property="og:site_name"]').attr("content")?.trim() ||
    decode((asArray(r.publisher)[0] as Json)?.name) ||
    u.hostname.replace(/^www\./, "");
  const authorRaw = asArray(r.author)[0] as Json;
  const author = ((typeof authorRaw === "string" ? decode(authorRaw) : decode(authorRaw?.name)) || "").split("|")[0].trim() || null;

  const notes = extractNotes(html, u.hostname);
  const noteFacts = parseStorageNotes(notes || "");
  const articleFacts = articleStorageFacts(html);
  const facts: StorageFacts = {
    fridgeDays: noteFacts.fridgeDays ?? articleFacts.fridgeDays,
    freezerDays: noteFacts.freezerDays ?? articleFacts.freezerDays,
    freezable: noteFacts.freezable ?? articleFacts.freezable,
    reheatNotes: noteFacts.reheatNotes ?? articleFacts.reheatNotes,
  };
  const hasFacts = facts.fridgeDays != null || facts.freezerDays != null || facts.freezable != null;
  const fromArticle = hasFacts && noteFacts.fridgeDays == null && noteFacts.freezerDays == null && noteFacts.freezable == null;

  const per = mapNutrition(r.nutrition);
  const keywords = textList(r.keywords).map((k) => k.toLowerCase());
  const categories = textList(r.recipeCategory).map((c) => c.toLowerCase());
  const course = categories.filter((c) => KNOWN_COURSES.has(c));
  const cuisine = textList(r.recipeCuisine)[0] ?? null;
  const tags = [...new Set([...keywords, ...categories.filter((c) => !KNOWN_COURSES.has(c)), ...(cuisine ? [cuisine.toLowerCase()] : [])])].slice(0, 12);
  const ing = asArray<string>(r.recipeIngredient).map((s) => cleanIngredientText(decode(s))).filter(Boolean);

  const draft: RecipeDraft = {
    title: decode(r.name) || "Untitled recipe",
    servings: parseServings(r.recipeYield),
    servingDescription: null,
    times: {
      prepMinutes: parseIsoDuration(r.prepTime),
      cookMinutes: parseIsoDuration(r.cookTime),
      totalMinutes: parseIsoDuration(r.totalTime),
    },
    ingredientsMd: ing.map((l) => `- ${l}`).join("\n"),
    methodMd: methodLines.join("\n"),
    sourceNotes: notes,
    tags,
    cuisine,
    course,
    diet: dietFrom(r.suitableForDiet),
    nutrition: per ? { perServing: per, source: "page", confidence: "high" } : null,
    leftovers: leftoversFromFacts(facts, defaults.fridgeDays),
    source: { type: "web", url, site, author, book: null, importedAt: null },
    uploadId: null,
    uploadedImages: [],
    confidence: {},
    warnings: [],
  };
  if (!ing.length) draft.warnings.push("No ingredient list was found in the page data.");
  if (!steps.length) draft.warnings.push("No method steps were found in the page data.");
  if (fromArticle) draft.warnings.push("Storage times were taken from the article text on the page.");
  else if (!hasFacts && !notes) draft.warnings.push("Couldn't find recipe notes or storage advice on the page, so fridge time is a default estimate.");
  else if (!hasFacts) draft.warnings.push("The page doesn't say how long leftovers keep; fridge time is a default estimate.");
  if (draft.times.totalMinutes == null && (draft.times.prepMinutes != null || draft.times.cookMinutes != null)) {
    draft.times.totalMinutes = (draft.times.prepMinutes ?? 0) + (draft.times.cookMinutes ?? 0);
  }
  if (!draft.nutrition) draft.warnings.push("The page has no nutrition data; it can be calculated from the ingredients after saving.");
  return { draft, imageUrl: pickImage(r.image), notesFound: !!notes };
}

/** Plain text of the page's main content, for the AI fallback when there's no structured data. */
export function cleanPageText(html: string, maxChars = 14000): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, header, footer, aside, form, iframe, svg, .comments, #comments, [class*='comment'], [class*='sidebar'], [class*='newsletter']").remove();
  const main = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body");
  const lines: string[] = [];
  main.find("h1, h2, h3, h4, p, li").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t.length > 1) lines.push(el.tagName.startsWith("h") ? `\n## ${t}` : `- ${t}`);
  });
  return lines.join("\n").slice(0, maxChars);
}
