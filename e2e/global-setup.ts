import fs from "node:fs";
import path from "node:path";

// Start each run with an empty screenshots folder so stale images from an earlier run can't be mistaken for new ones.
export default function globalSetup() {
  fs.rmSync(path.resolve(import.meta.dirname, "..", ".e2e", "screenshots"), { recursive: true, force: true });
}
