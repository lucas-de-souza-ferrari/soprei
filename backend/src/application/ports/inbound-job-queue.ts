import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CONTACT_REF_MAX_LENGTH,
  EXTERNAL_ID_MAX_LENGTH,
  MESSAGE_CONTENT_MAX_LENGTH,
  WHATSAPP_PHONE_NUMBER_ID_PATTERN,
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

const identityFields = {
  companyId: z.uuid(),
  /**
   * Número do negócio que recebeu a mensagem, gravado ao enfileirar. Defesa em profundidade: o envio
   * usa SEMPRE o número lido do banco pelo `companyId`; este só serve para descartar o job se o número
   * da empresa mudou (ou o job foi adulterado) entre enfileirar e processar.
   */
  phoneNumberId: z.string().regex(WHATSAPP_PHONE_NUMBER_ID_PATTERN),
  contactRef: jobContactRefSchema,
  requestId: z.string().min(1).max(128),
};

const baseFields = {
  ...identityFields,
  externalId: jobExternalIdSchema,
  /**
   * Instante em que o webhook recebeu a mensagem (ISO UTC, spec 034). É ele que ordena as mensagens
   * de um contato, não a ordem em que os jobs são processados (a fila roda vários ao mesmo tempo).
   * Opcional: job enfileirado antes de o campo existir continua válido e usa o relógio do banco.
   */
  receivedAt: z.iso.datetime().optional(),
};

/**
 * Job da fila de entrada do canal. Guarda o texto do contato e o `contactRef` (dado pessoal) até
 * ser concluído e pelo período configurado. Campos desconhecidos são descartados na leitura (um job
 * adulterado nunca escolhe o número de envio: ele vem do banco, pelo `companyId`). O `companyId` foi resolvido no banco a partir do número
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
 * Job de resposta às mensagens pendentes de um contato (spec 013). **Não carrega texto**: o texto
 * vive no banco. Leva só a empresa, o número do negócio (para descartar o job se o número da empresa
 * mudou), o contato e o `requestId`.
 */
export const flushJobSchema = z.object({
  kind: z.literal('flush'),
  ...identityFields,
});

export type FlushJob = z.infer<typeof flushJobSchema>;

/** Qualquer job da fila do canal: mensagem (`text`), aviso (`notice`) ou resposta (`flush`). */
export const channelJobSchema = z.discriminatedUnion('kind', [
  ...inboundJobSchema.options,
  flushJobSchema,
]);

export type ChannelJob = z.infer<typeof channelJobSchema>;

/**
 * Id determinístico do job: dedupe de reentregas do canal, por empresa (o mesmo `externalId` de
 * duas empresas nunca colide). Sem `:` (o BullMQ recusa) e nunca um inteiro puro: o prefixo é o
 * UUID da empresa e o `externalId` vai codificado.
 */
export function inboundJobId(job: Pick<InboundJob, 'companyId' | 'externalId'>): string {
  return `${job.companyId}_${encodeURIComponent(job.externalId)}`;
}

/**
 * Identidade do `flush` de um contato: no máximo um por `(companyId, contactRef)`. Inclui o
 * `companyId` (o mesmo `contactRef` de duas empresas nunca colide) e um hash do `contactRef`, para o
 * telefone não aparecer na chave do Redis. Sem `:`. Serve de id de deduplicação na fila (um
 * `jobId` fixo impediria a janela deslizante: ver o registro da spec 013).
 */
export function flushKey(job: Pick<FlushJob, 'companyId' | 'contactRef'>): string {
  const digest = createHash('sha256').update(job.contactRef).digest('hex').slice(0, 32);
  return `flush_${job.companyId}_${digest}`;
}

/** Quando e como o `flush` de um contato roda (spec 013). */
export interface FlushSchedule {
  /** Espera até o `flush` rodar, em ms (0 = assim que o worker puder). */
  readonly delayMs: number;
  /**
   * `slide`: janela deslizante, uma mensagem nova **reinicia** a espera de um `flush` que ainda está
   * esperando. `ensure`: só garante que existe um `flush` a caminho, sem adiar o que já existe
   * (reentrega do canal, retentativa e excedente de lote). Em ambos, se o `flush` do contato está
   * rodando agora, o próximo é guardado e criado quando ele terminar: uma mensagem que chega durante
   * o atendimento nunca fica sem resposta.
   */
  readonly mode: 'slide' | 'ensure';
}

/**
 * Porta da fila (a aplicação e a apresentação só conhecem isto, nunca o BullMQ).
 * Falha ao enfileirar (Redis fora) volta como `Result.err`; quem chama decide (o webhook responde
 * 500 para o canal retentar).
 */
export interface InboundJobQueue {
  enqueue(job: InboundJob): Promise<Result<void, ExternalServiceError>>;
  /** Agenda (ou reagenda) o `flush` de um contato. */
  scheduleFlush(
    job: FlushJob,
    schedule: FlushSchedule,
  ): Promise<Result<void, ExternalServiceError>>;
}

export interface InboundJobContext {
  /** Número desta tentativa, a partir de 1 (maior que 1 = retentativa de um job que já falhou). */
  readonly attempt?: number;
  /** Verdadeiro na última tentativa do job: depois dela não há retentativa. */
  readonly finalAttempt: boolean;
}

/** `done`: processado (ou já estava); `discarded`: descartado de propósito (ex.: empresa sem número). */
export type InboundJobOutcome = 'done' | 'discarded';

/** O que o worker executa para cada job (implementado por `ChannelInboundProcessor`). */
export type InboundJobHandler = (
  job: ChannelJob,
  context: InboundJobContext,
) => Promise<InboundJobOutcome>;

/**
 * Chamado quando um job **termina em falha sem ter passado pelo handler** (ex.: parado/"stalled"
 * mais vezes que o limite, depois de uma queda do processo). A implementação tenta, sem duplicar,
 * que o contato não fique no silêncio. Nunca deve lançar (a fila só registra a falha dela).
 */
export type InboundJobFailureHandler = (job: ChannelJob) => Promise<void>;

/**
 * Erro que não adianta retentar (token inválido, janela fechada, empresa removida...): a fila
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
