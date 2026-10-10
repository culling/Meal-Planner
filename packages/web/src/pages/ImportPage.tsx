import type { RecipeDraft } from "@mp/core/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, usePhotos } from "../api";
import { Camera, Link as LinkIcon } from "../icons";
import { Progress, useJobProgress } from "../components/jobs";
import { PhotoIntake } from "../components/PhotoIntake";
import { Seg, Spinner, errMsg, setReviewDraft, useToast } from "../ui";

type Tab = "link" | "links" | "photo";

export function ImportPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "photo" ? "photo" : params.get("tab") === "links" ? "links" : "link";
  const setTab = (t: Tab) => setParams(t === "link" ? {} : { tab: t }, { replace: true });
  const { data: photos } = usePhotos();
  const waiting = photos?.photos.filter((p) => p.status === "waiting").length ?? 0;
  return (
    <>
      <div className="page-head">
        <h1>Add a recipe</h1>
        <Link to="/new" className="btn">
          Type it in
        </Link>
      </div>
      <Seg
        fill
        value={tab}
        options={[
          { value: "link", label: "From a link" },
          { value: "links", label: "Several links" },
          { value: "photo", label: "From photos" },
        ]}
        onChange={setTab}
      />
      {tab === "link" && <FromLink />}
      {tab === "links" && <FromLinks />}
      {tab === "photo" && <PhotoIntake />}
      {waiting > 0 && (
        <Link to="/photos" className="card flat row" style={{ color: "inherit", textDecoration: "none" }}>
          <Camera style={{ width: 22, height: 22, color: "var(--primary)" }} />
          <span className="grow">
            <b>
              {waiting} saved photo{waiting === 1 ? "" : "s"}
            </b>{" "}
            waiting to be turned into recipes
          </span>
          <span className="small muted">Open →</span>
        </Link>
      )}
      <p className="small muted center">
        Recipes are for your own private use. The original source is saved with each one. Only the links you paste are fetched, politely (one request every couple of seconds), and sites that ask not to be fetched are skipped.
      </p>
    </>
  );
}

function FromLink() {
  const nav = useNavigate();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [dup, setDup] = useState<string | null>(null);
  const go = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setDup(null);
    try {
      const res = await api.post<{ draft: RecipeDraft; duplicateOf: string | null }>("/api/import/url", { url: url.trim() });
      setReviewDraft(res.draft);
      if (res.duplicateOf) setDup(res.duplicateOf);
      nav("/import/review");
    } catch (e) {
      toast(errMsg(e), "bad");
      setBusy(false);
    }
  };
  return (
    <div className="card stack">
      <div className="field">
        <label>Paste the recipe's web address</label>
        <input className="input" type="url" inputMode="url" placeholder="https://www.recipetineats.com/butter-chicken/" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} autoFocus />
      </div>
      <button className="btn primary block" disabled={busy || !url.trim()} onClick={go}>
        {busy ? (
          <>
            <Spinner /> Fetching…
          </>
        ) : (
          <>
            <LinkIcon /> Get recipe
          </>
        )}
      </button>
      {dup && <div className="notice warn">Already in your collection.</div>}
      <p className="small muted">You'll get to check everything before it's saved.</p>
    </div>
  );
}

function FromLinks() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [direct, setDirect] = useState(false);
  const { job, watch, reset } = useJobProgress();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<{ url: string; status: string; message?: string; slug?: string; draft?: RecipeDraft }[] | null>(null);
  const toast = useToast();
  const urls = text.split(/[\s,]+/).filter((u) => /^https?:\/\//i.test(u));

  const go = async () => {
    setRunning(true);
    setResults(null);
    reset();
    try {
      const { jobId } = await api.post<{ jobId: string }>("/api/import/urls", { urls, saveDirectly: direct });
      const done = await watch(jobId);
      setResults(done.result.results);
      await qc.invalidateQueries();
    } catch (e) {
      toast(errMsg(e), "bad");
    } finally {
      setRunning(false);
    }
  };

  const counts = results ? ["saved", "draft", "skipped", "failed"].map((s) => [s, results.filter((r) => r.status === s).length] as const) : [];
  return (
    <div className="stack">
      <div className="card stack">
        <div className="field">
          <label>Paste several links, one per line</label>
          <textarea className="input mono" style={{ minHeight: 150 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={"https://www.recipetineats.com/butter-chicken/\nhttps://www.recipetineats.com/beef-stew/"} spellCheck={false} />
          <div className="hint">{urls.length} link{urls.length === 1 ? "" : "s"} found. They're fetched one at a time with a short pause; ones you already have are skipped.</div>
        </div>
        <label className="check">
          <input type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} />
          Save them straight away (otherwise you check each one first)
        </label>
        <button className="btn primary block" disabled={running || !urls.length} onClick={go}>
          Get {urls.length || ""} recipe{urls.length === 1 ? "" : "s"}
        </button>
      </div>
      {running && <Progress job={job} />}
      {results && (
        <div className="card stack">
          <h3>Done</h3>
          <div className="chips">
            {counts.filter(([, n]) => n > 0).map(([s, n]) => (
              <span key={s} className={`chip ${s === "failed" ? "red" : s === "skipped" ? "amber" : "green"}`}>
                {n} {s === "draft" ? "ready to check" : s}
              </span>
            ))}
          </div>
          <div className="stack tight">
            {results.map((r, i) => (
              <div className="row between" key={i} style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>{r.message ?? r.url}</div>
                  <div className="tiny muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.status === "failed" ? "Failed — " : ""}
                    {r.url}
                  </div>
                </div>
                {r.status === "draft" && r.draft && (
                  <button
                    className="btn sm primary"
                    onClick={() => {
                      setReviewDraft(r.draft!);
                      nav("/import/review");
                    }}
                  >
                    Check
                  </button>
                )}
                {(r.status === "saved" || r.status === "skipped") && r.slug && (
                  <Link className="btn sm" to={`/recipes/${r.slug}`}>
                    Open
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
