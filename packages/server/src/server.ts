import fs from "node:fs";
import path from "node:path";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { repoRoot, type App } from "@mp/core";
import { registerOtherRoutes } from "./routes-other";
import { registerPhotoRoutes } from "./routes-photos";
import { registerRecipeRoutes } from "./routes-recipes";
import { installErrorHandler } from "./util";

export async function buildServer(app: App, opts: { logger?: boolean; webDir?: string } = {}): Promise<FastifyInstance> {
  const server = Fastify({ logger: opts.logger ? { level: "warn" } : false, bodyLimit: 20 * 1024 * 1024 });
  installErrorHandler(server);
  await server.register(fastifyMultipart, { limits: { fileSize: 40 * 1024 * 1024, files: 16 } });

  registerRecipeRoutes(server, app);
  registerOtherRoutes(server, app);
  registerPhotoRoutes(server, app);

  // the built web UI (pnpm build) is served from the same port so a phone only needs one address
  const webDir = opts.webDir ?? path.join(repoRoot(), "packages", "web", "dist");
  if (fs.existsSync(path.join(webDir, "index.html"))) {
    await server.register(fastifyStatic, { root: webDir, wildcard: false, setHeaders: (res, file) => {
      if (/\/assets\//.test(file.replace(/\\/g, "/"))) res.setHeader("cache-control", "public, max-age=31536000, immutable");
      else res.setHeader("cache-control", "no-cache");
    } });
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/images/")) return reply.status(404).send({ error: "Not found" });
      return reply.type("text/html").header("cache-control", "no-cache").send(fs.createReadStream(path.join(webDir, "index.html")));
    });
  } else {
    server.get("/", async (_req, reply) =>
      reply.type("text/html").send("<h1>Meal Planner</h1><p>The web app hasn't been built yet. Run <code>pnpm build</code>, or use <code>pnpm dev</code> and open the Vite address.</p>"),
    );
  }
  return server;
}
