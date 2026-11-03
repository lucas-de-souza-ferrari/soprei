import { ValidationError } from '../../shared/errors/index.js';
import type { Brand } from '../../shared/types/index.js';
import { isUuid } from '../../shared/utils/index.js';

/** Identificador de um `User` (de tenant). Só nasce de `UserId.parse`, que valida. */
export type UserId = Brand<string, 'UserId'>;

export const UserId = {
  parse(value: string): UserId {
    if (!isUuid(value)) throw new ValidationError('Identificador de usuário inválido');
    return value.toLowerCase() as UserId;
  },
} as const;

/** Identificador de um `PlatformAdmin` (global). */
export type PlatformAdminId = Brand<string, 'PlatformAdminId'>;

export const PlatformAdminId = {
  parse(value: string): PlatformAdminId {
    if (!isUuid(value)) throw new ValidationError('Identificador de administrador inválido');
    return value.toLowerCase() as PlatformAdminId;
  },
} as const;
