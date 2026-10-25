/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F3: compare any two saved scenario snapshots. The coach picks snapshot A
 * and snapshot B from the scenario list. The parent supplies `loadDiff`, which
 * scores both through `computeScenarioDiff`. A is the "before" side and B is
 * the "after" side. Nothing is restored.
 */

import React, { useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Snapshot } from '@omniswim/core/api/snapshots';
import type { ScenarioDiffResult } from '@omniswim/core/lib/scenarioDiffClient';
import { ScenarioCompareResult } from './ScenarioCompareTables';
import { snapshotOptionLabel } from './scenarioCompareView';

type Props = {
  /** Saved snapshots, newest first. */
  snapshots: Snapshot[];
  /** Score snapshot `aId` ("before") against snapshot `bId` ("after"). */
  loadDiff: (aId: string, bId: string) => Promise<ScenarioDiffResult>;
  /** False hides the section (no team or gender chosen). Default true. */
  enabled?: boolean;
};

type View =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'result'; result: ScenarioDiffResult };

const SELECT_CLASS = 'glass-input w-full min-w-0 rounded-lg px-2.5 py-1.5 text-ui-caption';

type PickerProps = {
  id: string;
  label: string;
  value: string;
  snapshots: Snapshot[];
  onChange: (id: string) => void;
};

function SnapshotPicker({ id, label, value, snapshots, onChange }: PickerProps) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-ui-micro font-medium text-theme-secondary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">Choose a snapshot</option>
        {snapshots.map(snap => (
          <option key={snap.id} value={snap.id}>
            {snapshotOptionLabel(snap)}
          </option>
        ))}
      </select>
    </div>
  );
}

function CompareStatus({ view, labelA, labelB }: { view: View; labelA: string; labelB: string }) {
  if (view.kind === 'loading') {
    return (
      <p className="flex items-center gap-1.5 text-ui-caption text-theme-muted">
        <Loader2 size={12} className="animate-spin" />
        Comparing…
      </p>
    );
  }
  if (view.kind === 'error') {
    return (
      <p role="alert" className="text-ui-caption text-warning-soft leading-relaxed">
        {view.message}
      </p>
    );
  }
  if (view.kind === 'result') {
    return <ScenarioCompareResult result={view.result} labelA={labelA} labelB={labelB} />;
  }
  return (
    <p className="text-ui-caption text-theme-muted leading-relaxed">
      Choose a snapshot for A and for B to see what changed.
    </p>
  );
}

export default function ScenarioCompare({ snapshots, loadDiff, enabled = true }: Props) {
  const baseId = useId();
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');
  const [view, setView] = useState<View>({ kind: 'idle' });
  const latestRequest = useRef(0);

  const run = (nextA: string, nextB: string) => {
    const request = ++latestRequest.current;
    if (!nextA || !nextB) {
      setView({ kind: 'idle' });
      return;
    }
    setView({ kind: 'loading' });
    loadDiff(nextA, nextB).then(
      result => {
        if (request === latestRequest.current) setView({ kind: 'result', result });
      },
      (err: unknown) => {
        if (request !== latestRequest.current) return;
        const message = err instanceof Error ? err.message : 'Could not compare these snapshots.';
        setView({ kind: 'error', message });
      }
    );
  };

  const pickA = (id: string) => {
    setAId(id);
    run(id, bId);
  };
  const pickB = (id: string) => {
    setBId(id);
    run(aId, id);
  };

  const labelOf = (id: string) => {
    const snap = snapshots.find(s => s.id === id);
    return snap ? snapshotOptionLabel(snap) : '';
  };

  if (!enabled || snapshots.length < 2) return null;

  return (
    <details className="mt-4 border-t border-theme-soft pt-3">
      <summary className="cursor-pointer text-ui-caption font-semibold text-[var(--text-primary)]">
        Compare two scenarios
      </summary>
      <div className="mt-2.5 space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <SnapshotPicker
            id={`${baseId}-a`}
            label="Snapshot A (before)"
            value={aId}
            snapshots={snapshots}
            onChange={pickA}
          />
          <SnapshotPicker
            id={`${baseId}-b`}
            label="Snapshot B (after)"
            value={bId}
            snapshots={snapshots}
            onChange={pickB}
          />
        </div>
        <div aria-live="polite">
          <CompareStatus view={view} labelA={labelOf(aId)} labelB={labelOf(bId)} />
        </div>
      </div>
    </details>
  );
}
