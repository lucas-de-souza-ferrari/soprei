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
export { queryTimingExtension } from './extensions/query-timing.js';
export type { QueryObserver, QueryTimingSample } from './extensions/query-timing.js';
export {
  isDatabaseFailure,
  isRecoverableTransactionError,
  toDatabaseError,
  withDatabaseErrors,
} from './database-errors.js';
export { retryOnRecoverable, runInTransaction } from './transaction.js';
export type { RetryOptions, TransactionOptions } from './transaction.js';
export { PrismaAttendanceUnitOfWork } from './repositories/attendance-unit-of-work.js';
export { PrismaChannelConnectionRepository } from './repositories/channel-connection.repository.js';
export { PrismaChannelUnitOfWork } from './repositories/channel-unit-of-work.js';
export { PrismaAuditRepository } from './repositories/audit.repository.js';
export { PrismaUserAdminUnitOfWork } from './repositories/user-admin-unit-of-work.js';
export { PrismaClientRepository } from './repositories/client.repository.js';
export { PrismaConversationRepository } from './repositories/conversation.repository.js';
export { PrismaPlatformAdminRepository } from './repositories/platform-admin.repository.js';
export { PrismaUserRepository } from './repositories/user.repository.js';
export { PrismaMessageRepository } from './repositories/message.repository.js';
export { withRepositoryErrors } from './repositories/repository-errors.js';
export { PrismaTenantRepository } from './repositories/tenant.repository.base.js';
export type { TenantModelOps, TenantWhere } from './repositories/tenant.repository.base.js';
export { extendWithTenantScope, MODEL_SCOPES } from './extensions/tenant-scope.js';
export type { ModelScope, TenantScopedDb, TenantScopedPrisma } from './extensions/tenant-scope.js';
export { PrismaAccountRepository } from './repositories/account.repository.js';
