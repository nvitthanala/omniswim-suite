import { useCallback } from 'react';
import type { useToast } from '@omniswim/ui';
import type { RaceTagStateMachine } from '@omniswim/core/lib/raceAnalysis';
import type { OperatorKey, RaceTag } from '../types';
import { updateTagTime } from '../components/TagTable';

function insertSorted(tags: readonly RaceTag[], tag: RaceTag): RaceTag[] {
  return [...tags, tag].sort((a, b) => a.time - b.time);
}

/** The length index a one-shot ('Signal' | 'Flags' | 'Kick') tag should carry, if any. */
function resolveOneShotLengthIndex(
  kind: 'Signal' | 'Flags' | 'Kick',
  machine: RaceTagStateMachine,
  lengthCount: number,
): number | undefined {
  if (kind === 'Kick') return machine.nextS().lengthIndex ?? machine.nextD().lengthIndex;
  if (kind === 'Flags') return lengthCount;
  return undefined;
}

interface UseTagKeyboardHandlersArgs {
  setupConfirmed: boolean;
  fifteenMetreGateReason: string | undefined;
  machine: RaceTagStateMachine;
  lengthCount: number;
  toast: ReturnType<typeof useToast>;
  setTags: (updater: (prev: RaceTag[]) => RaceTag[]) => void;
}

/**
 * The keyboard tagging surface's handlers: sequential operator keys (S/D/A/T
 * etc.), one-shot markers (Signal/Flags/Kick), undo, and drag-to-retime. All
 * of them are no-ops until setup is confirmed, and all mutate `tags` through
 * the same sorted-insert/update helpers, so they're grouped in one hook.
 */
export function useTagKeyboardHandlers({
  setupConfirmed,
  fifteenMetreGateReason,
  machine,
  lengthCount,
  toast,
  setTags,
}: UseTagKeyboardHandlersArgs) {
  const handleSequentialKey = useCallback(
    (key: OperatorKey, time: number) => {
      if (!setupConfirmed) return;
      if (key === 'A' && fifteenMetreGateReason !== undefined) {
        toast.push('info', fifteenMetreGateReason);
        return;
      }
      const pressResult = machine.press(key, time);
      if (pressResult.status === 'illegal') {
        toast.push('error', pressResult.reason);
        return;
      }
      setTags((prev) => insertSorted(prev, pressResult.tag));
    },
    [setupConfirmed, fifteenMetreGateReason, machine, toast, setTags],
  );

  const handleOneShotKey = useCallback(
    (kind: 'Signal' | 'Flags' | 'Kick', time: number) => {
      if (!setupConfirmed) return;
      const lengthIndex = resolveOneShotLengthIndex(kind, machine, lengthCount);
      const tag: RaceTag = lengthIndex === undefined ? { kind, time } : { kind, time, lengthIndex };
      setTags((prev) => insertSorted(prev, tag));
    },
    [setupConfirmed, machine, lengthCount, setTags],
  );

  const handleUndo = useCallback(() => {
    if (!setupConfirmed) return;
    const undoResult = machine.undo();
    if (undoResult.status === 'illegal') {
      toast.push('info', undoResult.reason);
      return;
    }
    setTags((prev) => prev.filter((tag) => tag !== undoResult.tag));
  }, [setupConfirmed, machine, toast, setTags]);

  const handleTagDragCommit = useCallback(
    (index: number, nextTime: number) => {
      setTags((prev) => updateTagTime(prev, index, nextTime));
    },
    [setTags],
  );

  return { handleSequentialKey, handleOneShotKey, handleUndo, handleTagDragCommit };
}
