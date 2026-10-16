import { WEEKDAYS, type Settings } from "@mp/core/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, useSettings, useStatus } from "../api";
import { Alert, Check } from "../icons";
import { ErrorBox, Loading, NumField, Seg, TagInput, errMsg, useConfirm, useToast } from "../ui";

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

export function SettingsPage() {
  const { data: settings, error, refetch } = useSettings();
  const { data: status, refetch: refetchStatus } = useStatus();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings) setS(structuredClone(settings));
  }, [settings]);

  if (error) return <ErrorBox error={error} retry={() => refetch()} />;
  if (!s) return <Loading />;

  const models = status?.ollama.models ?? [];
  const visionModels = models.filter((m) => m.vision);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const save = async () => {
    if (settings && s.weekStartsOn !== settings.weekStartsOn) {
      const ok = await confirm({
        title: `Start each week on ${cap(s.weekStartsOn)}?`,
        message: "Your saved meals keep their dates and are regrouped into the new weeks (the plan files are renamed to match). Shopping lists are kept per week, so press “Update from the plan” on any you still need.",
        confirmLabel: "Change it",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.put("/api/settings", s);
      await qc.invalidateQueries();
      toast("Settings saved");
    } catch (e) {
      toast(errMsg(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const modelSelect = (value: string, onChange: (v: string) => void, list = models) => (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {!list.some((m) => m.name === value) && <option value={value}>{value} (not found)</option>}
      {list.map((m) => (
        <option key={m.name} value={m.name}>
          {m.name}
          {m.sizeGb ? ` · ${m.sizeGb} GB` : ""}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <button className="btn primary" disabled={!dirty || busy} onClick={save}>
          Save
        </button>
      </div>

      <div className="card stack">
        <h2>Meals & people</h2>
        <div className="grid2">
          <NumField label="People by default" value={s.defaultPeople} onChange={(n) => setS({ ...s, defaultPeople: n ?? 2 })} hint="You can override this for a whole week, a day, or a single meal." />
          <NumField label="Calorie target per person per day" unit="kcal" value={s.dailyCalorieTargetPerPerson} onChange={(n) => setS({ ...s, dailyCalorieTargetPerPerson: n })} hint="Shows how each day compares. Leave empty to skip." />
        </div>
        <div className="field">
          <label>Meals in a day</label>
          <TagInput value={s.mealSlots} onChange={(mealSlots) => setS({ ...s, mealSlots: mealSlots.length ? mealSlots : ["dinner"] })} suggestions={["breakfast", "lunch", "dinner", "snack", "dessert"]} placeholder="add: snack, dessert…" />
          <div className="hint">The plan shows these in order. Existing meals in a removed slot stay in the file.</div>
        </div>
        <NumField label="Fridge life to assume when a recipe doesn't say" unit="days" value={s.defaultLeftoverFridgeDays} onChange={(n) => setS({ ...s, defaultLeftoverFridgeDays: n ?? 3 })} />
        <div className="field">
          <label htmlFor="week-start">The week starts on</label>
          <select id="week-start" className="input" style={{ maxWidth: 240 }} value={s.weekStartsOn} onChange={(e) => setS({ ...s, weekStartsOn: e.target.value as Settings["weekStartsOn"] })}>
            {WEEKDAYS.map((d) => (
              <option key={d} value={d}>
                {cap(d)}
              </option>
            ))}
          </select>
          <div className="hint">The plan and shopping list run for seven days from here — for example Saturday to Friday if that's when you start cooking for the week.</div>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Measurements are metric.</p>
      </div>

      <div className="card stack">
        <div className="row between">
          <h2>Local AI</h2>
          {status && (
            <span className={`chip ${status.ollama.ok ? "green" : "red"}`}>
              {status.ollama.ok ? (
                <>
                  <Check /> Ollama connected
                </>
              ) : (
                <>
                  <Alert /> Not connected
                </>
              )}
            </span>
          )}
        </div>
        {status && !status.ollama.ok && (
          <div className="notice bad">
            <div>
              {status.ollama.error ?? "Can't reach Ollama."} Check that Ollama is running on that computer (and accepts connections from the network), or fix the address below, then press <b>Check again</b>.
            </div>
          </div>
        )}
        <p className="small muted" style={{ margin: 0 }}>
          Models run on your own computer through Ollama. Nothing is sent to the internet. Bigger models are more accurate and slower.
        </p>
        <div className="field">
          <label htmlFor="ollama-url">Ollama address</label>
          <input
            id="ollama-url"
            className="input"
            style={{ maxWidth: 360 }}
            value={s.ollamaUrl}
            placeholder={status?.ollama.envUrl ?? "http://localhost:11434"}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setS({ ...s, ollamaUrl: e.target.value })}
          />
          <div className="hint">
            The computer that runs Ollama — an IP address or name like <code>192.168.0.10</code> or <code>http://my-pc:11434</code> (port 11434 is added if you leave it out). Leave empty to use <code>OLLAMA_URL</code> from the <code>.env</code> file
            {status ? ` (${status.ollama.envUrl})` : ""}. Save to switch, and the model lists below update.
          </div>
        </div>
        <div className="field">
          <label>Reading photos of recipes</label>
          <Seg
            fill
            value={s.extraction.provider}
            options={[
              { value: "ollama", label: "Vision model" },
              { value: "lightonocr", label: "LightOnOCR + text model" },
            ]}
            onChange={(provider) => setS({ ...s, extraction: { ...s.extraction, provider } })}
          />
          <div className="hint">
            “Vision model” sends the photo straight to a model that can see (fast, good). “LightOnOCR” first turns the photo into text with your OCR tool, then a text model tidies it up
            {status && !status.lightOnOcr ? " — not found at the path in .env (LIGHTONOCR_DIR)" : ""}.
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label>Vision model (for photos)</label>
            {modelSelect(s.extraction.visionModel, (v) => setS({ ...s, extraction: { ...s.extraction, visionModel: v } }), visionModels.length ? visionModels : models)}
          </div>
          <div className="field">
            <label>Text model (tidies OCR text, reads web pages)</label>
            {modelSelect(s.extraction.textModel, (v) => setS({ ...s, extraction: { ...s.extraction, textModel: v } }))}
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label>Working out nutrition</label>
            <Seg
              fill
              value={s.nutrition.provider}
              options={[
                { value: "ollama", label: "Use the AI" },
                { value: "none", label: "Off" },
              ]}
              onChange={(provider) => setS({ ...s, nutrition: { ...s.nutrition, provider } })}
            />
          </div>
          <div className="field">
            <label>Nutrition model</label>
            {modelSelect(s.nutrition.model, (v) => setS({ ...s, nutrition: { ...s.nutrition, model: v } }))}
          </div>
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => refetchStatus()}>
            Check again
          </button>
          {status?.ollama.ok && <span className="small muted">{models.length} models available</span>}
        </div>
      </div>

      <div className="card stack">
        <h2>Your data</h2>
        <p className="small" style={{ margin: 0 }}>
          Everything is stored as plain Markdown files in <code>{status?.dataDir}</code> — you can open and edit them in any text editor, and changes show up here straight away.
        </p>
        <div className="small">
          <b>Version history:</b> {status?.git.enabled ? "on — every change is saved a few seconds later to a git history inside that folder." : "off (git wasn't found or auto-commit is switched off in .env)."}
        </div>
        {status?.git.enabled && status.git.history.length > 0 && (
          <details>
            <summary>Recent changes</summary>
            <div className="stack tight small" style={{ marginTop: 6 }}>
              {status.git.history.map((h) => (
                <div className="row between" key={h.hash}>
                  <span>{h.message}</span>
                  <span className="muted nowrap">{new Date(h.date).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        {status && status.problems.length > 0 && (
          <div className="notice warn">
            <div>
              <b>Files that couldn't be read</b>
              <ul>
                {status.problems.map((p) => (
                  <li key={p.slug}>
                    <code>{p.slug}</code> — {p.error}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      <div className="card stack">
        <h2>Using it on your phone</h2>
        <p className="small" style={{ margin: 0 }}>
          With your phone on the same Wi-Fi, open <code>{window.location.origin}</code>
          {window.location.hostname === "localhost" ? " — but swap “localhost” for this computer's address, shown in the window where the app is running." : "."} If it won't load, Windows Firewall may need to allow the app on private networks (the first run usually asks). On Chrome you can use ⋮ → <b>Add to Home screen</b> to get an icon.
        </p>
      </div>
    </>
  );
}
