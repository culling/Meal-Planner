import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { leftoversFromFacts, mentionsStorage, parseStorageNotes, type StorageFacts } from "./leftover-notes";
import type { OllamaClient } from "./ollama";
import { ConfidenceSchema, emptyNutrients, type Confidence, type RecipeDraft, type Settings } from "./schemas";

const num = z.number().nullable();

export const AiDraftSchema = z.object({
  title: z.string(),
  servings: num,
  prepMinutes: num,
  cookMinutes: num,
  totalMinutes: num,
  ingredientGroups: z.array(z.object({ group: z.string().nullable(), items: z.array(z.string()) })),
  methodSteps: z.array(z.string()),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  cuisine: z.string().nullable(),
  nutritionPerServing: z
    .object({ calories: num, proteinG: num, carbsG: num, fatG: num, saturatedFatG: num, fibreG: num, sugarG: num, sodiumMg: num })
    .nullable(),
  storage: z.object({ fridgeDays: num, freezerDays: num, freezable: z.boolean().nullable() }).nullable(),
  confidence: z.object({
    title: ConfidenceSchema,
    servings: ConfidenceSchema,
    times: ConfidenceSchema,
    ingredients: ConfidenceSchema,
    method: ConfidenceSchema,
    nutrition: ConfidenceSchema,
  }),
});
export type AiDraft = z.infer<typeof AiDraftSchema>;

const SYSTEM = `You turn recipes into structured JSON. Rules:
- Copy the recipe exactly as written. Never invent ingredients, quantities, steps or numbers. If something is not stated, use null (or an empty list).
- Keep each ingredient on its own line exactly as written, with its quantity and unit (e.g. "2 tbsp olive oil", "400 g canned tomatoes"). Do not merge or split lines.
- If the ingredients have sub-headings (e.g. "Marinade", "Sauce") use them as "group"; otherwise use group null with all items in one group.
- methodSteps: one string per step, without the step number.
- servings is a number only (e.g. "Serves 4-6" -> 4). Times are whole minutes.
- nutritionPerServing: only if the recipe itself prints nutrition values; otherwise null. storage: only if the recipe itself says how long it keeps; otherwise null.
- confidence: for each part say "high" if clearly legible/complete, "medium" if you had to guess a little, "low" if hard to read or partly missing.
Answer only with the JSON object.`;

/** Resize/rotate a photo for the vision model and return base64 JPEG. */
export async function prepareForModel(data: Buffer, maxEdge = 1800): Promise<string> {
  const out = await sharp(data, { failOn: "none" })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  return out.toString("base64");
}

export async function structureFromImages(ollama: OllamaClient, model: string, images: Buffer[]): Promise<AiDraft> {
  const b64 = await Promise.all(images.map((i) => prepareForModel(i)));
  return ollama.chatJson({
    model,
    system: SYSTEM,
    prompt:
      images.length > 1
        ? `These ${images.length} images are consecutive pages of ONE recipe from a printed cookbook. Read all of them and return the single recipe.`
        : "This image is a page from a printed cookbook. Read the recipe on it and return it.",
    images: b64,
    schema: AiDraftSchema,
    timeoutMs: 600_000,
    numCtx: 16384,
  });
}

export async function structureFromText(ollama: OllamaClient, model: string, text: string, what: string): Promise<AiDraft> {
  return ollama.chatJson({
    model,
    system: SYSTEM,
    prompt: `Here is the text of ${what}. Return the recipe in it.\n\n---\n${text}\n---`,
    schema: AiDraftSchema,
    timeoutMs: 400_000,
    numCtx: 16384,
  });
}

/** Ask the model to read storage times out of notes text — only what's written, no guessing. */
export async function storageFromNotesWithAi(ollama: OllamaClient, model: string, notes: string): Promise<StorageFacts | null> {
  const schema = z.object({ fridgeDays: num, freezerDays: num, freezable: z.boolean().nullable() });
  try {
    const r = await ollama.chatJson({
      model,
      system:
        "Extract food storage information that is explicitly stated in the text. Do NOT guess or use general knowledge. fridgeDays: days it keeps in the fridge (use the lower number of a range; 1 week = 7). freezerDays: days it keeps in the freezer (1 month = 30). freezable: true/false only if the text says so. Use null for anything not stated. Answer only with JSON.",
      prompt: notes.slice(0, 4000),
      schema,
      timeoutMs: 120_000,
    });
    return { ...r, reheatNotes: null };
  } catch {
    return null;
  }
}

/** Run the LightOnOCR script on one image and return the text it prints. */
export async function ocrWithLightOn(dir: string, image: Buffer): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mp-ocr-"));
  const file = path.join(tmp, "page.jpg");
  try {
    await fs.writeFile(file, await sharp(image, { failOn: "none" }).rotate().jpeg({ quality: 92 }).toBuffer());
    const python = process.platform === "win32" ? "python" : "python3";
    const out = await new Promise<string>((resolve, reject) => {
      execFile(python, ["ocr.py", file], { cwd: dir, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`LightOnOCR failed: ${String(stderr || err.message).slice(-400)}`));
        else resolve(String(stdout));
      });
    });
    const marker = out.indexOf("--- Extracted Text ---");
    return (marker >= 0 ? out.slice(marker + "--- Extracted Text ---".length) : out).trim();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Convert the model's JSON into a draft the review screen can show. */
export function draftFromAi(ai: AiDraft, base: Pick<RecipeDraft, "source" | "uploadId" | "uploadedImages">, settings: Pick<Settings, "defaultLeftoverFridgeDays">, origin: "ocr" | "page"): RecipeDraft {
  const stripNum = (s: string) => s.replace(/^\s*(?:step\s*)?\d+[.):]\s*/i, "").trim();
  const ingredientLines: string[] = [];
  for (const g of ai.ingredientGroups) {
    if (g.group && g.group.trim()) ingredientLines.push(`${ingredientLines.length ? "\n" : ""}### ${g.group.trim()}`);
    for (const item of g.items) if (item.trim()) ingredientLines.push(`- ${item.replace(/^[-*•]\s*/, "").trim()}`);
  }
  const method = ai.methodSteps.map(stripNum).filter(Boolean).map((s, i) => `${i + 1}. ${s}`);
  const notes = (ai.notes ?? "").trim();

  const regexFacts = parseStorageNotes(notes);
  const facts: StorageFacts = {
    fridgeDays: regexFacts.fridgeDays ?? ai.storage?.fridgeDays ?? null,
    freezerDays: regexFacts.freezerDays ?? ai.storage?.freezerDays ?? null,
    freezable: regexFacts.freezable ?? ai.storage?.freezable ?? null,
    reheatNotes: regexFacts.reheatNotes,
  };
  const nut = ai.nutritionPerServing;
  const hasNut = !!nut && (nut.calories != null || nut.proteinG != null || nut.fatG != null || nut.carbsG != null);

  const draft: RecipeDraft = {
    title: ai.title.trim() || "Untitled recipe",
    servings: ai.servings,
    servingDescription: null,
    times: { prepMinutes: ai.prepMinutes, cookMinutes: ai.cookMinutes, totalMinutes: ai.totalMinutes ?? (ai.prepMinutes != null || ai.cookMinutes != null ? (ai.prepMinutes ?? 0) + (ai.cookMinutes ?? 0) : null) },
    ingredientsMd: ingredientLines.join("\n"),
    methodMd: method.join("\n"),
    sourceNotes: notes,
    tags: ai.tags.map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 10),
    cuisine: ai.cuisine,
    course: [],
    diet: [],
    nutrition: hasNut ? { perServing: { ...emptyNutrients(), ...nut! }, source: origin === "ocr" ? "ocr" : "page", confidence: ai.confidence.nutrition } : null,
    leftovers: leftoversFromFacts(facts, settings.defaultLeftoverFridgeDays),
    source: base.source,
    uploadId: base.uploadId,
    uploadedImages: base.uploadedImages,
    confidence: { ...ai.confidence } as Record<string, Confidence>,
    warnings: [],
  };
  if (!ai.ingredientGroups.some((g) => g.items.length)) draft.warnings.push("No ingredients were found.");
  if (!method.length) draft.warnings.push("No method steps were found.");
  if (!hasNut) draft.warnings.push("No nutrition information found; it can be calculated from the ingredients after saving.");
  if (draft.leftovers?.source === "estimated") draft.warnings.push("No storage times found; fridge time is a default estimate.");
  return draft;
}

export { mentionsStorage };
