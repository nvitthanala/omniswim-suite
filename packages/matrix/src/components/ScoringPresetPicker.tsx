/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `ScoringSettingsFields`'s "Scoring preset" picker: the select plus the two
 * one-click quick presets, and the selected preset's citation/description/
 * host-published-table notice. Pure extraction from `ScoringSettingsFields.tsx`
 * — no behavior change.
 */

import type { ReactNode } from 'react';
import { Badge, Button } from '@omniswim/ui';
import type { ScoringPresetMeta } from '@omniswim/core/types';

interface ScoringPresetPickerProps {
  presets: ScoringPresetMeta[];
  selectedPreset: string;
  onSelectPreset: (id: string) => void;
  onApplyGenericTop16: () => void;
  onApplyTop24: () => void;
  presetPickerExtra?: ReactNode;
  hostTableRequired: { citation: string; message: string } | null;
}

export function ScoringPresetPicker({
  presets,
  selectedPreset,
  onSelectPreset,
  onApplyGenericTop16,
  onApplyTop24,
  presetPickerExtra,
  hostTableRequired,
}: ScoringPresetPickerProps) {
  const selected = presets.find(p => p.id === selectedPreset);
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <label className="block text-[10px] text-theme-secondary uppercase">Scoring preset</label>
        {presetPickerExtra}
      </div>
      <div className="flex flex-wrap gap-2 items-start">
        <select
          className="glass-input flex-1 min-w-[10rem] text-xs uppercase"
          aria-label="Scoring preset"
          value={selectedPreset}
          onChange={e => onSelectPreset(e.target.value)}
        >
          <option value="">Custom (current fields)</option>
          {presets.map(p => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.builtIn ? '' : ' (saved)'}
            </option>
          ))}
        </select>
        <Button variant="outline" size="sm" onClick={onApplyGenericTop16} className="shrink-0">
          Generic Top 16
        </Button>
        <Button variant="outline" size="sm" onClick={onApplyTop24} className="shrink-0">
          Top 24 points only
        </Button>
      </div>
      {selectedPreset && selected ? (
        <div className="mt-1.5 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {selected.builtIn ? <Badge tone="neutral">Built-in</Badge> : <Badge tone="accent">Saved</Badge>}
            {selected.citation ? <Badge tone="info">{selected.citation}</Badge> : null}
            {selected.requiresHostPublishedTable ? <Badge tone="warning">Host publishes this table</Badge> : null}
          </div>
          {selected.description ? <p className="text-[9px] text-theme-secondary italic">{selected.description}</p> : null}
          {hostTableRequired ? (
            <div className="p-2 rounded-lg badge-warning text-[10px] normal-case tracking-normal leading-relaxed">
              <span className="font-medium">No points table applied.</span> {hostTableRequired.citation} leaves this
              format&apos;s scoring to the host institution — the NCAA publishes no table for it. Enter the
              host&apos;s published points below; nothing here is a guess.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
