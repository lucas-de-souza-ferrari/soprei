import { z } from 'zod';
import {
  MessageSendError,
  type MessageSender,
  type SendTextInput,
  type SendTextSuccess,
} from '../../../application/ports/message-sender.js';
import { EXTERNAL_ID_MAX_LENGTH } from '../../../domain/index.js';
import type { ExternalServiceError } from '../../../shared/errors/index.js';
import { Result } from '../../../shared/types/index.js';
import type { ChannelSendSample } from '../../metrics/index.js';

/** Nome do canal nos labels de métrica. */
export const WHATSAPP_CHANNEL = 'whatsapp';

/**
 * Teto de bytes lidos da resposta do Graph API (a de verdade tem poucas centenas). Passou disso a
 * leitura é abortada e a conexão cancelada: nada de bufferizar o corpo inteiro de uma resposta
 * hostil ou defeituosa.
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Códigos de erro da Meta que são transitórios (limite de taxa e indisponibilidade), segundo a
 * página de códigos de erro da Cloud API: 4 e 80007 (limite de chamadas do app e da conta),
 * 130429 (vazão da Cloud API), 131056 (muitas mensagens para o mesmo par), 17, 32 e 613 (limites
 * de chamadas do Graph API), 2, 131016 e 133004 (serviço indisponível) e 131000 (erro
 * desconhecido, que a documentação manda tentar de novo). Todo outro código é permanente: token
 * inválido ou expirado (0, 190), permissão (3, 10, 131005), janela de 24 h fechada (131047),
 * destinatário inválido ou não entregável (131021, 131026, 131030), parâmetro inválido (100,
 * 131008, 131009), pagamento (131042), conta restrita (368)...
 */
const RETRYABLE_PROVIDER_CODES: ReadonlySet<number> = new Set([
  2, 4, 17, 32, 613, 80007, 130429, 131000, 131016, 131056, 133004,
]);

/** Corpo de sucesso: só o id da mensagem importa. */
const sendSuccessSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1).max(EXTERNAL_ID_MAX_LENGTH) })).min(1),
});

/** Corpo de erro do Graph API: só `code` e `type` são lidos (a `message` pode citar o número). */
const graphErrorSchema = z.object({
  error: z.object({
    code: z.number().int().optional(),
    type: z
      .string()
      .regex(/^[A-Za-z0-9_]{1,64}$/)
      .optional(),
  }),
});

export interface WhatsappCloudApiClientOptions {
  /** `WHATSAPP_API_BASE_URL`, sem `/` no fim obrigatória (é normalizada). */
  readonly baseUrl: string;
  /** `WHATSAPP_GRAPH_API_VERSION` (`v26.0`). */
  readonly graphApiVersion: string;
  /** `WHATSAPP_ACCESS_TOKEN`. Nunca vai a log nem a erro. */
  readonly accessToken: string;
  /** `WHATSAPP_SEND_TIMEOUT_MS`. */
  readonly timeoutMs: number;
  /** Observador de métricas (o `Metrics` da 004 satisfaz). Falha ao medir nunca derruba o envio. */
  readonly metrics?: { observeChannelSend(sample: ChannelSendSample): void };
  /** Substituível nos testes; por padrão o `fetch` nativo. */
  readonly fetch?: typeof fetch;
}

/** Retentável pelo status HTTP e pelo código da Meta (o código tem precedência quando conhecido). */
export function isRetryableGraphFailure(
  httpStatus: number,
  providerCode: number | undefined,
): boolean {
  if (providerCode !== undefined && RETRYABLE_PROVIDER_CODES.has(providerCode)) return true;
  return httpStatus >= 500 || httpStatus === 429 || httpStatus === 408;
}

/**
 * Envio de texto pela Cloud API da Meta: `POST {base}/{versão}/{phone_number_id}/messages` com
 * `Authorization: Bearer`, via `fetch` nativo e prazo por `AbortSignal.timeout`.
 *
 * Privacidade: o erro devolvido leva só status HTTP, `code`, `type` e se é retentável; **nunca** o
 * corpo da requisição, o texto, o destinatário, o token nem a `message` do erro da Meta.
 */
export class WhatsappCloudApiClient implements MessageSender {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: WhatsappCloudApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? fetch;
  }

  async sendText(input: SendTextInput): Promise<Result<SendTextSuccess, ExternalServiceError>> {
    const startedAt = performance.now();
    const result = await this.post(input);
    this.observe({
      channel: WHATSAPP_CHANNEL,
      result: result.ok ? 'ok' : 'error',
      durationSeconds: (performance.now() - startedAt) / 1000,
    });
    return result;
  }

  private async post(input: SendTextInput): Promise<Result<SendTextSuccess, MessageSendError>> {
    const url = `${this.baseUrl}/${this.options.graphApiVersion}/${encodeURIComponent(input.phoneNumberId)}/messages`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: input.to,
          type: 'text',
          text: { body: input.text },
        }),
        // Redirecionar levaria o token a outro host: tratado como erro HTTP, sem seguir.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      return Result.err(
        new MessageSendError({ reason: isTimeout(error) ? 'timeout' : 'network', retryable: true }),
      );
    }

    let raw: unknown;
    try {
      const read = await readCapped(response, MAX_RESPONSE_BYTES);
      if (read.tooLarge) {
        // Corpo absurdo: lido só até o teto e descartado. Em 2xx o envio pode ter acontecido (nada de
        // reenviar); em erro, o status decide.
        if (response.ok) {
          return Result.err(
            new MessageSendError({
              reason: 'invalid_response',
              retryable: false,
              httpStatus: response.status,
            }),
          );
        }
        raw = undefined;
      } else {
        raw = parseJson(read.text);
      }
    } catch (error) {
      if (response.ok) {
        // A Meta aceitou o envio mas não lemos o id: retentar poderia duplicar a mensagem.
        return Result.err(
          new MessageSendError({
            reason: isTimeout(error) ? 'timeout' : 'invalid_response',
            retryable: false,
            httpStatus: response.status,
          }),
        );
      }
      raw = undefined;
    }

    if (response.ok) {
      const parsed = sendSuccessSchema.safeParse(raw);
      const first = parsed.success ? parsed.data.messages[0] : undefined;
      if (first === undefined) {
        return Result.err(
          new MessageSendError({
            reason: 'invalid_response',
            retryable: false,
            httpStatus: response.status,
          }),
        );
      }
      return Result.ok({ channelMessageId: first.id });
    }

    const graphError = graphErrorSchema.safeParse(raw);
    const providerCode = graphError.success ? graphError.data.error.code : undefined;
    const providerType = graphError.success ? graphError.data.error.type : undefined;
    return Result.err(
      new MessageSendError({
        reason: 'http_error',
        retryable: isRetryableGraphFailure(response.status, providerCode),
        httpStatus: response.status,
        ...(providerCode === undefined ? {} : { providerCode }),
        ...(providerType === undefined ? {} : { providerType }),
      }),
    );
  }

  private observe(sample: ChannelSendSample): void {
    try {
      this.options.metrics?.observeChannelSend(sample);
    } catch {
      // Métrica é acessório: nunca derruba nem muda o resultado do envio.
    }
  }
}

/**
 * Lê o corpo em pedaços e para ao passar de `maxBytes` (cancelando a conexão), mantendo o prazo do
 * `AbortSignal.timeout` da requisição. Erro de leitura (prazo, conexão) é relançado.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ readonly text: string; readonly tooLarge: boolean }> {
  if (response.body === null) return { text: '', tooLarge: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = (await reader.read()) as
      { done: true; value?: undefined } | { done: false; value: Uint8Array };
    if (result.done) break;
    const value = result.value;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { text: '', tooLarge: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), tooLarge: false };
}

function parseJson(text: string): unknown {
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
