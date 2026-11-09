export {
  COMPANY_SLUG_PATTERN,
  COMPANY_STATUSES,
  PERSONA_MAX_LENGTH,
  WHATSAPP_PHONE_NUMBER_ID_PATTERN,
} from './entities/company.js';
export type { Company, CompanyStatus, CompanyUpdate, NewCompany } from './entities/company.js';
export { CONTACT_REF_MAX_LENGTH } from './entities/conversation.js';
export type { Conversation, ConversationUpdate, NewConversation } from './entities/conversation.js';
export {
  EXTERNAL_ID_MAX_LENGTH,
  MESSAGE_CONTENT_MAX_LENGTH,
  MESSAGE_ROLES,
} from './entities/message.js';
export type {
  Message,
  MessageRole,
  MessageSentMark,
  MessageUpdate,
  NewMessage,
} from './entities/message.js';
export { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './pagination.js';
export type { ListOptions, Page } from './pagination.js';
export type { CompanyRepository } from './repositories/company.repository.js';
export type {
  AttendanceTransaction,
  AttendanceUnitOfWork,
} from './repositories/attendance-unit-of-work.js';
export type { ConversationRepository } from './repositories/conversation.repository.js';
export type { MessageOrder, MessageRepository } from './repositories/message.repository.js';
export type { TenantRepository, WithoutCompanyId } from './repositories/tenant.repository.js';
export { CompanyId } from './value-objects/company-id.js';
export { EMAIL_MAX_LENGTH, MEMBERSHIP_ROLES, ACCESS_STATUSES } from './entities/membership.js';
export type {
  NewPlatformAdmin,
  NewMembership,
  PlatformAdmin,
  PlatformAdminCredentials,
  Membership,
  MembershipCredentials,
  MembershipRole,
  AccessStatus,
  MembershipUpdate,
} from './entities/membership.js';
export type { PlatformAdminRepository } from './repositories/platform-admin.repository.js';
export type { MembershipRepository } from './repositories/membership.repository.js';
export { AccountId, PlatformAdminId } from './value-objects/account-id.js';
export { MembershipId } from './value-objects/membership-id.js';
export { AUDIT_ACTIONS } from './entities/audit-event.js';
export type { AuditAction, AuditEvent, NewAuditEvent } from './entities/audit-event.js';
export { canManageRole, hasPermission, PERMISSIONS, ROLE_PERMISSIONS } from './permissions.js';
export type { Permission } from './permissions.js';
export type { AuditRepository } from './repositories/audit.repository.js';
export { CHANNEL_CONNECTION_STATUSES, WABA_ID_PATTERN } from './entities/channel-connection.js';
export type {
  ChannelConnection,
  ChannelConnectionStatus,
  ChannelConnectionUpdate,
  NewChannelConnection,
} from './entities/channel-connection.js';
export type { ChannelConnectionRepository } from './repositories/channel-connection.repository.js';
export type {
  Account,
  AccountMembership,
  AccountRepository,
  ResetFailureOutcome,
  UnverifiedAccountPurgeRepository,
  VerifyOutcome,
} from './repositories/account.repository.js';
export {
  RESET_DAILY_FAILURE_CAP,
  RESET_FAILURE_WINDOW_MS,
  RESET_MAX_ATTEMPTS,
  VERIFICATION_DAILY_FAILURE_CAP,
  VERIFICATION_FAILURE_WINDOW_MS,
  VERIFICATION_MAX_ATTEMPTS,
} from './repositories/account.repository.js';
export {
  INVITABLE_ROLES,
  INVITATION_ACCOUNT_SENDS_PER_DAY,
  INVITATION_COMPANY_SENDS_PER_DAY,
  INVITATION_EXPIRY_GRACE_MS,
  INVITATION_INVITER_SENDS_PER_DAY,
  INVITATION_MAX_PENDING,
  INVITATION_MAX_SENDS,
  INVITATION_QUOTA_WINDOW_MS,
  INVITATION_RECIPIENT_EMAILS_PER_DAY,
  INVITATION_RESEND_INTERVAL_MS,
  INVITATION_STATUSES,
  INVITATION_VALIDITY_DAYS,
  INVITATION_VALIDITY_MS,
} from './entities/company-invitation.js';
export type {
  CompanyInvitation,
  InvitableRole,
  InvitationClosing,
  InvitationRenewal,
  InvitationStatus,
  NewCompanyInvitation,
} from './entities/company-invitation.js';
export type {
  CompanyInvitationRepository,
  InvitationExpiryRepository,
} from './repositories/company-invitation.repository.js';
export {
  KNOWLEDGE_BLOCK_MAX_CHARS,
  KNOWLEDGE_CHUNK_MAX_CHARS,
  KNOWLEDGE_CONTENT_MAX_LENGTH,
  KNOWLEDGE_MAX_CHUNKS,
  KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT,
  KNOWLEDGE_MAX_DOCUMENTS,
  KNOWLEDGE_MAX_PASSAGES,
  KNOWLEDGE_MAX_PRODUCTS,
  KNOWLEDGE_MIN_RANK,
  KNOWLEDGE_PREVIEW_LENGTH,
  KNOWLEDGE_PRODUCT_DESCRIPTION_PROMPT_CHARS,
  KNOWLEDGE_QUERY_MAX_CHARS,
  KNOWLEDGE_QUERY_MAX_TERMS,
  KNOWLEDGE_RELATIVE_RANK_FLOOR,
  KNOWLEDGE_RETRIEVAL_TIMEOUT_MS,
  KNOWLEDGE_TITLE_MAX_LENGTH,
} from './knowledge.js';
export {
  ADJUSTMENT_REASONS,
  INVENTORY_IMPORT_MAX_ROWS,
  INVENTORY_MAX_PRODUCTS,
  INVENTORY_SEARCH_MAX_LENGTH,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
  PRODUCT_PRICE_MAX_CENTS,
  PRODUCT_QUANTITY_MAX,
  PRODUCT_SKU_PATTERN,
  PRODUCT_THRESHOLD_MAX,
  STOCK_ADJUSTMENT_MAX,
  STOCK_REASONS,
} from './inventory.js';
export type {
  AdjustmentReason,
  NewProduct,
  NewStockMovement,
  Product,
  ProductListOptions,
  ProductRepository,
  ProductUpdate,
  StockMovement,
  StockMovementRepository,
  StockReason,
} from './inventory.js';
export type {
  KnowledgeDocument,
  KnowledgeDocumentRepository,
  NewKnowledgeChunk,
  NewKnowledgeDocument,
} from './knowledge.js';
export * from './schedule.js';
export * from './schedule-ai.js';
export * from './billing.js';
export * from './billing-notices.js';
export type {
  BillingNoticeRepository,
  NoticeCandidate,
  NoticeRecipient,
  NoticeTarget,
} from './repositories/billing-notice.repository.js';
export type {
  BillingRepository,
  CatalogEntry,
  CompanyBillingPolicy,
  OrderSummary,
  TrialSettings,
  UsageWindow,
} from './repositories/billing.repository.js';
export type {
  CheckoutRepository,
  GrantResult,
  NewOrderInput,
  OrderCap,
  PaidFacts,
  PaymentOrderRecord,
} from './repositories/checkout.repository.js';
