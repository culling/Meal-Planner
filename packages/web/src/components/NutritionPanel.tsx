import { NUTRIENT_KEYS, NUTRIENT_LABELS, emptyNutrients, type BreakdownRow, type Nutrients, type NutrientKey } from "@mp/core/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type RecipeFull } from "../api";
import { Edit, Sparkle } from "../icons";
import { AiMark, errMsg, fmtNum, Modal, NumField, SourceBadge, useToast, useTrackJob } from "../ui";

const SHORT: NutrientKey[] = ["calories", "proteinG", "carbsG", "fatG"];

export function NutritionPanel({ recipe }: { recipe: RecipeFull }) {
  const qc = useQueryClient();
  const toast = useToast();
  const track = useTrackJob();
  const n = recipe.meta.nutrition;
  const rows = n.breakdown;
  const [open, setOpen] = useState(false);
  const [editTotals, setEditTotals] = useState(false);
  const [draft, setDraft] = useState<BreakdownRow[]>(rows);
  const [busy, setBusy] = useState(false);
  const [allCols, setAllCols] = useState(false);
  useEffect(() => {
    setDraft(rows);
  }, [rows]); // pick up changes saved elsewhere
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(rows), [draft, rows]);

  const anyAi = rows.some((r) => !r.excluded && r.source === "ai");
  const hasData = n.perServing.calories != null;
  const refresh = (r: RecipeFull) => {
    qc.setQueryData(["recipe", recipe.slug], r);
    void qc.invalidateQueries({ queryKey: ["recipes"] });
    void qc.invalidateQueries({ queryKey: ["foods"] });
  };

  const calculate = async (keepManual: boolean) => {
    if (!recipe.ingredients.length) return toast("Add some ingredients first", "bad");
    try {
      const { jobId } = await api.post<{ jobId: string }>(`/api/recipes/${recipe.slug}/nutrition/recalculate`, { keepManual });
      track(jobId, { label: "Working out nutrition" });
    } catch (e) {
      toast(errMsg(e), "bad");
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      refresh(await api.put<RecipeFull>(`/api/recipes/${recipe.slug}/nutrition/breakdown`, { rows: draft }));
      toast("Saved");
    } catch (e) {
      toast(errMsg(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  const setRow = (i: number, patch: Partial<BreakdownRow>) => setDraft((d) => d.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setCell = (i: number, key: NutrientKey, value: number | null) =>
    setDraft((d) => d.map((r, j) => (j === i ? { ...r, override: true, source: "manual", total: { ...r.total, [key]: value } } : r)));
  const confirmRow = (i: number) => setDraft((d) => d.map((r, j) => (j === i ? { ...r, override: true, source: "manual" } : r)));

  const cols = allCols ? NUTRIENT_KEYS : SHORT;

  return (
    <div className="card">
      <div className="section-title">
        <h2>Nutrition</h2>
        <div className="row" style={{ gap: 6 }}>
          <SourceBadge source={n.source} />
          {anyAi && <AiMark />}
        </div>
      </div>

      {hasData ? (
        <>
          <p className="small muted" style={{ marginBottom: 8 }}>
            Per serving{recipe.meta.servingDescription ? ` (${recipe.meta.servingDescription})` : ""}
          </p>
          <div className="grid4">
            {NUTRIENT_KEYS.map((k) => (
              <div className="stat" key={k} style={k === "calories" ? { background: "var(--primary-soft)" } : undefined}>
                <div className="v" style={k === "calories" ? { color: "var(--primary)" } : undefined}>
                  {n.perServing[k] == null ? "—" : fmtNum(n.perServing[k], k === "calories" || k === "sodiumMg" ? 0 : 1)}
                </div>
                <div className="l">
                  {NUTRIENT_LABELS[k].label} <span style={{ fontWeight: 500 }}>{NUTRIENT_LABELS[k].unit}</span>
                </div>
              </div>
            ))}
          </div>
          {n.source === "calculated" && (
            <p className="small muted" style={{ marginTop: 10 }}>
              Worked out from the ingredients — an estimate, often 15–25% out. {anyAi ? "Rows marked " : ""}
              {anyAi && <AiMark small />}
              {anyAi ? " below are AI guesses nobody has checked yet. Edit a number to confirm it." : ""}
            </p>
          )}
        </>
      ) : (
        <p className="muted">No nutrition information yet. Work it out from the ingredients with the local AI model, or type it in.</p>
      )}

      <div className="row wrap" style={{ marginTop: 12 }}>
        <button className={`btn ${hasData ? "" : "primary"}`} onClick={() => calculate(true)}>
          <Sparkle /> {hasData ? "Recalculate" : "Work it out from the ingredients"}
        </button>
        <button className="btn" onClick={() => setEditTotals(true)}>
          <Edit /> Type the numbers
        </button>
        {rows.length > 0 && (
          <button className="btn ghost" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Show"} ingredient breakdown
          </button>
        )}
      </div>

      {open && rows.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <label className="check small">
              <input type="checkbox" checked={allCols} onChange={(e) => setAllCols(e.target.checked)} /> Show every nutrient
            </label>
            <span className="small muted">Whole amount in the recipe (not per serving)</span>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th />
                  <th>Ingredient</th>
                  <th className="num">Grams</th>
                  {cols.map((k) => (
                    <th className="num" key={k}>
                      {NUTRIENT_LABELS[k].label.replace(" fat", "")}
                    </th>
                  ))}
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {draft.map((r, i) => (
                  <tr key={i} className={`${r.excluded ? "excluded" : ""} ${r.source === "ai" && !r.excluded ? "ai" : ""}`}>
                    <td style={{ width: 28 }}>
                      {r.source === "ai" && !r.excluded && (
                        <button className="ai-mark" onClick={() => confirmRow(i)} title="AI guess, not checked. Tap to mark this row as checked, or edit a number.">
                          ?
                        </button>
                      )}
                    </td>
                    <td className="name">
                      {r.ingredient.replace(/^[-*]\s*/, "")}
                      {r.food && (
                        <div className="tiny muted">
                          <Link to={`/nutrition?food=${r.food}`}>{r.food}</Link>
                        </div>
                      )}
                    </td>
                    <td className="num">
                      <input className="cell" inputMode="decimal" value={r.grams ?? ""} onChange={(e) => setRow(i, { grams: e.target.value === "" ? null : Number(e.target.value), gramsSource: "manual" })} aria-label="Grams" />
                    </td>
                    {cols.map((k) => (
                      <td className="num" key={k}>
                        <input className="cell" inputMode="decimal" value={r.total[k] ?? ""} onChange={(e) => setCell(i, k, e.target.value === "" ? null : Number(e.target.value))} aria-label={NUTRIENT_LABELS[k].label} />
                      </td>
                    ))}
                    <td>
                      <input type="checkbox" style={{ width: 20, height: 20, accentColor: "var(--primary)" }} checked={!r.excluded} onChange={(e) => setRow(i, { excluded: !e.target.checked })} aria-label="Include in the total" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={!dirty || busy} onClick={save}>
              Save changes
            </button>
            {dirty && (
              <button className="btn ghost" onClick={() => setDraft(rows)}>
                Undo
              </button>
            )}
            <span className="small muted">Changing grams re-works the row from the food's per-100 g values. Typing a nutrient number replaces it and removes the ?.</span>
          </div>
        </div>
      )}

      {editTotals && <TotalsModal initial={n.perServing} slug={recipe.slug} onClose={() => setEditTotals(false)} onSaved={refresh} />}
    </div>
  );
}

function TotalsModal({ initial, slug, onClose, onSaved }: { initial: Nutrients; slug: string; onClose: () => void; onSaved: (r: RecipeFull) => void }) {
  const toast = useToast();
  const [v, setV] = useState<Nutrients>({ ...emptyNutrients(), ...initial });
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Nutrition per serving" onClose={onClose}>
      <p className="muted small">Type the numbers from the book or packaging. This replaces any calculated values and marks them as entered by hand.</p>
      <div className="grid2">
        {NUTRIENT_KEYS.map((k) => (
          <NumField key={k} label={NUTRIENT_LABELS[k].label} unit={NUTRIENT_LABELS[k].unit} value={v[k]} onChange={(x) => setV({ ...v, [k]: x })} />
        ))}
      </div>
      <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              onSaved(await api.put<RecipeFull>(`/api/recipes/${slug}/nutrition/manual`, { perServing: v }));
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
