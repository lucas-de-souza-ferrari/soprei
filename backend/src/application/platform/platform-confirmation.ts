import {
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from '../../shared/errors/index.js';
import type { Result } from '../../shared/types/index.js';
import type { LoginFailure } from '../auth/auth.service.js';
import type { PlatformIdentity } from '../auth/identity.js';

/** Código da recusa de uma confirmação reforçada (spec 045, regra comum 3). */
export const CONFIRMATION_INVALID = 'CONFIRMATION_INVALID';

/** Conferência do código novo do autenticador (o `AuthService.confirmPlatformCode`). */
export interface PlatformActionConfirmer {
  confirmPlatformCode(
    adminId: PlatformIdentity['adminId'],
    code: string | undefined,
  ): Promise<Result<void, LoginFailure>>;
}

export function confirmationInvalid(): ValidationError {
  return new ValidationError('Código de confirmação inválido', { code: CONFIRMATION_INVALID });
}

/**
 * Confirmação reforçada (D2 da spec 045): código novo do autenticador do próprio admin. Sem código, a
 * mesma recusa sem consultar nada (como o formato inválido, não conta no bloqueio); errado ou já usado, a
 * recusa e uma falha no bloqueio por conta do login da plataforma; bloqueado, 429 antes de conferir.
 */
export async function confirmPlatformAction(
  confirmer: PlatformActionConfirmer,
  identity: PlatformIdentity,
  code: string | undefined,
): Promise<void> {
  if (code === undefined) throw confirmationInvalid();
  const result = await confirmer.confirmPlatformCode(identity.adminId, code);
  if (result.ok) return;
  switch (result.error.reason) {
    case 'locked':
      throw new RateLimitError(result.error.retryAfterSeconds);
    case 'unavailable':
      throw new ServiceUnavailableError('Serviço de autenticação indisponível');
    case 'invalid_credentials':
      throw confirmationInvalid();
  }
}
