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
export { PrismaMembershipAdminUnitOfWork } from './repositories/membership-admin-unit-of-work.js';
export { PrismaCompanyRepository } from './repositories/company.repository.js';
export { PrismaConversationRepository } from './repositories/conversation.repository.js';
export { PrismaPlatformAdminRepository } from './repositories/platform-admin.repository.js';
export { PrismaMembershipRepository } from './repositories/membership.repository.js';
export { PrismaMessageRepository } from './repositories/message.repository.js';
export { PrismaNotificationRepository } from './repositories/notification.repository.js';
export { withRepositoryErrors } from './repositories/repository-errors.js';
export { PrismaTenantRepository } from './repositories/tenant.repository.base.js';
export type { TenantModelOps, TenantWhere } from './repositories/tenant.repository.base.js';
export { extendWithTenantScope, MODEL_SCOPES } from './extensions/tenant-scope.js';
export type { ModelScope, TenantScopedDb, TenantScopedPrisma } from './extensions/tenant-scope.js';
export { PrismaAccountRepository } from './repositories/account.repository.js';
export { PrismaKnowledgeDocumentRepository } from './repositories/knowledge-document.repository.js';
export {
  PrismaInventoryLedger,
  PrismaProductRepository,
  PrismaStockMovementRepository,
} from './repositories/inventory.repository.js';
export { PrismaOnboardingStore } from './repositories/onboarding.store.js';
export { PrismaKnowledgeRetriever } from './repositories/knowledge-retriever.js';
export { PrismaCompanyInvitationRepository } from './repositories/company-invitation.repository.js';
export { PrismaInvitationExpiryRepository } from './repositories/invitation-expiry.repository.js';
export { PrismaInvitationUnitOfWork } from './repositories/invitation-unit-of-work.js';
export { PrismaUnverifiedAccountPurgeRepository } from './repositories/unverified-account-purge.repository.js';
export {
  PrismaAppointmentRepository,
  PrismaAvailabilityRuleRepository,
  PrismaScheduleResourceRepository,
  PrismaScheduleServiceRepository,
  PrismaScheduleSettingsRepository,
} from './repositories/schedule.repository.js';
export { PrismaContactScheduleUnitOfWork } from './repositories/contact-schedule-unit-of-work.js';
export { PrismaScheduleAvailabilityReader } from './repositories/schedule-availability-reader.js';
export { PrismaBillingRepository } from './repositories/billing.repository.js';
export { PrismaBillingNoticeRepository } from './repositories/billing-notice.repository.js';
export { PrismaCheckoutRepository } from './repositories/checkout.repository.js';
export { PrismaPendingReplyReader } from './repositories/pending-reply-reader.js';
export { PrismaEntitlementReader } from './repositories/entitlement-reader.js';
export { PrismaUsageMeter } from './repositories/usage-meter.js';
