/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Full CRUD over scoring rule sets, against the routes P1 landed on
 * `apps/shell/server.ts` (`GET/POST/PUT/DELETE /api/scoring-presets[/:id]`,
 * client wrappers in `@omniswim/core/lib/scoringPresets`). `ScoringSettingsFields`
 * only ever picks a preset and edits the workspace's own draft; this modal is
 * the separate "manage the library itself" surface — create, duplicate a
 * built-in to edit, edit or delete a saved one, and import/export a rule set
 * as a file so a format can be handed to another coach.
 *
 * Built-ins are immutable by rule, not by omission: the server rejects a
 * write against a built-in id (see `parsePresetWrite` in server.ts), so this
 * modal never offers "Edit" on one — only "Duplicate to edit", which copies
 * its settings into a new, editable id. A preset with no published table
 * (`requiresHostPublishedTable`, NCAA Rule 7-4's invitational format) still
 * duplicates — into a *blank* points table the coach fills in from the
 * host's own sheet, never an invented one.
 */
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { AlertTriangle, Download, FileUp, Pencil, Plus, Settings2 } from 'lucide-react';
import { Badge, Button, ConfirmDeleteModal, Modal } from '@omniswim/ui';
import { ScoringPresetMeta, ScoringSettings } from '@omniswim/core/types';
import {
  ScoringPresetApiError,
  createScoringPreset,
  deleteScoringPreset,
  fetchScoringPresetList,
  fetchScoringPresetSettings,
  updateScoringPreset,
} from '@omniswim/core/lib/scoringPresets';
import {
  GENERIC_TOP16_SETTINGS,
  HostPublishedTableRequiredError,
  SCORING_PRESET_META_KEYS,
} from '@omniswim/core/lib/scoringDefaults';
import { ScoringSettingsFields } from './ScoringSettingsFields';

export interface ScoringPresetManagerModalProps {
  onClose: () => void;
  /**
   * Called after any create/update/delete so a host holding its own preset
   * list (e.g. `ScoringSettingsFields`'s picker) can refetch. Optional —
   * the manager works standalone.
   */
  onPresetsChanged?: () => void;
}

const USER_PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/** Lowercases, replaces runs of non-id characters with `-`, trims to the id shape the server requires. */
export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return USER_PRESET_ID_RE.test(slug) ? slug : `preset-${Date.now()}`;
}

interface EditorState {
  /** Absent = creating; present = editing this existing user preset's id. */
  editingId: string | null;
  id: string;
  label: string;
  description: string;
  conferenceMatches: string;
  settings: ScoringSettings;
}

/** The file shape this modal reads and writes. Deliberately close to `ScoringPresetWriteInput`. */
export interface ExportedPresetFile {
  omniswimScoringPreset: 1;
  id: string;
  label: string;
  description?: string;
  conferenceMatches?: string[];
  settings: ScoringSettings;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Structural check before anything touches the server. Names the first thing
 * wrong rather than a generic "invalid file" — CLAUDE.md's provenance rule
 * applies here too: a malformed points table must never be silently coerced.
 */
export function validateImportedPresetFile(raw: unknown): { file: ExportedPresetFile } | { error: string } {
  if (!isPlainObject(raw)) return { error: 'The file does not contain a JSON object.' };
  if (raw.omniswimScoringPreset !== 1) {
    return { error: 'Not an Omniswim scoring preset file (missing or wrong "omniswimScoringPreset" marker).' };
  }
  if (typeof raw.label !== 'string' || !raw.label.trim()) {
    return { error: 'Missing or empty "label".' };
  }
  if (!isPlainObject(raw.settings)) {
    return { error: 'Missing "settings" object.' };
  }
  const settings = raw.settings as Record<string, unknown>;
  if (!Array.isArray(settings.scoringPoints) || !settings.scoringPoints.every(n => typeof n === 'number')) {
    return { error: '"settings.scoringPoints" must be an array of numbers.' };
  }
  if (settings.relayPoints !== undefined) {
    if (!Array.isArray(settings.relayPoints) || !settings.relayPoints.every(n => typeof n === 'number')) {
      return { error: '"settings.relayPoints" must be an array of numbers when present.' };
    }
  }
  if (settings.divingPoints !== undefined) {
    if (!Array.isArray(settings.divingPoints) || !settings.divingPoints.every(n => typeof n === 'number')) {
      return { error: '"settings.divingPoints" must be an array of numbers when present.' };
    }
  }
  if (raw.conferenceMatches !== undefined) {
    if (!Array.isArray(raw.conferenceMatches) || !raw.conferenceMatches.every(s => typeof s === 'string')) {
      return { error: '"conferenceMatches" must be an array of strings when present.' };
    }
  }
  if (raw.id !== undefined && typeof raw.id !== 'string') {
    return { error: '"id" must be a string when present.' };
  }
  return {
    file: {
      omniswimScoringPreset: 1,
      id: typeof raw.id === 'string' && USER_PRESET_ID_RE.test(raw.id) ? raw.id : slugify(raw.label),
      label: raw.label,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      conferenceMatches: raw.conferenceMatches as string[] | undefined,
      settings: settings as unknown as ScoringSettings,
    },
  };
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ScoringPresetManagerModal({ onClose, onPresetsChanged }: ScoringPresetManagerModalProps) {
  const [presets, setPresets] = useState<ScoringPresetMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScoringPresetMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setListError(null);
    try {
      setPresets(await fetchScoringPresetList());
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not load scoring presets.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const notifyChanged = () => {
    onPresetsChanged?.();
    void reload();
  };

  const grouped = useMemo(() => {
    const byGroup = new Map<string, ScoringPresetMeta[]>();
    for (const p of presets) {
      const g = p.group ?? (p.builtIn ? 'Built-in' : 'Saved rule sets');
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(p);
    }
    return [...byGroup.entries()];
  }, [presets]);

  const openCreate = () => {
    setSaveError(null);
    setEditor({
      editingId: null,
      id: '',
      label: '',
      description: '',
      conferenceMatches: '',
      settings: GENERIC_TOP16_SETTINGS,
    });
  };

  const openEdit = async (preset: ScoringPresetMeta) => {
    setSaveError(null);
    try {
      const settings = await fetchScoringPresetSettings(preset.id);
      setEditor({
        editingId: preset.id,
        id: preset.id,
        label: preset.label,
        description: preset.description ?? '',
        conferenceMatches: (preset.conferenceMatches ?? []).join(', '),
        settings,
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not load this preset.');
    }
  };

  /** Built-in → new editable copy. A host-table-required built-in copies with an empty table, never an invented one. */
  const openDuplicate = async (preset: ScoringPresetMeta) => {
    setSaveError(null);
    let settings: ScoringSettings;
    try {
      settings = await fetchScoringPresetSettings(preset.id);
    } catch (err) {
      if (err instanceof HostPublishedTableRequiredError) {
        settings = { ...GENERIC_TOP16_SETTINGS, scoringPoints: [] };
      } else {
        setSaveError(err instanceof Error ? err.message : 'Could not load this preset.');
        return;
      }
    }
    setEditor({
      editingId: null,
      id: slugify(`${preset.label}-copy`),
      label: `${preset.label} (copy)`,
      description: preset.description ?? '',
      conferenceMatches: '',
      settings,
    });
  };

  const openImport = (file: ExportedPresetFile) => {
    setSaveError(null);
    setEditor({
      editingId: null,
      id: file.id,
      label: file.label,
      description: file.description ?? '',
      conferenceMatches: (file.conferenceMatches ?? []).join(', '),
      settings: file.settings,
    });
  };

  const handleImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    setImportError(null);
    const reader = new FileReader();
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        setImportError(`"${file.name}" is not valid JSON.`);
        input.value = '';
        return;
      }
      const result = validateImportedPresetFile(parsed);
      if ('error' in result) {
        setImportError(`"${file.name}": ${result.error}`);
        input.value = '';
        return;
      }
      openImport(result.file);
      input.value = '';
    };
    reader.onerror = () => {
      setImportError(`Could not read "${file.name}".`);
      input.value = '';
    };
    reader.readAsText(file);
  };

  const exportPreset = async (preset: ScoringPresetMeta) => {
    try {
      const settings = await fetchScoringPresetSettings(preset.id);
      const file: ExportedPresetFile = {
        omniswimScoringPreset: 1,
        id: preset.id,
        label: preset.label,
        description: preset.description,
        conferenceMatches: preset.conferenceMatches,
        settings,
      };
      downloadJson(`${preset.id}.omniswim-scoring-preset.json`, file);
    } catch (err) {
      if (err instanceof HostPublishedTableRequiredError) {
        setListError(`"${preset.label}" carries no points table (${err.citation}) — nothing to export.`);
        return;
      }
      setListError(err instanceof Error ? err.message : 'Could not export this preset.');
    }
  };

  const saveEditor = async () => {
    if (!editor) return;
    setSaveError(null);
    if (!USER_PRESET_ID_RE.test(editor.id)) {
      setSaveError(
        'Preset id must be lowercase letters, digits, hyphens or underscores, start with a letter or digit, and be at most 80 characters.'
      );
      return;
    }
    if (!editor.label.trim()) {
      setSaveError('Give this rule set a label.');
      return;
    }
    if (!editor.settings.scoringPoints.length) {
      setSaveError('Enter at least one scoring place before saving.');
      return;
    }
    const conferenceMatches = editor.conferenceMatches
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    // Strip any preset-meta keys that leaked into `settings` (e.g. from a
    // round-tripped GET /:id payload) — the server's schema is strict and
    // rejects unknown keys outright.
    const settings = { ...editor.settings } as Record<string, unknown>;
    for (const key of SCORING_PRESET_META_KEYS) delete settings[key];
    const input = {
      id: editor.id,
      label: editor.label.trim(),
      description: editor.description.trim() || undefined,
      conferenceMatches: conferenceMatches.length ? conferenceMatches : undefined,
      settings: settings as unknown as ScoringSettings,
    };
    setSaving(true);
    try {
      if (editor.editingId) {
        await updateScoringPreset(editor.editingId, input);
      } else {
        await createScoringPreset(input);
      }
      setEditor(null);
      notifyChanged();
    } catch (err) {
      if (err instanceof ScoringPresetApiError) {
        const detail = err.details.map(d => `${d.path}: ${d.message}`).join('; ');
        setSaveError(detail ? `${err.message} (${detail})` : err.message);
      } else {
        setSaveError(err instanceof Error ? err.message : 'Could not save this rule set.');
      }
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteScoringPreset(deleteTarget.id);
      setDeleteTarget(null);
      notifyChanged();
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not delete this rule set.');
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  if (editor) {
    return (
      <Modal
        onClose={() => setEditor(null)}
        ariaLabel={editor.editingId ? 'Edit scoring rule set' : 'New scoring rule set'}
        className="rounded-2xl p-6 max-w-2xl w-full mx-4 shadow-2xl max-h-[90vh] flex flex-col"
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-medium text-[var(--text-primary)] uppercase tracking-tight">
            {editor.editingId ? `Edit "${editor.label}"` : 'New scoring rule set'}
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-theme-secondary uppercase mb-1">Id</label>
              <input
                type="text"
                aria-label="Preset id"
                value={editor.id}
                disabled={editor.editingId != null}
                onChange={e => setEditor({ ...editor, id: e.target.value })}
                className="glass-input w-full text-xs font-mono disabled:opacity-60"
                title={editor.editingId != null ? "A saved rule set's id cannot change." : undefined}
              />
            </div>
            <div>
              <label className="block text-[10px] text-theme-secondary uppercase mb-1">Label</label>
              <input
                type="text"
                aria-label="Preset label"
                value={editor.label}
                onChange={e =>
                  setEditor({
                    ...editor,
                    label: e.target.value,
                    id: editor.editingId ? editor.id : editor.id || slugify(e.target.value),
                  })
                }
                className="glass-input w-full text-xs"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Description</label>
            <textarea
              aria-label="Preset description"
              value={editor.description}
              onChange={e => setEditor({ ...editor, description: e.target.value })}
              className="glass-input w-full text-xs min-h-[3rem]"
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">
              Conference matches (comma-separated)
            </label>
            <input
              type="text"
              aria-label="Conference matches"
              placeholder="e.g. NSISC, GSC"
              value={editor.conferenceMatches}
              onChange={e => setEditor({ ...editor, conferenceMatches: e.target.value })}
              className="glass-input w-full text-xs"
            />
          </div>

          <div className="border-t border-theme-soft pt-4">
            <ScoringSettingsFields
              settings={editor.settings}
              onChange={next => setEditor(prev => (prev ? { ...prev, settings: next } : prev))}
              hidePresetPicker
            />
          </div>

          {saveError ? (
            <div className="p-2 rounded-lg badge-warning text-[10px] flex items-start gap-2">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
              <span>{saveError}</span>
            </div>
          ) : null}
        </div>

        <div className="pt-4 mt-2 border-t border-theme-soft flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setEditor(null)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void saveEditor()} disabled={saving}>
            {saving ? 'Saving…' : 'Save rule set'}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <>
      <Modal
        onClose={onClose}
        ariaLabel="Manage scoring rule sets"
        className="rounded-2xl p-6 max-w-3xl w-full mx-4 shadow-2xl max-h-[90vh] flex flex-col"
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-medium text-[var(--text-primary)] uppercase tracking-tight flex items-center gap-2">
            <Settings2 size={18} aria-hidden />
            Scoring rule sets
          </h2>
          <div className="flex items-center gap-2">
            <label className="btn-accent-outline px-3 py-1.5 text-ui-micro rounded-lg cursor-pointer inline-flex items-center gap-2">
              <FileUp size={12} aria-hidden />
              Import
              <input type="file" accept="application/json" className="hidden" onChange={handleImportFile} />
            </label>
            <Button variant="outline" size="sm" onClick={openCreate} leadingIcon={<Plus size={12} />}>
              New rule set
            </Button>
          </div>
        </div>

        {importError ? (
          <div className="mb-3 p-2 rounded-lg badge-warning text-[10px]">{importError}</div>
        ) : null}
        {listError ? <div className="mb-3 p-2 rounded-lg badge-warning text-[10px]">{listError}</div> : null}

        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-5 text-sm">
          {loading ? (
            <p className="text-[10px] text-theme-muted">Loading…</p>
          ) : (
            grouped.map(([group, items]) => (
              <div key={group}>
                <h3 className="text-[10px] text-theme-secondary uppercase tracking-widest font-medium mb-2">
                  {group}
                </h3>
                <ul className="space-y-2">
                  {items.map(preset => (
                    <li
                      key={preset.id}
                      className="p-3 rounded-lg border border-theme-soft surface-overlay flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 mb-1">
                          <span className="text-xs font-medium text-[var(--text-primary)]">{preset.label}</span>
                          {preset.builtIn ? <Badge tone="neutral">Built-in</Badge> : <Badge tone="accent">Saved</Badge>}
                          {preset.citation ? <Badge tone="info">{preset.citation}</Badge> : null}
                          {preset.requiresHostPublishedTable ? (
                            <Badge tone="warning">Host publishes this table</Badge>
                          ) : null}
                        </div>
                        {preset.description ? (
                          <p className="text-[9px] text-theme-secondary">{preset.description}</p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {preset.builtIn ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void openDuplicate(preset)}
                            leadingIcon={<Pencil size={10} />}
                          >
                            Duplicate to edit
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void openEdit(preset)}
                              leadingIcon={<Pencil size={10} />}
                            >
                              Edit
                            </Button>
                            <Button variant="danger" size="sm" onClick={() => setDeleteTarget(preset)}>
                              Delete
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void exportPreset(preset)}
                          aria-label={`Export ${preset.label}`}
                          title="Export as a file"
                        >
                          <Download size={12} />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>

        <div className="pt-4 mt-2 border-t border-theme-soft flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </Modal>

      {deleteTarget ? (
        <ConfirmDeleteModal
          title="Delete rule set"
          description={`Delete "${deleteTarget.label}"?`}
          warning="This removes the saved rule set permanently. Any workspace currently scoring with it keeps its last-applied settings, but the preset itself will no longer appear in the picker."
          confirmLabel="Delete"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
          busy={deleting}
        />
      ) : null}
    </>
  );
}
