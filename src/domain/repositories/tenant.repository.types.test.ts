import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClientId } from '../value-objects/client-id.js';
import type { ConversationRepository } from './conversation.repository.js';
import type { TenantRepository } from './tenant.repository.js';

/**
 * Teste de TIPOS: este arquivo é compilado por `pnpm typecheck`. Cada `@ts-expect-error`
 * só é aceito pelo compilador se a linha seguinte realmente NÃO compilar; se alguém tornar
 * a API frouxa (ex.: deixar `clientId` opcional ou aceitar `string`), o typecheck falha por
 * "unused @ts-expect-error". A função nunca é chamada: só importa que compile (ou não).
 */
export function typeContracts(repo: ConversationRepository, clientId: ClientId, id: string): void {
  // O que deve compilar.
  void repo.findById(clientId, id);
  void repo.list(clientId);
  void repo.list(clientId, { limit: 10, cursor: 'x' });
  void repo.create(clientId, {});
  void repo.update(clientId, id, {});
  void repo.delete(clientId, id);
  void repo.count(clientId);

  // Sem ClientId.
  // @ts-expect-error findById exige o ClientId como primeiro parâmetro
  void repo.findById(id);
  // @ts-expect-error list exige o ClientId
  void repo.list();
  // @ts-expect-error count exige o ClientId
  void repo.count();
  // @ts-expect-error create exige o ClientId antes dos dados
  void repo.create({});
  // @ts-expect-error update exige o ClientId antes do id
  void repo.update(id, {});
  // @ts-expect-error delete exige o ClientId antes do id
  void repo.delete(id);

  // `string` solta no lugar do ClientId.
  // @ts-expect-error string não é ClientId
  void repo.findById('c7a1f2d0-3b1e-4d57-9f0a-6a1f2d03b1e4', id);
  // @ts-expect-error string não é ClientId
  void repo.list('c7a1f2d0-3b1e-4d57-9f0a-6a1f2d03b1e4');
  // @ts-expect-error string não é ClientId
  void repo.count(id);

  // clientId nos dados de criação ou de atualização.
  // @ts-expect-error TCreate não aceita clientId
  void repo.create(clientId, { clientId });
  // @ts-expect-error TUpdate não aceita clientId
  void repo.update(clientId, id, { clientId });
}

// O próprio contrato do repositório recusa um TCreate/TUpdate que carregue clientId.
interface ComClientId {
  clientId: string;
}
type Vazio = Record<string, never>;
// @ts-expect-error TCreate com clientId viola a restrição de TenantRepository
export type CreateComClientId = TenantRepository<object, ComClientId, Vazio>;
// @ts-expect-error TUpdate com clientId viola a restrição de TenantRepository
export type UpdateComClientId = TenantRepository<object, Vazio, ComClientId>;

describe('contrato de tipos do repositório de tenant', () => {
  it('é verificado pelo compilador (pnpm typecheck); em runtime só existe como módulo', () => {
    assert.equal(typeof typeContracts, 'function');
  });
});
