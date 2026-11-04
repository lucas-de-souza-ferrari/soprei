import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CompanyId } from '../value-objects/company-id.js';
import type { ConversationRepository } from './conversation.repository.js';
import type { TenantRepository } from './tenant.repository.js';

/**
 * Teste de TIPOS: este arquivo é compilado por `pnpm typecheck`. Cada `@ts-expect-error`
 * só é aceito pelo compilador se a linha seguinte realmente NÃO compilar; se alguém tornar
 * a API frouxa (ex.: deixar `companyId` opcional ou aceitar `string`), o typecheck falha por
 * "unused @ts-expect-error". A função nunca é chamada: só importa que compile (ou não).
 */
export function typeContracts(
  repo: ConversationRepository,
  companyId: CompanyId,
  id: string,
): void {
  // O que deve compilar.
  void repo.findById(companyId, id);
  void repo.list(companyId);
  void repo.list(companyId, { limit: 10, cursor: 'x' });
  void repo.create(companyId, { contactRef: 'c' });
  void repo.update(companyId, id, {});
  void repo.delete(companyId, id);
  void repo.count(companyId);

  // Sem CompanyId.
  // @ts-expect-error findById exige o CompanyId como primeiro parâmetro
  void repo.findById(id);
  // @ts-expect-error list exige o CompanyId
  void repo.list();
  // @ts-expect-error count exige o CompanyId
  void repo.count();
  // @ts-expect-error create exige o CompanyId antes dos dados
  void repo.create({ contactRef: 'c' });
  // @ts-expect-error update exige o CompanyId antes do id
  void repo.update(id, {});
  // @ts-expect-error delete exige o CompanyId antes do id
  void repo.delete(id);

  // `string` solta no lugar do CompanyId.
  // @ts-expect-error string não é CompanyId
  void repo.findById('c7a1f2d0-3b1e-4d57-9f0a-6a1f2d03b1e4', id);
  // @ts-expect-error string não é CompanyId
  void repo.list('c7a1f2d0-3b1e-4d57-9f0a-6a1f2d03b1e4');
  // @ts-expect-error string não é CompanyId
  void repo.count(id);

  // companyId nos dados de criação ou de atualização.
  // @ts-expect-error TCreate não aceita companyId
  void repo.create(companyId, { contactRef: 'c', companyId });
  // @ts-expect-error TUpdate não aceita companyId
  void repo.update(companyId, id, { companyId });
}

// O próprio contrato do repositório recusa um TCreate/TUpdate que carregue companyId.
interface ComCompanyId {
  companyId: string;
}
type Vazio = Record<string, never>;
// @ts-expect-error TCreate com companyId viola a restrição de TenantRepository
export type CreateComCompanyId = TenantRepository<object, ComCompanyId, Vazio>;
// @ts-expect-error TUpdate com companyId viola a restrição de TenantRepository
export type UpdateComCompanyId = TenantRepository<object, Vazio, ComCompanyId>;

describe('contrato de tipos do repositório de tenant', () => {
  it('é verificado pelo compilador (pnpm typecheck); em runtime só existe como módulo', () => {
    assert.equal(typeof typeContracts, 'function');
  });
});
