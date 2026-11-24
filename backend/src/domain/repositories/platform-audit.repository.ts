import type {
  NewPlatformAuditEvent,
  PlatformAuditEvent,
} from '../entities/platform-audit-event.js';
import type { ListOptions, Page } from '../pagination.js';

/** Trilha da plataforma (spec 044): só `create` e `list`, sem `update` nem `delete` (imutável pela API). */
export interface PlatformAuditRepository {
  create(data: NewPlatformAuditEvent): Promise<PlatformAuditEvent>;
  /** Mais recentes primeiro. */
  list(options?: ListOptions): Promise<Page<PlatformAuditEvent>>;
}
