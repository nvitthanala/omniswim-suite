/** In-memory optimistic undo history. A stack belongs to one host/document lifetime. */
import type { EditedStore, KeyOf, ValueOf } from './schema';
import type { PutManyOp, StorageRepo } from './repo';
import { StaleWriteError, ChangeRevMovedError } from './errors';

/**
 * One change and the way back. `before` is the state to restore; `writtenRev` is the rev the change left behind.
 * - `before.op === 'put'`: the row existed. If the change updated it, `writtenRev` is the new rev, and the undo puts `before.record` back at that rev.
 *   If the change DELETED it, no rev is left behind: pass `'absent'`. The undo then re-creates the row with `putMany`'s `expectedRev: 'new'`,
 *   which requires the row to be absent and fails with `StaleWriteError` if anything re-created it since. That is the same "changed elsewhere" outcome.
 * - `before.op === 'delete'`: the row did not exist. The change created it, and `writtenRev` is the rev it got.
 */
export type UndoChange =
  | { readonly before: { readonly op: 'put'; readonly store: EditedStore; readonly record: ValueOf<EditedStore> }; readonly writtenRev: number | 'absent' }
  | { readonly before: { readonly op: 'delete'; readonly store: EditedStore; readonly key: KeyOf<EditedStore> }; readonly writtenRev: number };
export interface UndoEntry { readonly changes: readonly UndoChange[] }
export type UndoOutcome = { readonly status: 'undone' } | { readonly status: 'empty' } | { readonly status: 'changed elsewhere' };
export interface UndoStack {
  recordUndo(entry: UndoEntry): void;
  undo(): Promise<UndoOutcome>;
  readonly size: number;
}

export function createUndoStack(repo: StorageRepo, limit = 50): UndoStack {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('undo limit must be between 1 and 50');
  const entries: UndoEntry[] = [];
  return {
    get size() { return entries.length; },
    recordUndo(entry) { if (entry.changes.length) { entries.push(entry); if (entries.length > limit) entries.shift(); } },
    async undo() {
      const entry = entries.at(-1);
      if (!entry) return { status: 'empty' };
      const ops: PutManyOp[] = entry.changes.map(({ before, writtenRev }) => before.op === 'put'
        ? { op: 'put', store: before.store, record: before.record as never, expectedRev: writtenRev === 'absent' ? 'new' : writtenRev } as PutManyOp
        : { op: 'delete', store: before.store, key: before.key as never, expectedRev: writtenRev } as PutManyOp);
      try { await repo.putMany(ops); entries.pop(); return { status: 'undone' }; }
      catch (error) { if (error instanceof StaleWriteError || error instanceof ChangeRevMovedError) return { status: 'changed elsewhere' }; throw error; }
    },
  };
}
