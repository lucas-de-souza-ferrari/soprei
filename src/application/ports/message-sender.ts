import { ExternalServiceError } from '../../shared/errors/index.js';
import type { Result } from '../../shared/types/index.js';

export interface SendTextInput {
  /** Número do **cliente** pelo qual a mensagem sai (o `phone_number_id` do canal). */
  readonly phoneNumberId: string;
  /** Destinatário: o contato, como o canal o identificou (`contactRef`). Nunca vai a log. */
  readonly to: string;
  /** Texto da resposta. Nunca vai a log. */
  readonly text: string;
}

export interface SendTextSuccess {
  /** Id da mensagem enviada no canal (o `wamid` do WhatsApp). */
  readonly channelMessageId: string;
}

/** Por que o envio falhou, em termos que não carregam dado do contato. */
export type SendFailureReason = 'network' | 'timeout' | 'http_error' | 'invalid_response';

export interface MessageSendErrorDetails {
  readonly reason: SendFailureReason;
  /** Se vale tentar de novo (rede, timeout, 5xx, 429, limite de taxa do canal). */
  readonly retryable: boolean;
  /** Status HTTP da resposta do canal, quando houve resposta. */
  readonly httpStatus?: number;
  /** `error.code` numérico do canal. */
  readonly providerCode?: number;
  /** `error.type` do canal (ex.: `OAuthException`). */
  readonly providerType?: string;
}

/**
 * Falha de envio ao canal. O `context` leva só status HTTP, código e tipo do erro do canal e se é
 * retentável: **nunca** o corpo da requisição, o texto, o destinatário, o token nem a mensagem de
 * erro do canal (que pode citar o número). Por isso o serviço pode logá-lo como vem.
 */
export class MessageSendError extends ExternalServiceError {
  readonly reason: SendFailureReason;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly providerCode: number | undefined;
  readonly providerType: string | undefined;

  constructor(details: MessageSendErrorDetails) {
    super('Falha ao enviar a mensagem ao canal', {
      context: {
        reason: details.reason,
        retryable: details.retryable,
        ...(details.httpStatus === undefined ? {} : { httpStatus: details.httpStatus }),
        ...(details.providerCode === undefined ? {} : { providerCode: details.providerCode }),
        ...(details.providerType === undefined ? {} : { providerType: details.providerType }),
      },
    });
    this.reason = details.reason;
    this.retryable = details.retryable;
    this.httpStatus = details.httpStatus;
    this.providerCode = details.providerCode;
    this.providerType = details.providerType;
  }
}

/**
 * Porta de saída de mensagens para um canal (WhatsApp...). Erro esperado (rede, token, limite de
 * taxa, janela fechada) volta como `Result.err`, nunca como exceção.
 */
export interface MessageSender {
  sendText(input: SendTextInput): Promise<Result<SendTextSuccess, ExternalServiceError>>;
}

/** Erro de envio sem classificação (outro tipo de `ExternalServiceError`) é tratado como transitório. */
export function isRetryableSendError(error: ExternalServiceError): boolean {
  return error instanceof MessageSendError ? error.retryable : true;
}
