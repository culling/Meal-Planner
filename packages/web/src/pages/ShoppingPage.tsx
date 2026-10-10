import { dateRangeLabel, isoWeekOf, shiftWeek, todayYmd, type ShoppingItem } from "@mp/core/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, useShopping } from "../api";
import { ChevL, ChevR, Copy, Plus, Refresh, Trash } from "../icons";
import { CheckBox, Empty, ErrorBox, Loading, Modal, errMsg, useToast } from "../ui";

export function ShoppingPage() {
  const { week: weekParam } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const week = weekParam ?? isoWeekOf(todayYmd());
  const { data: list, error, isLoading, refetch } = useShopping(week);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [copyText, setCopyText] = useState<string | null>(null);

  if (isLoading) return <Loading />;
  if (error || !list) return <ErrorBox error={error ?? new Error("Couldn't load the list")} retry={() => refetch()} />;

  const items = list.items;
  const save = async (next: ShoppingItem[]) => {
    qc.setQueryData(["shopping", week], { ...list, items: next }); // instant feel; the server copy follows
    try {
      qc.setQueryData(["shopping", week], await api.put(`/api/meal-plans/${week}/shopping-list`, { items: next }));
    } catch (e) {
      toast(errMsg(e), "bad");
      void refetch();
    }
  };
  const toggle = (key: string) => save(items.map((i) => (i.key === key ? { ...i, checked: !i.checked } : i)));
  const regenerate = async () => {
    setBusy(true);
    try {
      qc.setQueryData(["shopping", week], await api.post(`/api/meal-plans/${week}/shopping-list`));
      toast("Updated from this week's plan");
    } catch (e) {
      toast(errMsg(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const addManual = () => {
    const t = text.trim();
    if (!t) return;
    const key = `manual-${Date.now().toString(36)}`;
    void save([...items, { key, text: t, checked: false, manual: true, from: [] }]);
    setText("");
  };

  const open = items.filter((i) => !i.checked);
  const done = items.filter((i) => i.checked);
  const asText = () => open.map((i) => `• ${i.text}`).join("\n");

  const row = (i: ShoppingItem) => (
    <div key={i.key} className={`shop-item ${i.checked ? "done" : ""}`} role="checkbox" aria-checked={i.checked} tabIndex={0} onClick={() => toggle(i.key)} onKeyDown={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), toggle(i.key))}>
      <CheckBox on={i.checked} />
      <div className="grow">
        <div className="txt" style={{ fontWeight: 600 }}>
          {i.text}
        </div>
        {i.from.length > 0 && <div className="tiny muted">{i.from.join(", ")}</div>}
      </div>
      {i.manual && (
        <button
          className="btn ghost icon sm"
          aria-label="Remove"
          onClick={(e) => {
            e.stopPropagation();
            void save(items.filter((x) => x.key !== i.key));
          }}
        >
          <Trash />
        </button>
      )}
    </div>
  );

  return (
    <>
      <div className="week-nav">
        <button className="btn icon" onClick={() => nav(`/shopping/${shiftWeek(week, -1)}`)} aria-label="Previous week">
          <ChevL />
        </button>
        <div className="title">
          Shopping list
          <small>
            Week {Number(week.slice(6))} · {dateRangeLabel(week)}
          </small>
        </div>
        <button className="btn icon" onClick={() => nav(`/shopping/${shiftWeek(week, 1)}`)} aria-label="Next week">
          <ChevR />
        </button>
      </div>

      <div className="row wrap">
        <button className="btn primary" disabled={busy} onClick={regenerate}>
          <Refresh /> {items.some((i) => !i.manual) ? "Update from the plan" : "Build from the plan"}
        </button>
        <Link className="btn" to={`/plan/${week}`}>
          See the plan
        </Link>
        {open.length > 0 && (
          <button className="btn" onClick={() => setCopyText(asText())}>
            <Copy /> Copy list
          </button>
        )}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Built from the meals you'll cook this week, scaled for the number of people. Ticks and your own items are kept when you update it.
      </p>

      <div className="row">
        <input className="input" placeholder="Add something else (bin bags, milk…)" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addManual()} />
        <button className="btn icon primary" onClick={addManual} aria-label="Add">
          <Plus />
        </button>
      </div>

      {items.length === 0 ? (
        <Empty emoji="🛒" title="Nothing on the list yet">
          Plan some meals to cook, then press “Build from the plan”.
        </Empty>
      ) : (
        <div className="card">
          <div className="small muted" style={{ marginBottom: 4 }}>
            {open.length} to get{done.length ? ` · ${done.length} done` : ""}
          </div>
          {open.map(row)}
          {done.length > 0 && (
            <>
              <div className="small muted" style={{ margin: "14px 0 0" }}>
                In the trolley
              </div>
              {done.map(row)}
              <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => save(items.map((i) => ({ ...i, checked: false })))}>
                Untick everything
              </button>
            </>
          )}
        </div>
      )}

      {copyText !== null && (
        <Modal title="Copy the list" onClose={() => setCopyText(null)}>
          <textarea className="input" style={{ minHeight: 240 }} readOnly value={copyText} onFocus={(e) => e.target.select()} />
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn primary grow"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(copyText);
                  toast("Copied");
                  setCopyText(null);
                } catch {
                  toast("Your browser won't let the page copy — select the text and copy it", "bad");
                }
              }}
            >
              Copy
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
