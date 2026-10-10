import fs from "node:fs/promises";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp, isValidWeek } from "@mp/core";
import { buildTools } from "./tools";

// stdout is the protocol channel; anything human-readable must go to stderr
console.log = (...a) => console.error(...a);

// The MCP server uses the same data folder as the web app and works with or without the web app running.
// File watching is off here: this process only runs while a client is connected.
const app = await createApp({ watch: false });
const server = new McpServer({ name: "meal-planner", version: "0.1.0" });

for (const t of buildTools(app)) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, async (args: any) => {
    try {
      const r = await t.handler(args);
      const content: any[] = [{ type: "text", text: r.data === undefined ? r.summary : `${r.summary}\n\n${JSON.stringify(r.data, null, 1)}` }];
      if (r.image) content.push({ type: "image", data: r.image.data, mimeType: r.image.mimeType });
      return { content };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
    }
  });
}

server.registerResource("recipe", new ResourceTemplate("recipe://{slug}", { list: undefined }), { description: "A recipe's Markdown file", mimeType: "text/markdown" }, async (uri, { slug }) => ({
  contents: [{ uri: uri.href, mimeType: "text/markdown", text: (await app.store.getRecipeRaw(String(slug))).text }],
}));
server.registerResource("mealplan", new ResourceTemplate("mealplan://{week}", { list: undefined }), { description: "A week's meal plan Markdown (ISO week, e.g. 2026-W41)", mimeType: "text/markdown" }, async (uri, { week }) => {
  if (!isValidWeek(String(week))) throw new Error("Invalid week");
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: await fs.readFile(app.store.planFile(String(week)), "utf8").catch(() => "(no plan saved for this week)") }] };
});
server.registerResource("settings", "settings://", { description: "App settings", mimeType: "text/markdown" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "text/markdown", text: await fs.readFile(app.store.settingsFile, "utf8") }],
}));

await server.connect(new StdioServerTransport());
console.error(`meal-planner MCP ready (data: ${app.cfg.dataDir})`);
process.on("SIGINT", async () => (await app.close(), process.exit(0)));
process.stdin.on("close", async () => (await app.close(), process.exit(0)));
