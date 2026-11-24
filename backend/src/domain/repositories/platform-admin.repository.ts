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
  /** Segredo TOTP cifrado (spec 044), ou `null` sem fator. Lança `NotFoundError` se o administrador não existe. */
  findTotpSecret(id: PlatformAdminId): Promise<string | null>;
  /**
   * Grava (ou apaga, com `null`) o segredo TOTP cifrado e zera o último passo usado. Lança
   * `NotFoundError` se o administrador não existe.
   */
  setTotpSecret(id: PlatformAdminId, ciphertext: string | null): Promise<void>;
  /**
   * Marca o passo TOTP como usado **se** for maior que o último gravado (atômico: um UPDATE
   * condicional). `false` = o mesmo código (ou um passo anterior) já entrou; não entra de novo.
   */
  claimTotpStep(id: PlatformAdminId, step: number): Promise<boolean>;
}
