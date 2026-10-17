import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type JobInfo } from "./api";
import { Check, Dots, X } from "./icons";

// ---------- small helpers ----------

export function fmtMinutes(m: number | null | undefined): string {
  if (m == null) return "—";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null) return "—";
  return n.toLocaleString("en-NZ", { maximumFractionDigits: digits });
}

export function fmtDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" });
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- toasts ----------

type ToastKind = "ok" | "bad";
interface ToastAction { label: string; onClick: () => void }
interface ToastItem { id: number; msg: string; kind: ToastKind; actions?: ToastAction[] }
/** toast("Saved"), or toast("Moved", "ok", { actions: [{ label: "Undo", onClick }] }) */
type ToastFn = (msg: string, kind?: ToastKind, opts?: { actions?: ToastAction[]; ms?: number }) => void;
const ToastCtx = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastCtx);

// ---------- confirm dialog ----------

interface ConfirmOpts { title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean }
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

// ---------- background jobs ----------

interface TrackOpts { label: string; onDone?: (result: any) => void; quiet?: boolean }
const JobsCtx = createContext<(jobId: string, opts: TrackOpts) => void>(() => {});
export const useTrackJob = () => useContext(JobsCtx);

interface Tracked { id: string; opts: TrackOpts; info: JobInfo | null }

export function Providers({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const toast = useCallback<ToastFn>((msg, kind = "ok", opts) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, msg, kind, actions: opts?.actions }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts?.ms ?? (opts?.actions ? 9000 : kind === "bad" ? 7000 : 3200));
  }, []);

  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...o, resolve })), []);

  const [jobs, setJobs] = useState<Tracked[]>([]);
  const track = useCallback((id: string, opts: TrackOpts) => setJobs((j) => [...j, { id, opts, info: null }]), []);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(() => {
    if (!jobs.length) return;
    const timer = setInterval(async () => {
      for (const t of jobsRef.current) {
        try {
          const info = await api.get<JobInfo>(`/api/jobs/${t.id}`);
          setJobs((all) => all.map((x) => (x.id === t.id ? { ...x, info } : x)));
          if (info.status !== "running") {
            setJobs((all) => all.filter((x) => x.id !== t.id));
            void qc.invalidateQueries();
            if (info.status === "error") toast(`${t.opts.label} failed: ${info.error}`, "bad");
            else {
              if (!t.opts.quiet) toast(`${t.opts.label} — done`);
              t.opts.onDone?.(info.result);
            }
          }
        } catch {
          /* server busy; try again next tick */
        }
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [jobs.length > 0, qc, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  // pages refresh themselves when a file changes (in the app on another device, or in a text editor)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource("/api/events");
    es.onmessage = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void qc.invalidateQueries(), 400);
    };
    return () => {
      es.close();
      if (timer) clearTimeout(timer);
    };
  }, [qc]);

  return (
    <ToastCtx.Provider value={toast}>
      <ConfirmCtx.Provider value={confirm}>
        <JobsCtx.Provider value={track}>
          {children}
          <div className="jobs">
            {jobs.map((j) => (
              <div className="job" key={j.id}>
                <div className="spinner" />
                <div className="grow">
                  <div style={{ fontWeight: 700 }}>{j.opts.label}</div>
                  <div className="small muted">{j.info?.progress.at(-1) ?? "Working…"}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="toasts">
            {toasts.map((t) => (
              <div key={t.id} className={`toast ${t.kind === "bad" ? "bad" : ""}`} role={t.kind === "bad" ? "alert" : "status"}>
                <span>{t.msg}</span>
                {t.actions?.map((a) => (
                  <button
                    key={a.label}
                    className="toast-action"
                    onClick={() => {
                      setToasts((all) => all.filter((x) => x.id !== t.id));
                      a.onClick();
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
          {confirmState && (
            <Modal
              title={confirmState.title}
              onClose={() => {
                confirmState.resolve(false);
                setConfirmState(null);
              }}
            >
              {confirmState.message && <div style={{ marginBottom: 16 }}>{confirmState.message}</div>}
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button
                  className="btn"
                  onClick={() => {
                    confirmState.resolve(false);
                    setConfirmState(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className={`btn primary ${confirmState.danger ? "danger" : ""}`}
                  onClick={() => {
                    confirmState.resolve(true);
                    setConfirmState(null);
                  }}
                >
                  {confirmState.confirmLabel ?? "OK"}
                </button>
              </div>
            </Modal>
          )}
        </JobsCtx.Provider>
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  );
}

// ---------- building blocks ----------

// Count open modals rather than saving/restoring body.overflow per modal: nested modals that close out of order
// (or unmount together on navigation) would otherwise leave the page stuck with scrolling turned off.
let openModals = 0;

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    openModals++;
    document.body.style.overflow = "hidden";
    return () => {
      if (--openModals === 0) document.body.style.overflow = "";
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Spinner({ large }: { large?: boolean }) {
  return <div className={`spinner ${large ? "lg" : ""}`} role="status" aria-label="Loading" />;
}

export function Loading({ label }: { label?: string }) {
  return (
    <div className="loading" style={{ flexDirection: "column", alignItems: "center", gap: 12 }}>
      <Spinner large />
      {label && <div className="muted">{label}</div>}
    </div>
  );
}

export function Empty({ emoji, title, children }: { emoji: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{emoji}</div>
      <h3 style={{ marginBottom: 6, color: "var(--ink)" }}>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="notice bad">
      <div className="grow">
        <b>That didn't work.</b> {errMsg(error)}
      </div>
      {retry && (
        <button className="btn sm" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** Orange "?" shown on any number an AI model filled in that nobody has checked yet. */
export function AiMark({ small, title }: { small?: boolean; title?: string }) {
  return (
    <span className={`ai-mark ${small ? "sm" : ""}`} title={title ?? "Filled in by an AI model and not checked yet. Edit it to confirm."} aria-label="AI estimate, unchecked">
      ?
    </span>
  );
}

export function Stepper({ value, onChange, min = 0, max = 99, step = 1, small, ariaLabel }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; small?: boolean; ariaLabel?: string }) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className={`stepper ${small ? "sm" : ""}`}>
      <button type="button" onClick={() => onChange(clamp(value - step))} disabled={value <= min} aria-label="Decrease">
        −
      </button>
      <input
        inputMode="decimal"
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value.replace(",", "."));
          if (Number.isFinite(n)) onChange(clamp(n));
        }}
      />
      <button type="button" onClick={() => onChange(clamp(value + step))} disabled={value >= max} aria-label="Increase">
        +
      </button>
    </div>
  );
}

/** A number box that allows "empty" (null). */
export function NumField({ label, value, onChange, hint, unit, placeholder, step }: { label: string; value: number | null | undefined; onChange: (n: number | null) => void; hint?: string; unit?: string; placeholder?: string; step?: string }) {
  return (
    <div className="field">
      <label>
        {label}
        {unit ? ` (${unit})` : ""}
      </label>
      <input
        className="input"
        type="number"
        inputMode="decimal"
        step={step ?? "any"}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, fill }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; fill?: boolean }) {
  return (
    <div className={`seg ${fill ? "fill" : ""}`} role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TagInput({ value, onChange, placeholder, suggestions }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[] }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const parts = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    setDraft("");
  };
  const listId = useMemo(() => `dl-${Math.random().toString(36).slice(2)}`, []);
  return (
    <div className="stack tight">
      {value.length > 0 && (
        <div className="chips">
          {value.map((t) => (
            <span className="chip" key={t}>
              {t}
              <button type="button" className="btn icon ghost sm" style={{ width: 22, minHeight: 22, padding: 0 }} onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
                <X style={{ width: 14, height: 14 }} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className="input"
        value={draft}
        list={listId}
        placeholder={placeholder ?? "Type and press Enter"}
        onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => draft.trim() && add(draft)}
      />
      {suggestions && <datalist id={listId}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>}
    </div>
  );
}

export function Menu({ children, label = "More" }: { children: (close: () => void) => ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="btn icon" onClick={() => setOpen((o) => !o)} aria-label={label} aria-expanded={open}>
        <Dots />
      </button>
      {open && <div className="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function CheckBox({ on }: { on: boolean }) {
  return <span className="box">{on && <Check />}</span>;
}

export function SourceBadge({ source }: { source: string | null | undefined }) {
  if (!source) return null;
  const map: Record<string, { label: string; cls: string; tip: string }> = {
    page: { label: "From the recipe", cls: "green", tip: "Taken from the original recipe page." },
    ocr: { label: "From the photo", cls: "blue", tip: "Read from the photo of the book page." },
    calculated: { label: "Calculated estimate", cls: "amber", tip: "Worked out from the ingredients. Real values can differ by 15–25%." },
    estimated: { label: "Estimate", cls: "amber", tip: "A default guess, not from the recipe." },
    manual: { label: "Entered by hand", cls: "green", tip: "Typed or confirmed by a person." },
  };
  const m = map[source] ?? { label: source, cls: "", tip: "" };
  return (
    <span className={`badge ${m.cls}`} title={m.tip}>
      {m.label}
    </span>
  );
}

// ---------- import draft hand-over (survives a page refresh on the review screen) ----------

import type { RecipeDraft } from "@mp/core/shared";
const DRAFT_KEY = "mp-draft";
let memoryDraft: RecipeDraft | null = null;
export function setReviewDraft(d: RecipeDraft | null) {
  memoryDraft = d;
  try {
    if (d) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage can be unavailable in private windows */
  }
}
export function getReviewDraft(): RecipeDraft | null {
  if (memoryDraft) return memoryDraft;
  try {
    const s = sessionStorage.getItem(DRAFT_KEY);
    if (s) return (memoryDraft = JSON.parse(s));
  } catch {
    /* ignore */
  }
  return null;
}
