import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { type ChannelConnection, type Client, ClientId } from '../../domain/index.js';
import { AesGcmCredentialCipher } from '../../infrastructure/security/aes-gcm-credential-cipher.js';
import { ExternalServiceError } from '../../shared/errors/index.js';
import { SecretString } from '../../shared/types/index.js';
import { ChannelCredentialsService } from './channel-credentials.service.js';

const cipher = new AesGcmCredentialCipher([{ keyId: 'k', key: randomBytes(32) }], 'k');
const ID = ClientId.parse(randomUUID());

function client(number: string | null, updatedAt: Date): Client {
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
    clientId: ID,
    wabaId: '1',
    tokenCiphertext: cipher.encrypt(ID, new SecretString(token)),
    registrationPinCiphertext: null,
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
      clients: { findById: () => Promise.resolve(client('555', stamp)) },
      connections: { find: () => Promise.resolve(connection('CONNECTED', 'tok-A')) },
      cipher,
      legacyToken: undefined,
    });
    const result = await service.forClient(ID);
    assert.ok(result.kind === 'ready');
    assert.equal(result.phoneNumberId, '555');
    assert.equal(result.token.reveal(), 'tok-A');
    assert.equal(result.tokenVersion, 4);
  });

  it('cliente que muda entre a leitura do número e a da conexão: erro transitório, nunca um par misto', async () => {
    let reads = 0;
    const service = new ChannelCredentialsService({
      clients: {
        findById: () => {
          reads += 1;
          // Primeira leitura: estado antigo; a segunda (depois da conexão) já é o estado novo.
          return Promise.resolve(
            reads === 1 ? client('555', new Date(1000)) : client('777', new Date(2000)),
          );
        },
      },
      connections: { find: () => Promise.resolve(connection('CONNECTED', 'tok-novo')) },
      cipher,
      legacyToken: undefined,
    });
    await assert.rejects(service.forClient(ID), (error: unknown) => {
      assert.ok(error instanceof ExternalServiceError);
      return true;
    });
  });

  it('TOKEN_INVALID, sem número e LEGACY', async () => {
    const stamp = new Date(1000);
    const withConnection = (status: 'CONNECTED' | 'TOKEN_INVALID', number: string | null) =>
      new ChannelCredentialsService({
        clients: { findById: () => Promise.resolve(client(number, stamp)) },
        connections: { find: () => Promise.resolve(connection(status, 'tok')) },
        cipher,
        legacyToken: 'global-token-de-teste',
      });
    assert.deepEqual(await withConnection('TOKEN_INVALID', '5').forClient(ID), {
      kind: 'token_invalid',
    });
    assert.deepEqual(await withConnection('CONNECTED', null).forClient(ID), { kind: 'none' });
    const legacy = await new ChannelCredentialsService({
      clients: { findById: () => Promise.resolve(client('9', stamp)) },
      connections: { find: () => Promise.resolve(null) },
      cipher,
      legacyToken: 'global-token-de-teste',
    }).forClient(ID);
    assert.ok(legacy.kind === 'ready');
    assert.equal(legacy.tokenVersion, 'legacy');
  });
});
