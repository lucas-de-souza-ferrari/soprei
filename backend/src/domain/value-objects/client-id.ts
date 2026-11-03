import { ValidationError } from '../../shared/errors/index.js';
import type { Brand } from '../../shared/types/index.js';
import { isUuid } from '../../shared/utils/index.js';

/** Identificador de um cliente (tenant). Só nasce de `ClientId.parse`, que valida. */
export type ClientId = Brand<string, 'ClientId'>;

export const ClientId = {
  /** Valida um UUID e o marca como `ClientId`; qualquer outra coisa lança `ValidationError`. */
  parse(value: string): ClientId {
    if (!isUuid(value)) {
      throw new ValidationError('Identificador de cliente inválido');
    }
    // UUID em minúsculas, a forma que o PostgreSQL devolve: ids iguais comparam iguais.
    return value.toLowerCase() as ClientId;
  },
} as const;
