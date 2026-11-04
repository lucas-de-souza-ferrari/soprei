import { ValidationError } from '../../shared/errors/index.js';
import type { Brand } from '../../shared/types/index.js';
import { isUuid } from '../../shared/utils/index.js';

/** Identificador de uma empresa (tenant). Só nasce de `CompanyId.parse`, que valida. */
export type CompanyId = Brand<string, 'CompanyId'>;

export const CompanyId = {
  /** Valida um UUID e o marca como `CompanyId`; qualquer outra coisa lança `ValidationError`. */
  parse(value: string): CompanyId {
    if (!isUuid(value)) {
      throw new ValidationError('Identificador de empresa inválida');
    }
    // UUID em minúsculas, a forma que o PostgreSQL devolve: ids iguais comparam iguais.
    return value.toLowerCase() as CompanyId;
  },
} as const;
