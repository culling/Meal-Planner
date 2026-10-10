import { NUTRIENT_KEYS, NUTRIENT_LABELS, emptyNutrients, type Nutrients } from "@mp/core/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, useFoods, type FoodRow } from "../api";
import { Plus, Search, Sparkle, Trash } from "../icons";
import { AiMark, Empty, ErrorBox, Loading, Modal, NumField, errMsg, fmtNum, useConfirm, useToast } from "../ui";

type SortKey = "name" | "calories" | "usedIn";

export function FoodsPage() {
  const { data, error, isLoading, refetch } = useFoods();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [onlyAi, setOnlyAi] = useState(false);
  const [sort, setSort] = useState<SortKey>("name");
  const [editing, setEditing] = useState<FoodRow | "new" | null>(null);
  const [allCols, setAllCols] = useState(false);

  const foods = data?.foods ?? [];
  const focus = params.get("food");
  useEffect(() => {
    if (focus && foods.length) {
      const f = foods.find((x) => x.id === focus);
      if (f) setEditing(f);
    }
  }, [focus, foods.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return foods
      .filter((f) => (!onlyAi || f.source === "ai") && (!needle || f.name.toLowerCase().includes(needle) || f.aliases.some((a) => a.toLowerCase().includes(needle))))
      .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "calories" ? (b.per100g.calories ?? -1) - (a.per100g.calories ?? -1) : b.usedIn - a.usedIn || a.name.localeCompare(b.name)));
  }, [foods, q, onlyAi, sort]);
  const unchecked = foods.filter((f) => f.source === "ai").length;
  const cols = allCols ? NUTRIENT_KEYS : (["calories", "proteinG", "carbsG", "fatG"] as const);

  return (
    <>
      <div className="page-head">
        <h1>Nutrition data</h1>
        <button className="btn primary" onClick={() => setEditing("new")}>
          <Plus /> Add a food
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Every food the app knows, per 100 g. Recipes use these to work out their nutrition. <AiMark small /> marks values a local AI model filled in that nobody has checked — fix a number (or tap “Mark as checked”) and the ? goes away from this list. A recipe row keeps its ? until its gram amount is confirmed too, if that was a guess as well.
      </p>

      <div className="row wrap">
        <div className="grow" style={{ position: "relative", minWidth: 200 }}>
          <Search style={{ position: "absolute", left: 14, top: 12, width: 20, height: 20, color: "var(--ink-soft)" }} />
          <input className="input" style={{ paddingLeft: 42 }} type="search" placeholder="Search foods…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className={`chip ${onlyAi ? "on" : ""}`} style={{ cursor: "pointer" }} onClick={() => setOnlyAi((o) => !o)}>
          <AiMark small /> Needs checking ({unchecked})
        </button>
        <select className="input" style={{ width: "auto" }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
          <option value="name">A–Z</option>
          <option value="calories">Most calories</option>
          <option value="usedIn">Most used</option>
        </select>
        <label className="check small">
          <input type="checkbox" checked={allCols} onChange={(e) => setAllCols(e.target.checked)} /> All nutrients
        </label>
      </div>

      {isLoading && <Loading />}
      {error && <ErrorBox error={error} retry={() => refetch()} />}
      {data && foods.length === 0 && (
        <Empty emoji="🥕" title="No foods yet">
          They appear here as soon as you work out a recipe's nutrition. You can also add your own.
        </Empty>
      )}
      {shown.length > 0 && (
        <div className="card" style={{ padding: 8 }}>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th>Food</th>
                  {cols.map((k) => (
                    <th className="num" key={k}>
                      {NUTRIENT_LABELS[k].label.replace(" fat", "")}
                      <br />
                      <span style={{ fontWeight: 500, textTransform: "none" }}>{NUTRIENT_LABELS[k].unit}</span>
                    </th>
                  ))}
                  <th className="num">Used</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((f) => (
                  <tr key={f.id} className={f.source === "ai" ? "ai" : ""} style={{ cursor: "pointer" }} onClick={() => setEditing(f)}>
                    <td>{f.source === "ai" && <AiMark small />}</td>
                    <td className="name">
                      <b>{f.name}</b>
                      {f.aliases.length > 0 && <div className="tiny muted">also: {f.aliases.slice(0, 3).join(", ")}</div>}
                    </td>
                    {cols.map((k) => (
                      <td className="num" key={k}>
                        {fmtNum(f.per100g[k], k === "calories" || k === "sodiumMg" ? 0 : 1)}
                      </td>
                    ))}
                    <td className="num">{f.usedIn || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {data && foods.length > 0 && shown.length === 0 && <Empty emoji="🔍" title="No foods match" />}

      {editing && (
        <FoodModal
          food={editing === "new" ? null : editing}
          onClose={() => {
            setEditing(null);
            if (focus) setParams({}, { replace: true });
          }}
        />
      )}
    </>
  );
}

function FoodModal({ food, onClose }: { food: FoodRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState(food?.name ?? "");
  const [aliases, setAliases] = useState((food?.aliases ?? []).join(", "));
  const [n, setN] = useState<Nutrients>({ ...emptyNutrients(), ...(food?.per100g ?? {}) });
  const [gramsPerCup, setGramsPerCup] = useState<number | null>(food?.gramsPerCup ?? null);
  const [gramsPerPiece, setGramsPerPiece] = useState<number | null>(food?.gramsPerPiece ?? null);
  const [source, setSource] = useState<"ai" | "manual">(food?.source ?? "manual");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

  const numbersChanged = food ? NUTRIENT_KEYS.some((k) => (food.per100g[k] ?? null) !== (n[k] ?? null)) : true;
  const setNum = (k: keyof Nutrients, v: number | null) => {
    setN({ ...n, [k]: v });
    setSource("manual"); // a person typed it
  };

  const ask = async () => {
    if (!name.trim()) return toast("Type the food's name first", "bad");
    setAsking(true);
    try {
      const r = await api.post<{ per100g: Nutrients }>("/api/foods/estimate", { name: name.trim() });
      setN(r.per100g);
      setSource("ai");
      toast("Filled in by the AI — check the numbers, then save");
    } catch (e) {
      toast(errMsg(e), "bad");
    } finally {
      setAsking(false);
    }
  };

  const save = async (markChecked = false) => {
    if (!name.trim()) return toast("The food needs a name", "bad");
    setBusy(true);
    const body = {
      name: name.trim(),
      aliases: aliases.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean),
      per100g: n,
      gramsPerCup,
      gramsPerPiece,
      source: markChecked ? "manual" : numbersChanged && source === "ai" && food ? "manual" : source,
    };
    try {
      const res = food ? await api.put<{ updatedRecipes: string[] }>(`/api/foods/${food.id}`, body) : await api.post("/api/foods", body);
      await qc.invalidateQueries();
      const updated = (res as any).updatedRecipes?.length;
      toast(updated ? `Saved — ${updated} recipe${updated === 1 ? "" : "s"} re-totalled` : "Saved");
      onClose();
    } catch (e) {
      toast(errMsg(e), "bad");
      setBusy(false);
    }
  };

  return (
    <Modal title={food ? food.name : "Add a food"} onClose={onClose} wide>
      <div className="stack">
        <div className="grid2">
          <div className="field">
            <label>Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="chicken thigh" autoFocus={!food} />
          </div>
          <div className="field">
            <label>Also called (commas)</label>
            <input className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="thigh fillets" />
          </div>
        </div>
        <div className="row between wrap">
          <b>Per 100 g {source === "ai" && <AiMark />}</b>
          <button className="btn sm" onClick={ask} disabled={asking}>
            <Sparkle /> {asking ? "Asking…" : "Ask the AI to fill in"}
          </button>
        </div>
        <div className="grid4">
          {NUTRIENT_KEYS.map((k) => (
            <NumField key={k} label={NUTRIENT_LABELS[k].label} unit={NUTRIENT_LABELS[k].unit} value={n[k]} onChange={(v) => setNum(k, v)} />
          ))}
        </div>
        <div className="grid2">
          <NumField label="Grams in one cup" value={gramsPerCup} onChange={setGramsPerCup} hint="Lets “1 cup” be turned into grams" />
          <NumField label="Grams in one whole item" value={gramsPerPiece} onChange={setGramsPerPiece} hint="e.g. one egg ≈ 50" />
        </div>
        {food && <p className="small muted" style={{ margin: 0 }}>Used in {food.usedIn} recipe{food.usedIn === 1 ? "" : "s"}. Saving updates their totals.</p>}
        <div className="row wrap" style={{ justifyContent: "flex-end" }}>
          {food && (
            <button
              className="btn danger"
              onClick={async () => {
                if (await confirm({ title: `Delete “${food.name}”?`, message: food.usedIn ? "Recipes that use it keep their numbers but won't update from this food any more." : undefined, confirmLabel: "Delete", danger: true })) {
                  await api.del(`/api/foods/${food.id}`);
                  await qc.invalidateQueries();
                  onClose();
                }
              }}
            >
              <Trash /> Delete
            </button>
          )}
          <span className="grow" />
          {food?.source === "ai" && !numbersChanged && (
            <button className="btn soft" disabled={busy} onClick={() => save(true)}>
              ✓ Mark as checked
            </button>
          )}
          <button className="btn primary" disabled={busy} onClick={() => save()}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
