import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  /** Folder holding recipes/, meal-plans/ etc. Separate from the code; has its own git repo. */
  dataDir: string;
  ollamaUrl: string;
  /** Checkout of the LightOnOCR tool (contains ocr.py), or null if not available */
  lightOnOcrDir: string | null;
  gitAutocommit: boolean;
  watch: boolean;
  port: number;
  host: string;
  /** minimum gap between requests to one website, in ms */
  fetchDelayMs: number;
  userAgent: string;
}

/** The folder that contains pnpm-workspace.yaml (the repo root). */
export function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

let envLoaded = false;
function loadDotEnv(root: string) {
  if (envLoaded) return;
  envLoaded = true;
  const file = path.join(root, ".env");
  if (fs.existsSync(file)) {
    try {
      process.loadEnvFile(file); // does not override variables already set
    } catch {
      /* ignore a malformed .env */
    }
  }
}

/** Build config from environment variables (and .env). Anything in `overrides` wins. */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const root = repoRoot();
  loadDotEnv(root);
  const env = process.env;
  const dataDirRaw = env.DATA_DIR?.trim() || "./data";
  const ocrDir = env.LIGHTONOCR_DIR?.trim();
  const cfg: AppConfig = {
    dataDir: path.resolve(root, dataDirRaw),
    ollamaUrl: (env.OLLAMA_URL?.trim() || "http://localhost:11434").replace(/\/$/, ""),
    lightOnOcrDir: ocrDir ? path.resolve(root, ocrDir) : null,
    gitAutocommit: (env.GIT_AUTOCOMMIT ?? "true").toLowerCase() !== "false",
    watch: true,
    port: Number(env.PORT) || 3456,
    host: env.HOST?.trim() || "0.0.0.0",
    fetchDelayMs: 2000,
    userAgent: "PersonalMealPlanner/0.1 (single-user home app; imports only URLs the user supplies)",
    ...overrides,
  };
  cfg.dataDir = path.resolve(cfg.dataDir);
  return cfg;
}
