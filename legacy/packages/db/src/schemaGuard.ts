/**
 * Refuse a database written by a newer build.
 *
 * Every migration in this package only adds (`IF NOT EXISTS`, `ADD COLUMN`),
 * so an older build opens a newer database without error, then writes rows
 * the newer build may read back differently — and stamps `meta.schema_version`
 * back down. Nothing warns anyone. This module is the one place that decides
 * "this file is too new for me"; both stores call it before they touch the
 * file, so a refusal changes nothing on disk.
 */

/** `code` on {@link SchemaVersionError} when the stored version is greater than the build's. */
export const SCHEMA_TOO_NEW_CODE = 'SCHEMA_TOO_NEW';
/** `code` on {@link SchemaVersionError} when the stored value is not a positive integer. */
export const SCHEMA_UNREADABLE_CODE = 'SCHEMA_VERSION_UNREADABLE';

export class SchemaVersionError extends Error {
  readonly code: typeof SCHEMA_TOO_NEW_CODE | typeof SCHEMA_UNREADABLE_CODE;
  /** What the database holds, exactly as stored. */
  readonly stored: string;
  /** The highest schema version this build understands. */
  readonly supported: number;

  constructor(
    code: SchemaVersionError['code'],
    stored: string,
    supported: number,
    where: string
  ) {
    super(
      code === SCHEMA_TOO_NEW_CODE
        ? `Refusing to open ${where}: it was written by a newer build (schema version ${stored}; ` +
            `this build supports up to ${supported}). Update the app, or open the file with the build ` +
            `that wrote it. Nothing was changed.`
        : `Refusing to open ${where}: meta.schema_version is "${stored}", which is not a schema ` +
            `version number. Nothing was changed.`
    );
    this.name = 'SchemaVersionError';
    this.code = code;
    this.stored = stored;
    this.supported = supported;
  }
}

/**
 * Throw when `stored` (the raw `meta.schema_version` value, or null/undefined
 * for a database that has never been stamped) is greater than `supported`.
 * An absent value is a fresh database and is fine.
 */
export function assertSchemaNotNewer(
  stored: string | number | null | undefined,
  supported: number,
  where: string
): void {
  if (stored === null || stored === undefined) return;
  const raw = String(stored).trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new SchemaVersionError(SCHEMA_UNREADABLE_CODE, raw, supported, where);
  }
  if (Number(raw) > supported) {
    throw new SchemaVersionError(SCHEMA_TOO_NEW_CODE, raw, supported, where);
  }
}
