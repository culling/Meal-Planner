import type { ParsedIngredient } from "./schemas";

const UNICODE_FRACTIONS: Record<string, number> = {
  "½": 0.5,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "¼": 0.25,
  "¾": 0.75,
  "⅕": 0.2,
  "⅖": 0.4,
  "⅗": 0.6,
  "⅘": 0.8,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 0.125,
  "⅜": 0.375,
  "⅝": 0.625,
  "⅞": 0.875,
};

/** canonical unit name for each spelling we recognise */
const UNIT_ALIASES: Record<string, string> = {
  g: "g", gram: "g", grams: "g", gm: "g",
  kg: "kg", kilogram: "kg", kilograms: "kg", kgs: "kg",
  mg: "mg",
  ml: "ml", millilitre: "ml", millilitres: "ml", milliliter: "ml", milliliters: "ml", mls: "ml",
  l: "l", litre: "l", litres: "l", liter: "l", liters: "l",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp", tsps: "tsp",
  tbsp: "tbsp", tbs: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp", tbsps: "tbsp",
  cup: "cup", cups: "cup",
  oz: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  clove: "clove", cloves: "clove",
  can: "can", cans: "can", tin: "can", tins: "can",
  pinch: "pinch", pinches: "pinch",
  bunch: "bunch", bunches: "bunch",
  sprig: "sprig", sprigs: "sprig",
  slice: "slice", slices: "slice",
  stick: "stick", sticks: "stick",
  packet: "packet", packets: "packet", pack: "packet", packs: "packet",
  piece: "piece", pieces: "piece",
  head: "head", heads: "head",
  stalk: "stalk", stalks: "stalk",
  handful: "handful", handfuls: "handful",
  dash: "dash", dashes: "dash",
  knob: "knob",
};

export const VOLUME_ML: Record<string, number> = { ml: 1, l: 1000, tsp: 5, tbsp: 15, cup: 250 };
export const MASS_G: Record<string, number> = { g: 1, kg: 1000, mg: 0.001, oz: 28.3495, lb: 453.592 };

const OPTIONAL_RE = /\b(to taste|for serving|to serve|for garnish|garnish|optional|as needed|for frying|for greasing|for dusting)\b/i;

function parseNumber(s: string): number | null {
  s = s.trim();
  if (!s) return null;
  let total = 0;
  let any = false;
  for (const part of s.split(/\s+/)) {
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^(\d+)([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])$/))) {
      total += Number(m[1]) + UNICODE_FRACTIONS[m[2]];
    } else if (UNICODE_FRACTIONS[part] !== undefined) {
      total += UNICODE_FRACTIONS[part];
    } else if ((m = part.match(/^(\d+)\/(\d+)$/))) {
      if (Number(m[2]) === 0) return null;
      total += Number(m[1]) / Number(m[2]);
    } else if (/^\d+(\.\d+)?$/.test(part)) {
      total += Number(part);
    } else if ((m = part.match(/^\d+,\d+$/))) {
      total += Number(part.replace(",", "."));
    } else {
      return null;
    }
    any = true;
  }
  return any ? total : null;
}

const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+(?:[.,]\d+)?\/\d+|\d+\s*[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|\d+(?:[.,]\d+)?)`;
const LEADING_QTY = new RegExp(String.raw`^(${NUM})(?:\s*(?:-|–|—|to)\s*(${NUM}))?\s*`, "i");

function normUnit(u: string): string | null {
  return UNIT_ALIASES[u.toLowerCase().replace(/\.$/, "")] ?? null;
}

/** Parse one ingredient line like "1 1/2 cups plain yoghurt, drained". */
export function parseIngredient(line: string, group: string | null = null): ParsedIngredient {
  const raw = line.trim();
  let rest = raw
    .replace(/^[-*•]\s*/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/\*\*|__/g, "")
    .trim();
  const result: ParsedIngredient = {
    raw,
    quantity: null,
    quantityMax: null,
    unit: null,
    name: rest,
    prep: null,
    metric: null,
    group,
    optional: OPTIONAL_RE.test(rest),
  };

  const q = rest.match(LEADING_QTY);
  if (q) {
    const qty = parseNumber(q[1]);
    if (qty !== null) {
      result.quantity = qty;
      if (q[2]) result.quantityMax = parseNumber(q[2]);
      rest = rest.slice(q[0].length);

      const takeUnit = () => {
        const unitMatch = rest.match(/^([A-Za-z]+\.?)\s*/);
        const u = unitMatch ? normUnit(unitMatch[1]) : null;
        if (unitMatch && u) {
          result.unit = u;
          rest = rest.slice(unitMatch[0].length);
        }
      };
      takeUnit();
      // alternative amounts: "/ 14 oz", "or 1 cup", "(250ml)", "(about 2 cups)"
      let metricBeforeUnit = false;
      for (let i = 0; i < 3; i++) {
        const slash = rest.match(new RegExp(String.raw`^(?:\/|or)\s*(${NUM})\s*([A-Za-z]+)\.?\s*`, "i"));
        const paren = rest.match(new RegExp(String.raw`^\(\s*(?:about\s+|approx\.?\s+)?(${NUM})\s*([A-Za-z]+)\.?[^)]*\)\s*`, "i"));
        const m = slash ?? paren;
        if (!m || !normUnit(m[2])) break;
        const altQty = parseNumber(m[1]);
        const altUnit = normUnit(m[2])!;
        if (altQty !== null && !result.metric) {
          if (altUnit === "g" || altUnit === "ml") result.metric = { quantity: altQty, unit: altUnit };
          else if (altUnit === "kg") result.metric = { quantity: altQty * 1000, unit: "g" };
          else if (altUnit === "l") result.metric = { quantity: altQty * 1000, unit: "ml" };
          if (result.metric && result.unit === null) metricBeforeUnit = true;
        }
        rest = rest.slice(m[0].length);
      }
      if (result.unit === null) takeUnit();
      // "2 (400 g) cans tomatoes": the bracketed amount is per can
      if (metricBeforeUnit && result.unit && result.metric && result.quantity > 1) {
        result.metric.quantity *= result.quantity;
      }
      rest = rest.replace(/^of\s+/i, "");
    }
  }

  // bracketed notes ("(finely chopped)", "((halve for table salt))", an unclosed "(cut into cubes") become the prep
  const { text: noBrackets, notes } = takeBrackets(rest);
  // split "name, preparation"
  const comma = noBrackets.indexOf(",");
  const head = comma > -1 ? noBrackets.slice(0, comma) : noBrackets;
  const tail = comma > -1 ? noBrackets.slice(comma + 1) : "";
  result.name = head.replace(/\s+/g, " ").trim();
  result.prep = [...notes, tail.trim()].map((s) => s.trim()).filter(Boolean).join(", ") || null;
  if (!result.name && result.prep) {
    result.name = result.prep;
    result.prep = null;
  }
  return result;
}

/** Remove (possibly nested or unclosed) bracketed text and return it separately. */
function takeBrackets(s: string): { text: string; notes: string[] } {
  let depth = 0;
  let text = "";
  const notes: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (ch === "(") {
      if (depth === 0) cur = "";
      else cur += ch;
      depth++;
    } else if (ch === ")" && depth > 0) {
      depth--;
      if (depth === 0) {
        const note = cur.replace(/^[\s,(]+|[\s,)]+$/g, "");
        if (note) notes.push(note);
      } else cur += ch;
    } else if (depth > 0) cur += ch;
    else text += ch;
  }
  if (depth > 0) {
    const note = cur.replace(/^[\s,(]+|[\s,)]+$/g, "");
    if (note) notes.push(note);
  }
  return { text: text.replace(/\s+/g, " ").trim(), notes };
}

/** Grams for an ingredient when it can be worked out from the unit alone (no density needed). */
export function knownGrams(ing: ParsedIngredient, scale = 1): number | null {
  if (ing.metric?.unit === "g") return ing.metric.quantity * scale;
  if (ing.quantity === null) return null;
  const q = avg(ing.quantity, ing.quantityMax) * scale;
  if (ing.unit && MASS_G[ing.unit]) return q * MASS_G[ing.unit];
  return null;
}

/** Millilitres for volume units (assumes the quantity refers to the ingredient itself). */
export function knownMl(ing: ParsedIngredient, scale = 1): number | null {
  if (ing.metric?.unit === "ml") return ing.metric.quantity * scale;
  if (ing.quantity === null) return null;
  const q = avg(ing.quantity, ing.quantityMax) * scale;
  if (ing.unit && VOLUME_ML[ing.unit]) return q * VOLUME_ML[ing.unit];
  return null;
}

function avg(a: number, b: number | null): number {
  return b !== null ? (a + b) / 2 : a;
}

// ---------- formatting & scaling ----------

const FRACTIONS: [number, string][] = [
  [0.125, "⅛"], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"],
];

export function formatQuantity(n: number): string {
  if (!isFinite(n)) return "";
  if (n >= 20) return String(Math.round(n));
  if (n >= 5) return String(Math.round(n * 2) / 2).replace(/\.5$/, "½");
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  if (frac < 0.06) return String(whole || 0);
  for (const [v, s] of FRACTIONS) {
    if (Math.abs(frac - v) < 0.06) return whole ? `${whole}${s}` : s;
  }
  if (frac > 0.94) return String(whole + 1);
  return String(Math.round(n * 10) / 10);
}

/** Render a (possibly scaled) ingredient back to a readable line. */
export function formatIngredient(ing: ParsedIngredient, scale = 1): string {
  if (ing.quantity === null) return ing.raw.replace(/^[-*•]\s*/, "");
  let q = formatQuantity(ing.quantity * scale);
  if (ing.quantityMax !== null) q += `–${formatQuantity(ing.quantityMax * scale)}`;
  let unit = ing.unit ?? "";
  if (unit && ing.quantity * scale > 1 && ["cup", "clove", "can", "slice", "piece", "stick", "packet", "bunch", "sprig", "head", "stalk"].includes(unit)) {
    unit += "s";
  }
  const metric = ing.metric && ing.unit !== ing.metric.unit ? ` (${formatQuantity(ing.metric.quantity * scale)}${ing.metric.unit})` : "";
  const joiner = ["g", "kg", "ml", "l", "mg"].includes(unit) ? "" : " ";
  const head = unit ? `${q}${joiner}${unit}` : q;
  const tail = ing.prep ? `, ${ing.prep}` : "";
  return `${head}${metric} ${ing.name}${tail}`.replace(/\s+/g, " ").trim();
}

/** Parse a whole Markdown "Ingredients" section body into ingredient lines with groups. */
export function parseIngredientSection(md: string): ParsedIngredient[] {
  const out: ParsedIngredient[] = [];
  let group: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^#{3,6}\s+(.*)$/);
    if (h) {
      group = h[1].trim();
      continue;
    }
    const li = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    if (li && li[1].trim()) out.push(parseIngredient(li[1], group));
  }
  return out;
}
