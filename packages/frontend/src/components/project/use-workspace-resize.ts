import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

const MIN_WIDTH = 280;
const EXPAND_AT = 240;
const RESTORE_AT = 280;
const COLLAPSE_AT = 160;
const REOPEN_AT = 220;
const STORAGE_KEY = 'sky-panel-width';
export const WORKSPACE_RESIZE_EVENT = 'wing-workspace-resize';

/** Resize the existing workspace in place so editors and their drafts stay mounted. */
export function useWorkspaceResize(open: boolean, onCollapse: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  const finishDrag = useRef<(() => void) | null>(null);
  const [available, setAvailable] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [collapsing, setCollapsing] = useState(false);
  const [savedWidth, setSavedWidth] = useState(() => {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : 360;
  });
  const dockedWidth = available
    ? Math.min(savedWidth, Math.max(MIN_WIDTH, available - EXPAND_AT))
    : savedWidth;
  const compact = available > 0 && available < MIN_WIDTH + RESTORE_AT;
  const full = expanded || compact;

  useLayoutEffect(() => {
    const workspace = panel.current?.parentElement;
    if (!workspace) return;
    const measure = () => setAvailable(workspace.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open) finishDrag.current?.();
    return () => finishDrag.current?.();
  }, [open]);

  function persist(width: number) {
    setSavedWidth(width);
    localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || compact) return;
    const node = panel.current,
      workspace = node?.parentElement;
    if (!node || !workspace) return;
    event.preventDefault();
    finishDrag.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const bounds = workspace.getBoundingClientRect();
    // Pointer coordinates include interface zoom; widths are CSS layout pixels.
    const scale = bounds.width / workspace.clientWidth || 1;
    const grabOffset = (event.clientX - node.getBoundingClientRect().left) / scale;
    const start = { width: dockedWidth, expanded };
    let nextWidth = dockedWidth,
      nextExpanded = expanded,
      nextCollapsed = false;
    const oldCursor = document.body.style.cursor,
      oldSelect = document.body.style.userSelect;
    handle.setPointerCapture(pointerId);
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.body.dataset['wingWorkspaceResizing'] = 'true';
    window.dispatchEvent(new Event(WORKSPACE_RESIZE_EVENT));

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const currentBounds = workspace.getBoundingClientRect();
      const currentScale = currentBounds.width / workspace.clientWidth || 1;
      const requested = (currentBounds.right - ev.clientX) / currentScale + grabOffset;
      const remaining = workspace.clientWidth - requested;
      nextCollapsed = requested <= (nextCollapsed ? REOPEN_AT : COLLAPSE_AT);
      setCollapsing(nextCollapsed);
      if (nextCollapsed) {
        nextExpanded = false;
        setExpanded(false);
        return;
      }
      // Hysteresis prevents flicker at the expand boundary, including reversing
      // direction without releasing the same pointer gesture.
      nextExpanded = nextExpanded ? remaining < RESTORE_AT : remaining <= EXPAND_AT;
      if (!nextExpanded) {
        nextWidth = Math.max(MIN_WIDTH, Math.min(requested, workspace.clientWidth));
        setSavedWidth(nextWidth);
      }
      setExpanded(nextExpanded);
    };
    const finish = (cancel = false) => {
      finishDrag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', canceled);
      window.removeEventListener('blur', blurred);
      window.removeEventListener('keydown', key);
      handle.removeEventListener('lostpointercapture', canceled);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldSelect;
      delete document.body.dataset['wingWorkspaceResizing'];
      setDragging(false);
      setCollapsing(false);
      if (cancel) {
        setSavedWidth(start.width);
        setExpanded(start.expanded);
      } else if (nextCollapsed) {
        // Keep a zero-width preview during the gesture so pointer capture and
        // reversing direction work. Commit closing only when the drag ends.
        persist(start.width);
        setExpanded(false);
        onCollapse();
      } else {
        persist(nextWidth);
      }
      window.dispatchEvent(new Event(WORKSPACE_RESIZE_EVENT));
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) {
        move(ev);
        finish();
      }
    };
    const canceled = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(true);
    };
    const blurred = () => finish();
    const key = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(true);
      }
    };
    finishDrag.current = () => finish();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', canceled);
    window.addEventListener('blur', blurred);
    window.addEventListener('keydown', key);
    handle.addEventListener('lostpointercapture', canceled);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (compact || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'End') {
      setExpanded(true);
      return;
    }
    if (event.key === 'Enter') {
      setExpanded((value) => !value);
      return;
    }
    if (event.key === 'Home') {
      setExpanded(false);
      persist(MIN_WIDTH);
      return;
    }
    if (expanded) {
      if (event.key === 'ArrowRight') setExpanded(false);
      return;
    }
    if (event.key === 'ArrowRight' && dockedWidth <= MIN_WIDTH) {
      onCollapse();
      return;
    }
    const next = Math.max(MIN_WIDTH, dockedWidth + (event.key === 'ArrowLeft' ? 32 : -32));
    if (available - next <= EXPAND_AT) setExpanded(true);
    else persist(next);
  }

  return {
    panel,
    full,
    compact,
    dragging,
    collapsing,
    width: collapsing ? 0 : dockedWidth,
    available,
    minWidth: 0,
    onPointerDown,
    onKeyDown,
    toggleExpanded: () => setExpanded((value) => !value),
  };
}
