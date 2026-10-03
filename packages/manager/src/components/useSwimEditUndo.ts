/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One-shot Undo for the last what-if swim edit (the toolbar "Undo: <edit>" button).
 *
 * `swimEditor` returns an `inverse` patch that holds the FULL earlier value of every field the
 * edit touched (meetEntryPlans, and often activeEntryIds). Writing it back later is only safe
 * while those fields still read as the edit left them. Otherwise it would replace a different
 * workspace's plans, or throw away an optimizer run or a later edit. So each edit records:
 *  - the workspace id it was made in, and
 *  - a fingerprint of exactly the fields the inverse would overwrite, taken right after the edit.
 * Undo refuses (with a message) unless both still match. The check runs when Undo is pressed,
 * the same way the optimizer's Undo does it (see optimizerUndo.ts).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace } from '@omniswim/core/types';
import { canonical } from './optimizerUndo';

type ToastLike = { push: (kind: 'success' | 'error' | 'info', message: string) => unknown };

export type SwimEditBuild = { patch: Partial<Workspace>; inverse: Partial<Workspace>; description: string };

export type SwimEditUndoRecord = {
  inverse: Partial<Workspace>;
  description: string;
  /** Workspace the edit was made in. Undo never crosses workspaces. */
  workspaceId: string;
  /** Fingerprint of the inverse's fields right after the edit was applied. */
  appliedFingerprint: string;
};

export const SWIM_EDIT_UNDO_CHANGED_MESSAGE =
  'The lineup changed since this edit. Undo would discard later changes, so it was not applied.';

/**
 * The lineup fields the optimizer also writes. They are always part of the fingerprint, even when
 * the inverse does not touch one of them, so an optimizer run after the edit invalidates the Undo
 * whichever of the three it changed (writing back only some of them would mix two lineups).
 */
const LINEUP_FIELDS = ['scorerRosterOverrides', 'meetEntryPlans', 'activeEntryIds'] as const;

/**
 * Fingerprint of every field `inverse` would overwrite, plus the three lineup fields, as `source`
 * holds them. Absent and null read the same.
 */
export function fingerprintInverseFields(source: Partial<Workspace>, inverse: Partial<Workspace>): string {
  const keys = [...new Set<string>([...Object.keys(inverse), ...LINEUP_FIELDS])].sort() as Array<keyof Workspace>;
  return canonical(keys.map(key => [key, source[key] ?? null]));
}

/** Build the record. `afterEdit` is the workspace as the edit left it (current workspace plus the patch). */
export function buildSwimEditUndo(args: { afterEdit: Workspace; build: SwimEditBuild }): SwimEditUndoRecord {
  return {
    inverse: args.build.inverse,
    description: args.build.description,
    workspaceId: args.afterEdit.id,
    appliedFingerprint: fingerprintInverseFields(args.afterEdit, args.build.inverse),
  };
}

export type SwimEditUndoState = 'clean' | 'other_workspace' | 'changed';

export function swimEditUndoState(record: SwimEditUndoRecord, current: Workspace): SwimEditUndoState {
  if (record.workspaceId !== current.id) return 'other_workspace';
  return fingerprintInverseFields(current, record.inverse) === record.appliedFingerprint ? 'clean' : 'changed';
}

/**
 * Owns the compose-ref (BUG 3.2: each credited-swim patch is built against the freshest
 * workspace, the prop composed forward with applied patches, so rapid successive edits do not
 * clobber one another) and the guarded one-shot Undo.
 */
export function useSwimEditUndo({
  workspace,
  onUpdate,
  toast,
}: {
  workspace: Workspace;
  onUpdate: (patch: Partial<Workspace>) => void;
  toast: ToastLike;
}) {
  const [record, setRecord] = useState<SwimEditUndoRecord | null>(null);

  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  // An edit belongs to one workspace. Derive the visible record, so a workspace switch never paints
  // one frame of another workspace's Undo button, and drop the state with it.
  const lastSwimEdit = record && record.workspaceId === workspace.id ? record : null;
  useEffect(() => {
    if (record && record.workspaceId !== workspace.id) setRecord(null);
  }, [record, workspace.id]);

  const applySwimPatch = useCallback(
    (build: (ws: Workspace) => SwimEditBuild) => {
      const result = build(workspaceRef.current);
      workspaceRef.current = { ...workspaceRef.current, ...result.patch };
      onUpdate(result.patch);
      setRecord(buildSwimEditUndo({ afterEdit: workspaceRef.current, build: result }));
      toast.push('success', result.description);
    },
    [onUpdate, toast]
  );

  const undoSwimEdit = useCallback(() => {
    if (!record) return;
    const state = swimEditUndoState(record, workspaceRef.current);
    if (state !== 'clean') {
      // The record can never become valid again, so drop it. A mismatch on the same workspace is
      // the one the coach should hear about; a switch has already hidden the button.
      setRecord(null);
      if (state === 'changed') toast.push('error', SWIM_EDIT_UNDO_CHANGED_MESSAGE);
      return;
    }
    workspaceRef.current = { ...workspaceRef.current, ...record.inverse };
    onUpdate(record.inverse);
    toast.push('success', `Undid: ${record.description}`);
    setRecord(null);
  }, [record, onUpdate, toast]);

  return { lastSwimEdit, applySwimPatch, undoSwimEdit };
}
