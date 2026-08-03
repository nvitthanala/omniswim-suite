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
  onSeek: (time: number) => void;
}

export function TagTimeline({ tags, duration, onSeek }: TagTimelineProps) {
  if (!(duration > 0)) return null;

  return (
    <div className="absolute inset-0 z-20 pointer-events-none">
      {tags.map((tag, index) => (
        <button
          key={`${tag.kind}-${tag.time}-${index}`}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSeek(tag.time);
          }}
          className="absolute top-0 bottom-0 w-0.5 pointer-events-auto cursor-pointer hover:w-1 transition-[width]"
          style={{ left: `${(tag.time / duration) * 100}%`, backgroundColor: TAG_KIND_COLOR[tag.kind] }}
          title={`${TAG_KIND_LABEL[tag.kind]}${tag.lengthIndex !== undefined ? ` · L${tag.lengthIndex}` : ''} @ ${tag.time.toFixed(3)}s`}
          aria-label={`Seek to ${TAG_KIND_LABEL[tag.kind]} tag at ${tag.time.toFixed(3)} seconds`}
        />
      ))}
    </div>
  );
}
