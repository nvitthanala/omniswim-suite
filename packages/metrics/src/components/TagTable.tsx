import { useMemo } from 'react';
import { Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { validateRaceTags } from '@omniswim/core/lib/raceAnalysis';
import type { Problem, ProblemSeverity, RaceConfig, RaceTag, RaceTagKind } from '../types';
import { ALL_TAG_KINDS, TAG_KIND_COLOR, TAG_KIND_LABEL } from './TagTimeline';

interface TagTableProps {
  config: RaceConfig;
  tags: readonly RaceTag[];
  frameSeconds: number | null;
  onChange: (nextTags: RaceTag[]) => void;
}

function sortedByTime(tags: readonly RaceTag[]): RaceTag[] {
  return [...tags].sort((a, b) => a.time - b.time);
}

const SEVERITY_ORDER: readonly ProblemSeverity[] = ['error', 'warning', 'info'];
const SEVERITY_LABEL: Record<ProblemSeverity, string> = { error: 'Errors', warning: 'Warnings', info: 'Info' };
const SEVERITY_CLASS: Record<ProblemSeverity, string> = {
  error: 'border-red-500/40 text-red-500 dark:text-red-400',
  warning: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  info: 'border-theme-soft text-theme-muted',
};

export function TagTable({ config, tags, frameSeconds, onChange }: TagTableProps) {
  const rows = useMemo(() => sortedByTime(tags), [tags]);
  const problems = useMemo(() => validateRaceTags(config, rows), [config, rows]);
  const problemsBySeverity = useMemo(() => {
    const grouped: Record<ProblemSeverity, Problem[]> = { error: [], warning: [], info: [] };
    for (const problem of problems) grouped[problem.severity].push(problem);
    return grouped;
  }, [problems]);

  const updateRow = (index: number, updater: (tag: RaceTag) => RaceTag) => {
    const next = rows.map((tag, i) => (i === index ? updater(tag) : tag));
    onChange(sortedByTime(next));
  };

  const nudge = (index: number, direction: 1 | -1) => {
    if (frameSeconds === null) return;
    updateRow(index, (tag) => ({ ...tag, time: Math.max(0, tag.time + direction * frameSeconds) }));
  };

  const retype = (index: number, kind: RaceTagKind) => {
    updateRow(index, (tag) => ({ ...tag, kind }));
  };

  const deleteRow = (index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-theme-soft overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-3 py-2 bg-[var(--surface-muted)] text-ui-micro font-bold uppercase tracking-widest text-theme-muted">
          <span>Tag</span>
          <span>Length</span>
          <span>Time</span>
          <span className="text-right">Actions</span>
        </div>
        <div className="divide-y divide-[var(--border-soft)] max-h-72 overflow-y-auto custom-scrollbar">
          {rows.length === 0 ? (
            <div className="px-3 py-4 text-ui-caption text-theme-muted">No tags yet.</div>
          ) : (
            rows.map((tag, index) => (
              <div key={`${tag.kind}-${tag.time}-${index}`} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center px-3 py-2 text-ui-caption">
                <select
                  value={tag.kind}
                  onChange={(event) => retype(index, event.target.value as RaceTagKind)}
                  className="glass-input px-2 py-1 rounded text-ui-caption font-mono"
                  style={{ color: TAG_KIND_COLOR[tag.kind] }}
                >
                  {ALL_TAG_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {TAG_KIND_LABEL[kind]}
                    </option>
                  ))}
                </select>
                <span className="font-mono text-theme-muted text-center">{tag.lengthIndex ?? '—'}</span>
                <span className="font-mono tabular-nums text-[var(--text-primary)]">{tag.time.toFixed(3)}s</span>
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => nudge(index, -1)}
                    disabled={frameSeconds === null}
                    title={frameSeconds === null ? 'Set frame rate to nudge by frame' : 'Nudge back 1 frame'}
                    className="p-1 rounded theme-hover-row text-theme-muted hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronDown size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => nudge(index, 1)}
                    disabled={frameSeconds === null}
                    title={frameSeconds === null ? 'Set frame rate to nudge by frame' : 'Nudge forward 1 frame'}
                    className="p-1 rounded theme-hover-row text-theme-muted hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteRow(index)}
                    title="Delete tag"
                    className="p-1 rounded theme-hover-row text-theme-muted hover:text-red-400"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {problems.length > 0 ? (
        <div className="flex flex-col gap-2">
          {SEVERITY_ORDER.filter((severity) => problemsBySeverity[severity].length > 0).map((severity) => (
            <div key={severity} className={`rounded-lg border px-3 py-2 space-y-1 ${SEVERITY_CLASS[severity]}`}>
              <div className="text-ui-micro font-bold uppercase tracking-widest">{SEVERITY_LABEL[severity]}</div>
              {problemsBySeverity[severity].map((problem, i) => (
                <div key={`${problem.code}-${i}`} className="text-ui-caption">
                  {problem.message}
                  {problem.lengthIndex !== undefined ? <span className="opacity-70"> · L{problem.lengthIndex}</span> : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
