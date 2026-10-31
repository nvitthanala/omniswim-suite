export { WorkspaceService } from './WorkspaceService';
export { PgWorkspaceService } from './PgWorkspaceService';
export { AuthService, ShareLinkService, type AuthUser, type AuthSession } from './AuthService';
export {
  SCHEMA_VERSION,
  CREATE_TABLES_SQL,
  SQLITE_MIGRATIONS_V2,
  SQLITE_MIGRATIONS_V3,
  SQLITE_MIGRATIONS_V4,
  CHILD_TABLES,
  CATALOG_TABLES,
  type ChildTable,
  type CatalogTable,
} from './schema';
export { PG_SCHEMA_VERSION, CREATE_PG_TABLES_SQL } from './pgSchema';
export { ID_KEYED_CHILD_TABLES, migrateSqliteChildKeys, migratePgChildKeys } from './childKeyMigration';
export type { WorkspaceScope } from './workspacePersistence';
export {
  VERSION_CONFLICT_CODE,
  DUPLICATE_WORKSPACE_ID_CODE,
  DUPLICATE_ROW_ID_CODE,
  PROTECTED_PATCH_FIELDS,
  duplicateWorkspaceError,
  duplicateRowIdError,
  versionConflictError,
  stripProtectedPatchFields,
  workspaceVersionOf,
  type CodedError,
} from './workspacePersistence';
export {
  SCHEMA_TOO_NEW_CODE,
  SCHEMA_UNREADABLE_CODE,
  SchemaVersionError,
  assertSchemaNotNewer,
} from './schemaGuard';
