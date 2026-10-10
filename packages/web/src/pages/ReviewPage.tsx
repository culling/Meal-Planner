import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { NUTRIENT_KEYS } from "@mp/core/shared";
import { api, usePhoto, useStatus } from "../api";
import { RecipeForm, SaveBar, WarningList, formFromDraft, formToDraft, type FormState } from "../components/RecipeForm";
import { ChevL } from "../icons";
import { Empty, errMsg, getReviewDraft, setReviewDraft, useToast, useTrackJob } from "../ui";

export function ReviewPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const track = useTrackJob();
  const { data: status } = useStatus();
  const draft = useMemo(() => getReviewDraft(), []);
  // a draft that came from a saved photo shows that photo's pages beside the form
  const { data: photoState } = usePhoto(draft?.photoId ?? undefined);
  const [form, setForm] = useState<FormState | null>(() => (draft ? formFromDraft(draft) : null));
  const [calc, setCalc] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"original" | "extracted">("extracted");

  if (!draft || !form) {
    return (
      <Empty emoji="📭" title="Nothing to review">
        <Link className="btn primary" to="/import">
          Add a recipe
        </Link>
      </Empty>
    );
  }

  const images = draft.uploadedImages;
  const hasNutrition = form.nutrition && NUTRIENT_KEYS.some((k) => form.nutrition!.perServing[k] != null);
  const sourceImages = images.filter((i) => i.kind === "source-page");
  const photoPages = photoState?.photo.images ?? [];
  const hero = images.find((i) => i.kind === "hero");

  const save = async () => {
    if (!form.title.trim()) return toast("The recipe needs a title", "bad");
    setBusy(true);
    try {
      const res = await api.post<{ slug: string; jobId: string | null }>("/api/import/confirm", {
        draft: formToDraft(form, draft),
        calculateNutrition: calc && !hasNutrition && status?.ollama.ok !== false,
      });
      setReviewDraft(null);
      await qc.invalidateQueries();
      if (res.jobId) track(res.jobId, { label: "Working out nutrition" });
      toast("Recipe saved");
      nav(`/recipes/${res.slug}`, { replace: true });
    } catch (e) {
      toast(errMsg(e), "bad");
      setBusy(false);
    }
  };

  const preview = (
    <div className="stack sticky">
      {hero && draft.uploadId && <img className="source-img" src={`/api/uploads/${draft.uploadId}/${hero.file}`} alt="Recipe photo" style={{ aspectRatio: "16/9", objectFit: "cover", width: "100%" }} />}
      {photoPages.map((file, i) => (
        <a key={file} href={`/api/photos/${draft.photoId}/images/${file}`} target="_blank" rel="noreferrer">
          <img className="source-img" src={`/api/photos/${draft.photoId}/images/${file}?w=1100`} alt={`Photo page ${i + 1}`} style={{ width: "100%" }} />
        </a>
      ))}
      {sourceImages.map((img, i) => (
        <a key={img.file} href={`/api/uploads/${draft.uploadId}/${img.file}`} target="_blank" rel="noreferrer">
          <img className="source-img" src={`/api/uploads/${draft.uploadId}/${img.file}`} alt={`Book page ${i + 1}`} style={{ width: "100%" }} />
        </a>
      ))}
      {draft.source.url && (
        <a className="small" href={draft.source.url} target="_blank" rel="noreferrer">
          Open the original page ↗
        </a>
      )}
    </div>
  );

  return (
    <>
      <div className="page-head">
        <button className="btn ghost icon" onClick={() => nav(-1)} aria-label="Back">
          <ChevL />
        </button>
        <h1>Check the recipe</h1>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>
        Nothing is saved until you press Save. Anything outlined in orange was hard to read — please check it.
      </p>
      <WarningList warnings={draft.warnings} />

      {sourceImages.length > 0 || photoPages.length > 0 || hero ? (
        <>
          {(sourceImages.length > 0 || photoPages.length > 0) && (
            <div className="seg fill wide-hide">
              <button className={tab === "extracted" ? "on" : ""} onClick={() => setTab("extracted")}>
                What was read
              </button>
              <button className={tab === "original" ? "on" : ""} onClick={() => setTab("original")}>
                Original photo
              </button>
            </div>
          )}
          <div className="split">
            <div className={tab === "original" ? "" : "narrow-hide"}>{preview}</div>
            <div className={tab === "extracted" ? "" : "narrow-hide"}>
              <RecipeForm mode="review" value={form} onChange={setForm} confidence={draft.confidence} />
            </div>
          </div>
        </>
      ) : (
        <RecipeForm mode="review" value={form} onChange={setForm} confidence={draft.confidence} />
      )}

      {!hasNutrition && (
        <label className="check card flat">
          <input type="checkbox" checked={calc} onChange={(e) => setCalc(e.target.checked)} />
          <span>
            Work out nutrition from the ingredients after saving
            <span className="small muted" style={{ display: "block" }}>
              The local AI fills in calories and nutrients. Each ingredient it guessed is marked with <b>?</b> until you check it.
            </span>
          </span>
        </label>
      )}

      <SaveBar>
        <button
          className="btn"
          onClick={() => {
            const back = draft.photoId ? `/photos/${draft.photoId}` : "/import";
            setReviewDraft(null);
            nav(back);
          }}
        >
          Discard
        </button>
        <button className="btn primary grow" disabled={busy} onClick={save}>
          Save recipe
        </button>
      </SaveBar>
    </>
  );
}
