import type { Leftovers } from "./schemas";

export interface StorageFacts {
  fridgeDays: number | null;
  freezerDays: number | null;
  freezable: boolean | null;
  reheatNotes: string | null;
}

const RANGE = String.raw`(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?`;
const UNIT = String.raw`(day|days|week|weeks|month|months|hour|hours)`;
const FRIDGE_WORD = /\b(fridge|refrigerator|refrigerated|refrigerate|chilled)\b/i;
const STORAGE_CONTEXT = /\b(keep|keeps|kept|store|stored|storage|storing|leftover|leftovers|last|lasts|make[- ]ahead)\b/i;
const FREEZER_WORD = /\b(freez\w*|frozen)\b/i;

function toDays(n: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("month")) return Math.round(n * 30);
  if (u.startsWith("week")) return Math.round(n * 7);
  if (u.startsWith("hour")) return Math.max(1, Math.round(n / 24));
  return Math.round(n);
}

/** Use the lower end of a range ("3–4 days" -> 3): the safe choice for food. */
function duration(sentence: string, near: RegExp): number | null {
  // "for up to 3 days", "3-4 days", "within 2 days"
  const after = new RegExp(`${near.source}[^.;]{0,80}?${RANGE}\\s*${UNIT}\\b`, "i");
  const before = new RegExp(`${RANGE}\\s*${UNIT}\\b[^.;]{0,40}?${near.source}`, "i");
  let m = sentence.match(after);
  if (m) return toDays(Number(m[m.length - 3]), m[m.length - 1]);
  m = sentence.match(before);
  if (m) return toDays(Number(m[1]), m[3]);
  return null;
}

const NOT_FREEZABLE = [
  /\b(?:doesn'?t|does not|don'?t|do not|won'?t|will not|can'?t|cannot|isn'?t|is not|not)\b[^.;]{0,50}\bfreez\w*/i,
  /\bfreez\w*\b[^.;]{0,30}\b(?:not recommended|isn'?t recommended|not suitable|not ideal|doesn'?t work|is not good|isn'?t good)\b/i,
  /\bnot (?:suitable|recommended|good|ideal)\b[^.;]{0,20}\bfreez\w*/i,
  /\bavoid freezing\b/i,
  /\bnever freeze\b/i,
];

/** Find storage statements in a recipe's notes text. Only reports what the text actually says. */
export function parseStorageNotes(text: string, opts: { requireContext?: boolean } = {}): StorageFacts {
  const facts: StorageFacts = { fridgeDays: null, freezerDays: null, freezable: null, reheatNotes: null };
  // when scanning a whole article, only paragraphs that talk about keeping/storing food count
  // (a paragraph, not a sentence, so "How long do leftovers keep? 4 days in the fridge." still counts)
  const scanned = opts.requireContext
    ? text
        .split("\n")
        .filter((line) => STORAGE_CONTEXT.test(line))
        .join("\n")
    : text;
  const sentences = scanned
    .replace(/[ \t]+/g, " ")
    .split(/(?<=[.!?])\s+|\s*[\n•]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const s of sentences) {
    // durations are read clause by clause so "fridge 3 days, freezer 3 months" doesn't cross over
    for (const clause of s.split(/;|,\s|\s+or\s+|\s+and\s+|\s+then\s+/i)) {
      if (facts.fridgeDays != null) break;
      if (FRIDGE_WORD.test(clause)) {
        const d = duration(clause, FRIDGE_WORD);
        if (d != null) facts.fridgeDays = d;
      } else if (!FREEZER_WORD.test(clause) && /\b(leftovers?|keeps?|lasts?|good for|stays? good)\b/i.test(clause)) {
        // "leftovers will keep for up to 3 days" — no place named, which means the fridge
        const m = clause.match(new RegExp(String.raw`\b(?:keeps?|lasts?|good for|stays? good for|will keep for)\b[^.;]{0,30}?${RANGE}\s*${UNIT}\b`, "i"));
        if (m) facts.fridgeDays = toDays(Number(m[1]), m[3]);
      }
    }
    const hasFreezer = FREEZER_WORD.test(s);
    if (hasFreezer) {
      if (NOT_FREEZABLE.some((re) => re.test(s))) {
        facts.freezable = false;
      } else {
        let d: number | null = null;
        for (const clause of s.split(/;|,\s|\s+or\s+|\s+and\s+|\s+then\s+/i)) {
          if (FREEZER_WORD.test(clause)) d = d ?? duration(clause, FREEZER_WORD);
        }
        if (d != null && facts.freezerDays == null) {
          facts.freezerDays = d;
          facts.freezable = true;
        } else if (facts.freezable == null && /\b(freezes? (?:well|beautifully|perfectly)|can be (?:frozen|stored in the freezer)|suitable for freezing|great for freezing|good for freezing|freeze (?:any|the|leftovers|for))\b/i.test(s)) {
          facts.freezable = true;
        }
      }
    }
    if (facts.reheatNotes == null && /\b(reheat|re-heat|reheating)\b/i.test(s)) facts.reheatNotes = s.slice(0, 200);
  }
  if (facts.freezable === false) facts.freezerDays = null;
  return facts;
}

/** Turn facts into a recipe `leftovers` block. `fallbackFridgeDays` marks unknown values as estimates. */
export function leftoversFromFacts(facts: StorageFacts, fallbackFridgeDays: number): Leftovers {
  const found = facts.fridgeDays != null || facts.freezerDays != null || facts.freezable != null;
  return {
    fridgeDays: facts.fridgeDays ?? fallbackFridgeDays,
    freezerDays: facts.freezerDays,
    freezable: facts.freezable,
    reheatNotes: facts.reheatNotes,
    source: found && facts.fridgeDays != null ? "page" : "estimated",
  };
}

/** True when the text talks about storing food even though no pattern matched (worth asking an AI model). */
export function mentionsStorage(text: string): boolean {
  return /\b(store|storage|keep|keeps|leftover|leftovers|fridge|freezer|refrigerat\w*)\b/i.test(text);
}
