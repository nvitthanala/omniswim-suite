export { WorkspaceService } from './WorkspaceService';
export { PgWorkspaceService } from './PgWorkspaceService';
export { AuthService, ShareLinkService, type AuthUser, type AuthSession } from './AuthService';
export {
  SCHEMA_VERSION,
  CREATE_TABLES_SQL,
  SQLITE_MIGRATIONS_V2,
  CHILD_TABLES,
  type ChildTable,
} from './schema';
export { PG_SCHEMA_VERSION, CREATE_PG_TABLES_SQL } from './pgSchema';
export type { WorkspaceScope } from './workspacePersistence';
