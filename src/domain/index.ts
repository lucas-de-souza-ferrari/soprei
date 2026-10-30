export {
  CLIENT_SLUG_PATTERN,
  CLIENT_STATUSES,
  PERSONA_MAX_LENGTH,
  WHATSAPP_PHONE_NUMBER_ID_PATTERN,
} from './entities/client.js';
export type { Client, ClientStatus, ClientUpdate, NewClient } from './entities/client.js';
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
export type { ClientRepository } from './repositories/client.repository.js';
export type {
  AttendanceTransaction,
  AttendanceUnitOfWork,
} from './repositories/attendance-unit-of-work.js';
export type { ConversationRepository } from './repositories/conversation.repository.js';
export type { MessageRepository } from './repositories/message.repository.js';
export type { TenantRepository, WithoutClientId } from './repositories/tenant.repository.js';
export { ClientId } from './value-objects/client-id.js';
export { EMAIL_MAX_LENGTH, USER_ROLES, USER_STATUSES } from './entities/user.js';
export type {
  NewPlatformAdmin,
  NewUser,
  PlatformAdmin,
  PlatformAdminCredentials,
  User,
  UserCredentials,
  UserRole,
  UserStatus,
  UserUpdate,
} from './entities/user.js';
export type { PlatformAdminRepository } from './repositories/platform-admin.repository.js';
export type { UserRepository } from './repositories/user.repository.js';
export { PlatformAdminId, UserId } from './value-objects/user-id.js';
export { AUDIT_ACTIONS } from './entities/audit-event.js';
export type { AuditAction, AuditEvent, NewAuditEvent } from './entities/audit-event.js';
export { canManageRole, hasPermission, PERMISSIONS, ROLE_PERMISSIONS } from './permissions.js';
export type { Permission } from './permissions.js';
export type { AuditRepository } from './repositories/audit.repository.js';
