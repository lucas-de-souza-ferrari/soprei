import type {
  ChannelConnectionRepository,
  ClientId,
  ClientRepository,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import { CredentialDecryptionError, ExternalServiceError } from '../../shared/errors/index.js';
import { SecretString } from '../../shared/types/index.js';
import type { ChannelCredentials, ChannelCredentialsResult } from '../ports/channel-credentials.js';
import type { CredentialCipher } from '../ports/credential-cipher.js';

export interface ChannelCredentialsServiceDeps {
  readonly clients: Pick<ClientRepository, 'findById'>;
  readonly connections: Pick<ChannelConnectionRepository, 'find'>;
  readonly cipher: CredentialCipher;
  /** `WHATSAPP_ACCESS_TOKEN`: só para clientes `LEGACY` (número gravado e sem conexão própria). */
  readonly legacyToken: string | undefined;
  readonly metrics?: Pick<Metrics, 'countChannelCredentialError'> | undefined;
}

/**
 * Credenciais de envio de um cliente (spec 015). Cliente **com** conexão nunca usa o token global
 * (mesmo `TOKEN_INVALID`); só o `LEGACY` (número e nenhuma conexão) o usa, se existir. Texto que não
 * decifra (formato, chave ausente, outro cliente pela AAD) conta em
 * `channel_credential_errors_total{reason}` e relança `CredentialDecryptionError`: é falha nossa, não
 * vira `TOKEN_INVALID`.
 */
export class ChannelCredentialsService implements ChannelCredentials {
  constructor(private readonly deps: ChannelCredentialsServiceDeps) {}

  async forClient(clientId: ClientId): Promise<ChannelCredentialsResult> {
    // O número (cliente) e o token (conexão) são gravados na mesma transação, mas lidos aqui em duas
    // consultas: relê o cliente depois da conexão e confere que não mudou no meio (`updatedAt`), para
    // nunca parear o número de um estado com o token de outro. Mudou: erro transitório (a fila retenta).
    const client = await this.deps.clients.findById(clientId);
    const phoneNumberId = client.whatsappPhoneNumberId;
    if (phoneNumberId === null) return { kind: 'none' };

    const connection = await this.deps.connections.find(clientId);
    const after = await this.deps.clients.findById(clientId);
    if (
      after.whatsappPhoneNumberId !== phoneNumberId ||
      after.updatedAt.getTime() !== client.updatedAt.getTime()
    ) {
      throw new ExternalServiceError('Credencial do canal mudou durante a leitura; tente de novo', {
        context: { reason: 'credentials_changed_during_read' },
      });
    }
    if (connection === null) {
      if (this.deps.legacyToken === undefined) return { kind: 'none' };
      return {
        kind: 'ready',
        phoneNumberId,
        token: new SecretString(this.deps.legacyToken),
        tokenVersion: 'legacy',
      };
    }
    if (connection.status === 'TOKEN_INVALID') return { kind: 'token_invalid' };

    try {
      const token = this.deps.cipher.decrypt(clientId, connection.tokenCiphertext);
      return { kind: 'ready', phoneNumberId, token, tokenVersion: connection.tokenVersion };
    } catch (error) {
      if (error instanceof CredentialDecryptionError) {
        try {
          this.deps.metrics?.countChannelCredentialError(error.reason);
        } catch {
          // Métrica é acessório.
        }
      }
      throw error;
    }
  }
}
