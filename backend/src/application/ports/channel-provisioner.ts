import { ExternalServiceError } from '../../shared/errors/index.js';
import type { Result, SecretString } from '../../shared/types/index.js';

export type ProvisionOperation =
  'exchange_code' | 'inspect_token' | 'list_numbers' | 'subscribe' | 'register' | 'unsubscribe';
export type ProvisionFailureReason = 'network' | 'timeout' | 'http_error' | 'invalid_response';

export interface ChannelProvisionErrorDetails {
  readonly operation: ProvisionOperation;
  readonly reason: ProvisionFailureReason;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly providerCode?: number;
}

/**
 * Falha de uma chamada de administração ao Graph (spec 015). O `context` leva só
 * `{ operation, httpStatus, providerCode, retryable }`: **nunca** o corpo da Meta (que pode ecoar
 * token ou número), o token nem a URL.
 */
export class ChannelProvisionError extends ExternalServiceError {
  readonly operation: ProvisionOperation;
  readonly reason: ProvisionFailureReason;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly providerCode: number | undefined;

  constructor(details: ChannelProvisionErrorDetails) {
    super('Falha ao consultar o provedor do canal', {
      context: {
        operation: details.operation,
        reason: details.reason,
        retryable: details.retryable,
        ...(details.httpStatus === undefined ? {} : { httpStatus: details.httpStatus }),
        ...(details.providerCode === undefined ? {} : { providerCode: details.providerCode }),
      },
    });
    this.operation = details.operation;
    this.reason = details.reason;
    this.retryable = details.retryable;
    this.httpStatus = details.httpStatus;
    this.providerCode = details.providerCode;
  }
}

/** O que o `debug_token` revela do token, já resumido. */
export interface TokenInspection {
  readonly isValid: boolean;
  readonly appId: string | undefined;
  /** Escopos concedidos (incluindo os granulares). */
  readonly scopes: readonly string[];
  /**
   * WABAs (`target_ids`) dos escopos do WhatsApp; `undefined` se a Meta não os devolveu (a prova de
   * posse pela lista de números continua obrigatória).
   */
  readonly wabaTargetIds: readonly string[] | undefined;
  /** `null` = não expira (ou a Meta não informou). */
  readonly expiresAt: Date | null;
}

/**
 * Chamadas de administração ao Graph para conectar um cliente (spec 015). O token do cliente vai em
 * `Authorization: Bearer`; erros esperados voltam como `Result.err`.
 */
export interface ChannelProvisioner {
  /**
   * Troca o `code` do Embedded Signup (uso único, vida de ~30 s) pelo token de negócio, com o app id
   * e o segredo do app. O `code` e o token nunca vão a log nem a erro.
   */
  exchangeCode(code: SecretString): Promise<Result<SecretString, ChannelProvisionError>>;
  /** Registra o número na Cloud API (`/register`) com o PIN de 6 dígitos (spec 015b). */
  registerNumber(
    phoneNumberId: string,
    token: SecretString,
    pin: SecretString,
  ): Promise<Result<void, ChannelProvisionError>>;
  /** `debug_token`, autenticado com o token de app (`WHATSAPP_APP_ID|WHATSAPP_APP_SECRET`). */
  inspectToken(token: SecretString): Promise<Result<TokenInspection, ChannelProvisionError>>;
  /** `phone_number_id` dos números da WABA que o token enxerga. */
  listPhoneNumberIds(
    wabaId: string,
    token: SecretString,
  ): Promise<Result<readonly string[], ChannelProvisionError>>;
  /** Assina o app na WABA (sem isso o webhook não chega). */
  subscribeApp(wabaId: string, token: SecretString): Promise<Result<void, ChannelProvisionError>>;
  /** Desassina o app da WABA. */
  unsubscribeApp(wabaId: string, token: SecretString): Promise<Result<void, ChannelProvisionError>>;
}
