import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(dir: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve({ stdout: String(stdout ?? ""), code: err ? ((err as any).code as number) || 1 : 0 });
    });
  });
}

const IGNORE = [".cache/", ".trash/", "*.tmp", ""].join("\n");

/**
 * Keeps the data folder in its own git repository and commits changes shortly after they happen,
 * giving a full version history of recipes and plans. Failures never break the app.
 */
export class DataGit {
  private timer: NodeJS.Timeout | null = null;
  private reasons = new Set<string>();
  private running: Promise<void> = Promise.resolve();
  ready = false;

  constructor(
    private dir: string,
    private enabled: boolean,
    private debounceMs = 4000,
  ) {}

  async init(): Promise<void> {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const probe = await git(this.dir, ["--version"]);
      if (probe.code !== 0) {
        this.enabled = false;
        return;
      }
      if (!fs.existsSync(path.join(this.dir, ".git"))) {
        await git(this.dir, ["init", "-b", "main"]);
        await git(this.dir, ["config", "core.autocrlf", "false"]);
        const name = await git(this.dir, ["config", "user.name"]);
        if (!name.stdout.trim()) await git(this.dir, ["config", "user.name", "Meal Planner"]);
        const email = await git(this.dir, ["config", "user.email"]);
        if (!email.stdout.trim()) await git(this.dir, ["config", "user.email", "mealplanner@localhost"]);
      }
      const ignorePath = path.join(this.dir, ".gitignore");
      if (!fs.existsSync(ignorePath)) fs.writeFileSync(ignorePath, IGNORE);
      this.ready = true;
      await this.commitNow("Initial snapshot");
    } catch {
      this.enabled = false;
    }
  }

  /** Queue a commit; several changes in quick succession become one commit. */
  schedule(reason: string): void {
    if (!this.enabled || !this.ready) return;
    this.reasons.add(reason);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.commitNow();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async commitNow(reason?: string): Promise<void> {
    if (!this.enabled || !this.ready) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (reason) this.reasons.add(reason);
    const list = [...this.reasons];
    this.reasons.clear();
    this.running = this.running.then(async () => {
      try {
        await git(this.dir, ["add", "-A"]);
        const diff = await git(this.dir, ["diff", "--cached", "--quiet"]);
        if (diff.code === 0) return; // nothing changed
        const subject = list.length === 0 ? "Update data" : list.length <= 3 ? list.join("; ") : `${list.slice(0, 3).join("; ")} (+${list.length - 3} more)`;
        await git(this.dir, ["commit", "-m", subject.slice(0, 200), "--quiet"]);
      } catch {
        /* a stale index.lock from another process: the next change will retry */
      }
    });
    await this.running;
  }

  /** Recent history, newest first. Optionally limited to one path. */
  async log(limit = 30, relPath?: string): Promise<{ hash: string; date: string; message: string }[]> {
    if (!this.ready) return [];
    const args = ["log", `-n${limit}`, "--pretty=format:%h\t%aI\t%s"];
    if (relPath) args.push("--", relPath);
    const r = await git(this.dir, args);
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, date, ...rest] = l.split("\t");
        return { hash, date, message: rest.join("\t") };
      });
  }

  async show(hash: string, relPath: string): Promise<string | null> {
    if (!this.ready || !/^[0-9a-f]{4,40}$/.test(hash)) return null;
    const r = await git(this.dir, ["show", `${hash}:${relPath.replace(/\\/g, "/")}`]);
    return r.code === 0 ? r.stdout : null;
  }
}
