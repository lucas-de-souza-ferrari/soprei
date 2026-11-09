import { ExternalServiceError } from '../../shared/errors/index.js';
import type { Result } from '../../shared/types/index.js';

export type PaymentOperation = 'create_link' | 'payment_check';

/**
 * Categoria da falha do provedor de pagamento:
 * - `config`: credencial recusada (401/403): erro de CONFIGURAÇÃO, nunca "pagamento não feito";
 * - `rate_limited`: 429, com espera sugerida;
 * - `transient`: rede, prazo ou 5xx (vale tentar de novo);
 * - `rejected`: outro 4xx (pedido recusado, não adianta repetir igual);
 * - `invalid_response`: resposta que não bate com o formato esperado.
 */
export type PaymentFailureReason =
  'config' | 'rate_limited' | 'transient' | 'rejected' | 'invalid_response';

export interface PaymentProviderErrorDetails {
  readonly operation: PaymentOperation;
  readonly reason: PaymentFailureReason;
  readonly httpStatus?: number;
  /** Espera sugerida em ms (só no 429, a partir de Retry-After quando válido). */
  readonly retryAfterMs?: number;
}

/**
 * Falha de uma chamada ao provedor de pagamento (spec 031, E3). O context leva SÓ
 * { operation, reason, httpStatus, retryable }: nunca o corpo do provedor (que pode ecoar a API Key, o link
 * ou o pagador), a chave nem a URL.
 */
export class PaymentProviderError extends ExternalServiceError {
  readonly operation: PaymentOperation;
  readonly reason: PaymentFailureReason;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(details: PaymentProviderErrorDetails) {
    super('Falha ao consultar o provedor de pagamento', {
      context: {
        operation: details.operation,
        reason: details.reason,
        retryable: PaymentProviderError.isRetryable(details.reason),
        ...(details.httpStatus === undefined ? {} : { httpStatus: details.httpStatus }),
      },
    });
    this.operation = details.operation;
    this.reason = details.reason;
    this.httpStatus = details.httpStatus;
    this.retryAfterMs = details.retryAfterMs;
  }

  get retryable(): boolean {
    return PaymentProviderError.isRetryable(this.reason);
  }

  private static isRetryable(reason: PaymentFailureReason): boolean {
    return reason === 'rate_limited' || reason === 'transient';
  }
}

export interface CreateLinkInput {
  /** O id do nosso pedido: vira o order_nsu. */
  readonly orderId: string;
  /** Valor do catálogo, em centavos. */
  readonly amountCents: number;
  readonly description: string;
  /** O mínimo do pagador (e-mail da conta); nunca telefone nem endereço. */
  readonly customerEmail?: string;
  readonly redirectUrl: string;
  readonly webhookUrl: string;
  readonly validUntil: Date;
}

export interface PaymentCheckInput {
  readonly orderId: string;
  /** Referências do evento ou do retorno; só valem como parâmetro da consulta (nada é concedido por elas). */
  readonly transactionNsu?: string | undefined;
  readonly slug?: string | undefined;
}

export interface PaymentCheckOutcome {
  /** success E paid verdadeiros na resposta. */
  readonly paid: boolean;
  /** Valor do link (amount): é o que se confere com o pedido. */
  readonly amountCents: number | null;
  /** Valor pago (pode ser maior: taxas de parcelamento repassadas). Só informativo. */
  readonly paidAmountCents: number | null;
  readonly captureMethod: string | null;
}

/**
 * Porta do provedor de pagamento (spec 031, E3): a aplicação nunca conhece o HTTP da InfinitePay.
 * Implementação real em infrastructure/external-apis/infinitepay/; os testes usam um servidor falso.
 */
export interface PaymentProvider {
  createLink(
    input: CreateLinkInput,
  ): Promise<Result<{ readonly url: string }, PaymentProviderError>>;
  checkPayment(
    input: PaymentCheckInput,
  ): Promise<Result<PaymentCheckOutcome, PaymentProviderError>>;
}
