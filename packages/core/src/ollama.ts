import { z } from "zod";

export interface OllamaModelInfo {
  name: string;
  sizeGb: number | null;
  vision: boolean;
}

export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaError";
  }
}

export interface ChatJsonOptions<T> {
  model: string;
  system?: string;
  prompt: string;
  /** raw base64 image data (no data: prefix) */
  images?: string[];
  schema: z.ZodType<T>;
  timeoutMs?: number;
  /** extra context window if the prompt is long */
  numCtx?: number;
}

/** Minimal client for a local Ollama server. Everything stays on this machine. */
export class OllamaClient {
  constructor(private baseUrl: string) {}

  async status(): Promise<{ ok: boolean; error?: string; models: OllamaModelInfo[] }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { ok: false, error: `Ollama answered ${res.status}`, models: [] };
      const data = (await res.json()) as { models?: { name: string; size?: number; capabilities?: string[]; details?: { families?: string[] } }[] };
      return {
        ok: true,
        models: (data.models ?? []).map((m) => ({
          name: m.name,
          sizeGb: m.size ? Math.round((m.size / 1e9) * 10) / 10 : null,
          vision: !!m.capabilities?.includes("vision") || /vl|vision|llava|gemma3|gemma4|minicpm-v/i.test(m.name),
        })),
      };
    } catch (e) {
      return { ok: false, error: `Can't reach Ollama at ${this.baseUrl} (${(e as Error).message})`, models: [] };
    }
  }

  /** Ask for a JSON answer that must match `schema`. Retries once if the model returns something invalid. */
  async chatJson<T>(opts: ChatJsonOptions<T>): Promise<T> {
    const jsonSchema = z.toJSONSchema(opts.schema, { target: "draft-7" } as any) as Record<string, unknown>;
    delete jsonSchema.$schema;
    const messages: { role: string; content: string; images?: string[] }[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: opts.prompt, ...(opts.images?.length ? { images: opts.images } : {}) });

    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = {
        model: opts.model,
        messages: attempt === 0 ? messages : [...messages, { role: "user", content: `Your previous answer was not valid (${lastError}). Reply again with only the JSON object.` }],
        stream: false,
        think: false,
        format: jsonSchema,
        options: { temperature: 0.1, num_ctx: opts.numCtx ?? 8192 },
        keep_alive: "10m",
      };
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
        });
      } catch (e) {
        throw new OllamaError(`Couldn't reach Ollama at ${this.baseUrl}: ${(e as Error).message}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new OllamaError(`Ollama error ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as { message?: { content?: string; thinking?: string } };
      // some reasoning models (qwen3-vl) put the structured answer in `thinking` and leave `content` empty
      const content = data.message?.content?.trim() ? data.message.content : (data.message?.thinking ?? "");
      try {
        const parsed = JSON.parse(extractJson(content));
        return opts.schema.parse(parsed);
      } catch (e) {
        lastError = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) : (e as Error).message;
      }
    }
    throw new OllamaError(`The model's answer didn't match the expected format (${lastError})`);
  }
}

/** Models sometimes wrap JSON in prose or code fences. */
function extractJson(text: string): string {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) return t;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}
