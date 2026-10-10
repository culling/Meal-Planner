import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";

it("starts over stdio, lists tools and resources, and calls a tool", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mp-stdio-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, "..", "run.mjs")],
    env: { ...process.env, DATA_DIR: dir, GIT_AUTOCOMMIT: "false" } as Record<string, string>,
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  expect(tools).toEqual(expect.arrayContaining(["search_recipes", "set_meal", "set_people", "generate_shopping_list", "import_recipe_from_url"]));
  const created: any = await client.callTool({ name: "create_recipe", arguments: { title: "Toast", ingredientsMd: "- 2 slices bread", methodMd: "1. Toast" } });
  expect(created.content[0].text).toContain("Created toast");
  const res = await client.readResource({ uri: "recipe://toast" });
  expect(String((res.contents[0] as { text: string }).text)).toContain("title: Toast");
  const bad: any = await client.callTool({ name: "get_recipe", arguments: { slug: "nope" } });
  expect(bad.isError).toBe(true);
  await client.close();
  await fs.rm(dir, { recursive: true, force: true });
}, 60000);
