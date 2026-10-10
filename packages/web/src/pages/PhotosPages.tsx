import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, usePhoto, usePhotos, useSettings, useStatus, type PhotoInfo } from "../api";
import { Progress, useJobProgress } from "../components/jobs";
import { PhotoPicker } from "../components/PhotoIntake";
import { Camera, ChevL, Edit, Plus, Sparkle, Trash } from "../icons";
import { Empty, ErrorBox, Loading, Spinner, errMsg, fmtDate, setReviewDraft, useConfirm, useToast } from "../ui";
import type { RecipeDraft } from "@mp/core/shared";

const thumb = (p: PhotoInfo) => `/api/photos/${p.id}/images/${p.images[0]}?w=480`;

function StatusChip({ p }: { p: PhotoInfo }) {
  if (p.status === "done") return <span className="chip green">Recipe made</span>;
  if (p.hasDraft) return <span className="chip blue">Read — check it</span>;
  return <span className="chip amber">Waiting</span>;
}

/** Everything saved from a photo that hasn't become a recipe yet, and what has. */
export function PhotosPage() {
  const { data, error, isLoading, refetch } = usePhotos();
  const [showDone, setShowDone] = useState(false);
  const photos = data?.photos ?? [];
  const waiting = photos.filter((p) => p.status === "waiting");
  const done = photos.filter((p) => p.status === "done");
  return (
    <>
      <div className="page-head">
        <h1>Saved photos</h1>
        <Link to="/import?tab=photo" className="btn primary">
          <Plus /> Add photos
        </Link>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Pictures of recipes waiting to be read — by the AI now or later, or typed in by you with the photo beside you.
      </p>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} retry={() => refetch()} />}
      {data && photos.length === 0 && (
        <Empty emoji="📷" title="No saved photos yet">
          <p>Take a photo of a cookbook page, or pick one from your gallery, and give it a name.</p>
          <Link className="btn primary" to="/import?tab=photo">
            Add a photo
          </Link>
        </Empty>
      )}
      {waiting.length > 0 && (
        <>
          <h2>Waiting ({waiting.length})</h2>
          <div className="cards">{waiting.map((p) => <PhotoCard key={p.id} p={p} />)}</div>
        </>
      )}
      {done.length > 0 && (
        <>
          <button className="btn ghost" style={{ alignSelf: "flex-start" }} onClick={() => setShowDone((s) => !s)}>
            {showDone ? "Hide" : "Show"} photos already made into recipes ({done.length})
          </button>
          {showDone && <div className="cards">{done.map((p) => <PhotoCard key={p.id} p={p} />)}</div>}
        </>
      )}
    </>
  );
}

function PhotoCard({ p }: { p: PhotoInfo }) {
  return (
    <Link className="rcard" to={`/photos/${p.id}`}>
      <div className="pic" style={{ aspectRatio: "3 / 4" }}>
        {p.images[0] ? <img loading="lazy" src={thumb(p)} alt="" /> : "📷"}
      </div>
      <div className="body">
        <div className="title">{p.name}</div>
        <div className="meta">
          <StatusChip p={p} />
          {p.images.length > 1 && <span>{p.images.length} pages</span>}
        </div>
        {p.book?.title && (
          <div className="meta">
            {p.book.title}
            {p.book.page ? `, p. ${p.book.page}` : ""}
          </div>
        )}
        {p.createdAt && <div className="tiny muted">Saved {fmtDate(p.createdAt.slice(0, 10))}</div>}
      </div>
    </Link>
  );
}

const MODEL_DEFAULT = "";

/** One saved photo: look at it, name it, read it (now, with a model you choose), or type it in yourself. */
export function PhotoPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const { data, error, isLoading, refetch } = usePhoto(id);
  const { data: status } = useStatus();
  const { data: settings } = useSettings();
  const { job, watch, reset } = useJobProgress();
  const [reading, setReading] = useState(false);
  const [model, setModel] = useState(MODEL_DEFAULT);
  const [name, setName] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [book, setBook] = useState<{ title: string; author: string; page: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const watching = useRef<string | null>(null);

  const photo = data?.photo;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["photo", id] });
    void qc.invalidateQueries({ queryKey: ["photos"] });
  };

  /** Follow a reading job until it finishes, then open the draft for checking. */
  const follow = async (jobId: string) => {
    if (watching.current === jobId) return;
    watching.current = jobId;
    setReading(true);
    reset();
    try {
      const done = await watch(jobId);
      setReviewDraft(done.result.draft as RecipeDraft);
      refresh();
      nav("/import/review");
    } catch (e) {
      toast(`Reading didn't work: ${errMsg(e)}`, "bad");
      setReading(false);
      refresh();
    }
  };

  // arriving from "Save and read it now" with ?job=…
  useEffect(() => {
    const j = params.get("job");
    if (j && photo) {
      setParams({}, { replace: true });
      void follow(j);
    }
  }, [params, photo]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <Loading />;
  if (error || !photo) return <ErrorBox error={error ?? new Error("Photo not found")} retry={() => refetch()} />;

  const nameVal = name ?? photo.name;
  const notesVal = notes ?? photo.notes;
  const bookVal = book ?? { title: photo.book?.title ?? "", author: photo.book?.author ?? "", page: String(photo.book?.page ?? "") };
  const dirty = nameVal !== photo.name || notesVal !== photo.notes || JSON.stringify(bookVal) !== JSON.stringify({ title: photo.book?.title ?? "", author: photo.book?.author ?? "", page: String(photo.book?.page ?? "") });

  const saveDetails = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/photos/${photo.id}`, {
        name: nameVal,
        notes: notesVal,
        book: bookVal.title || bookVal.author || bookVal.page ? { title: bookVal.title || null, author: bookVal.author || null, page: bookVal.page || null } : null,
      });
      setName(null);
      setNotes(null);
      setBook(null);
      refresh();
      toast("Saved");
    } catch (e) {
      toast(errMsg(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  const read = async () => {
    try {
      const body = model === "lightonocr" ? { provider: "lightonocr" } : model ? { provider: "ollama", model } : {};
      const { jobId } = await api.post<{ jobId: string }>(`/api/photos/${photo.id}/read`, body);
      void follow(jobId);
    } catch (e) {
      toast(errMsg(e), "bad");
    }
  };

  const openDraft = async () => {
    const r = await api.get<{ draft: RecipeDraft | null }>(`/api/photos/${photo.id}/draft`);
    if (!r.draft) return toast("That reading is gone — read it again", "bad");
    setReviewDraft(r.draft);
    nav("/import/review");
  };

  const typeItIn = async () => {
    try {
      const r = await api.post<{ draft: RecipeDraft }>(`/api/photos/${photo.id}/blank-draft`, {});
      setReviewDraft(r.draft);
      nav("/import/review");
    } catch (e) {
      toast(errMsg(e), "bad");
    }
  };

  const vision = status?.ollama.models.filter((m) => m.vision) ?? [];
  const current = settings ? (settings.extraction.provider === "lightonocr" ? `LightOnOCR + ${settings.extraction.textModel}` : settings.extraction.visionModel) : "…";

  return (
    <>
      <div className="row">
        <button className="btn ghost icon" onClick={() => nav("/photos")} aria-label="Back to saved photos">
          <ChevL />
        </button>
        <h1 className="grow" style={{ minWidth: 0 }}>
          {photo.name}
        </h1>
        <StatusChip p={{ ...photo, hasDraft: !!data.draft }} />
      </div>

      {reading && <Progress job={job} hint="Local models take a little while. You can leave this page open — or leave it and come back: the photo is already saved." />}

      <div className="card stack">
        <div className="stack tight">
          {photo.images.map((f, i) => (
            <figure key={f} style={{ margin: 0, position: "relative" }}>
              <a href={`/api/photos/${photo.id}/images/${f}`} target="_blank" rel="noreferrer">
                <img className="source-img" src={`/api/photos/${photo.id}/images/${f}?w=1100`} alt={`${photo.name}, page ${i + 1}`} style={{ width: "100%" }} />
              </a>
              {photo.images.length > 1 && (
                <button
                  className="btn icon sm"
                  style={{ position: "absolute", top: 8, right: 8 }}
                  aria-label={`Remove page ${i + 1}`}
                  onClick={async () => {
                    if (await confirm({ title: `Remove page ${i + 1}?`, confirmLabel: "Remove", danger: true })) {
                      await api.del(`/api/photos/${photo.id}/pages?file=${encodeURIComponent(f)}`).catch((e) => toast(errMsg(e), "bad"));
                      refresh();
                    }
                  }}
                >
                  <Trash />
                </button>
              )}
            </figure>
          ))}
        </div>
        <PhotoPicker
          compact
          onAdd={async (files) => {
            const form = new FormData();
            files.forEach((f) => form.append("files", f));
            try {
              await api.upload(`/api/photos/${photo.id}/pages`, form);
              refresh();
              toast("Page added");
            } catch (e) {
              toast(errMsg(e), "bad");
            }
          }}
        />
      </div>

      {photo.status === "done" ? (
        <div className="card stack tight">
          <b>✓ This became a recipe</b>
          <div className="row wrap">
            {photo.recipe && (
              <Link className="btn primary" to={`/recipes/${photo.recipe}`}>
                Open the recipe
              </Link>
            )}
            <button
              className="btn"
              onClick={async () => {
                await api.post(`/api/photos/${photo.id}/reopen`, {});
                refresh();
              }}
            >
              Use this photo again
            </button>
          </div>
        </div>
      ) : (
        <div className="card stack">
          <h2>Turn it into a recipe</h2>
          {data.draft && (
            <div className="notice">
              <div className="grow">
                <b>Already read</b> {fmtDate(data.draft.readAt.slice(0, 10))} with {data.draft.model ?? (data.draft.provider === "lightonocr" ? "LightOnOCR" : "your saved model")}: “{data.draft.title}”.
              </div>
              <button className="btn primary sm" onClick={openDraft}>
                Check it
              </button>
            </div>
          )}
          <div className="field">
            <label htmlFor="read-model">Read it with</label>
            <select id="read-model" className="input" value={model} onChange={(e) => setModel(e.target.value)} disabled={reading}>
              <option value={MODEL_DEFAULT}>My setting — {current}</option>
              {vision.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.sizeGb ? ` (${m.sizeGb} GB)` : ""}
                </option>
              ))}
              {status?.lightOnOcr && <option value="lightonocr">LightOnOCR, then my text model</option>}
            </select>
            <div className="hint">For this one reading only — your settings aren't changed. You can read the same photo again with another model whenever you like.</div>
          </div>
          <div className="row wrap">
            <button className="btn primary" disabled={reading || status?.ollama.ok === false} onClick={read}>
              {reading ? <Spinner /> : <Sparkle />} {data.draft ? "Read it again" : "Read it now"}
            </button>
            <button className="btn" disabled={reading} onClick={typeItIn}>
              <Edit /> I'll type it in
            </button>
          </div>
          {status?.ollama.ok === false && <div className="small muted">The local AI isn't running right now — you can still type it in, or come back later.</div>}
        </div>
      )}

      <div className="card stack">
        <h2>Details</h2>
        <div className="field">
          <label htmlFor="pn">Name</label>
          <input id="pn" className="input" value={nameVal} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid2">
          <div className="field">
            <label>Book title</label>
            <input className="input" value={bookVal.title} onChange={(e) => setBook({ ...bookVal, title: e.target.value })} />
          </div>
          <div className="field">
            <label>Author</label>
            <input className="input" value={bookVal.author} onChange={(e) => setBook({ ...bookVal, author: e.target.value })} />
          </div>
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Page</label>
          <input className="input" inputMode="numeric" value={bookVal.page} onChange={(e) => setBook({ ...bookVal, page: e.target.value })} />
        </div>
        <div className="field">
          <label>Notes</label>
          <textarea className="input" style={{ minHeight: 80 }} value={notesVal} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="row">
          <button className="btn primary" disabled={!dirty || busy} onClick={saveDetails}>
            Save details
          </button>
          <span className="grow" />
          <button
            className="btn danger"
            onClick={async () => {
              if (await confirm({ title: "Delete this photo?", message: "It moves to the .trash folder in your data folder.", confirmLabel: "Delete", danger: true })) {
                try {
                  await api.del(`/api/photos/${photo.id}`);
                } catch (e) {
                  return toast(errMsg(e), "bad");
                }
                // drop it from the list first and leave, so nothing asks the server for the deleted photo again
                qc.setQueryData<{ photos: PhotoInfo[] }>(["photos"], (old) => (old ? { photos: old.photos.filter((x) => x.id !== photo.id) } : old));
                nav("/photos", { replace: true });
                void qc.invalidateQueries({ queryKey: ["photos"] });
              }
            }}
          >
            <Trash /> Delete
          </button>
        </div>
      </div>
    </>
  );
}

export { Camera };
