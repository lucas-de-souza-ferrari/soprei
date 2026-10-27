import { z } from 'zod';
import {
  CONTACT_REF_MAX_LENGTH,
  EXTERNAL_ID_MAX_LENGTH,
  MESSAGE_CONTENT_MAX_LENGTH,
} from '../../domain/index.js';
import { BaseError, type ExternalServiceError } from '../../shared/errors/index.js';
import type { Result } from '../../shared/types/index.js';

/** Por que uma mensagem recebe a resposta constante em vez de ir ao atendimento. */
export const INBOUND_NOTICE_REASONS = ['unsupported_type', 'invalid_text'] as const;
export type InboundNoticeReason = (typeof INBOUND_NOTICE_REASONS)[number];

const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;

/** Campos de identificação do job, também usados para validar a entrada antes de enfileirar. */
export const jobContactRefSchema = z
  .string()
  .regex(NO_CONTROL_CHARS)
  .min(1)
  .max(CONTACT_REF_MAX_LENGTH);
export const jobExternalIdSchema = z
  .string()
  .regex(NO_CONTROL_CHARS)
  .min(1)
  .max(EXTERNAL_ID_MAX_LENGTH);

const baseFields = {
  clientId: z.uuid(),
  contactRef: jobContactRefSchema,
  externalId: jobExternalIdSchema,
  requestId: z.string().min(1).max(128),
};

/**
 * Job da fila de entrada do canal. Guarda o texto do contato e o `contactRef` (dado pessoal) até
 * ser concluído e pelo período configurado. Campos desconhecidos são descartados na leitura (um job
 * adulterado nunca escolhe o número de envio: ele vem do banco, pelo `clientId`). O `clientId` foi resolvido no banco a partir do número
 * do canal; o worker nunca o deduz de outra coisa.
 */
export const inboundJobSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    ...baseFields,
    text: z.string().min(1).max(MESSAGE_CONTENT_MAX_LENGTH),
  }),
  z.object({
    kind: z.literal('notice'),
    ...baseFields,
    reason: z.enum(INBOUND_NOTICE_REASONS),
  }),
]);

export type InboundJob = z.infer<typeof inboundJobSchema>;

/**
 * Id determinístico do job: dedupe de reentregas do canal, por cliente (o mesmo `externalId` de
 * dois clientes nunca colide). Sem `:` (o BullMQ recusa) e nunca um inteiro puro: o prefixo é o
 * UUID do cliente e o `externalId` vai codificado.
 */
export function inboundJobId(job: Pick<InboundJob, 'clientId' | 'externalId'>): string {
  return `${job.clientId}_${encodeURIComponent(job.externalId)}`;
}

/**
 * Porta de entrada da fila (a aplicação e a apresentação só conhecem isto, nunca o BullMQ).
 * Falha ao enfileirar (Redis fora) volta como `Result.err`; quem chama decide (o webhook responde
 * 500 para o canal retentar).
 */
export interface InboundJobQueue {
  enqueue(job: InboundJob): Promise<Result<void, ExternalServiceError>>;
}

export interface InboundJobContext {
  /** Verdadeiro na última tentativa do job: depois dela não há retentativa. */
  readonly finalAttempt: boolean;
}

/** `done`: processado (ou já estava); `discarded`: descartado de propósito (ex.: cliente sem número). */
export type InboundJobOutcome = 'done' | 'discarded';

/** O que o worker executa para cada job (implementado por `ChannelInboundProcessor`). */
export type InboundJobHandler = (
  job: InboundJob,
  context: InboundJobContext,
) => Promise<InboundJobOutcome>;

/**
 * Erro que não adianta retentar (token inválido, janela fechada, cliente removido...): a fila
 * marca o job como falho de vez. O `context` nunca leva texto do contato nem destinatário.
 */
export class NonRetryableJobError extends BaseError {
  constructor(
    message: string,
    options: {
      readonly cause?: unknown;
      readonly context?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super({ message, code: 'JOB_NOT_RETRYABLE', statusCode: 500, ...options });
  }
}
