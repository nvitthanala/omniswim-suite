import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';
import { listFocusable } from './Modal';
export type FloatingWindowState = { x: number; y: number; w: number; h: number };
type Props = {
  title: string;
  open: boolean;
  onClose: () => void;
  state: FloatingWindowState;
  onStateChange: (next: FloatingWindowState) => void;
  minWidth?: number;
  minHeight?: number;
  headerActions?: ReactNode;
  children: ReactNode;
};
type DragMode = 'move' | 'resize' | null;
/** Pixels moved or resized per arrow key press. */
const KEY_STEP = 16;
const ARROW_DELTAS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
const KEYBOARD_HINT =
  'Use the arrow keys to move this window. Hold Shift and use the arrow keys to resize it. Press Escape to close it.';

type Bounds = { minWidth: number; minHeight: number; viewportW: number; viewportH: number };

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(low, value), high);

/** The window state after one arrow key press, kept inside the viewport like the pointer path. */
function stateAfterArrow(
  state: FloatingWindowState,
  delta: readonly [number, number],
  resize: boolean,
  bounds: Bounds,
): FloatingWindowState {
  const dx = delta[0] * KEY_STEP;
  const dy = delta[1] * KEY_STEP;
  if (resize) {
    const w = clamp(state.w + dx, bounds.minWidth, bounds.viewportW - state.x);
    const h = clamp(state.h + dy, bounds.minHeight, bounds.viewportH - state.y);
    return { ...state, w, h };
  }
  const x = clamp(state.x + dx, 0, Math.max(0, bounds.viewportW - state.w));
  const y = clamp(state.y + dy, 0, Math.max(0, bounds.viewportH - state.h));
  return { ...state, x, y };
}
export function FloatingWindow({
  title,
  open,
  onClose,
  state,
  onStateChange,
  minWidth = 280,
  minHeight = 200,
  headerActions,
  children,
}: Props) {
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  // Newest geometry, including a key press whose render has not committed yet, so a held
  // arrow key never repeats from a stale position.
  const latestState = useRef(state);
  latestState.current = state;
  const dragStart = useRef({ x: 0, y: 0, winX: 0, winY: 0, winW: 0, winH: 0 });
  const clampPosition = useCallback((x: number, y: number, w: number, h: number) => {
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }, []);
  const handlePointerDownMove = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragMode('move');
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      winX: state.x,
      winY: state.y,
      winW: state.w,
      winH: state.h,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const handlePointerDownResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setDragMode('resize');
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      winX: state.x,
      winY: state.y,
      winW: state.w,
      winH: state.h,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  useEffect(() => {
    if (!dragMode) return;
    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      if (dragMode === 'move') {
        const pos = clampPosition(
          dragStart.current.winX + dx,
          dragStart.current.winY + dy,
          state.w,
          state.h,
        );
        onStateChange({ ...state, ...pos });
      } else {
        const w = Math.max(minWidth, dragStart.current.winW + dx);
        const h = Math.max(minHeight, dragStart.current.winH + dy);
        const maxW = window.innerWidth - state.x;
        const maxH = window.innerHeight - state.y;
        onStateChange({ ...state, w: Math.min(w, maxW), h: Math.min(h, maxH) });
      }
    };
    const onUp = () => setDragMode(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragMode, state, onStateChange, clampPosition, minWidth, minHeight]);
  // Same focus handling as `Modal`, keyed on `open` because this component stays mounted while
  // closed: move focus in on open (the title bar comes first), hand it back on close. Not modal,
  // so Tab is not trapped and the page behind stays usable.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const win = windowRef.current;
    if (win) (listFocusable(win)[0] ?? win).focus();
    return () => {
      if (previous && previous.isConnected) previous.focus();
    };
  }, [open]);
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    // A dialog opened inside this window handles its own keys.
    if (target.closest('[role="dialog"]') !== e.currentTarget) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      // A Modal listens on `document`. Without this, one Escape closes the window and the modal.
      e.stopPropagation();
      onClose();
      return;
    }
    // Arrows belong to the title bar only, so inputs and lists in the body keep theirs.
    const delta = ARROW_DELTAS[e.key];
    if (!delta || target !== headerRef.current) return;
    e.preventDefault();
    const bounds = { minWidth, minHeight, viewportW: window.innerWidth, viewportH: window.innerHeight };
    const next = stateAfterArrow(latestState.current, delta, e.shiftKey, bounds);
    latestState.current = next;
    onStateChange(next);
  };
  if (!open) return null;
  return (
    <>
      {' '}
      {dragMode ? (
        <div
          className="floating-window-overlay"
          style={{ cursor: dragMode === 'move' ? 'grabbing' : 'nwse-resize' }}
          aria-hidden
        />
      ) : null}{' '}
      <div
        className="floating-window"
        style={{ left: state.x, top: state.y, width: state.w, height: state.h }}
        role="dialog"
        aria-label={title}
        tabIndex={-1}
        ref={windowRef}
        onKeyDown={handleKeyDown}
      >
        {' '}
        <div
          className="floating-window-header"
          ref={headerRef}
          tabIndex={0}
          role="group"
          aria-label={`${title} title bar`}
          aria-describedby={hintId}
          title="Arrow keys move, Shift plus arrow keys resize"
          onPointerDown={handlePointerDownMove}
        >
          <span id={hintId} className="sr-only">
            {KEYBOARD_HINT}
          </span>{' '}
          <span className="floating-window-title">{title}</span> {headerActions}{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            className="p-1.5"
            aria-label="Close"
            leadingIcon={<X size={14} />}
          />{' '}
        </div>{' '}
        <div className="floating-window-body">{children}</div>{' '}
        <div
          className="floating-window-resize"
          onPointerDown={handlePointerDownResize}
          aria-hidden
        />{' '}
      </div>{' '}
    </>
  );
}
