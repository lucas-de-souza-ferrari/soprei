import type {
  ChannelConnection,
  ChannelConnectionUpdate,
  NewChannelConnection,
} from '../entities/channel-connection.js';
import type { CompanyId } from '../value-objects/company-id.js';
import type { TenantRepository } from './tenant.repository.js';

/**
 * Credencial do canal por empresa (spec 015). `CompanyId` é o primeiro parâmetro de todo método;
 * só existe uma conexão por empresa.
 */
export interface ChannelConnectionRepository extends TenantRepository<
  ChannelConnection,
  NewChannelConnection,
  ChannelConnectionUpdate
> {
  /** A conexão da empresa, ou `null`. */
  find(companyId: CompanyId): Promise<ChannelConnection | null>;
  /**
   * Grava o token: cria a conexão ou troca o token da existente (`tokenVersion + 1`, `status` volta
   * a `CONNECTED`, `tokenInvalidAt` limpo). `replaced` diz se já havia conexão. Serialize por
   * `lockCompany` (a unidade de trabalho do canal faz).
   */
  save(
    companyId: CompanyId,
    data: NewChannelConnection,
  ): Promise<{ readonly connection: ChannelConnection; readonly replaced: boolean }>;
  /**
   * Marca `TOKEN_INVALID` **só se** a conexão ainda está na `tokenVersion` informada e `CONNECTED`
   * (um token novo gravado no meio não é invalidado por falha do antigo). Devolve se marcou.
   */
  markTokenInvalid(companyId: CompanyId, tokenVersion: number, at: Date): Promise<boolean>;
  /** Apaga a conexão da empresa (some o texto cifrado). Devolve se havia. */
  removeByCompany(companyId: CompanyId): Promise<boolean>;
}
