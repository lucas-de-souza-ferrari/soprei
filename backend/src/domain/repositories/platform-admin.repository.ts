import type {
  NewPlatformAdmin,
  PlatformAdmin,
  PlatformAdminCredentials,
} from '../entities/membership.js';
import type { PlatformAdminId } from '../value-objects/account-id.js';

/** Repositório de `PlatformAdmin` (global, sem `CompanyId`). E-mail único global. */
export interface PlatformAdminRepository {
  findCredentialsByEmail(email: string): Promise<PlatformAdminCredentials | null>;
  /** Lança `NotFoundError` se não existe. */
  findById(id: PlatformAdminId): Promise<PlatformAdmin>;
  /** Lança `ConflictError` se o e-mail já existe. */
  create(data: NewPlatformAdmin): Promise<PlatformAdmin>;
  /** Lança `NotFoundError` se não existe. */
  updatePassword(id: PlatformAdminId, passwordHash: string): Promise<void>;
}
