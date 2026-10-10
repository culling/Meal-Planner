import crypto from "node:crypto";

export interface JobInfo {
  id: string;
  label: string;
  status: "running" | "done" | "error";
  progress: string[];
  result: unknown;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface JobContext {
  progress: (msg: string) => void;
}

/** Long tasks (AI calls, bulk imports) run in the background and are polled for progress. */
export class JobManager {
  private jobs = new Map<string, JobInfo>();

  start<T>(label: string, runner: (ctx: JobContext) => Promise<T>): JobInfo {
    this.prune();
    const job: JobInfo = {
      id: crypto.randomBytes(6).toString("hex"),
      label,
      status: "running",
      progress: [],
      result: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    runner({
      progress: (m) => {
        job.progress.push(m);
        if (job.progress.length > 200) job.progress.shift();
      },
    }).then(
      (result) => {
        job.result = result;
        job.status = "done";
        job.finishedAt = Date.now();
      },
      (e: unknown) => {
        job.error = e instanceof Error ? e.message : String(e);
        job.status = "error";
        job.finishedAt = Date.now();
      },
    );
    return job;
  }

  get(id: string): JobInfo | undefined {
    return this.jobs.get(id);
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  private prune() {
    const cutoff = Date.now() - 3 * 3600_000;
    for (const [id, j] of this.jobs) if (j.finishedAt && j.finishedAt < cutoff) this.jobs.delete(id);
  }
}
