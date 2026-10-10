// `npm run start` (or `pnpm start`): builds the web app if it's missing or out of date, then starts the server.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ensureBuilt } from "./ensure-built.mjs";

const root = path.resolve(import.meta.dirname, "..");
ensureBuilt(root);

const server = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "packages", "server", "src", "index.ts")], { cwd: path.join(root, "packages", "server"), stdio: "inherit" });
process.exit(server.status ?? 0);
