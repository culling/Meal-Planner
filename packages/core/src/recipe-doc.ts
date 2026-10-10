import { parseIngredientSection } from "./ingredients";
import type { CookLogEntry, MethodStep, NoteEntry, ParsedIngredient } from "./schemas";

export interface Section {
  heading: string;
  /** everything after the heading line up to the next "## " heading */
  content: string;
}

export interface SplitBody {
  /** text before the first "## " heading (usually "# Title") */
  preamble: string;
  sections: Section[];
}

/** Split a recipe body on level-2 headings. Headings are matched case-insensitively by callers. */
export function splitBody(body: string): SplitBody {
  const lines = body.split(/\r?\n/);
  const pre: string[] = [];
  const sections: Section[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence ? line.match(/^##\s+(.+?)\s*#*\s*$/) : null;
    if (h) {
      if (current) sections.push({ heading: current.heading, content: current.lines.join("\n") });
      current = { heading: h[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      pre.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, content: current.lines.join("\n") });
  return { preamble: pre.join("\n"), sections };
}

export function joinBody(s: SplitBody): string {
  const parts: string[] = [];
  if (s.preamble.trim()) parts.push(s.preamble.trimEnd());
  for (const sec of s.sections) parts.push(`## ${sec.heading}\n\n${sec.content.trim()}`.trimEnd());
  return parts.join("\n\n") + "\n";
}

export function findSection(s: SplitBody, name: string | RegExp): Section | undefined {
  return s.sections.find((x) => (typeof name === "string" ? x.heading.toLowerCase() === name.toLowerCase() : name.test(x.heading)));
}

const METHOD_RE = /^(method|instructions|directions|steps)$/i;
const NOTES_RE = /^(my notes|notes)$/i;

/** Numbered (or bulleted) steps. A "### Heading" inside the method prefixes the step that follows it. */
export function parseMethod(md: string): MethodStep[] {
  const steps: MethodStep[] = [];
  let cur = null as string[] | null;
  let prefix: string | null = null;
  const flush = () => {
    if (cur) steps.push({ n: steps.length + 1, text: cur.join("\n").trim() });
    cur = null;
  };
  const start = (text: string) => {
    flush();
    cur = [prefix ? `**${prefix}:** ${text}` : text];
    prefix = null;
  };
  for (const line of md.split(/\r?\n/)) {
    const item = line.match(/^\s*(?:\d+[.)]|[-*+])\s+(.*)$/);
    const heading = line.match(/^#{3,6}\s+(.*)$/);
    if (item) start(item[1]);
    else if (heading) {
      flush();
      prefix = heading[1].trim();
    } else if (line.trim() && cur) cur.push(line.trim());
    else if (line.trim() && !line.startsWith("#")) start(line.trim()); // un-numbered paragraphs count as steps
  }
  flush();
  return steps;
}

export function parseNotes(md: string): NoteEntry[] {
  const out: NoteEntry[] = [];
  let cur: { date: string; lines: string[] } | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^###\s+(.*)$/);
    if (h) {
      if (cur) out.push({ date: cur.date, text: cur.lines.join("\n").trim() });
      cur = { date: h[1].trim(), lines: [] };
    } else if (cur) cur.lines.push(line);
    else if (line.trim()) cur = { date: "", lines: [line] };
  }
  if (cur) out.push({ date: cur.date, text: cur.lines.join("\n").trim() });
  return out.filter((n) => n.text);
}

export function parseCookLog(md: string): CookLogEntry[] {
  const out: CookLogEntry[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\b(.*)$/);
    if (!m) continue;
    const people = m[2].match(/for\s+(\d+)/i);
    const rating = m[2].match(/rating\s+(\d(?:\.\d)?)/i);
    out.push({ date: m[1], people: people ? Number(people[1]) : null, rating: rating ? Number(rating[1]) : null, raw: line.trim() });
  }
  return out;
}

export interface ParsedBody {
  ingredients: ParsedIngredient[];
  method: MethodStep[];
  notes: NoteEntry[];
  sourceNotes: string;
  cookLog: CookLogEntry[];
}

export function parseBody(body: string): ParsedBody {
  const split = splitBody(body);
  return {
    ingredients: parseIngredientSection(findSection(split, "ingredients")?.content ?? ""),
    method: parseMethod(findSection(split, METHOD_RE)?.content ?? ""),
    notes: parseNotes(findSection(split, NOTES_RE)?.content ?? ""),
    sourceNotes: (findSection(split, "source notes")?.content ?? "").trim(),
    cookLog: parseCookLog(findSection(split, "cook log")?.content ?? ""),
  };
}

/** Raw Markdown of the ingredient and method sections (for the edit form). */
export function bodyParts(body: string): { ingredientsMd: string; methodMd: string; sourceNotes: string } {
  const split = splitBody(body);
  return {
    ingredientsMd: (findSection(split, "ingredients")?.content ?? "").trim(),
    methodMd: (findSection(split, METHOD_RE)?.content ?? "").trim(),
    sourceNotes: (findSection(split, "source notes")?.content ?? "").trim(),
  };
}

function setSection(split: SplitBody, name: string, content: string, matcher?: RegExp, insertAt?: number): void {
  const existing = findSection(split, matcher ?? name);
  if (existing) existing.content = content;
  else if (insertAt === undefined) split.sections.push({ heading: name, content });
  else split.sections.splice(Math.min(insertAt, split.sections.length), 0, { heading: name, content });
}

export interface BodyParts {
  title: string;
  ingredientsMd: string;
  methodMd: string;
  sourceNotes?: string;
}

export function buildBody(p: BodyParts): string {
  const split: SplitBody = { preamble: `# ${p.title}`, sections: [] };
  setSection(split, "Ingredients", p.ingredientsMd.trim());
  setSection(split, "Method", p.methodMd.trim());
  if (p.sourceNotes?.trim()) setSection(split, "Source notes", p.sourceNotes.trim());
  setSection(split, "My notes", "");
  setSection(split, "Cook log", "");
  return joinBody(split);
}

/** Replace the Ingredients/Method/Source notes sections (and the title heading), leaving notes and log alone. */
export function updateBodyParts(body: string, p: Partial<BodyParts>): string {
  const split = splitBody(body);
  if (p.title !== undefined) {
    if (/^#\s+/m.test(split.preamble)) split.preamble = split.preamble.replace(/^#\s+.*$/m, `# ${p.title}`);
    else split.preamble = `# ${p.title}\n${split.preamble}`.trim();
  }
  if (p.ingredientsMd !== undefined) setSection(split, "Ingredients", p.ingredientsMd.trim(), undefined, 0);
  if (p.methodMd !== undefined) setSection(split, "Method", p.methodMd.trim(), METHOD_RE, 1);
  if (p.sourceNotes !== undefined) {
    if (p.sourceNotes.trim()) setSection(split, "Source notes", p.sourceNotes.trim());
    else split.sections = split.sections.filter((s) => s.heading.toLowerCase() !== "source notes");
  }
  return joinBody(split);
}

/** Add a dated note under "My notes", newest first. */
export function addNote(body: string, date: string, text: string): string {
  const split = splitBody(body);
  const sec = findSection(split, NOTES_RE);
  const entry = `### ${date}\n${text.trim()}`;
  if (sec) sec.content = sec.content.trim() ? `${entry}\n\n${sec.content.trim()}` : entry;
  else split.sections.push({ heading: "My notes", content: entry });
  return joinBody(split);
}

/** Replace the whole My notes section (used by the inline notes editor). */
export function setNotes(body: string, notes: NoteEntry[]): string {
  const split = splitBody(body);
  const content = notes.map((n) => (n.date ? `### ${n.date}\n${n.text.trim()}` : n.text.trim())).join("\n\n");
  setSection(split, "My notes", content, NOTES_RE);
  return joinBody(split);
}

export function addCookLog(body: string, line: string): string {
  const split = splitBody(body);
  const sec = findSection(split, "cook log");
  const item = `- ${line}`;
  if (sec) sec.content = sec.content.trim() ? `${sec.content.trim()}\n${item}` : item;
  else split.sections.push({ heading: "Cook log", content: item });
  return joinBody(split);
}
