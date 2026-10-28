import { ZodError } from 'zod';
import { ClientId, type ClientRepository, type MessageRepository } from '../../domain/index.js';
import type { ExternalServiceError } from '../../shared/errors/index.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { messageRef } from '../../shared/utils/index.js';
import { describeError } from './describe-error.js';
import type { AttendanceResult } from '../attendance/attendance.service.js';
import { ATTENDANCE_FALLBACK_TEXT } from '../attendance/attendance.service.js';
import type { InboundMessage } from '../attendance/attendance.schemas.js';
import {
  type InboundJob,
  type InboundJobContext,
  type InboundJobOutcome,
  NonRetryableJobError,
} from '../ports/inbound-job-queue.js';
import {
  isRetryableSendError,
  MessageSendError,
  type MessageSender,
} from '../ports/message-sender.js';
import { CHANNEL_NOTICE_TEXTS } from './channel-texts.js';
import type { ChannelLogger } from './channel-intake.service.js';

/** O que o processador precisa do atendimento (o `AttendanceService` satisfaz). */
export interface InboundAttendance {
  handleInboundMessage(clientId: ClientId, input: InboundMessage): Promise<AttendanceResult>;
}

export interface ChannelInboundProcessorDeps {
  readonly attendance: InboundAttendance;
  /** O número do canal é lido daqui, pelo `clientId` do job: nunca do payload. */
  readonly clients: Pick<ClientRepository, 'findById'>;
  readonly messages: Pick<MessageRepository, 'markSent' | 'findByExternalId' | 'findReplyTo'>;
  readonly sender: MessageSender;
  readonly logger: ChannelLogger;
  /** Relógio injetável, para os testes. */
  readonly now?: () => Date;
}

/**
 * Processa um job da fila de entrada do canal (spec 011), em segundo plano:
 *
 * - `text`: atendimento (`AttendanceService`, idempotente por `externalId`), depois envio da
 *   resposta pelo número que o **banco** associa ao `clientId` do job, e marca de envio. Resposta
 *   que já tem `sentAt` não é reenviada.
 * - `notice`: envia o texto constante, sem gravar mensagem nem chamar o LLM.
 *
 * Erros: transitórios (`ConflictError` de mensagem em andamento, banco, rede, 5xx, 429, limite de
 * taxa) são relançados para a fila retentar; permanentes viram `NonRetryableJobError`. Falha final
 * **antes de existir resposta gravada** tenta uma vez enviar o texto padrão ao contato (melhor
 * esforço); se a resposta já existe e o que falha é o envio, nada é reenviado como fallback.
 *
 * Privacidade: nenhum texto, destinatário ou id de mensagem cru vai a log (só `messageRef`, ids
 * internos e códigos). O `ExternalServiceError` do envio já não carrega dado do contato.
 */
export class ChannelInboundProcessor {
  private readonly now: () => Date;

  constructor(private readonly deps: ChannelInboundProcessorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async process(job: InboundJob, context: InboundJobContext): Promise<InboundJobOutcome> {
    const clientId = parseClientId(job);
    return job.kind === 'notice'
      ? this.processNotice(clientId, job)
      : this.processText(clientId, job, context);
  }

  /**
   * Job que falhou de vez **sem passar pelo handler** (ex.: parado além do limite depois de uma
   * queda do processo): para o contato não ficar no silêncio, tenta uma vez o texto padrão, mas só
   * se ainda não há resposta gravada (se há, ela fica visível na API administrativa e nada é
   * enviado). Melhor esforço, nunca lança. Limitação: se a tentativa que parou chegou a enviar a
   * resposta sem gravar a marca, o contato pode receber o texto padrão além dela.
   */
  async handleUnprocessedFailure(job: InboundJob): Promise<void> {
    const ref = messageRef(job.externalId);
    try {
      const clientId = parseClientId(job);
      if (job.kind === 'notice') {
        this.deps.logger.warn(
          { clientId, messageRef: ref },
          'aviso constante não enviado: o job falhou',
        );
        return;
      }
      const message = await this.deps.messages.findByExternalId(clientId, job.externalId);
      if (
        message !== null &&
        (await this.deps.messages.findReplyTo(clientId, message.id)) !== null
      ) {
        this.deps.logger.info(
          { clientId, messageRef: ref },
          'job falhou, mas já há resposta gravada; sem texto padrão',
        );
        return;
      }
      this.deps.logger.error(
        { clientId, messageRef: ref },
        'job falhou sem resposta gravada; enviando o texto padrão ao contato',
      );
      await this.sendFallback(clientId, job);
    } catch (error) {
      this.deps.logger.error(
        { messageRef: ref, ...describeError(error) },
        'falha ao tratar o job que falhou sem handler',
      );
    }
  }

  private async processText(
    clientId: ClientId,
    job: Extract<InboundJob, { kind: 'text' }>,
    context: InboundJobContext,
  ): Promise<InboundJobOutcome> {
    let result: AttendanceResult;
    try {
      result = await this.deps.attendance.handleInboundMessage(clientId, {
        contactRef: job.contactRef,
        text: job.text,
        externalId: job.externalId,
      });
    } catch (error) {
      if (error instanceof ForbiddenError) {
        // Cliente suspenso entre o enfileiramento e o processamento: decisão do dono (2026-10-28),
        // nada é enviado ao contato, nem o texto padrão. O job é descartado (métrica `discarded`).
        this.logSuspended(clientId, job);
        return 'discarded';
      }
      throw await this.onAttendanceFailure(clientId, job, context, error);
    }

    if (result.reply.sentAt !== null) {
      // Retentativa depois de envio concluído: nada a enviar de novo.
      this.deps.logger.info(
        { clientId, messageRef: messageRef(job.externalId), replyId: result.reply.id },
        'resposta já enviada; nada a reenviar',
      );
      return 'done';
    }
    return this.sendReply(clientId, job, result.reply.id, result.reply.text);
  }

  private async processNotice(
    clientId: ClientId,
    job: Extract<InboundJob, { kind: 'notice' }>,
  ): Promise<InboundJobOutcome> {
    const outcome = await this.deliver(clientId, job, CHANNEL_NOTICE_TEXTS[job.reason]);
    if (outcome.kind === 'discarded') return 'discarded';
    this.deps.logger.info(
      { clientId, messageRef: messageRef(job.externalId), reason: job.reason },
      'aviso constante enviado ao contato',
    );
    return 'done';
  }

  /** Envia a resposta gravada e confirma o envio na mensagem (`markSent`). */
  private async sendReply(
    clientId: ClientId,
    job: InboundJob,
    replyId: string,
    text: string,
  ): Promise<InboundJobOutcome> {
    const outcome = await this.deliver(clientId, job, text);
    if (outcome.kind === 'discarded') return 'discarded';

    try {
      const marked = await this.deps.messages.markSent(clientId, replyId, {
        channelMessageId: outcome.channelMessageId,
        sentAt: this.now(),
      });
      if (!marked) {
        this.deps.logger.warn(
          { clientId, replyId, messageRef: messageRef(job.externalId) },
          'resposta enviada, mas não havia marca de envio a gravar',
        );
      }
    } catch (error) {
      // O contato já recebeu a resposta: relançar reenviaria. Só registra.
      this.deps.logger.error(
        { clientId, replyId, messageRef: messageRef(job.externalId), ...describeError(error) },
        'resposta enviada, mas a marca de envio não foi gravada',
      );
    }
    this.deps.logger.info(
      { clientId, replyId, messageRef: messageRef(job.externalId) },
      'resposta enviada ao contato',
    );
    return 'done';
  }

  /**
   * Resolve o número do cliente no banco (pelo `clientId` do job) e envia `text` ao contato.
   * Lança o erro de envio já classificado (retentável ou `NonRetryableJobError`).
   */
  private async deliver(
    clientId: ClientId,
    job: InboundJob,
    text: string,
  ): Promise<{ kind: 'sent'; channelMessageId: string } | { kind: 'discarded' }> {
    const target = await this.resolvePhoneNumber(clientId, job);
    if (target.kind === 'suspended') return { kind: 'discarded' };
    if (target.kind === 'none') {
      this.deps.logger.error(
        { clientId, messageRef: messageRef(job.externalId) },
        'cliente sem número do canal; mensagem não enviada',
      );
      return { kind: 'discarded' };
    }
    const sent = await this.deps.sender.sendText({
      phoneNumberId: target.phoneNumberId,
      to: job.contactRef,
      text,
    });
    if (sent.ok) return { kind: 'sent', channelMessageId: sent.value.channelMessageId };
    throw this.classifySendFailure(clientId, job, sent.error);
  }

  /** Cliente suspenso não recebe nada do canal: nem resposta, nem aviso, nem texto padrão. */
  private logSuspended(clientId: ClientId, job: InboundJob): void {
    this.deps.logger.warn(
      { clientId, messageRef: messageRef(job.externalId), jobKind: job.kind },
      'cliente suspenso; nada é enviado ao contato e o job é descartado',
    );
  }

  /**
   * O que o envio precisa saber do cliente, lido do banco pelo `clientId` do job: o número do canal,
   * ou que não há número, ou que o cliente está suspenso (nada se envia). Cliente removido e número
   * trocado desde o enfileiramento lançam `NonRetryableJobError`.
   */
  private async resolvePhoneNumber(
    clientId: ClientId,
    job: InboundJob,
  ): Promise<
    | { readonly kind: 'number'; readonly phoneNumberId: string }
    | { readonly kind: 'none' }
    | { readonly kind: 'suspended' }
  > {
    try {
      const client = await this.deps.clients.findById(clientId);
      if (client.status === 'SUSPENDED') {
        this.logSuspended(clientId, job);
        return { kind: 'suspended' };
      }
      const current = client.whatsappPhoneNumberId;
      if (current !== null && current !== job.phoneNumberId) {
        // O número do cliente mudou desde que a mensagem entrou (ou o job foi adulterado): quem
        // recebeu a mensagem não é mais o número deste cliente. Nada é enviado. Sem números em log.
        this.deps.logger.error(
          { clientId, messageRef: messageRef(job.externalId), jobKind: job.kind },
          'o número do cliente mudou desde o enfileiramento; mensagem descartada sem envio',
        );
        throw new NonRetryableJobError('Número do cliente diferente do número do job', {
          context: { clientId, messageRef: messageRef(job.externalId) },
        });
      }
      return current === null ? { kind: 'none' } : { kind: 'number', phoneNumberId: current };
    } catch (error) {
      if (error instanceof NotFoundError) {
        // Cliente removido depois de enfileirar: não há por onde responder.
        throw new NonRetryableJobError('Cliente do job não existe mais', {
          cause: error,
          context: { clientId, messageRef: messageRef(job.externalId) },
        });
      }
      throw error;
    }
  }

  private classifySendFailure(
    clientId: ClientId,
    job: InboundJob,
    error: ExternalServiceError,
  ): Error {
    if (isRetryableSendError(error)) return error;
    this.deps.logger.error(
      {
        clientId,
        messageRef: messageRef(job.externalId),
        jobKind: job.kind,
        ...(error instanceof MessageSendError
          ? {
              httpStatus: error.httpStatus,
              providerCode: error.providerCode,
              providerType: error.providerType,
            }
          : { errName: error.name }),
      },
      'envio recusado de forma permanente; sem retentativa',
    );
    return new NonRetryableJobError('Envio recusado de forma permanente pelo canal', {
      cause: error,
      context: { clientId, messageRef: messageRef(job.externalId) },
    });
  }

  /**
   * Falha do atendimento **antes** de existir resposta gravada. Transitória e ainda há tentativas:
   * devolve o erro para a fila retentar. Senão (permanente ou última tentativa), tenta uma vez o
   * texto padrão ao contato e devolve o erro final.
   */
  private async onAttendanceFailure(
    clientId: ClientId,
    job: Extract<InboundJob, { kind: 'text' }>,
    context: InboundJobContext,
    error: unknown,
  ): Promise<Error> {
    const permanent = isPermanentAttendanceError(error);
    if (!permanent && !context.finalAttempt) {
      return error instanceof Error ? error : new Error('falha desconhecida no atendimento');
    }
    this.deps.logger.error(
      {
        clientId,
        messageRef: messageRef(job.externalId),
        permanent,
        ...describeError(error),
      },
      'atendimento falhou sem resposta gravada; enviando o texto padrão ao contato',
    );
    await this.sendFallback(clientId, job);
    if (permanent) {
      return new NonRetryableJobError('Atendimento falhou de forma permanente', {
        cause: error,
        context: { clientId, messageRef: messageRef(job.externalId), ...describeError(error) },
      });
    }
    return error instanceof Error ? error : new Error('falha desconhecida no atendimento');
  }

  /** Melhor esforço: falhar aqui só gera log (o contato já ficaria sem resposta de qualquer jeito). */
  private async sendFallback(clientId: ClientId, job: InboundJob): Promise<void> {
    const ref = messageRef(job.externalId);
    try {
      const target = await this.resolvePhoneNumber(clientId, job);
      // Suspenso: já logado em `resolvePhoneNumber`; nem o texto padrão sai.
      if (target.kind === 'suspended') return;
      if (target.kind === 'none') {
        this.deps.logger.warn(
          { clientId, messageRef: ref },
          'sem número do canal para o texto padrão',
        );
        return;
      }
      const sent = await this.deps.sender.sendText({
        phoneNumberId: target.phoneNumberId,
        to: job.contactRef,
        text: ATTENDANCE_FALLBACK_TEXT,
      });
      if (sent.ok) {
        this.deps.logger.info({ clientId, messageRef: ref }, 'texto padrão enviado ao contato');
      } else {
        this.deps.logger.warn(
          {
            clientId,
            messageRef: ref,
            ...describeError(sent.error),
            ...sendErrorFields(sent.error),
          },
          'falha ao enviar o texto padrão ao contato',
        );
      }
    } catch (error) {
      this.deps.logger.warn(
        { clientId, messageRef: ref, ...describeError(error) },
        'falha ao enviar o texto padrão ao contato',
      );
    }
  }
}

/** Erro que repetir não resolve: cliente removido, entrada inválida (bug do enfileirador). O cliente suspenso (`ForbiddenError`) nem chega aqui: o job é descartado sem envio. */
function isPermanentAttendanceError(error: unknown): boolean {
  return (
    error instanceof NotFoundError || error instanceof ValidationError || error instanceof ZodError
  );
}

function parseClientId(job: InboundJob): ClientId {
  try {
    return ClientId.parse(job.clientId);
  } catch (error) {
    throw new NonRetryableJobError('clientId do job é inválido', { cause: error });
  }
}

function sendErrorFields(error: ExternalServiceError): object {
  return error instanceof MessageSendError
    ? {
        httpStatus: error.httpStatus,
        providerCode: error.providerCode,
        retryable: error.retryable,
      }
    : {};
}
