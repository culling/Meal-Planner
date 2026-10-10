import os from "node:os";
import { createApp } from "@mp/core";
import { buildServer } from "./server";

const app = await createApp();
const server = await buildServer(app, { logger: true });

try {
  await server.listen({ port: app.cfg.port, host: app.cfg.host });
} catch (e) {
  console.error(`\nCouldn't start on port ${app.cfg.port}: ${(e as Error).message}`);
  console.error("Is the app already running? Change PORT in .env to use another port.");
  process.exit(1);
}

const lan = Object.values(os.networkInterfaces())
  .flat()
  .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal)
  .map((i) => i.address);

console.log("\n  Meal Planner is running\n");
console.log(`  On this computer:  http://localhost:${app.cfg.port}`);
for (const ip of lan) console.log(`  On your phone:     http://${ip}:${app.cfg.port}   (same Wi-Fi)`);
console.log(`\n  Data folder:       ${app.cfg.dataDir}`);
console.log(`  Recipes loaded:    ${app.store.listRecipes().length}`);
console.log(`  Version history:   ${app.store.git.ready ? "on (auto-commits to the data folder's own git repo)" : "off"}\n`);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`
Stopping (received ${signal}) — saving…`);
  await server.close();
  await app.close();
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) process.on(sig, () => void shutdown(sig));
process.on("uncaughtException", (e) => console.error("Unexpected error:", e));
process.on("unhandledRejection", (e) => console.error("Unexpected error:", e));
