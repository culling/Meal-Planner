// Starts a throwaway copy of the app for the end-to-end tests.
//   node scripts/e2e-server.mjs <port> <data-dir> [--seed]
// The data folder is wiped first, so it never touches ./data. With --seed it is filled with demo recipes.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const [port, dirArg, ...flags] = process.argv.slice(2);
const dir = path.resolve(root, dirArg);
if (path.resolve(root, "data") === dir) throw new Error("Refusing to use the real data folder for tests");

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
if (flags.includes("--seed")) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/seed-demo.mts", dir, "--fake-ai"], { cwd: path.join(root, "packages", "core"), stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "packages", "server", "src", "index.ts")], {
  cwd: path.join(root, "packages", "server"),
  stdio: "inherit",
  env: { ...process.env, PORT: port, DATA_DIR: dir, GIT_AUTOCOMMIT: "false", HOST: "127.0.0.1" },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill());
