/**
 * Public surface of `account-state` module.
 */

export {
  AccountJsonSchema,
  type AccountJson,
  type OperatingCadence,
  type XActionSystem,
  type EngagementPolicy,
  type ApprovalPolicy,
  type TriggerPolicy,
  type HotZone,
} from './account-schema.js';
export {
  StateJsonSchema,
  PostingStateSchema,
  PostingSessionSchema,
  PublishStatusSchema,
  PublishItemSchema,
  TERMINAL_POSTING_STATES,
  type StateJson,
  type PostingState,
  type PostingSession,
  type PublishStatus,
  type PublishItem,
} from './state-schema.js';
export { readJson, readJsonRaw, writeJsonAtomic, withStateLock } from './io.js';
export { migrateAccount, migrateState, type MigrationResult } from './schema-migration.js';
export { AccountRepo, type WithStateResult } from './repo.js';
export { GitSync, type GitSyncOptions, type GitSyncResult } from './git-sync.js';
