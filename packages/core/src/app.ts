import { loadConfig, type AppConfig } from "./config";
import { Importer } from "./importer";
import { JobManager } from "./jobs";
import { OllamaClient } from "./ollama";
import { Planner } from "./planner";
import { RecipeSearch, type RecipeFilters, type SearchResult } from "./search";
import { DataStore } from "./store";
import { PoliteFetcher } from "./webfetch";

/** Everything the web server and the MCP server need, wired together. */
export interface App {
  cfg: AppConfig;
  store: DataStore;
  ollama: OllamaClient;
  fetcher: PoliteFetcher;
  jobs: JobManager;
  importer: Importer;
  planner: Planner;
  searchRecipes: (filters?: RecipeFilters) => SearchResult;
  close: () => Promise<void>;
}

export async function createApp(overrides: Partial<AppConfig> = {}): Promise<App> {
  const cfg = loadConfig(overrides);
  const store = new DataStore(cfg);
  store.on("warning", (m) => console.warn(`[data] ${m}`));
  await store.init();
  // the address set on the Settings page wins over OLLAMA_URL in .env
  const ollama = new OllamaClient(() => store.getSettings().ollamaUrl || cfg.ollamaUrl);
  const fetcher = new PoliteFetcher(cfg);
  const jobs = new JobManager();
  const importer = new Importer(store, ollama, fetcher, jobs);
  const planner = new Planner(store);
  const search = new RecipeSearch();
  return {
    cfg,
    store,
    ollama,
    fetcher,
    jobs,
    importer,
    planner,
    searchRecipes: (filters = {}) => search.search(store.listRecipes(), store.version, filters),
    close: () => store.close(),
  };
}
