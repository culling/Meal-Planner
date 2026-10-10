import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config";
import { DataStore } from "../src/store";

/** A store in a fresh temp folder, with git and file watching off unless asked for. */
export async function tempStore(opts: { watch?: boolean; git?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mp-test-"));
  const cfg = loadConfig({ dataDir: dir, gitAutocommit: opts.git ?? false, watch: opts.watch ?? false });
  const store = new DataStore(cfg);
  await store.init();
  return {
    store,
    dir,
    cleanup: async () => {
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
