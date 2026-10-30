import type {
  ChannelConnection,
  ChannelConnectionUpdate,
  NewChannelConnection,
} from '../entities/channel-connection.js';
import type { ClientId } from '../value-objects/client-id.js';
import type { TenantRepository } from './tenant.repository.js';

/**
 * Credencial do canal por cliente (spec 015). `ClientId` é o primeiro parâmetro de todo método;
 * só existe uma conexão por cliente.
 */
export interface ChannelConnectionRepository extends TenantRepository<
  ChannelConnection,
  NewChannelConnection,
  ChannelConnectionUpdate
> {
  /** A conexão do cliente, ou `null`. */
  find(clientId: ClientId): Promise<ChannelConnection | null>;
  /**
   * Grava o token: cria a conexão ou troca o token da existente (`tokenVersion + 1`, `status` volta
   * a `CONNECTED`, `tokenInvalidAt` limpo). `replaced` diz se já havia conexão. Serialize por
   * `lockClient` (a unidade de trabalho do canal faz).
   */
  save(
    clientId: ClientId,
    data: NewChannelConnection,
  ): Promise<{ readonly connection: ChannelConnection; readonly replaced: boolean }>;
  /**
   * Marca `TOKEN_INVALID` **só se** a conexão ainda está na `tokenVersion` informada e `CONNECTED`
   * (um token novo gravado no meio não é invalidado por falha do antigo). Devolve se marcou.
   */
  markTokenInvalid(clientId: ClientId, tokenVersion: number, at: Date): Promise<boolean>;
  /** Apaga a conexão do cliente (some o texto cifrado). Devolve se havia. */
  removeByClient(clientId: ClientId): Promise<boolean>;
}
