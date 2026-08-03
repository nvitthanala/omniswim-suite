import { tagsOfKind } from '@omniswim/core/lib/raceAnalysis';
import type { RaceTag, RaceTagStateMachine, TagPreview } from '../types';
import { ALL_TAG_KINDS, TAG_KIND_COLOR, TAG_KIND_LABEL } from './TagTimeline';

const LEGEND: ReadonlyArray<{ key: string; description: string; addition?: boolean }> = [
  { key: 'S', description: 'Start → Entry → Breakout → Stroke (repeats within a length)' },
  { key: 'D', description: 'Turn Start → Turn End (Finish on the final length)' },
  { key: 'A', description: '15 m mark' },
  { key: 'R', description: 'Starting signal (horn / strobe)', addition: true },
  { key: 'G', description: 'Flags crossing on the final length', addition: true },
  { key: 'K', description: 'Underwater dolphin kick', addition: true },
  { key: 'Ctrl+Z', description: 'Undo the last tag' },
];

interface TagDeckProps {
  machine: RaceTagStateMachine;
  tags: readonly RaceTag[];
  lengthCount: number;
  fifteenMetreGateReason?: string;
}

function PreviewChip({ label, preview, gateReason }: { label: string; preview: TagPreview; gateReason?: string }) {
  const blocked = preview.status === 'illegal' || gateReason !== undefined;
  const kindLabel = preview.kind !== undefined ? TAG_KIND_LABEL[preview.kind] : undefined;
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2 ${
        blocked ? 'border-theme-soft bg-[var(--surface-muted)] opacity-70' : 'border-[var(--text-accent)]/40 bg-[var(--surface)]'
      }`}
    >
      <span className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted">{label}</span>
      {blocked ? (
        <span className="text-ui-caption text-theme-muted">{gateReason ?? preview.reason ?? 'not available'}</span>
      ) : (
        <span className="text-ui-body font-bold text-[var(--text-primary)]">
          {kindLabel}
          {preview.lengthIndex !== undefined ? <span className="text-theme-muted"> · L{preview.lengthIndex}</span> : null}
        </span>
      )}
    </div>
  );
}

export function TagDeck({ machine, tags, lengthCount, fifteenMetreGateReason }: TagDeckProps) {
  const nextS = machine.nextS();
  const nextD = machine.nextD();
  const nextA = machine.nextA();
  const currentLength = nextS.lengthIndex ?? nextD.lengthIndex ?? (tagsOfKind(tags, 'Finish').length > 0 ? lengthCount : 1);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-theme-soft bg-[var(--surface)]/95 backdrop-blur-sm p-3 shadow-[var(--ui-shadow-lg)]">
      <div className="flex items-center justify-between border-b border-theme-soft pb-2">
        <span className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted">Length</span>
        <span className="text-ui-body font-bold text-[var(--text-primary)]">
          {currentLength} / {lengthCount}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <PreviewChip label="Next S" preview={nextS} />
        <PreviewChip label="Next D" preview={nextD} />
        <PreviewChip label="Next A" preview={nextA} gateReason={fifteenMetreGateReason} />
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {ALL_TAG_KINDS.map((kind) => (
          <div key={kind} className="flex items-center justify-between text-ui-micro font-mono">
            <span className="flex items-center gap-1.5 text-theme-muted">
              <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: TAG_KIND_COLOR[kind] }} />
              {TAG_KIND_LABEL[kind]}
            </span>
            <span className="font-bold text-[var(--text-primary)]">{tagsOfKind(tags, kind).length}</span>
          </div>
        ))}
      </div>

      <div className="border-t border-theme-soft pt-2 space-y-1">
        {LEGEND.map((row) => (
          <div key={row.key} className="flex items-start justify-between gap-2 text-ui-micro">
            <span className="bg-[var(--surface-muted)] border border-theme-soft rounded px-1.5 py-0.5 font-mono font-bold text-[var(--text-primary)] shrink-0">
              {row.key}
            </span>
            <span className="text-theme-muted text-right">
              {row.description}
              {row.addition ? (
                <span className="block text-[var(--text-accent)] font-bold">OmniSwim addition — not a Swimcloud key</span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
