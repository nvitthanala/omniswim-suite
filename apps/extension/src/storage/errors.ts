/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Errors the storage layer throws (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5.3 to 5.6).
 * Each has a stable `code` so the service-worker broker can map it to a reply code without
 * matching message text.
 */

/** One problem in a record or a file: a JSON path and a message. */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** An optimistic write lost: the stored `rev` is not the one the caller read, or `'new'` hit an existing key. */
export class StaleWriteError extends Error {
  readonly code = 'stale' as const;
  constructor(
    readonly store: string,
    readonly key: unknown
  ) {
    super(`Stale write to ${store} ${JSON.stringify(key)}: the record changed elsewhere.`);
    this.name = 'StaleWriteError';
  }
}

/** A batch was made against a `meta.changeRev` that another write has since moved. Nothing was written. Maps to broker code `stale`. */
export class ChangeRevMovedError extends Error {
  readonly code = 'stale' as const;
  constructor(
    readonly expected: number,
    readonly actual: number
  ) {
    super(`The database changed since it was read (change ${expected} is now ${actual}). Nothing was written.`);
    this.name = 'ChangeRevMovedError';
  }
}

/** The database on disk has a higher version than this build knows. It is never downgraded or deleted. */
export class NewerDatabaseError extends Error {
  readonly code = 'newer-database' as const;
  constructor(message = 'The OmniSwim database was written by a newer version of the extension.') {
    super(message);
    this.name = 'NewerDatabaseError';
  }
}

/** A record failed validation. `issues` carry the JSON paths. Maps to broker code `invalid`. */
export class InvalidRecordError extends Error {
  readonly code = 'invalid' as const;
  constructor(
    readonly store: string,
    readonly issues: readonly ValidationIssue[]
  ) {
    super(`Invalid ${store} record: ${issues.map(i => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'InvalidRecordError';
  }
}

/** A snapshot lineup was written to after create. Snapshots are immutable. Maps to broker code `denied`. */
export class SnapshotImmutableError extends Error {
  readonly code = 'denied' as const;
  constructor(readonly lineupId: string) {
    super(`Lineup ${lineupId} is a snapshot. A snapshot cannot change after it is created.`);
    this.name = 'SnapshotImmutableError';
  }
}

/** The file has a newer `formatVersion` (or `dbSchemaVersion`) than this build reads. */
export class NewerExportError extends Error {
  readonly code = 'newer-export' as const;
  constructor(message: string) {
    super(message);
    this.name = 'NewerExportError';
  }
}

/** The import file failed validation. Nothing was written. `issues` list every JSON path found. */
export class ImportValidationError extends Error {
  readonly code = 'invalid' as const;
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(`The import file is not valid (${issues.length} problem${issues.length === 1 ? '' : 's'}): ${issues.map(i => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'ImportValidationError';
  }
}

/** The database is at a version whose schema or meta.db row is not complete. It is never repaired or deleted. */
export class DatabaseInconsistentError extends Error {
  readonly code = 'inconsistent' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseInconsistentError';
  }
}
