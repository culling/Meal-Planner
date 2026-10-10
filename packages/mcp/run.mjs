// Launcher for MCP clients (Claude Desktop / Claude Code): node packages/mcp/run.mjs
// Plain `node` so nothing else writes to stdout, which is the protocol channel.
import { register } from "tsx/esm/api";
register();
await import("./src/index.ts");
