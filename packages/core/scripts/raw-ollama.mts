// Debug helper: send one raw chat request to Ollama and print the response fields.
//   tsx scripts/raw-ollama.mts <model> [--format] [--think] [--image]
import sharp from "sharp";

const [model = "qwen3-vl:8b", ...flags] = process.argv.slice(2);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="100%" height="100%" fill="white"/><text x="40" y="120" font-size="48" font-family="Georgia">Lemon Chicken</text><text x="40" y="200" font-size="36" font-family="Georgia">600 g chicken thigh</text><text x="40" y="260" font-size="36" font-family="Georgia">3 tbsp olive oil</text></svg>`;
const jpg = await sharp(Buffer.from(svg)).jpeg().toBuffer();
const body: Record<string, unknown> = {
  model,
  stream: false,
  messages: [{ role: "user", content: "Read the recipe in the image and answer as JSON with keys title and ingredients (list of strings).", ...(flags.includes("--image") ? { images: [jpg.toString("base64")] } : {}) }],
  options: { temperature: 0.1, num_ctx: 8192 },
};
if (flags.includes("--format")) body.format = { type: "object", properties: { title: { type: "string" }, ingredients: { type: "array", items: { type: "string" } } }, required: ["title", "ingredients"] };
body.think = flags.includes("--think");
const t0 = Date.now();
const res = await fetch("http://localhost:11434/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const data: any = await res.json();
console.log(res.status, `${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify({ content: data.message?.content, thinking: String(data.message?.thinking ?? "").slice(0, 200), done_reason: data.done_reason, error: data.error }, null, 1));
