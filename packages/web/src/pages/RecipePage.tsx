import { formatIngredient, todayYmd, type GalleryItem } from "@mp/core/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, useRecipe, type RecipeFull } from "../api";
import { NutritionPanel } from "../components/NutritionPanel";
import { AddToPlanModal, CookedModal, HistoryModal, LeftoversModal, RawModal, RenameModal, Stars } from "../components/RecipeModals";
import { Calendar, Camera, ChevL, Clock, Copy, Edit, EyeOff, Fridge, Heart, History, Image as ImageIcon, Snow, Trash, Users, Utensils } from "../icons";
import { CheckBox, ErrorBox, fmtDate, fmtMinutes, Loading, Menu, SourceBadge, Stepper, errMsg, useConfirm, useToast } from "../ui";

export function RecipePage() {
  const { slug } = useParams();
  const { data: r, error, isLoading, refetch } = useRecipe(slug);
  if (isLoading) return <Loading />;
  if (error || !r) return <ErrorBox error={error ?? new Error("Recipe not found")} retry={() => refetch()} />;
  return <RecipeView key={r.slug} r={r} />;
}

type ModalName = null | "plan" | "cooked" | "raw" | "history" | "rename" | "leftovers";

function RecipeView({ r }: { r: RecipeFull }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const m = r.meta;
  const baseServings = m.servings ?? 4;
  const [servings, setServings] = useState(baseServings);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [doneSteps, setDoneSteps] = useState<Set<number>>(new Set());
  const [modal, setModal] = useState<ModalName>(null);
  const [noteText, setNoteText] = useState("");
  const [editingNote, setEditingNote] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const scale = servings / baseServings;

  const apply = (next: RecipeFull) => {
    qc.setQueryData(["recipe", r.slug], next);
    void qc.invalidateQueries({ queryKey: ["recipes"] });
  };
  const run = async (fn: () => Promise<RecipeFull>, ok?: string) => {
    try {
      apply(await fn());
      if (ok) toast(ok);
    } catch (e) {
      toast(errMsg(e), "bad");
    }
  };

  const groups = useMemo(() => {
    const out: { name: string | null; items: { i: number; text: string }[] }[] = [];
    r.ingredients.forEach((ing, i) => {
      const last = out[out.length - 1];
      const text = formatIngredient(ing, scale);
      if (last && last.name === ing.group) last.items.push({ i, text });
      else out.push({ name: ing.group, items: [{ i, text }] });
    });
    return out;
  }, [r.ingredients, scale]);

  const stepImages = useMemo(() => {
    const map = new Map<number, GalleryItem[]>();
    for (const g of m.images.gallery) if (g.kind === "step" && g.step != null) map.set(g.step, [...(map.get(g.step) ?? []), g]);
    return map;
  }, [m.images.gallery]);

  const sourceLine = (() => {
    const s = m.source;
    if (s.type === "web" && s.url)
      return (
        <>
          From{" "}
          <a href={s.url} target="_blank" rel="noreferrer">
            {s.site ?? new URL(s.url).hostname}
          </a>
          {s.author ? ` · by ${s.author}` : ""}
        </>
      );
    if (s.type === "book")
      return (
        <>
          From the book <b>{s.book?.title ?? "(untitled)"}</b>
          {s.book?.author || s.author ? ` by ${s.book?.author ?? s.author}` : ""}
          {s.book?.page ? `, page ${s.book.page}` : ""}
        </>
      );
    return <>Your own recipe</>;
  })();

  return (
    <>
      <div className="row">
        <button className="btn ghost icon" onClick={() => nav(-1)} aria-label="Back">
          <ChevL />
        </button>
        <div className="grow" />
        <button className="btn soft" onClick={() => setModal("plan")}>
          <Calendar /> Add to plan
        </button>
        <button className="btn primary" onClick={() => setModal("cooked")}>
          <Utensils /> Cooked it
        </button>
        <Menu>
          {(close) => (
            <>
              <Link to={`/recipes/${r.slug}/edit`} onClick={close}>
                <Edit /> Edit recipe
              </Link>
              <button onClick={() => (close(), setModal("raw"))}>
                <Copy /> Edit Markdown file
              </button>
              <button onClick={() => (close(), setModal("history"))}>
                <History /> Version history
              </button>
              <button onClick={() => (close(), setModal("rename"))}>
                <Edit /> Rename folder
              </button>
              <button
                className="danger"
                onClick={async () => {
                  close();
                  if (await confirm({ title: "Delete this recipe?", message: "It moves to the .trash folder in your data folder, so it can be recovered.", confirmLabel: "Delete", danger: true })) {
                    try {
                      await api.del(`/api/recipes/${r.slug}`);
                      await qc.invalidateQueries();
                      toast("Deleted");
                      nav("/", { replace: true });
                    } catch (e) {
                      toast(errMsg(e), "bad");
                    }
                  }
                }}
              >
                <Trash /> Delete
              </button>
            </>
          )}
        </Menu>
      </div>

      <div className="hero">
        {m.images.hero ? <img src={`/images/${r.slug}/${m.images.hero}?w=1200`} alt={m.title} /> : "🍽️"}
        <div className="hero-actions">
          <button className={`round ${m.favorite ? "on" : ""}`} aria-pressed={m.favorite} aria-label="Favourite" onClick={() => run(() => api.post(`/api/recipes/${r.slug}/favorite`, {}))}>
            <Heart filled={m.favorite} />
          </button>
          <button className={`round ${m.hidden ? "on" : ""}`} aria-pressed={m.hidden} aria-label={m.hidden ? "Unhide" : "Hide from lists"} title="Hide from lists" onClick={() => run(() => api.post(`/api/recipes/${r.slug}/hide`, {}), m.hidden ? "Visible again" : "Hidden from lists")}>
            <EyeOff />
          </button>
          <ImageUpload slug={r.slug} kind="hero" onDone={apply} label="Change photo">
            <span className="round" style={{ cursor: "pointer" }} title="Change photo">
              <Camera />
            </span>
          </ImageUpload>
        </div>
      </div>

      <div className="stack tight">
        <h1>{m.title}</h1>
        <div className="small muted">{sourceLine}</div>
        <div className="row wrap" style={{ gap: 8 }}>
          {r.totalMinutes != null && (
            <span className="chip">
              <Clock /> {fmtMinutes(r.totalMinutes)}
            </span>
          )}
          {m.times.prepMinutes != null && m.times.cookMinutes != null && (
            <span className="chip">
              Prep {fmtMinutes(m.times.prepMinutes)} · Cook {fmtMinutes(m.times.cookMinutes)}
            </span>
          )}
          {m.leftovers.fridgeDays != null && (
            <span className="chip">
              <Fridge /> {m.leftovers.fridgeDays} days
            </span>
          )}
          {m.leftovers.freezable === true && (
            <span className="chip blue">
              <Snow /> Freezes well
            </span>
          )}
          {m.leftovers.freezable === false && <span className="chip amber">Doesn't freeze well</span>}
          {m.cuisine && <span className="chip">{m.cuisine}</span>}
          {m.tags.slice(0, 6).map((t) => (
            <Link key={t} to={`/?tags=${encodeURIComponent(t)}`} className="chip" style={{ textDecoration: "none" }}>
              #{t}
            </Link>
          ))}
        </div>
        <div className="row">
          <Stars value={m.rating} onChange={(n) => run(() => api.patch(`/api/recipes/${r.slug}`, { rating: n }))} />
          {r.lastCooked && <span className="small muted">Last cooked {fmtDate(r.lastCooked)}</span>}
        </div>
      </div>

      <div className="two-col">
        <div className="card" style={{ position: "relative" }}>
          <div className="section-title">
            <h2>Ingredients</h2>
          </div>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span className="row small" style={{ gap: 6 }}>
              <Users style={{ width: 18, height: 18 }} /> Servings
            </span>
            <Stepper value={servings} onChange={setServings} min={1} max={60} small />
          </div>
          {servings !== baseServings && (
            <div className="small muted" style={{ marginBottom: 6 }}>
              Scaled from {baseServings}.{" "}
              <button className="btn ghost sm" style={{ minHeight: 24, padding: "0 6px" }} onClick={() => setServings(baseServings)}>
                Reset
              </button>
            </div>
          )}
          {r.ingredients.length === 0 && <p className="muted">No ingredients yet — tap Edit to add them.</p>}
          {groups.map((g, gi) => (
            <div key={gi}>
              {g.name && <div className="ing-group">{g.name}</div>}
              {g.items.map(({ i, text }) => (
                <div
                  key={i}
                  className={`ing ${ticked.has(i) ? "done" : ""}`}
                  role="checkbox"
                  aria-checked={ticked.has(i)}
                  tabIndex={0}
                  onClick={() => setTicked((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set(s).add(i)))}
                  onKeyDown={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), (e.currentTarget as HTMLElement).click())}
                >
                  <CheckBox on={ticked.has(i)} />
                  <span className="txt">{text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="card">
          <div className="section-title">
            <h2>Method</h2>
          </div>
          {r.method.length === 0 && <p className="muted">No method yet — tap Edit to add it.</p>}
          {r.method.map((s) => (
            <div
              key={s.n}
              className={`step ${doneSteps.has(s.n) ? "done" : ""}`}
              onClick={() => setDoneSteps((d) => (d.has(s.n) ? new Set([...d].filter((x) => x !== s.n)) : new Set(d).add(s.n)))}
            >
              <div className="n">{s.n}</div>
              <div className="grow">
                <div className="txt">{renderInline(s.text)}</div>
                {stepImages.get(s.n)?.map((g) => (
                  <figure key={g.file} style={{ margin: 0 }}>
                    <img src={`/images/${r.slug}/${g.file}?w=900`} alt={g.caption ?? `Step ${s.n}`} />
                    {g.caption && <figcaption className="small muted">{g.caption}</figcaption>}
                  </figure>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <NutritionPanel recipe={r} />

      <div className="card">
        <div className="section-title">
          <h2>Leftovers</h2>
          <div className="row" style={{ gap: 6 }}>
            <SourceBadge source={m.leftovers.source} />
            <button className="btn sm" onClick={() => setModal("leftovers")}>
              <Edit /> Edit
            </button>
          </div>
        </div>
        <div className="grid3">
          <div className="stat">
            <div className="v">{m.leftovers.fridgeDays != null ? `${m.leftovers.fridgeDays} days` : "—"}</div>
            <div className="l">In the fridge</div>
          </div>
          <div className="stat">
            <div className="v">{m.leftovers.freezable === false ? "No" : m.leftovers.freezerDays != null ? `${m.leftovers.freezerDays} days` : m.leftovers.freezable ? "Yes" : "—"}</div>
            <div className="l">In the freezer</div>
          </div>
          <div className="stat">
            <div className="v">{m.leftovers.freezable == null ? "?" : m.leftovers.freezable ? "Yes" : "No"}</div>
            <div className="l">Freezes well</div>
          </div>
        </div>
        {m.leftovers.reheatNotes && <p className="small" style={{ marginTop: 10 }}>♨️ {m.leftovers.reheatNotes}</p>}
        {m.leftovers.source === "estimated" && <p className="small muted" style={{ marginTop: 8 }}>This is a default guess — the recipe didn't say. Edit it if you know better.</p>}
      </div>

      <div className="card">
        <div className="section-title">
          <h2>My notes</h2>
        </div>
        <div className="stack tight">
          {r.notes.map((n, idx) => (
            <div className="note" key={idx}>
              <div className="row between">
                <div className="d">{n.date}</div>
                <div className="row" style={{ gap: 2 }}>
                  <button className="btn ghost icon sm" aria-label="Edit note" onClick={() => (setEditingNote(idx), setNoteDraft(n.text))}>
                    <Edit />
                  </button>
                  <button
                    className="btn ghost icon sm"
                    aria-label="Delete note"
                    onClick={async () => {
                      if (await confirm({ title: "Delete this note?", confirmLabel: "Delete", danger: true }))
                        run(() => api.put(`/api/recipes/${r.slug}/notes`, { notes: r.notes.filter((_, j) => j !== idx) }));
                    }}
                  >
                    <Trash />
                  </button>
                </div>
              </div>
              {editingNote === idx ? (
                <div className="stack tight">
                  <textarea className="input" value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} />
                  <div className="row">
                    <button
                      className="btn primary sm"
                      onClick={() => run(() => api.put(`/api/recipes/${r.slug}/notes`, { notes: r.notes.map((x, j) => (j === idx ? { ...x, text: noteDraft } : x)) })).then(() => setEditingNote(null))}
                    >
                      Save
                    </button>
                    <button className="btn sm" onClick={() => setEditingNote(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                n.text
              )}
            </div>
          ))}
          <textarea className="input" style={{ minHeight: 80 }} placeholder="Add a note — what you changed, who liked it…" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
          <button
            className="btn soft"
            style={{ alignSelf: "flex-start" }}
            disabled={!noteText.trim()}
            onClick={() => run(() => api.post(`/api/recipes/${r.slug}/notes`, { text: noteText.trim(), date: todayYmd() }), "Note added").then(() => setNoteText(""))}
          >
            Add note
          </button>
        </div>
        {r.sourceNotes && (
          <details style={{ marginTop: 14 }}>
            <summary>Notes from the original recipe</summary>
            <div className="source-notes">{r.sourceNotes}</div>
          </details>
        )}
      </div>

      {r.cookLog.length > 0 && (
        <div className="card">
          <div className="section-title">
            <h2>Cook log</h2>
            <span className="small muted">{r.cookLog.length}× cooked</span>
          </div>
          <div className="stack tight">
            {[...r.cookLog].reverse().map((c, i) => (
              <div className="row between small" key={i}>
                <span>{fmtDate(c.date)}</span>
                <span className="muted">
                  {c.people ? `for ${c.people}` : ""}
                  {c.rating ? ` · ${"★".repeat(c.rating)}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="section-title">
          <h2>Photos</h2>
          <div className="row wrap" style={{ gap: 6 }}>
            <ImageUpload slug={r.slug} kind="cooked" onDone={apply} label="I made this">
              <span className="btn sm">
                <Camera /> I made this
              </span>
            </ImageUpload>
            <StepPhotoButton r={r} onDone={apply} />
          </div>
        </div>
        {m.images.gallery.length === 0 ? (
          <p className="muted small">Add a photo of how it turned out, or a photo for a particular step.</p>
        ) : (
          <div className="gallery">
            {m.images.gallery.map((g) => (
              <figure key={g.file}>
                <a href={`/images/${r.slug}/${g.file}`} target="_blank" rel="noreferrer">
                  <img loading="lazy" src={`/images/${r.slug}/${g.file}?w=360`} alt={g.caption ?? g.kind} />
                </a>
                <figcaption>
                  {g.kind === "step" ? `Step ${g.step}` : g.kind === "cooked" ? `Made ${g.date ?? ""}` : g.kind === "source-page" ? "Book page" : "Photo"}
                  {g.caption ? ` — ${g.caption}` : ""}
                </figcaption>
                <div className="row" style={{ gap: 2 }}>
                  <button className="btn ghost sm" style={{ minHeight: 28, padding: "0 8px" }} onClick={() => run(() => api.post(`/api/recipes/${r.slug}/hero`, { file: g.file }), "Now the main photo")}>
                    <ImageIcon style={{ width: 15, height: 15 }} /> Use as main
                  </button>
                  <button
                    className="btn ghost sm danger"
                    style={{ minHeight: 28, padding: "0 8px" }}
                    aria-label="Delete photo"
                    onClick={async () => {
                      if (await confirm({ title: "Delete this photo?", confirmLabel: "Delete", danger: true })) run(() => api.del(`/api/recipes/${r.slug}/images?file=${encodeURIComponent(g.file)}`));
                    }}
                  >
                    <Trash style={{ width: 15, height: 15 }} />
                  </button>
                </div>
              </figure>
            ))}
          </div>
        )}
      </div>

      <p className="small muted center">
        {sourceLine}
        {m.source.importedAt ? ` · imported ${m.source.importedAt.slice(0, 10)}` : ""}
        <br />
        Kept for personal use only.
      </p>

      {modal === "plan" && <AddToPlanModal recipe={r} onClose={() => setModal(null)} />}
      {modal === "cooked" && <CookedModal recipe={r} onClose={() => setModal(null)} />}
      {modal === "raw" && <RawModal recipe={r} onClose={() => setModal(null)} />}
      {modal === "history" && <HistoryModal recipe={r} onClose={() => setModal(null)} />}
      {modal === "rename" && <RenameModal recipe={r} onClose={() => setModal(null)} />}
      {modal === "leftovers" && <LeftoversModal recipe={r} onClose={() => setModal(null)} />}
    </>
  );
}

/** **bold** from imported method steps */
function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <b key={i}>{part.slice(2, -2)}</b> : part));
}

function ImageUpload({ slug, kind, onDone, children, step, caption, label }: { slug: string; kind: string; onDone: (r: RecipeFull) => void; children: React.ReactNode; step?: number; caption?: string; label: string }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        aria-label={label}
        style={{ display: "inline-flex", opacity: busy ? 0.5 : 1 }}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
      >
        {children}
      </span>
      <input
        ref={input}
        className="hidden-input"
        type="file"
        accept="image/*"
        tabIndex={-1}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          try {
            const form = new FormData();
            form.set("kind", kind);
            if (step != null) form.set("step", String(step));
            if (caption) form.set("caption", caption);
            form.set("file", file);
            onDone(await api.upload<RecipeFull>(`/api/recipes/${slug}/images`, form));
            toast("Photo saved");
          } catch (err) {
            toast(errMsg(err), "bad");
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

function StepPhotoButton({ r, onDone }: { r: RecipeFull; onDone: (r: RecipeFull) => void }) {
  const [step, setStep] = useState(1);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setStep((s) => Math.min(s, Math.max(r.method.length, 1)));
  }, [r.method.length]);
  if (r.method.length === 0) return null;
  return (
    <span className="row" style={{ gap: 4 }}>
      {open ? (
        <>
          <select className="input" style={{ width: "auto", minHeight: 34, padding: "0 8px" }} value={step} onChange={(e) => setStep(Number(e.target.value))}>
            {r.method.map((s) => (
              <option key={s.n} value={s.n}>
                Step {s.n}
              </option>
            ))}
          </select>
          <ImageUpload slug={r.slug} kind="step" step={step} onDone={(x) => (onDone(x), setOpen(false))} label="Upload step photo">
            <span className="btn sm primary">
              <Camera /> Choose
            </span>
          </ImageUpload>
        </>
      ) : (
        <button className="btn sm" onClick={() => setOpen(true)}>
          <Camera /> Step photo
        </button>
      )}
    </span>
  );
}
