import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, useStatus, type PhotoState } from "../api";
import { Alert, Camera, Image as ImageIcon, X } from "../icons";
import { Spinner, errMsg, useToast } from "../ui";

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?|avif)$/i;
const looksLikeImage = (f: File) => f.type.startsWith("image/") || IMAGE_RE.test(f.name);

/** A title worth showing from a file name; empty for camera names like IMG_2043 or PXL_2026…. */
export function suggestName(file: string): string {
  const base = file.replace(/\.[^.]+$/, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  const compact = base.toLowerCase().replace(/[\s._-]+/g, "");
  if (!base || /^(img|pxl|dsc|dscn|image|photo|mvimg|screenshot|scan|pano|wp|signal)?\d{4,}[a-z]{0,6}$/.test(compact) || /^(image|photo|picture|untitled|scan|img)\d{0,3}$/.test(compact)) return "";
  return base;
}

/** True on phones/tablets, where the "take a photo" button opens the camera. */
const useTouch = () => {
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(window.matchMedia("(pointer: coarse)").matches), []);
  return touch;
};

/** The two ways to get a picture in: camera, or files from the gallery / computer (with drag and drop). */
export function PhotoPicker({ onAdd, many = true, compact }: { onAdd: (files: File[]) => void; many?: boolean; compact?: boolean }) {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const touch = useTouch();
  const [over, setOver] = useState(false);
  const add = (list: FileList | File[]) => {
    const files = Array.from(list).filter(looksLikeImage);
    if (files.length) onAdd(files);
  };
  return (
    <div
      className={`dropzone ${over ? "over" : ""}`}
      style={compact ? { padding: 14 } : undefined}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => (e.preventDefault(), setOver(false), add(e.dataTransfer.files))}
    >
      {/* the camera input opens the phone's camera app straight away; the other lets you pick from the gallery or files */}
      <input ref={camera} className="hidden-input" type="file" accept="image/*" capture="environment" tabIndex={-1} aria-label="Take a photo" onChange={(e) => (e.target.files && add(e.target.files), (e.target.value = ""))} />
      <input ref={gallery} className="hidden-input" type="file" accept="image/*" multiple={many} tabIndex={-1} aria-label="Choose photos" onChange={(e) => (e.target.files && add(e.target.files), (e.target.value = ""))} />
      {!compact && <Camera style={{ width: 34, height: 34 }} />}
      {!compact && (
        <div style={{ fontWeight: 800, margin: "4px 0 10px" }}>{touch ? "Photograph the recipe, or pick a picture" : "Drop a picture of the recipe here"}</div>
      )}
      <div className="row wrap" style={{ justifyContent: "center" }}>
        {touch && (
          <button type="button" className="btn primary" onClick={() => camera.current?.click()}>
            <Camera /> Take a photo
          </button>
        )}
        <button type="button" className={`btn ${touch ? "" : "primary"}`} onClick={() => gallery.current?.click()}>
          <ImageIcon /> {touch ? "Choose from gallery" : "Choose pictures…"}
        </button>
      </div>
      {!compact && <div className="small" style={{ marginTop: 8 }}>If the recipe runs over two pages, add both. JPEG, PNG or WebP.</div>}
    </div>
  );
}

/** Add photos, give them a name, and either keep them for later or read them straight away. */
export function PhotoIntake() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: status } = useStatus();
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [book, setBook] = useState({ title: "", author: "", page: "" });
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<null | "save" | "read">(null);

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  // the file name becomes the title until you type your own
  useEffect(() => {
    if (!nameTouched && files[0]) setName(suggestName(files[0].name));
  }, [files, nameTouched]);

  const add = (more: File[]) => setFiles((f) => [...f, ...more].slice(0, 12));

  const submit = async (readNow: boolean) => {
    setBusy(readNow ? "read" : "save");
    try {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      form.set("name", name.trim());
      form.set("bookTitle", book.title);
      form.set("bookAuthor", book.author);
      form.set("bookPage", book.page);
      form.set("notes", notes);
      const saved = await api.upload<PhotoState>("/api/photos", form);
      void qc.invalidateQueries({ queryKey: ["photos"] });
      if (readNow) {
        const { jobId } = await api.post<{ jobId: string }>(`/api/photos/${saved.photo.id}/read`, {});
        nav(`/photos/${saved.photo.id}?job=${jobId}`);
      } else {
        toast(`Saved “${saved.photo.name}” — read it whenever you like`);
        nav(`/photos/${saved.photo.id}`);
      }
    } catch (e) {
      toast(errMsg(e), "bad");
      setBusy(null);
    }
  };

  const vision = status?.ollama.models.filter((m) => m.vision) ?? [];
  return (
    <div className="stack">
      <div className="card stack">
        {files.length === 0 ? (
          <PhotoPicker onAdd={add} />
        ) : (
          <>
            <div className="thumbs">
              {previews.map((p, i) => (
                <div className="t" key={p}>
                  <img src={p} alt={`Page ${i + 1}`} />
                  <button className="btn icon sm" aria-label={`Remove page ${i + 1}`} onClick={() => setFiles((f) => f.filter((_, j) => j !== i))}>
                    <X />
                  </button>
                </div>
              ))}
            </div>
            <PhotoPicker onAdd={add} compact />
          </>
        )}

        {files.length > 0 && (
          <>
            <div className="field">
              <label htmlFor="photo-name">Name this recipe</label>
              <input
                id="photo-name"
                className="input"
                value={name}
                placeholder="e.g. Daal curry"
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
              />
              <div className="hint">So you can find the photo again. It becomes the recipe's title, which you can still change.</div>
            </div>
            <details>
              <summary>Book, page and notes (optional)</summary>
              <div className="stack" style={{ marginTop: 8 }}>
                <div className="grid2">
                  <div className="field">
                    <label>Book title</label>
                    <input className="input" value={book.title} onChange={(e) => setBook({ ...book, title: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Author</label>
                    <input className="input" value={book.author} onChange={(e) => setBook({ ...book, author: e.target.value })} />
                  </div>
                </div>
                <div className="field" style={{ maxWidth: 200 }}>
                  <label>Page number</label>
                  <input className="input" inputMode="numeric" value={book.page} onChange={(e) => setBook({ ...book, page: e.target.value })} />
                </div>
                <div className="field">
                  <label>Notes</label>
                  <textarea className="input" style={{ minHeight: 70 }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything to remember about it…" />
                </div>
              </div>
            </details>
            <div className="row wrap">
              <button className="btn grow" disabled={!!busy} onClick={() => submit(false)}>
                {busy === "save" ? <Spinner /> : null} Save for later
              </button>
              <button className="btn primary grow" disabled={!!busy} onClick={() => submit(true)}>
                {busy === "read" ? <Spinner /> : null} Save and read it now
              </button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              The photo is saved first, so nothing is lost if reading fails. You can read it later with a different model, or type the recipe in yourself with the photo beside you.
            </p>
          </>
        )}
      </div>
      {status && !status.ollama.ok && (
        <div className="notice warn">
          <Alert />
          <div>
            The local AI (Ollama) isn't running — you can still save photos now and read them later. {status.ollama.error}
          </div>
        </div>
      )}
      {status?.ollama.ok && vision.length === 0 && (
        <div className="notice warn">
          <Alert />
          <div>No vision-capable model was found in Ollama. Pull one (for example <code>qwen3-vl:8b</code>) or choose another in Settings.</div>
        </div>
      )}
    </div>
  );
}
