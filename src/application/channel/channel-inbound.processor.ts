import { ZodError } from 'zod';
import { ClientId, type ClientRepository, type MessageRepository } from '../../domain/index.js';
import type { ExternalServiceError } from '../../shared/errors/index.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { messageRef } from '../../shared/utils/index.js';
import { describeError } from './describe-error.js';
import type {
  AcceptedMessage,
  PendingResponse,
  RespondToPendingOptions,
} from '../attendance/attendance.service.js';
import { ATTENDANCE_FALLBACK_TEXT } from '../attendance/attendance.service.js';
import type { BatchLimits, InboundMessage } from '../attendance/attendance.schemas.js';
import {
  type ChannelJob,
  type FlushJob,
  flushKey,
  type InboundJob,
  type InboundJobContext,
  type InboundJobOutcome,
  type InboundJobQueue,
  NonRetryableJobError,
} from '../ports/inbound-job-queue.js';
import {
  isRetryableSendError,
  MessageSendError,
  type MessageSender,
} from '../ports/message-sender.js';
import { flushDelayMs } from './batch-window.js';
import { CHANNEL_NOTICE_TEXTS } from './channel-texts.js';
import type { ChannelLogger } from './channel-intake.service.js';

/** O que o processador precisa do atendimento (o `AttendanceService` satisfaz). */
export interface InboundAttendance {
  acceptInboundMessage(clientId: ClientId, input: InboundMessage): Promise<AcceptedMessage>;
  respondToPending(
    clientId: ClientId,
    contactRef: string,
    limits: BatchLimits,
    options?: RespondToPendingOptions,
  ): Promise<PendingResponse>;
  hasPendingMessages(clientId: ClientId, contactRef: string): Promise<boolean>;
}

/** Janela de espera e limites do lote (spec 013); vêm da config do canal. */
export interface ChannelBatchSettings extends BatchLimits {
  /** Espera sem mensagem nova antes de responder; 0 desliga a espera. */
  readonly windowMs: number;
  /** Teto de espera, contado desde a mais antiga mensagem pendente. */
  readonly maxWaitMs: number;
}

export interface ChannelInboundProcessorDeps {
  readonly attendance: InboundAttendance;
  /** O número do canal é lido daqui, pelo `clientId` do job: nunca do payload. */
  readonly clients: Pick<ClientRepository, 'findById'>;
  readonly messages: Pick<MessageRepository, 'markSent' | 'findByExternalId' | 'findReplyTo'>;
  readonly sender: MessageSender;
  /** Agenda o `flush` do contato (e o próximo, quando sobra pendente). */
  readonly queue: Pick<InboundJobQueue, 'scheduleFlush'>;
  readonly batch: ChannelBatchSettings;
  readonly logger: ChannelLogger;
  /** Relógio injetável, para os testes. */
  readonly now?: () => Date;
}

/**
 * Processa um job da fila do canal, em segundo plano:
 *
 * - `text` (etapa "aceitar", spec 013): grava a mensagem do contato (idempotente por `externalId`,
 *   sem LLM) e agenda o `flush` do contato com a janela deslizante. Só termina depois de agendar.
 * - `flush`: junta as mensagens pendentes do contato, atende (`AttendanceService.respondToPending`:
 *   uma chamada ao LLM, uma resposta, o lote inteiro marcado como respondido), envia a resposta pelo
 *   número que o **banco** associa ao `clientId` do job e grava a marca de envio. Resposta que já
 *   tem `sentAt` não é reenviada. Se ainda sobram pendentes (excederam o limite do lote), agenda o
 *   próximo `flush`, sem nova espera.
 * - `notice`: envia o texto constante, imediato, sem gravar mensagem nem chamar o LLM.
 *
 * Erros: transitórios (banco, rede, 5xx, 429, limite de taxa) são relançados para a fila retentar;
 * permanentes viram `NonRetryableJobError`. Falha final **antes de existir resposta gravada** tenta
 * uma vez enviar o texto padrão ao contato (melhor esforço); se a resposta já existe e o que falha é
 * o envio, nada é reenviado como fallback. Cliente suspenso não recebe nada: o job é descartado.
 *
 * Privacidade: nenhum texto, destinatário ou id de mensagem cru vai a log (só `messageRef`/`flushRef`,
 * ids internos e códigos). O `ExternalServiceError` do envio já não carrega dado do contato.
 */
export class ChannelInboundProcessor {
  private readonly now: () => Date;

  constructor(private readonly deps: ChannelInboundProcessorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async process(job: ChannelJob, context: InboundJobContext): Promise<InboundJobOutcome> {
    const clientId = parseClientId(job);
    switch (job.kind) {
      case 'notice':
        return this.processNotice(clientId, job);
      case 'text':
        return this.processAccept(clientId, job, context);
      case 'flush':
        return this.processFlush(clientId, job, context);
    }
  }

  /**
   * Job que falhou de vez **sem passar pelo handler** (ex.: parado além do limite depois de uma
   * queda do processo): para o contato não ficar no silêncio, tenta uma vez o texto padrão, mas só
   * se ainda não há resposta gravada (se há, ela fica visível na API administrativa e nada é
   * enviado). Melhor esforço, nunca lança. Limitação: se a tentativa que parou chegou a enviar a
   * resposta sem gravar a marca, o contato pode receber o texto padrão além dela.
   */
  async handleUnprocessedFailure(job: ChannelJob): Promise<void> {
    const refs = refFields(job);
    try {
      const clientId = parseClientId(job);
      if (job.kind === 'notice') {
        this.deps.logger.warn({ clientId, ...refs }, 'aviso constante não enviado: o job falhou');
        return;
      }
      if (await this.alreadyHandled(clientId, job)) {
        this.deps.logger.info(
          { clientId, ...refs },
          'job falhou, mas já há resposta gravada ou nada pendente; sem texto padrão',
        );
        return;
      }
      this.deps.logger.error(
        { clientId, ...refs },
        'job falhou sem resposta gravada; enviando o texto padrão ao contato',
      );
      await this.sendFallback(clientId, job);
    } catch (error) {
      this.deps.logger.error(
        { ...refs, ...describeError(error) },
        'falha ao tratar o job que falhou sem handler',
      );
    }
  }

  /** Já existe resposta para o que o job tratava (ou, no `flush`, não há nada pendente)? */
  private async alreadyHandled(
    clientId: ClientId,
    job: Exclude<ChannelJob, { kind: 'notice' }>,
  ): Promise<boolean> {
    if (job.kind === 'flush') {
      return !(await this.deps.attendance.hasPendingMessages(clientId, job.contactRef));
    }
    const message = await this.deps.messages.findByExternalId(clientId, job.externalId);
    if (message === null) return false;
    return (
      message.answeredById !== null ||
      (await this.deps.messages.findReplyTo(clientId, message.id)) !== null
    );
  }

  /**
   * Etapa "aceitar": grava a mensagem e agenda o `flush`. Reentrega de mensagem já respondida não
   * gera nada; de mensagem ainda pendente só garante que há um `flush` a caminho (sem adiar o que já
   * existe). Se o processo cair entre gravar e agendar, a retentativa refaz os dois passos.
   */
  private async processAccept(
    clientId: ClientId,
    job: Extract<InboundJob, { kind: 'text' }>,
    context: InboundJobContext,
  ): Promise<InboundJobOutcome> {
    const refs = refFields(job);
    let delayMs: number;
    let mode: 'slide' | 'ensure';
    try {
      const accepted = await this.deps.attendance.acceptInboundMessage(clientId, {
        contactRef: job.contactRef,
        text: job.text,
        externalId: job.externalId,
      });
      if (accepted.status === 'answered') {
        this.deps.logger.info(
          { clientId, ...refs },
          'mensagem já respondida (reentrega do canal); nada a fazer',
        );
        return 'done';
      }
      delayMs = flushDelayMs({
        windowMs: this.deps.batch.windowMs,
        maxWaitMs: this.deps.batch.maxWaitMs,
        oldestPendingAt: accepted.oldestPendingAt,
        referenceAt: accepted.messageCreatedAt,
      });
      // Mensagem nova reinicia a janela; reentrega ou retentativa só garante que há um `flush`.
      mode = accepted.status === 'accepted' ? 'slide' : 'ensure';
      const scheduled = await this.deps.queue.scheduleFlush(flushJobOf(job), { delayMs, mode });
      if (!scheduled.ok) throw scheduled.error;
    } catch (error) {
      if (error instanceof ForbiddenError) {
        // Cliente suspenso entre o enfileiramento e o processamento: decisão do dono (2026-10-28),
        // nada é enviado ao contato, nem o texto padrão. O job é descartado (métrica `discarded`).
        this.logSuspended(clientId, job);
        return 'discarded';
      }
      throw await this.onAttendanceFailure(clientId, job, context, error);
    }
    this.deps.logger.info(
      { clientId, ...refs, delayMs, mode },
      'resposta agendada para o fim da janela de espera',
    );
    return 'done';
  }

  private async processFlush(
    clientId: ClientId,
    job: FlushJob,
    context: InboundJobContext,
  ): Promise<InboundJobOutcome> {
    const refs = refFields(job);
    let response: PendingResponse;
    try {
      response = await this.deps.attendance.respondToPending(
        clientId,
        job.contactRef,
        { maxMessages: this.deps.batch.maxMessages, maxChars: this.deps.batch.maxChars },
        // Retentativa de um job que já falhou: a resposta gravada e não enviada sai primeiro.
        { resumeUnsent: (context.attempt ?? 1) > 1 },
      );
    } catch (error) {
      if (error instanceof ForbiddenError) {
        this.logSuspended(clientId, job);
        return 'discarded';
      }
      throw await this.onAttendanceFailure(clientId, job, context, error);
    }

    const { reply } = response;
    if (reply === null) {
      this.deps.logger.info({ clientId, ...refs }, 'nada pendente para responder');
      return 'done';
    }

    let outcome: InboundJobOutcome;
    try {
      outcome = await this.sendOrSkip(clientId, job, reply);
    } catch (error) {
      // Se o job não vai ser retentado (erro permanente ou última tentativa), o excedente do lote
      // não pode ficar sem `flush`; se vai, a retentativa o encontra.
      const willRetry = !(error instanceof NonRetryableJobError) && !context.finalAttempt;
      if (response.hasMorePending && !willRetry) await this.scheduleNextQuietly(clientId, job);
      throw error;
    }
    if (outcome === 'discarded') return outcome;

    if (response.hasMorePending) {
      // O BullMQ não aceita outro job com o mesmo id enquanto este está ativo: o agendamento fica
      // guardado e vira o próximo job quando este terminar. Falhar aqui faz o job ser retentado.
      const scheduled = await this.deps.queue.scheduleFlush(job, { delayMs: 0, mode: 'ensure' });
      if (!scheduled.ok) throw scheduled.error;
      this.deps.logger.info(
        { clientId, ...refs },
        'sobraram mensagens pendentes; próximo turno agendado sem nova espera',
      );
    }
    return outcome;
  }

  /** Envia a resposta ainda não enviada; resposta com `sentAt` não é reenviada. */
  private async sendOrSkip(
    clientId: ClientId,
    job: FlushJob,
    reply: { readonly id: string; readonly text: string; readonly sentAt: Date | null },
  ): Promise<InboundJobOutcome> {
    if (reply.sentAt !== null) {
      // Retentativa depois de envio concluído: nada a enviar de novo.
      this.deps.logger.info(
        { clientId, ...refFields(job), replyId: reply.id },
        'resposta já enviada; nada a reenviar',
      );
      return 'done';
    }
    return this.sendReply(clientId, job, reply.id, reply.text);
  }

  /** Agenda o próximo `flush` sem lançar (o erro que está subindo é o que importa). */
  private async scheduleNextQuietly(clientId: ClientId, job: FlushJob): Promise<void> {
    try {
      const scheduled = await this.deps.queue.scheduleFlush(job, { delayMs: 0, mode: 'ensure' });
      if (!scheduled.ok) throw scheduled.error;
    } catch (error) {
      this.deps.logger.error(
        { clientId, ...refFields(job), ...describeError(error) },
        'não foi possível agendar o próximo turno depois de uma falha',
      );
    }
  }

  private async processNotice(
    clientId: ClientId,
    job: Extract<InboundJob, { kind: 'notice' }>,
  ): Promise<InboundJobOutcome> {
    const outcome = await this.deliver(clientId, job, CHANNEL_NOTICE_TEXTS[job.reason]);
    if (outcome.kind === 'discarded') return 'discarded';
    this.deps.logger.info(
      { clientId, ...refFields(job), reason: job.reason },
      'aviso constante enviado ao contato',
    );
    return 'done';
  }

  /** Envia a resposta gravada e confirma o envio na mensagem (`markSent`). */
  private async sendReply(
    clientId: ClientId,
    job: ChannelJob,
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
          { clientId, replyId, ...refFields(job) },
          'resposta enviada, mas não havia marca de envio a gravar',
        );
      }
    } catch (error) {
      // O contato já recebeu a resposta: relançar reenviaria. Só registra.
      this.deps.logger.error(
        { clientId, replyId, ...refFields(job), ...describeError(error) },
        'resposta enviada, mas a marca de envio não foi gravada',
      );
    }
    this.deps.logger.info({ clientId, replyId, ...refFields(job) }, 'resposta enviada ao contato');
    return 'done';
  }

  /**
   * Resolve o número do cliente no banco (pelo `clientId` do job) e envia `text` ao contato.
   * Lança o erro de envio já classificado (retentável ou `NonRetryableJobError`).
   */
  private async deliver(
    clientId: ClientId,
    job: ChannelJob,
    text: string,
  ): Promise<{ kind: 'sent'; channelMessageId: string } | { kind: 'discarded' }> {
    const target = await this.resolvePhoneNumber(clientId, job);
    if (target.kind === 'suspended') return { kind: 'discarded' };
    if (target.kind === 'none') {
      this.deps.logger.error(
        { clientId, ...refFields(job) },
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
  private logSuspended(clientId: ClientId, job: ChannelJob): void {
    this.deps.logger.warn(
      { clientId, ...refFields(job), jobKind: job.kind },
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
    job: ChannelJob,
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
          { clientId, ...refFields(job), jobKind: job.kind },
          'o número do cliente mudou desde o enfileiramento; mensagem descartada sem envio',
        );
        throw new NonRetryableJobError('Número do cliente diferente do número do job', {
          context: { clientId, ...refFields(job) },
        });
      }
      return current === null ? { kind: 'none' } : { kind: 'number', phoneNumberId: current };
    } catch (error) {
      if (error instanceof NotFoundError) {
        // Cliente removido depois de enfileirar: não há por onde responder.
        throw new NonRetryableJobError('Cliente do job não existe mais', {
          cause: error,
          context: { clientId, ...refFields(job) },
        });
      }
      throw error;
    }
  }

  private classifySendFailure(
    clientId: ClientId,
    job: ChannelJob,
    error: ExternalServiceError,
  ): Error {
    if (isRetryableSendError(error)) return error;
    this.deps.logger.error(
      {
        clientId,
        ...refFields(job),
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
      context: { clientId, ...refFields(job) },
    });
  }

  /**
   * Falha do atendimento **antes** de existir resposta gravada. Transitória e ainda há tentativas:
   * devolve o erro para a fila retentar. Senão (permanente ou última tentativa), tenta uma vez o
   * texto padrão ao contato e devolve o erro final. As mensagens do contato seguem pendentes no banco
   * (a próxima mensagem dele agenda um novo `flush` que as responde juntas).
   */
  private async onAttendanceFailure(
    clientId: ClientId,
    job: Exclude<ChannelJob, { kind: 'notice' }>,
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
        ...refFields(job),
        permanent,
        ...describeError(error),
      },
      'atendimento falhou sem resposta gravada; enviando o texto padrão ao contato',
    );
    await this.sendFallback(clientId, job);
    if (permanent) {
      return new NonRetryableJobError('Atendimento falhou de forma permanente', {
        cause: error,
        context: { clientId, ...refFields(job), ...describeError(error) },
      });
    }
    return error instanceof Error ? error : new Error('falha desconhecida no atendimento');
  }

  /** Melhor esforço: falhar aqui só gera log (o contato já ficaria sem resposta de qualquer jeito). */
  private async sendFallback(clientId: ClientId, job: ChannelJob): Promise<void> {
    const refs = refFields(job);
    try {
      const target = await this.resolvePhoneNumber(clientId, job);
      // Suspenso: já logado em `resolvePhoneNumber`; nem o texto padrão sai.
      if (target.kind === 'suspended') return;
      if (target.kind === 'none') {
        this.deps.logger.warn({ clientId, ...refs }, 'sem número do canal para o texto padrão');
        return;
      }
      const sent = await this.deps.sender.sendText({
        phoneNumberId: target.phoneNumberId,
        to: job.contactRef,
        text: ATTENDANCE_FALLBACK_TEXT,
      });
      if (sent.ok) {
        this.deps.logger.info({ clientId, ...refs }, 'texto padrão enviado ao contato');
      } else {
        this.deps.logger.warn(
          {
            clientId,
            ...refs,
            ...describeError(sent.error),
            ...sendErrorFields(sent.error),
          },
          'falha ao enviar o texto padrão ao contato',
        );
      }
    } catch (error) {
      this.deps.logger.warn(
        { clientId, ...refs, ...describeError(error) },
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

function parseClientId(job: ChannelJob): ClientId {
  try {
    return ClientId.parse(job.clientId);
  } catch (error) {
    throw new NonRetryableJobError('clientId do job é inválido', { cause: error });
  }
}

/**
 * Referência para correlacionar linhas de log sem registrar dado do contato: `messageRef` (hash do
 * id da mensagem no canal, que carrega o telefone) em `text` e `notice`; `flushRef` (hash da
 * identidade do `flush`, que inclui o cliente e o contato) em `flush`.
 */
function refFields(job: ChannelJob): { messageRef: string } | { flushRef: string } {
  return job.kind === 'flush'
    ? { flushRef: messageRef(flushKey(job)) }
    : { messageRef: messageRef(job.externalId) };
}

/** O `flush` do contato que enviou esta mensagem: só ids, nunca o texto. */
function flushJobOf(job: Extract<InboundJob, { kind: 'text' }>): FlushJob {
  return {
    kind: 'flush',
    clientId: job.clientId,
    phoneNumberId: job.phoneNumberId,
    contactRef: job.contactRef,
    requestId: job.requestId,
  };
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
