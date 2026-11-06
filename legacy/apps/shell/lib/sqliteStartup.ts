/**
 * What the server does when the SQLite store will not open.
 *
 * It used to fall back to `meets.json` on ANY error. That turned two very
 * different situations into one silent one:
 *
 *  - SQLite itself cannot load (`node:sqlite` missing, a native-module load
 *    failure). `meets.json` is the documented fallback for that, so it stays,
 *    but it is logged as an error: the user is now on the older JSON copy.
 *  - SQLite loaded and refused the file (a newer schema, a corrupt database, a
 *    locked file). Falling back there serves stale JSON data in place of the
 *    real store and then writes to it. That is how data gets forked, so the
 *    server stops and says why.
 */
import { SchemaVersionError } from '../../../packages/db/src/schemaGuard.ts';

const NATIVE_LOAD_CODES = new Set([
  'ERR_UNKNOWN_BUILTIN_MODULE',
  'ERR_DLOPEN_FAILED',
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
]);

export type SqliteStartupDecision =
  | { action: 'fallback-to-json'; message: string }
  | { action: 'exit'; message: string };

/** Pure: decide, so the server hunk is one switch and the rule is testable. */
export function decideSqliteStartupFailure(err: unknown): SqliteStartupDecision {
  if (err instanceof SchemaVersionError) {
    return { action: 'exit', message: err.message };
  }
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && NATIVE_LOAD_CODES.has(code)) {
    return {
      action: 'fallback-to-json',
      message:
        'SQLite could not be loaded; falling back to data/meets.json. Changes made now are NOT in ' +
        `data/omniswim.db. (${(err as Error).message})`,
    };
  }
  const detail = err instanceof Error ? err.message : String(err);
  return {
    action: 'exit',
    message:
      `SQLite backend failed to open and was NOT replaced by the JSON file, because that would ` +
      `serve and change a different copy of your data: ${detail}`,
  };
}
