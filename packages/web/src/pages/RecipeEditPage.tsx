import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError, api, useRecipe, type RecipeFull } from "../api";
import { RecipeForm, SaveBar, blankForm, formFromRecipe, formToRecipeInput, type FormState } from "../components/RecipeForm";
import { ChevL } from "../icons";
import { ErrorBox, Loading, Modal, errMsg, useToast } from "../ui";

export function RecipeEditPage() {
  const { slug } = useParams();
  const { data: r, error, isLoading, refetch } = useRecipe(slug);
  if (slug && isLoading) return <Loading />;
  if (slug && (error || !r)) return <ErrorBox error={error ?? new Error("Recipe not found")} retry={() => refetch()} />;
  return <EditForm key={slug ?? "new"} recipe={r} />;
}

function EditForm({ recipe }: { recipe?: RecipeFull }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => (recipe ? formFromRecipe(recipe) : blankForm()));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const loadedMtime = useRef(recipe?.mtimeMs ?? null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const save = async () => {
    if (!form.title.trim()) return toast("Give the recipe a title first", "bad");
    setBusy(true);
    try {
      if (recipe) {
        await api.patch(`/api/recipes/${recipe.slug}`, { ...formToRecipeInput(form, false), expectedMtimeMs: loadedMtime.current });
        await qc.invalidateQueries();
        setDirty(false);
        toast("Saved");
        nav(`/recipes/${recipe.slug}`, { replace: true });
      } else {
        const created = await api.post<RecipeFull>("/api/recipes", formToRecipeInput(form, true));
        await qc.invalidateQueries();
        setDirty(false);
        toast("Recipe added");
        nav(`/recipes/${created.slug}`, { replace: true });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      else toast(errMsg(e), "bad");
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <button className="btn ghost icon" onClick={() => nav(-1)} aria-label="Back">
          <ChevL />
        </button>
        <h1>{recipe ? "Edit recipe" : "New recipe"}</h1>
      </div>
      <RecipeForm
        mode={recipe ? "edit" : "new"}
        value={form}
        onChange={(f) => {
          setForm(f);
          setDirty(true);
        }}
      />
      <SaveBar>
        <button className="btn" onClick={() => nav(-1)}>
          Cancel
        </button>
        <button className="btn primary grow" disabled={busy} onClick={save}>
          {recipe ? "Save changes" : "Add recipe"}
        </button>
      </SaveBar>
      {conflict && recipe && (
        <Modal title="This recipe changed" onClose={() => setConflict(false)}>
          <p>The file was edited somewhere else (a text editor, or another device) while you were working on it. Saving now would overwrite that.</p>
          <div className="stack tight">
            <button
              className="btn primary block"
              onClick={async () => {
                const fresh = await api.get<RecipeFull>(`/api/recipes/${recipe.slug}`);
                loadedMtime.current = fresh.mtimeMs;
                setConflict(false);
                setBusy(false);
                toast("Ready — press Save again to replace the other changes with yours");
              }}
            >
              Keep my version (overwrite theirs)
            </button>
            <button
              className="btn block"
              onClick={async () => {
                await qc.invalidateQueries();
                setDirty(false);
                nav(`/recipes/${recipe.slug}`, { replace: true });
              }}
            >
              Discard mine and look at the file
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
