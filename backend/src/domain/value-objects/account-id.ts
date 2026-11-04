import { ValidationError } from '../../shared/errors/index.js';
import type { Brand } from '../../shared/types/index.js';
import { isUuid } from '../../shared/utils/index.js';

/** Identificador de uma `Account` (a pessoa que entra no site; global). Só nasce de `AccountId.parse`. */
export type AccountId = Brand<string, 'AccountId'>;
export const AccountId = {
  parse(value: string): AccountId {
    if (!isUuid(value)) throw new ValidationError('Identificador de conta inválido');
    return value.toLowerCase() as AccountId;
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
