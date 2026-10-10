import { useCallback, useEffect, useRef, useState } from "react";

export interface SlotRef {
  date: string;
  slot: string;
}
export const slotKey = (r: SlotRef) => `${r.date}/${r.slot}`;
const isPrep = (slot: string) => /^prep(-\d+)?$/.test(slot);

export interface DragState {
  /** fill = the round handle painting copies over slots; move = the meal itself being carried */
  kind: "fill" | "move";
  from: SlotRef;
  label: string;
  x: number;
  y: number;
  /** slots picked so far (fill) or the one slot being hovered (move) */
  targets: string[];
  /** the slot under the pointer right now (it is included when you let go) */
  hover: string | null;
  /** Ctrl/Cmd held while carrying a meal: duplicate instead of move */
  copy: boolean;
}

interface Handlers {
  onFill: (from: SlotRef, targets: SlotRef[]) => void;
  /** the handle was clicked without dragging */
  onHandleTap: (from: SlotRef) => void;
  onMove: (from: SlotRef, to: SlotRef, copy: boolean) => void;
}

const MOVE_PX = 6; // mouse: how far before a press becomes a drag
const LONG_PRESS_MS = 380; // touch: hold this long to pick a meal up (a quick swipe still scrolls the page)
const EDGE_PX = 70; // near the top/bottom of the window the page scrolls while dragging
const DWELL_MS = 350; // pause this long on a slot of another meal to include it while filling

function slotAt(x: number, y: number): SlotRef | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-slot-date]");
  return el ? { date: el.dataset.slotDate!, slot: el.dataset.slotName! } : null;
}

/**
 * Pointer-based dragging for the plan grid, so it works with a mouse, a pen and a finger:
 *  • the fill handle paints copies over the slots you sweep across (release to apply; a tap opens "choose slots" mode)
 *  • pressing on a meal and dragging carries it (move); hold Ctrl (⌘ on Mac) to duplicate instead
 *  • on touch, hold a meal for a moment to pick it up
 */
export function usePlanDrag(handlers: Handlers) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const h = useRef(handlers);
  h.current = handlers;
  const live = useRef<DragState | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const justDragged = useRef(false);

  useEffect(() => () => cleanup.current?.(), []);

  const begin = useCallback((initial: DragState, e: PointerEvent | React.PointerEvent, moved0 = false) => {
    cleanup.current?.();
    let moved = moved0;
    let raf = 0;
    let lastY = e.clientY;
    let dwellTimer: ReturnType<typeof setTimeout> | null = null;
    let dwellKey: string | null = null;
    // dragging out of the make-ahead row: the meal you first pause on (say lunch) becomes the one filled along the row
    let eatingMeal: string | null = null;
    live.current = initial;
    setDrag(initial);

    const update = (patch: Partial<DragState>) => {
      live.current = { ...live.current!, ...patch };
      setDrag(live.current);
    };
    const onMove = (ev: PointerEvent) => {
      const cur = live.current;
      if (!cur) return;
      moved = true;
      lastY = ev.clientY;
      const over = slotAt(ev.clientX, ev.clientY);
      const overKey = over ? slotKey(over) : null;
      let targets = cur.targets;
      if (cur.kind === "fill") {
        // sweeping along the same meal (lunch → lunch → lunch) picks each slot you cross; slots of other meals are only
        // picked if you pause on them (or let go on them), so a diagonal sweep doesn't grab everything in between
        const fromPrep = isPrep(cur.from.slot);
        const sameMeal = fromPrep ? eatingMeal : cur.from.slot;
        const pickable = !!over && !isPrep(over.slot) && overKey !== slotKey(cur.from);
        if (pickable && over!.slot === sameMeal && !targets.includes(overKey!)) targets = [...targets, overKey!];
        if (overKey !== dwellKey) {
          if (dwellTimer) clearTimeout(dwellTimer);
          dwellKey = overKey;
          if (pickable && over!.slot !== sameMeal) {
            const k = overKey!;
            dwellTimer = setTimeout(() => {
              const now = live.current;
              if (now && dwellKey === k && !now.targets.includes(k)) {
                if (isPrep(now.from.slot) && !eatingMeal) eatingMeal = k.slice(11);
                update({ targets: [...now.targets, k] });
              }
            }, DWELL_MS);
          }
        }
      } else {
        targets = over && overKey !== slotKey(cur.from) ? [overKey!] : [];
      }
      update({ x: ev.clientX, y: ev.clientY, targets, hover: overKey, copy: ev.ctrlKey || ev.metaKey });
    };
    const scroller = () => {
      if (!live.current) return;
      if (lastY < EDGE_PX) window.scrollBy(0, -14);
      else if (lastY > window.innerHeight - EDGE_PX) window.scrollBy(0, 14);
      raf = requestAnimationFrame(scroller);
    };
    raf = requestAnimationFrame(scroller);
    const blockTouchScroll = (ev: TouchEvent) => ev.cancelable && ev.preventDefault();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") stop(false);
      else if (ev.key === "Control" || ev.key === "Meta") update({ copy: ev.type === "keydown" });
    };
    const onUp = (ev: PointerEvent) => {
      const cur = live.current;
      stop(true, ev, cur);
    };
    const onCancel = () => stop(false);

    function stop(apply: boolean, ev?: PointerEvent, cur?: DragState | null) {
      cancelAnimationFrame(raf);
      if (dwellTimer) clearTimeout(dwellTimer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("touchmove", blockTouchScroll);
      cleanup.current = null;
      live.current = null;
      setDrag(null);
      if (moved) {
        // the click that follows a drag must not open the meal
        justDragged.current = true;
        setTimeout(() => (justDragged.current = false), 0);
      }
      if (!apply || !cur) return;
      const parse = (k: string): SlotRef => ({ date: k.slice(0, 10), slot: k.slice(11) });
      if (cur.kind === "fill") {
        // the slot under the pointer when you let go always counts
        const finalKey = cur.hover && cur.hover !== slotKey(cur.from) && !cur.targets.includes(cur.hover) && !isPrep(cur.hover.slice(11)) ? [cur.hover] : [];
        const all = [...cur.targets, ...finalKey];
        if (all.length) h.current.onFill(cur.from, all.map(parse));
        else h.current.onHandleTap(cur.from);
      } else if (cur.targets.length) {
        h.current.onMove(cur.from, parse(cur.targets[0]), !!(ev?.ctrlKey || ev?.metaKey || cur.copy));
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("touchmove", blockTouchScroll, { passive: false });
    cleanup.current = () => stop(false);
  }, []);

  /** props for the round fill handle on a filled slot */
  const handleProps = (from: SlotRef, label: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      begin({ kind: "fill", from, label, x: e.clientX, y: e.clientY, targets: [], hover: null, copy: false }, e);
    },
    // a keyboard press on the handle behaves like a tap
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        h.current.onHandleTap(from);
      }
    },
  });

  /** props for the meal button: drag to move, Ctrl+drag to duplicate */
  const mealProps = (from: SlotRef, label: string) => ({
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(), // long-press on a phone shouldn't pop a menu
    onClickCapture: (e: React.MouseEvent) => {
      if (justDragged.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const make = (x: number, y: number, copy: boolean): DragState => ({ kind: "move", from, label, x, y, targets: [], hover: null, copy });
      if (e.pointerType === "touch") {
        // hold to pick up; moving before that means the user is scrolling
        let armed = true;
        const timer = setTimeout(() => {
          if (!armed) return;
          armed = false;
          stopWatching();
          navigator.vibrate?.(15);
          begin(make(sx, sy, false), e, true);
        }, LONG_PRESS_MS);
        const early = (ev: PointerEvent) => {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) {
            armed = false;
            clearTimeout(timer);
            stopWatching();
          }
        };
        const stopWatching = () => {
          window.removeEventListener("pointermove", early);
          window.removeEventListener("pointerup", early);
          window.removeEventListener("pointercancel", early);
          clearTimeout(timer);
        };
        window.addEventListener("pointermove", early);
        window.addEventListener("pointerup", () => (armed = false, stopWatching()), { once: true });
        window.addEventListener("pointercancel", () => (armed = false, stopWatching()), { once: true });
        return;
      }
      // mouse / pen: a press that travels a few pixels becomes a drag
      const probe = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < MOVE_PX) return;
        window.removeEventListener("pointermove", probe);
        window.removeEventListener("pointerup", release);
        begin(make(ev.clientX, ev.clientY, ev.ctrlKey || ev.metaKey), ev, true);
      };
      const release = () => {
        window.removeEventListener("pointermove", probe);
        window.removeEventListener("pointerup", release);
      };
      window.addEventListener("pointermove", probe);
      window.addEventListener("pointerup", release);
    },
  });

  return { drag, handleProps, mealProps };
}
