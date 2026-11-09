import { z } from 'zod';
import {
  type CreateLinkInput,
  type PaymentCheckInput,
  type PaymentCheckOutcome,
  type PaymentFailureReason,
  type PaymentOperation,
  type PaymentProvider,
  PaymentProviderError,
} from '../../../application/ports/payment-provider.js';
import { Result, type SecretString } from '../../../shared/types/index.js';
import {
  isTimeout,
  MAX_RESPONSE_BYTES,
  parseJson,
  readCapped,
} from '../whatsapp/whatsapp-cloud-api.client.js';

/** Nome do campo que traz a lista de itens no corpo de POST /links (a confirmar no primeiro teste real). */
const ITEMS_FIELD = 'items';
/** Teto da espera sugerida por Retry-After (nunca dorme mais que isto por uma instrução do provedor). */
const MAX_RETRY_AFTER_MS = 60_000;

const linkResponseSchema = z.object({ url: z.url().max(2048) });

const checkResponseSchema = z.object({
  success: z.boolean().optional(),
  paid: z.boolean().optional(),
  amount: z.number().nonnegative().optional(),
  paid_amount: z.number().nonnegative().optional(),
  capture_method: z.string().max(40).optional(),
});

export interface InfinitepayClientOptions {
  readonly baseUrl: string;
  /** INFINITEPAY_API_KEY: só vai em X-Api-Key, nunca em URL, log, erro ou métrica. */
  readonly apiKey: SecretString;
  /** INFINITEPAY_HANDLE (InfiniteTag, sem o cifrão). */
  readonly handle: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

interface CallParams {
  readonly operation: PaymentOperation;
  readonly path: string;
  readonly body: unknown;
}

/**
 * Adaptador da InfinitePay (Checkout Integrado, spec 031 E3) por fetch nativo, atrás da porta
 * PaymentProvider. Mesmo padrão dos adaptadores Graph: redirect manual (nunca segue redirecionamento: a
 * API Key iria junto), prazo por AbortSignal.timeout, leitura com teto de 64 KiB e schemas tolerantes.
 * A API Key vai SEMPRE em X-Api-Key, também no payment_check. 401 e 403 são erro de configuração (o
 * chamador alerta; nunca vira "não pago"). O erro devolvido nunca carrega o corpo do provedor.
 */
export class InfinitepayClient implements PaymentProvider {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: InfinitepayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? fetch;
  }

  async createLink(
    input: CreateLinkInput,
  ): Promise<Result<{ readonly url: string }, PaymentProviderError>> {
    const result = await this.call({
      operation: 'create_link',
      path: 'links',
      body: {
        handle: this.options.handle,
        order_nsu: input.orderId,
        [ITEMS_FIELD]: [{ quantity: 1, price: input.amountCents, description: input.description }],
        redirect_url: input.redirectUrl,
        webhook_url: input.webhookUrl,
        ...(input.customerEmail === undefined ? {} : { customer: { email: input.customerEmail } }),
        options: {
          single_payment: true,
          valid_until: input.validUntil.toISOString(),
          payment_methods_enabled: ['credit_card', 'pix'],
          // Taxas de parcelamento repassadas ao pagador (decisão do dono, E0): o amount continua o do pedido.
          assured_installments: 0,
        },
      },
    });
    if (!result.ok) return result;
    const parsed = linkResponseSchema.safeParse(result.value);
    if (!parsed.success || !this.isSafeLink(parsed.data.url)) {
      return fail('create_link', 'invalid_response');
    }
    return Result.ok({ url: parsed.data.url });
  }

  async checkPayment(
    input: PaymentCheckInput,
  ): Promise<Result<PaymentCheckOutcome, PaymentProviderError>> {
    const result = await this.call({
      operation: 'payment_check',
      path: 'payment_check',
      body: {
        handle: this.options.handle,
        order_nsu: input.orderId,
        ...(input.transactionNsu === undefined ? {} : { transaction_nsu: input.transactionNsu }),
        ...(input.slug === undefined ? {} : { slug: input.slug }),
      },
    });
    if (!result.ok) return result;
    const parsed = checkResponseSchema.safeParse(result.value);
    if (!parsed.success) return fail('payment_check', 'invalid_response');
    const data = parsed.data;
    return Result.ok({
      paid: data.success === true && data.paid === true,
      amountCents: integerOrNull(data.amount),
      paidAmountCents: integerOrNull(data.paid_amount),
      captureMethod: data.capture_method ?? null,
    });
  }

  /** O link vai ao navegador: só https (http só quando a própria base é http, ou seja, o servidor falso). */
  private isSafeLink(raw: string): boolean {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:') return true;
      return url.protocol === 'http:' && this.baseUrl.startsWith('http:');
    } catch {
      return false;
    }
  }

  private async call(params: CallParams): Promise<Result<unknown, PaymentProviderError>> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/${params.path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-api-key': this.options.apiKey.reveal(),
        },
        body: JSON.stringify(params.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      // Rede ou prazo: nunca se anexa o erro original (pode carregar a URL).
      return fail(params.operation, 'transient');
    }

    if (!response.ok) {
      // Corpo de erro nunca é lido para dentro do erro (pode ecoar a chave, o link ou o pagador).
      await response.body?.cancel().catch(() => undefined);
      return fail(
        params.operation,
        reasonFor(response.status),
        response.status,
        response.status === 429 ? retryAfterMs(response.headers.get('retry-after')) : undefined,
      );
    }
    try {
      const read = await readCapped(response, MAX_RESPONSE_BYTES);
      if (read.tooLarge) return fail(params.operation, 'invalid_response', response.status);
      return Result.ok(parseJson(read.text));
    } catch (error) {
      return fail(
        params.operation,
        isTimeout(error) ? 'transient' : 'invalid_response',
        response.status,
      );
    }
  }
}

function reasonFor(status: number): PaymentFailureReason {
  if (status === 401 || status === 403) return 'config';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status >= 500) return 'transient';
  return 'rejected';
}

function integerOrNull(value: number | undefined): number | null {
  return value === undefined || !Number.isInteger(value) ? null : value;
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
}

function fail(
  operation: PaymentOperation,
  reason: PaymentFailureReason,
  httpStatus?: number,
  retryAfter?: number,
): Result<never, PaymentProviderError> {
  return Result.err(
    new PaymentProviderError({
      operation,
      reason,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
    }),
  );
}
