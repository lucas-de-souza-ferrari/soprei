import {
  type Company,
  type CompanyRepository,
  WHATSAPP_PHONE_NUMBER_ID_PATTERN,
} from '../../domain/index.js';
import { messageRef } from '../../shared/utils/index.js';
import { describeError } from './describe-error.js';
import { messageTextSchema } from '../attendance/attendance.schemas.js';
import {
  type InboundJob,
  type InboundJobQueue,
  jobExternalIdSchema,
} from '../ports/inbound-job-queue.js';

/** Destino de uma mensagem de entrada (vira o label `result` da métrica; conjunto fixo). */
export type ChannelInboundResult =
  | 'enqueued'
  | 'unknown_number'
  | 'company_unavailable'
  | 'unsupported_type'
  | 'invalid_text'
  | 'missing_sender'
  | 'invalid_message'
  | 'ignored_type';

export interface ChannelIntakeMetrics {
  countChannelInbound(channel: string, result: ChannelInboundResult): void;
}

/** Logger do canal. **Nunca** passe texto de mensagem, remetente, destinatário, nome nem segredo. */
export interface ChannelLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/** Uma mensagem de entrada, já extraída do formato do canal (o webhook valida o formato). */
/**
 * Tipos de mensagem do **contato** que o atendimento não lê: recebem o aviso "só consigo ler
 * texto". Qualquer outro tipo que não seja `text` (reação, `system`, `unsupported`, tipo novo ou
 * desconhecido) não é uma mensagem para atender: é descartado sem aviso.
 */
export const UNSUPPORTED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'audio',
  'image',
  'video',
  'document',
  'sticker',
  'location',
  'contacts',
]);

/** Conteúdo de uma mensagem de entrada a partir do `type` informado pelo canal. */
export function contentFromType(
  type: string | undefined,
  text: string | undefined,
): InboundChannelMessage['content'] {
  if (type === 'text') return { kind: 'text', text };
  if (type !== undefined && UNSUPPORTED_CONTENT_TYPES.has(type)) return { kind: 'unsupported' };
  return { kind: 'ignored' };
}

export interface InboundChannelMessage {
  /** Número do **negócio** que recebeu a mensagem (`phone_number_id`): o que resolve a empresa. */
  readonly phoneNumberId: string;
  /** Id da mensagem no canal (`wamid`): idempotência e id do job. */
  readonly messageId: string;
  /** Identificador do contato (`from`); ausente quando o canal não o informa. */
  readonly sender: string | undefined;
  readonly content:
    | { readonly kind: 'text'; readonly text: string | undefined }
    /** Conteúdo do contato que não sabemos ler (áudio, imagem...): recebe o aviso constante. */
    | { readonly kind: 'unsupported' }
    /** Evento que não é mensagem do contato (reação, sistema...): descartado sem aviso. */
    | { readonly kind: 'ignored' };
  /**
   * Instante em que o webhook recebeu a mensagem (spec 034), carimbado por quem lê o lote: dentro
   * do mesmo lote os valores são estritamente crescentes, na ordem do payload. Ordena as mensagens
   * do contato sem depender da ordem de processamento da fila.
   */
  readonly receivedAt?: Date;
}

export interface IntakeSummary {
  /** Mensagens que viraram job (texto ou aviso). */
  readonly enqueued: number;
  /** Descartadas de propósito (número desconhecido, empresa indisponível, sem remetente...). */
  readonly discarded: number;
  /** Que não puderam ser enfileiradas (fila ou banco fora): o webhook responde 500. */
  readonly failed: number;
}

export interface ChannelIntakeDeps {
  readonly companies: Pick<CompanyRepository, 'findByWhatsappPhoneNumberId'>;
  /** O webhook só enfileira mensagens e avisos; o `flush` é agendado pelo processador. */
  readonly queue: Pick<InboundJobQueue, 'enqueue'>;
  readonly logger: ChannelLogger;
  readonly metrics?: ChannelIntakeMetrics;
  /** Nome do canal para métricas (`whatsapp`). */
  readonly channel: string;
}

/** `wa_id` do contato: só dígitos (o canal o entrega assim). */
const SENDER_PATTERN = /^[0-9]{1,32}$/;

/**
 * Entrada do canal (spec 011): para cada mensagem, resolve a empresa **no banco** pelo número do
 * negócio e enfileira um job de atendimento (`text`) ou de aviso (`notice`). Não chama LLM nem o
 * canal: é o que o webhook faz de forma síncrona antes de responder 200.
 *
 * Isolamento: o `CompanyId` nasce aqui, da resolução `phone_number_id` -> empresa (assinada pela
 * Meta e conferida no banco), e é a única origem da empresa do job. Nada vem de cabeçalho, query
 * ou corpo. Privacidade: nenhum texto, remetente nem id de mensagem cru vai a log (só `messageRef`).
 */
export class ChannelIntakeService {
  constructor(private readonly deps: ChannelIntakeDeps) {}

  async accept(
    messages: readonly InboundChannelMessage[],
    requestId: string,
  ): Promise<IntakeSummary> {
    let enqueued = 0;
    let discarded = 0;
    let failed = 0;
    // Uma resolução por número dentro do lote (um lote costuma ter um número só).
    const companyCache = new Map<string, Promise<Company | null>>();

    // Em sequência: mantém a ordem do lote ao enfileirar. A ordem das mensagens do contato não
    // depende disso (vem do `receivedAt` de cada uma; a fila processa vários jobs ao mesmo tempo).
    for (const message of messages) {
      try {
        const outcome = await this.acceptOne(message, requestId, companyCache);
        if (outcome === 'enqueued') enqueued += 1;
        else if (outcome === 'failed') failed += 1;
        else discarded += 1;
      } catch (error) {
        failed += 1;
        this.deps.logger.error(
          { messageRef: messageRef(message.messageId), ...describeError(error) },
          'falha ao aceitar a mensagem de entrada do canal',
        );
      }
    }
    return { enqueued, discarded, failed };
  }

  private async acceptOne(
    message: InboundChannelMessage,
    requestId: string,
    companyCache: Map<string, Promise<Company | null>>,
  ): Promise<'enqueued' | 'discarded' | 'failed'> {
    const { logger } = this.deps;
    const ref = messageRef(message.messageId);

    // Reação, evento de sistema e tipo desconhecido não são mensagem do contato: nem aviso nem job.
    // Só id interno no log (nada do conteúdo).
    if (message.content.kind === 'ignored') {
      this.count('ignored_type');
      logger.info({ messageRef: ref }, 'evento que não é mensagem do contato ignorado');
      return 'discarded';
    }

    const contactRef = message.sender;
    if (contactRef === undefined || !SENDER_PATTERN.test(contactRef)) {
      this.count('missing_sender');
      logger.warn({ messageRef: ref }, 'mensagem sem remetente utilizável descartada');
      return 'discarded';
    }
    // O id do canal precisa servir de `externalId` (idempotência) e de id do job.
    if (
      !jobExternalIdSchema.safeParse(message.messageId).success ||
      !WHATSAPP_PHONE_NUMBER_ID_PATTERN.test(message.phoneNumberId)
    ) {
      this.count('invalid_message');
      logger.warn({ messageRef: ref }, 'mensagem com identificador inválido descartada');
      return 'discarded';
    }

    let lookup = companyCache.get(message.phoneNumberId);
    if (lookup === undefined) {
      lookup = this.deps.companies.findByWhatsappPhoneNumberId(message.phoneNumberId);
      companyCache.set(message.phoneNumberId, lookup);
    }
    const company = await lookup;
    if (company === null) {
      this.count('unknown_number');
      logger.warn(
        { phoneNumberId: message.phoneNumberId, messageRef: ref },
        'mensagem para número sem empresa descartada',
      );
      return 'discarded';
    }
    if (company.status === 'SUSPENDED') {
      this.count('company_unavailable');
      logger.warn(
        { companyId: company.id, messageRef: ref },
        'mensagem de empresa suspensa descartada',
      );
      return 'discarded';
    }

    const { job, result } = this.buildJob(message, company, contactRef, requestId);
    const enqueuedJob = await this.deps.queue.enqueue(job);
    if (!enqueuedJob.ok) {
      logger.error(
        {
          companyId: company.id,
          messageRef: ref,
          jobKind: job.kind,
          ...describeError(enqueuedJob.error),
        },
        'falha ao enfileirar a mensagem de entrada',
      );
      return 'failed';
    }
    this.count(result);
    logger.info(
      { companyId: company.id, messageRef: ref, jobKind: job.kind, result },
      'mensagem de entrada enfileirada',
    );
    return 'enqueued';
  }

  /** Texto válido vira `text`; tipo não textual ou texto inválido vira `notice` (nunca silêncio). */
  private buildJob(
    message: InboundChannelMessage,
    company: Company,
    contactRef: string,
    requestId: string,
  ): { job: InboundJob; result: ChannelInboundResult } {
    const base = {
      companyId: company.id,
      phoneNumberId: message.phoneNumberId,
      contactRef,
      externalId: message.messageId,
      requestId,
      ...(message.receivedAt === undefined ? {} : { receivedAt: message.receivedAt.toISOString() }),
    };
    if (message.content.kind !== 'text') {
      return {
        job: { kind: 'notice', ...base, reason: 'unsupported_type' },
        result: 'unsupported_type',
      };
    }
    const text = message.content.text;
    if (text === undefined || !messageTextSchema.safeParse(text).success) {
      return { job: { kind: 'notice', ...base, reason: 'invalid_text' }, result: 'invalid_text' };
    }
    return { job: { kind: 'text', ...base, text }, result: 'enqueued' };
  }

  private count(result: ChannelInboundResult): void {
    try {
      this.deps.metrics?.countChannelInbound(this.deps.channel, result);
    } catch (err) {
      this.deps.logger.warn(describeError(err), 'falha ao registrar métrica do canal');
    }
  }
}
