export {
  closeDatabase,
  createDatabase,
  getDatabase,
  getPoolMetrics,
  getPrisma,
} from './database.js';
export type {
  CreateDatabaseOptions,
  Database,
  DatabaseConfig,
  GetDatabaseOptions,
  PoolMetrics,
} from './database.js';
export { queryTimingExtension } from './query-timing.js';
export type { QueryObserver, QueryTimingSample } from './query-timing.js';
export {
  isDatabaseFailure,
  isRecoverableTransactionError,
  toDatabaseError,
  withDatabaseErrors,
} from './database-errors.js';
export { retryOnRecoverable, runInTransaction } from './transaction.js';
export type { RetryOptions, TransactionOptions } from './transaction.js';
export { PrismaClientRepository } from './client.repository.js';
export { PrismaConversationRepository } from './conversation.repository.js';
export { withRepositoryErrors } from './repository-errors.js';
export { PrismaTenantRepository } from './tenant.repository.base.js';
export type { TenantModelOps, TenantWhere } from './tenant.repository.base.js';
export { extendWithTenantScope, MODEL_SCOPES } from './tenant-scope.js';
export type { ModelScope, TenantScopedDb, TenantScopedPrisma } from './tenant-scope.js';
