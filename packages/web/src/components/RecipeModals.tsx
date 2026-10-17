import { isoWeekOf, todayYmd, windowStartFor, type Leftovers } from "@mp/core/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, useSettings, type RecipeFull } from "../api";
import { Star } from "../icons";
import { errMsg, fmtDate, Loading, Modal, NumField, Seg, Stepper, useToast } from "../ui";

export function Stars({ value, onChange }: { value: number | null; onChange?: (n: number | null) => void }) {
  return (
    <span className="row" style={{ gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onChange}
          onClick={() => onChange?.(value === n ? null : n)}
          style={{ border: 0, background: "none", padding: 4, cursor: onChange ? "pointer" : "default", color: (value ?? 0) >= n ? "var(--amber)" : "var(--line)" }}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
        >
          <Star filled={(value ?? 0) >= n} style={{ width: 24, height: 24 }} />
        </button>
      ))}
    </span>
  );
}

export function AddToPlanModal({ recipe, onClose }: { recipe: RecipeFull; onClose: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const [date, setDate] = useState(todayYmd());
  const [slot, setSlot] = useState("dinner");
  const [extra, setExtra] = useState(false);
  const [people, setPeople] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const slots = settings?.mealSlots ?? ["breakfast", "lunch", "dinner"];
  const basePeople = people ?? settings?.defaultPeople ?? 2;

  const add = async () => {
    setBusy(true);
    try {
      const week = isoWeekOf(date);
      await api.put(`/api/meal-plans/${week}/days/${date}/meals/${slot}`, {
        meal: { recipe: recipe.slug, type: "cook", people, portions: extra ? basePeople * 2 : null, cooked: false },
      });
      void qc.invalidateQueries({ queryKey: ["plan"] });
      toast(`Added to ${fmtDate(date)}`);
      onClose();
      const start = windowStartFor(date); // the plan page counts 7-day steps from today
      nav(start === todayYmd() ? "/plan" : `/plan/${start}`);
    } catch (e) {
      toast(errMsg(e), "bad");
      setBusy(false);
    }
  };

  return (
    <Modal title={`Add to the plan`} onClose={onClose}>
      <div className="stack">
        <div className="field">
          <label>Which day?</label>
          <input className="input" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </div>
        <div className="field">
          <label>Which meal?</label>
          <Seg fill value={slot} options={slots.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} onChange={setSlot} />
        </div>
        <div className="field">
          <label>How many people?</label>
          <div className="row">
            <Stepper value={basePeople} onChange={setPeople} min={1} />
            {people !== null ? (
              <button className="btn ghost sm" onClick={() => setPeople(null)}>
                Use the plan's number
              </button>
            ) : (
              <span className="small muted">from the plan's default</span>
            )}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={extra} onChange={(e) => setExtra(e.target.checked)} />
          Cook double so there are leftovers
        </label>
        <button className="btn primary block" disabled={busy} onClick={add}>
          Add to {fmtDate(date)} {slot}
        </button>
      </div>
    </Modal>
  );
}

export function CookedModal({ recipe, onClose }: { recipe: RecipeFull; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const [date, setDate] = useState(todayYmd());
  const [people, setPeople] = useState<number>(settings?.defaultPeople ?? 2);
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Cooked it!" onClose={onClose}>
      <div className="stack">
        <div className="field">
          <label>When?</label>
          <input className="input" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </div>
        <div className="field">
          <label>For how many?</label>
          <Stepper value={people} onChange={setPeople} min={1} />
        </div>
        <div className="field">
          <label>How was it?</label>
          <Stars value={rating} onChange={setRating} />
        </div>
        <div className="field">
          <label>A note for next time (optional)</label>
          <textarea className="input" style={{ minHeight: 80 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Less chilli, kids loved it…" />
        </div>
        <button
          className="btn primary block"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post(`/api/recipes/${recipe.slug}/cooked`, { date, people, rating });
              if (note.trim()) await api.post(`/api/recipes/${recipe.slug}/notes`, { text: note.trim(), date });
              await qc.invalidateQueries();
              toast("Added to the cook log");
              onClose();
            } catch (e) {
              toast(errMsg(e), "bad");
              setBusy(false);
            }
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

export function RawModal({ recipe, onClose }: { recipe: RecipeFull; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [mtime, setMtime] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.get<{ text: string; mtimeMs: number }>(`/api/recipes/${recipe.slug}/raw`).then((r) => {
      setText(r.text);
      setMtime(r.mtimeMs);
    });
  }, [recipe.slug]);
  return (
    <Modal title="Edit the Markdown file" onClose={onClose} wide>
      {text === null ? (
        <Loading />
      ) : (
        <div className="stack">
          <p className="small muted">This is the recipe's file exactly as stored on disk. Changes are checked before saving.</p>
          <textarea className="input mono" style={{ minHeight: "52vh" }} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.put(`/api/recipes/${recipe.slug}/raw`, { text, expectedMtimeMs: mtime });
                  await qc.invalidateQueries();
                  toast("Saved");
                  onClose();
                } catch (e) {
                  toast(errMsg(e), "bad");
                  setBusy(false);
                }
              }}
            >
              Save file
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function HistoryModal({ recipe, onClose }: { recipe: RecipeFull; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [commits, setCommits] = useState<{ hash: string; date: string; message: string }[] | null>(null);
  const [viewing, setViewing] = useState<{ hash: string; text: string } | null>(null);
  useEffect(() => {
    void api.get<{ commits: { hash: string; date: string; message: string }[] }>(`/api/recipes/${recipe.slug}/history`).then((r) => setCommits(r.commits));
  }, [recipe.slug]);
  return (
    <Modal title="Version history" onClose={onClose} wide>
      {commits === null ? (
        <Loading />
      ) : viewing ? (
        <div className="stack">
          <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setViewing(null)}>
            ← Back to the list
          </button>
          <textarea className="input mono" style={{ minHeight: "46vh" }} readOnly value={viewing.text} />
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await api.put(`/api/recipes/${recipe.slug}/raw`, { text: viewing.text });
                await qc.invalidateQueries();
                toast("Restored that version");
                onClose();
              } catch (e) {
                toast(errMsg(e), "bad");
              }
            }}
          >
            Restore this version
          </button>
        </div>
      ) : commits.length === 0 ? (
        <p className="muted">No history yet. Changes are saved a few seconds after each edit.</p>
      ) : (
        <div className="stack tight">
          {commits.map((c) => (
            <button
              key={c.hash}
              className="card flat row between"
              style={{ cursor: "pointer", textAlign: "left" }}
              onClick={async () => setViewing({ hash: c.hash, text: (await api.get<{ text: string }>(`/api/recipes/${recipe.slug}/history/${c.hash}`)).text })}
            >
              <span>
                <b>{c.message}</b>
                <br />
                <span className="small muted">{new Date(c.date).toLocaleString("en-NZ")}</span>
              </span>
              <span className="small muted">View</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function RenameModal({ recipe, onClose }: { recipe: RecipeFull; onClose: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [slug, setSlug] = useState(recipe.slug);
  return (
    <Modal title="Rename the folder" onClose={onClose}>
      <p className="small muted">The recipe's folder name is used in meal plans. Renaming it updates every plan that uses it. (The title can be changed any time from Edit.)</p>
      <div className="field">
        <label>Folder name</label>
        <input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} />
      </div>
      <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            try {
              const r = await api.post<RecipeFull>(`/api/recipes/${recipe.slug}/rename`, { slug });
              await qc.invalidateQueries();
              onClose();
              nav(`/recipes/${r.slug}`, { replace: true });
            } catch (e) {
              toast(errMsg(e), "bad");
            }
          }}
        >
          Rename
        </button>
      </div>
    </Modal>
  );
}

export function LeftoversModal({ recipe, onClose }: { recipe: RecipeFull; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [v, setV] = useState<Leftovers>({ ...recipe.meta.leftovers });
  return (
    <Modal title="Leftovers" onClose={onClose}>
      <div className="stack">
        <div className="grid2">
          <NumField label="Keeps in the fridge" unit="days" value={v.fridgeDays} onChange={(n) => setV({ ...v, fridgeDays: n })} />
          <NumField label="Keeps in the freezer" unit="days" value={v.freezerDays} onChange={(n) => setV({ ...v, freezerDays: n })} hint="90 days = 3 months" />
        </div>
        <div className="field">
          <label>Freezes well?</label>
          <Seg
            fill
            value={v.freezable === null ? "unknown" : v.freezable ? "yes" : "no"}
            options={[
              { value: "unknown", label: "Don't know" },
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ]}
            onChange={(x) => setV({ ...v, freezable: x === "unknown" ? null : x === "yes" })}
          />
        </div>
        <div className="field">
          <label>Reheating notes</label>
          <input className="input" value={v.reheatNotes ?? ""} onChange={(e) => setV({ ...v, reheatNotes: e.target.value || null })} />
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await api.patch(`/api/recipes/${recipe.slug}`, { leftovers: { ...v, source: "manual" } });
                await qc.invalidateQueries();
                onClose();
              } catch (e) {
                toast(errMsg(e), "bad");
              }
            }}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

export { Link };
