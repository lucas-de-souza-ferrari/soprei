import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { type ChannelConnection, type Company, CompanyId } from '../../domain/index.js';
import { AesGcmCredentialCipher } from '../../infrastructure/security/aes-gcm-credential-cipher.js';
import { ExternalServiceError } from '../../shared/errors/index.js';
import { SecretString } from '../../shared/types/index.js';
import { ChannelCredentialsService } from './channel-credentials.service.js';

const cipher = new AesGcmCredentialCipher([{ keyId: 'k', key: randomBytes(32) }], 'k');
const ID = CompanyId.parse(randomUUID());

function company(number: string | null, updatedAt: Date): Company {
  return {
    id: ID,
    name: 'x',
    slug: 'x-slug',
    status: 'ACTIVE',
    persona: null,
    whatsappPhoneNumberId: number,
    createdAt: new Date(0),
    updatedAt,
  };
}

function connection(status: 'CONNECTED' | 'TOKEN_INVALID', token: string): ChannelConnection {
  return {
    id: randomUUID(),
    companyId: ID,
    wabaId: '1',
    tokenCiphertext: cipher.encrypt(ID, new SecretString(token)),
    registrationPinCiphertext: null,
    mode: 'API_ONLY',
    tokenVersion: 4,
    status,
    tokenExpiresAt: null,
    tokenInvalidAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('ChannelCredentialsService', () => {
  it('par número+token coerente: devolve ready com a versão', async () => {
    const stamp = new Date(1000);
    const service = new ChannelCredentialsService({
      companies: { findById: () => Promise.resolve(company('555', stamp)) },
      connections: { find: () => Promise.resolve(connection('CONNECTED', 'tok-A')) },
      cipher,
      legacyToken: undefined,
    });
    const result = await service.forCompany(ID);
    assert.ok(result.kind === 'ready');
    assert.equal(result.phoneNumberId, '555');
    assert.equal(result.token.reveal(), 'tok-A');
    assert.equal(result.tokenVersion, 4);
  });

  it('empresa que muda entre a leitura do número e a da conexão: erro transitório, nunca um par misto', async () => {
    let reads = 0;
    const service = new ChannelCredentialsService({
      companies: {
        findById: () => {
          reads += 1;
          // Primeira leitura: estado antigo; a segunda (depois da conexão) já é o estado novo.
          return Promise.resolve(
            reads === 1 ? company('555', new Date(1000)) : company('777', new Date(2000)),
          );
        },
      },
      connections: { find: () => Promise.resolve(connection('CONNECTED', 'tok-novo')) },
      cipher,
      legacyToken: undefined,
    });
    await assert.rejects(service.forCompany(ID), (error: unknown) => {
      assert.ok(error instanceof ExternalServiceError);
      return true;
    });
  });

  it('TOKEN_INVALID, sem número e LEGACY', async () => {
    const stamp = new Date(1000);
    const withConnection = (status: 'CONNECTED' | 'TOKEN_INVALID', number: string | null) =>
      new ChannelCredentialsService({
        companies: { findById: () => Promise.resolve(company(number, stamp)) },
        connections: { find: () => Promise.resolve(connection(status, 'tok')) },
        cipher,
        legacyToken: 'global-token-de-teste',
      });
    assert.deepEqual(await withConnection('TOKEN_INVALID', '5').forCompany(ID), {
      kind: 'token_invalid',
    });
    assert.deepEqual(await withConnection('CONNECTED', null).forCompany(ID), { kind: 'none' });
    const legacy = await new ChannelCredentialsService({
      companies: { findById: () => Promise.resolve(company('9', stamp)) },
      connections: { find: () => Promise.resolve(null) },
      cipher,
      legacyToken: 'global-token-de-teste',
    }).forCompany(ID);
    assert.ok(legacy.kind === 'ready');
    assert.equal(legacy.tokenVersion, 'legacy');
  });
});
