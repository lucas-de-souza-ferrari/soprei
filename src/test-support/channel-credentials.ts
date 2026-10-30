import { randomBytes } from 'node:crypto';
import { ChannelCredentialsService } from '../application/channel/channel-credentials.service.js';
import {
  PrismaChannelConnectionRepository,
  PrismaClientRepository,
  type TenantScopedPrisma,
} from '../infrastructure/database/index.js';
import type { Metrics } from '../infrastructure/metrics/index.js';
import { AesGcmCredentialCipher } from '../infrastructure/security/aes-gcm-credential-cipher.js';

/** Chaves descartáveis de teste (nunca valem fora dos testes). */
export const TEST_CREDENTIAL_KEY_ID = 'teste';

export function testCredentialCipher(): AesGcmCredentialCipher {
  return new AesGcmCredentialCipher(
    [{ keyId: TEST_CREDENTIAL_KEY_ID, key: randomBytes(32) }],
    TEST_CREDENTIAL_KEY_ID,
  );
}

/**
 * Credenciais do canal sobre o banco de testes (spec 015): repositório real, cifra descartável e o
 * token global de transição só se informado. Cliente com número e sem conexão é `LEGACY`.
 */
export function buildChannelCredentials(
  prisma: TenantScopedPrisma,
  options: {
    readonly legacyToken?: string;
    readonly metrics?: Pick<Metrics, 'countChannelCredentialError'>;
    readonly cipher?: AesGcmCredentialCipher;
  } = {},
): {
  readonly cipher: AesGcmCredentialCipher;
  readonly connections: PrismaChannelConnectionRepository;
  readonly credentials: ChannelCredentialsService;
} {
  const cipher = options.cipher ?? testCredentialCipher();
  const connections = new PrismaChannelConnectionRepository(prisma);
  const credentials = new ChannelCredentialsService({
    clients: new PrismaClientRepository(prisma),
    connections,
    cipher,
    legacyToken: options.legacyToken,
    metrics: options.metrics,
  });
  return { cipher, connections, credentials };
}
