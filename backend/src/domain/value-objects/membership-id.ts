import { ValidationError } from '../../shared/errors/index.js';
import type { Brand } from '../../shared/types/index.js';
import { isUuid } from '../../shared/utils/index.js';

/** Identificador de um `Membership` (vínculo de uma conta com uma empresa; de tenant). Só nasce de `MembershipId.parse`, que valida. */
export type MembershipId = Brand<string, 'MembershipId'>;

export const MembershipId = {
  parse(value: string): MembershipId {
    if (!isUuid(value)) throw new ValidationError('Identificador de usuário inválido');
    return value.toLowerCase() as MembershipId;
  },
} as const;
