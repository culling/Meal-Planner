import { useEffect, useRef, useState } from "react";
import { api, type JobInfo } from "../api";
import { Spinner } from "../ui";

/** Polls a job until it finishes, showing the progress lines. */
export function useJobProgress() {
  const [job, setJob] = useState<JobInfo | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);
  const watch = (jobId: string) =>
    new Promise<JobInfo>((resolve, reject) => {
      const tick = async () => {
        try {
          const info = await api.get<JobInfo>(`/api/jobs/${jobId}`);
          setJob(info);
          if (info.status !== "running") {
            if (timer.current) clearInterval(timer.current);
            if (info.status === "error") reject(new Error(info.error ?? "Failed"));
            else resolve(info);
          }
        } catch (e) {
          if (timer.current) clearInterval(timer.current);
          reject(e);
        }
      };
      void tick();
      timer.current = setInterval(tick, 1200);
    });
  return { job, watch, reset: () => setJob(null) };
}

export function Progress({ job, hint }: { job: JobInfo | null; hint?: string }) {
  return (
    <div className="card stack tight">
      <div className="row">
        <Spinner />
        <b>{job?.label ?? "Starting…"}</b>
      </div>
      {hint && <div className="small muted">{hint}</div>}
      {job && job.progress.length > 0 && (
        <div className="progress-list">
          {job.progress.map((p, i) => (
            <div key={i}>{p}</div>
          ))}
        </div>
      )}
    </div>
  );
}

