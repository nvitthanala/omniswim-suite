import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { RaceTag, RaceTagKind } from '../types';

export const TAG_KIND_COLOR: Record<RaceTagKind, string> = {
  Signal: '#eab308',
  Start: '#34d399',
  Entry: '#22d3ee',
  Breakout: '#fb923c',
  Stroke: '#fbbf24',
  TurnStart: '#a78bfa',
  TurnEnd: '#c084fc',
  Finish: '#f87171',
  FifteenMetre: '#f472b6',
  Flags: '#38bdf8',
  Kick: '#60a5fa',
};

export const ALL_TAG_KINDS: readonly RaceTagKind[] = [
  'Signal',
  'Start',
  'Entry',
  'Breakout',
  'Stroke',
  'TurnStart',
  'TurnEnd',
  'Finish',
  'FifteenMetre',
  'Flags',
  'Kick',
];

export const TAG_KIND_LABEL: Record<RaceTagKind, string> = {
  Signal: 'Signal',
  Start: 'Start',
  Entry: 'Entry',
  Breakout: 'Breakout',
  Stroke: 'Stroke',
  TurnStart: 'Turn Start',
  TurnEnd: 'Turn End',
  Finish: 'Finish',
  FifteenMetre: '15 m',
  Flags: 'Flags',
  Kick: 'Kick',
};

interface TagTimelineProps {
  tags: readonly RaceTag[];
  duration: number;
  /** True frame duration in seconds, from measured/overridden fps. Null when unknown — never fabricate one. */
  frameSeconds: number | null;
  onSeek: (time: number) => void;
  /** Committed the same way a typed nudge is: `index` is the tag's position in `tags`. */
  onTagTimeChange: (index: number, nextTime: number) => void;
}

const DRAG_THRESHOLD_PX = 4;

function snapToFrame(time: number, frameSeconds: number | null): number {
  if (frameSeconds === null) return time;
  return Math.round(time / frameSeconds) * frameSeconds;
}

type DragState = {
  index: number;
  pointerId: number;
  element: HTMLButtonElement;
  startClientX: number;
  originalTime: number;
  previewTime: number;
  moved: boolean;
};

export function TagTimeline({ tags, duration, frameSeconds, onSeek, onTagTimeChange }: TagTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const [dragPreview, setDragPreview] = useState<{ index: number; time: number } | null>(null);

  const cancelDrag = useCallback(() => {
    const drag = dragRef.current;
    if (drag) {
      try {
        drag.element.releasePointerCapture(drag.pointerId);
      } catch {
        // already released
      }
    }
    dragRef.current = null;
    setDragPreview(null);
  }, []);

  useEffect(() => {
    if (!dragPreview) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelDrag();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dragPreview, cancelDrag]);

  if (!(duration > 0)) return null;

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, index: number, tag: RaceTag) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      index,
      pointerId: event.pointerId,
      element: event.currentTarget,
      startClientX: event.clientX,
      originalTime: tag.time,
      previewTime: tag.time,
      moved: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const containerWidth = containerRef.current?.getBoundingClientRect().width;
    if (!containerWidth) return;
    const deltaX = event.clientX - drag.startClientX;
    if (!drag.moved && Math.abs(deltaX) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const deltaTime = (deltaX / containerWidth) * duration;
    const rawTime = Math.min(duration, Math.max(0, drag.originalTime + deltaTime));
    const nextTime = snapToFrame(rawTime, frameSeconds);
    drag.previewTime = nextTime;
    setDragPreview({ index: drag.index, time: nextTime });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    dragRef.current = null;
    setDragPreview(null);
    if (drag.moved) {
      onTagTimeChange(drag.index, drag.previewTime);
      // A completed drag is followed by a synthetic click; swallow it so the
      // retime is not immediately followed by a seek.
      suppressClickRef.current = true;
    }
    // A press that never moved is a click, and the click handler below does the
    // seek. Seeking here as well would leave keyboard users -- who get a click
    // with no pointer events at all -- as the only ones who could not seek.
  };

  /** Seek on click, which is what Enter/Space on a focused marker dispatches. */
  const handleClick = (time: number) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onSeek(time);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    cancelDrag();
  };

  return (
    <div ref={containerRef} className="absolute inset-0 z-20 pointer-events-none">
      {tags.map((tag, index) => {
        const isDragging = dragPreview !== null && dragPreview.index === index;
        const displayTime = isDragging ? dragPreview.time : tag.time;
        return (
          <button
            key={`${tag.kind}-${tag.time}-${index}`}
            type="button"
            onClick={() => handleClick(tag.time)}
            onPointerDown={(event) => handlePointerDown(event, index, tag)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            className={`absolute top-0 bottom-0 w-0.5 pointer-events-auto touch-none cursor-ew-resize hover:w-1 transition-[width] ${
              isDragging ? 'w-1 ring-2 ring-[var(--text-accent)]' : ''
            }`}
            style={{ left: `${(displayTime / duration) * 100}%`, backgroundColor: TAG_KIND_COLOR[tag.kind] }}
            title={`${TAG_KIND_LABEL[tag.kind]}${tag.lengthIndex !== undefined ? ` · L${tag.lengthIndex}` : ''} @ ${displayTime.toFixed(3)}s`}
            aria-label={`${TAG_KIND_LABEL[tag.kind]} tag at ${tag.time.toFixed(3)} seconds. Click to seek, drag to retime, Escape cancels a drag.`}
          />
        );
      })}
    </div>
  );
}
