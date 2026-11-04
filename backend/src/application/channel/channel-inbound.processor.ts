import { ZodError } from 'zod';
import {
  type ChannelConnectionRepository,
  CompanyId,
  type CompanyRepository,
  type MessageRepository,
} from '../../domain/index.js';
import type { Metrics } from '../../infrastructure/metrics/index.js';
import type { ExternalServiceError } from '../../shared/errors/index.js';
import {
  CredentialDecryptionError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js';
import type { SecretString } from '../../shared/types/index.js';
import { messageRef } from '../../shared/utils/index.js';
import { describeError } from './describe-error.js';
import type {
  AcceptedMessage,
  PendingResponse,
  RespondToPendingOptions,
} from '../attendance/attendance.service.js';
import { ATTENDANCE_FALLBACK_TEXT } from '../attendance/attendance.service.js';
import type { BatchLimits, InboundMessage } from '../attendance/attendance.schemas.js';
import type { ChannelCredentials } from '../ports/channel-credentials.js';
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
  acceptInboundMessage(companyId: CompanyId, input: InboundMessage): Promise<AcceptedMessage>;
  respondToPending(
    companyId: CompanyId,
    contactRef: string,
    limits: BatchLimits,
    options?: RespondToPendingOptions,
  ): Promise<PendingResponse>;
  hasPendingMessages(companyId: CompanyId, contactRef: string): Promise<boolean>;
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
  /** O número do canal é lido daqui, pelo `companyId` do job: nunca do payload. */
  readonly companies: Pick<CompanyRepository, 'findById'>;
  readonly messages: Pick<MessageRepository, 'markSent' | 'findByExternalId' | 'findReplyTo'>;
  readonly sender: MessageSender;
  /**
   * Número, token e estado da credencial da empresa, lidos do banco pelo `companyId` do job a cada
   * envio (spec 015). Nunca vêm do payload nem do job.
   */
  readonly credentials: ChannelCredentials;
  /** Marca `TOKEN_INVALID` (condicional à `tokenVersion`) quando o envio é recusado com 190. */
  readonly connections: Pick<ChannelConnectionRepository, 'markTokenInvalid'>;
  readonly metrics?: Pick<Metrics, 'countChannelStateTransition'> | undefined;
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
 *   número que o **banco** associa ao `companyId` do job e grava a marca de envio. Resposta que já
 *   tem `sentAt` não é reenviada. Se ainda sobram pendentes (excederam o limite do lote), agenda o
 *   próximo `flush`, sem nova espera.
 * - `notice`: envia o texto constante, imediato, sem gravar mensagem nem chamar o LLM.
 *
 * Erros: transitórios (banco, rede, 5xx, 429, limite de taxa) são relançados para a fila retentar;
 * permanentes viram `NonRetryableJobError`. Falha final **antes de existir resposta gravada** tenta
 * uma vez enviar o texto padrão ao contato (melhor esforço); se a resposta já existe e o que falha é
 * o envio, nada é reenviado como fallback. Empresa suspensa não recebe nada: o job é descartado.
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
    const companyId = parseCompanyId(job);
    switch (job.kind) {
      case 'notice':
        return this.processNotice(companyId, job);
      case 'text':
        return this.processAccept(companyId, job, context);
      case 'flush':
        return this.processFlush(companyId, job, context);
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
      const companyId = parseCompanyId(job);
      if (job.kind === 'notice') {
        this.deps.logger.warn({ companyId, ...refs }, 'aviso constante não enviado: o job falhou');
        return;
      }
      if (await this.alreadyHandled(companyId, job)) {
        this.deps.logger.info(
          { companyId, ...refs },
          'job falhou, mas já há resposta gravada ou nada pendente; sem texto padrão',
        );
        return;
      }
      this.deps.logger.error(
        { companyId, ...refs },
        'job falhou sem resposta gravada; enviando o texto padrão ao contato',
      );
      await this.sendFallback(companyId, job);
    } catch (error) {
      this.deps.logger.error(
        { ...refs, ...describeError(error) },
        'falha ao tratar o job que falhou sem handler',
      );
    }
  }

  /** Já existe resposta para o que o job tratava (ou, no `flush`, não há nada pendente)? */
  private async alreadyHandled(
    companyId: CompanyId,
    job: Exclude<ChannelJob, { kind: 'notice' }>,
  ): Promise<boolean> {
    if (job.kind === 'flush') {
      return !(await this.deps.attendance.hasPendingMessages(companyId, job.contactRef));
    }
    const message = await this.deps.messages.findByExternalId(companyId, job.externalId);
    if (message === null) return false;
    return (
      message.answeredById !== null ||
      (await this.deps.messages.findReplyTo(companyId, message.id)) !== null
    );
  }

  /**
   * Etapa "aceitar": grava a mensagem e agenda o `flush`. Reentrega de mensagem já respondida não
   * gera nada; de mensagem ainda pendente só garante que há um `flush` a caminho (sem adiar o que já
   * existe). Se o processo cair entre gravar e agendar, a retentativa refaz os dois passos.
   */
  private async processAccept(
    companyId: CompanyId,
    job: Extract<InboundJob, { kind: 'text' }>,
    context: InboundJobContext,
  ): Promise<InboundJobOutcome> {
    const refs = refFields(job);
    let delayMs: number;
    let mode: 'slide' | 'ensure';
    try {
      const accepted = await this.deps.attendance.acceptInboundMessage(companyId, {
        contactRef: job.contactRef,
        text: job.text,
        externalId: job.externalId,
      });
      if (accepted.status === 'answered') {
        this.deps.logger.info(
          { companyId, ...refs },
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
        // Empresa suspensa entre o enfileiramento e o processamento: decisão do dono (2026-10-28),
        // nada é enviado ao contato, nem o texto padrão. O job é descartado (métrica `discarded`).
        this.logSuspended(companyId, job);
        return 'discarded';
      }
      throw await this.onAttendanceFailure(companyId, job, context, error);
    }
    this.deps.logger.info(
      { companyId, ...refs, delayMs, mode },
      'resposta agendada para o fim da janela de espera',
    );
    return 'done';
  }

  private async processFlush(
    companyId: CompanyId,
    job: FlushJob,
    context: InboundJobContext,
  ): Promise<InboundJobOutcome> {
    const refs = refFields(job);
    // Credencial recusada pela Meta (`TOKEN_INVALID`): nada a responder e nenhuma chamada ao LLM; as
    // mensagens seguem pendentes e a próxima do contato, depois de reconectar, as responde juntas.
    if (await this.isTokenInvalid(companyId)) {
      this.logTokenInvalid(companyId, job);
      return 'discarded';
    }
    let response: PendingResponse;
    try {
      response = await this.deps.attendance.respondToPending(
        companyId,
        job.contactRef,
        { maxMessages: this.deps.batch.maxMessages, maxChars: this.deps.batch.maxChars },
        // Retentativa de um job que já falhou: a resposta gravada e não enviada sai primeiro.
        { resumeUnsent: (context.attempt ?? 1) > 1 },
      );
    } catch (error) {
      if (error instanceof ForbiddenError) {
        this.logSuspended(companyId, job);
        return 'discarded';
      }
      throw await this.onAttendanceFailure(companyId, job, context, error);
    }

    const { reply } = response;
    if (reply === null) {
      this.deps.logger.info({ companyId, ...refs }, 'nada pendente para responder');
      return 'done';
    }

    let outcome: InboundJobOutcome;
    try {
      outcome = await this.sendOrSkip(companyId, job, reply);
    } catch (error) {
      // Se o job não vai ser retentado (erro permanente ou última tentativa), o excedente do lote
      // não pode ficar sem `flush`; se vai, a retentativa o encontra.
      const willRetry = !(error instanceof NonRetryableJobError) && !context.finalAttempt;
      if (response.hasMorePending && !willRetry) await this.scheduleNextQuietly(companyId, job);
      throw error;
    }
    if (outcome === 'discarded') return outcome;

    if (response.hasMorePending) {
      // O BullMQ não aceita outro job com o mesmo id enquanto este está ativo: o agendamento fica
      // guardado e vira o próximo job quando este terminar. Falhar aqui faz o job ser retentado.
      const scheduled = await this.deps.queue.scheduleFlush(job, { delayMs: 0, mode: 'ensure' });
      if (!scheduled.ok) throw scheduled.error;
      this.deps.logger.info(
        { companyId, ...refs },
        'sobraram mensagens pendentes; próximo turno agendado sem nova espera',
      );
    }
    return outcome;
  }

  /** Envia a resposta ainda não enviada; resposta com `sentAt` não é reenviada. */
  private async sendOrSkip(
    companyId: CompanyId,
    job: FlushJob,
    reply: { readonly id: string; readonly text: string; readonly sentAt: Date | null },
  ): Promise<InboundJobOutcome> {
    if (reply.sentAt !== null) {
      // Retentativa depois de envio concluído: nada a enviar de novo.
      this.deps.logger.info(
        { companyId, ...refFields(job), replyId: reply.id },
        'resposta já enviada; nada a reenviar',
      );
      return 'done';
    }
    return this.sendReply(companyId, job, reply.id, reply.text);
  }

  /** Agenda o próximo `flush` sem lançar (o erro que está subindo é o que importa). */
  private async scheduleNextQuietly(companyId: CompanyId, job: FlushJob): Promise<void> {
    try {
      const scheduled = await this.deps.queue.scheduleFlush(job, { delayMs: 0, mode: 'ensure' });
      if (!scheduled.ok) throw scheduled.error;
    } catch (error) {
      this.deps.logger.error(
        { companyId, ...refFields(job), ...describeError(error) },
        'não foi possível agendar o próximo turno depois de uma falha',
      );
    }
  }

  private async processNotice(
    companyId: CompanyId,
    job: Extract<InboundJob, { kind: 'notice' }>,
  ): Promise<InboundJobOutcome> {
    const outcome = await this.deliver(companyId, job, CHANNEL_NOTICE_TEXTS[job.reason]);
    if (outcome.kind === 'discarded') return 'discarded';
    this.deps.logger.info(
      { companyId, ...refFields(job), reason: job.reason },
      'aviso constante enviado ao contato',
    );
    return 'done';
  }

  /** Envia a resposta gravada e confirma o envio na mensagem (`markSent`). */
  private async sendReply(
    companyId: CompanyId,
    job: ChannelJob,
    replyId: string,
    text: string,
  ): Promise<InboundJobOutcome> {
    const outcome = await this.deliver(companyId, job, text);
    if (outcome.kind === 'discarded') return 'discarded';

    try {
      const marked = await this.deps.messages.markSent(companyId, replyId, {
        channelMessageId: outcome.channelMessageId,
        sentAt: this.now(),
      });
      if (!marked) {
        this.deps.logger.warn(
          { companyId, replyId, ...refFields(job) },
          'resposta enviada, mas não havia marca de envio a gravar',
        );
      }
    } catch (error) {
      // O contato já recebeu a resposta: relançar reenviaria. Só registra.
      this.deps.logger.error(
        { companyId, replyId, ...refFields(job), ...describeError(error) },
        'resposta enviada, mas a marca de envio não foi gravada',
      );
    }
    this.deps.logger.info({ companyId, replyId, ...refFields(job) }, 'resposta enviada ao contato');
    return 'done';
  }

  /**
   * Resolve o número da empresa no banco (pelo `companyId` do job) e envia `text` ao contato.
   * Lança o erro de envio já classificado (retentável ou `NonRetryableJobError`).
   */
  private async deliver(
    companyId: CompanyId,
    job: ChannelJob,
    text: string,
  ): Promise<{ kind: 'sent'; channelMessageId: string } | { kind: 'discarded' }> {
    const target = await this.resolvePhoneNumber(companyId, job);
    if (target.kind === 'suspended') return { kind: 'discarded' };
    if (target.kind === 'token_invalid') {
      this.logTokenInvalid(companyId, job);
      return { kind: 'discarded' };
    }
    if (target.kind === 'none') {
      this.deps.logger.error(
        { companyId, ...refFields(job) },
        'empresa sem número ou sem credencial do canal; mensagem não enviada',
      );
      return { kind: 'discarded' };
    }
    const sent = await this.deps.sender.sendText({
      phoneNumberId: target.phoneNumberId,
      accessToken: target.token,
      to: job.contactRef,
      text,
    });
    if (sent.ok) return { kind: 'sent', channelMessageId: sent.value.channelMessageId };
    throw await this.classifySendFailure(companyId, job, sent.error, target.tokenVersion);
  }

  /** Empresa suspensa não recebe nada do canal: nem resposta, nem aviso, nem texto padrão. */
  private logSuspended(companyId: CompanyId, job: ChannelJob): void {
    this.deps.logger.warn(
      { companyId, ...refFields(job), jobKind: job.kind },
      'empresa suspensa; nada é enviado ao contato e o job é descartado',
    );
  }

  /**
   * O que o envio precisa da empresa, lido do banco pelo `companyId` do job: número, token e versão
   * (spec 015), ou que não há credencial, ou que a empresa está suspenso (nada se envia) ou com o
   * token recusado. Empresa removida, número trocado desde o enfileiramento e texto cifrado que não
   * decifra lançam `NonRetryableJobError`.
   */
  private async resolvePhoneNumber(
    companyId: CompanyId,
    job: ChannelJob,
  ): Promise<
    | {
        readonly kind: 'number';
        readonly phoneNumberId: string;
        readonly token: SecretString;
        readonly tokenVersion: number | 'legacy';
      }
    | { readonly kind: 'none' }
    | { readonly kind: 'suspended' }
    | { readonly kind: 'token_invalid' }
  > {
    try {
      const company = await this.deps.companies.findById(companyId);
      if (company.status === 'SUSPENDED') {
        this.logSuspended(companyId, job);
        return { kind: 'suspended' };
      }
      const current = company.whatsappPhoneNumberId;
      if (current !== null && current !== job.phoneNumberId) {
        throw this.numberChanged(companyId, job);
      }
      if (current === null) return { kind: 'none' };
      const credentials = await this.deps.credentials.forCompany(companyId);
      if (credentials.kind === 'token_invalid') return { kind: 'token_invalid' };
      if (credentials.kind === 'none') return { kind: 'none' };
      // O número pode ter mudado entre as duas leituras: o par token/número tem de ser o do job.
      if (credentials.phoneNumberId !== job.phoneNumberId) {
        throw this.numberChanged(companyId, job);
      }
      return {
        kind: 'number',
        phoneNumberId: credentials.phoneNumberId,
        token: credentials.token,
        tokenVersion: credentials.tokenVersion,
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        // Empresa removida depois de enfileirar: não há por onde responder.
        throw new NonRetryableJobError('Empresa do job não existe mais', {
          cause: error,
          context: { companyId, ...refFields(job) },
        });
      }
      if (error instanceof CredentialDecryptionError) {
        // Falha nossa (chave ausente, texto adulterado ou de outra empresa): sem retentativa, sem
        // texto cifrado em log (o erro só carrega `reason`) e sem marcar o token como inválido.
        this.deps.logger.error(
          { companyId, ...refFields(job), reason: error.reason },
          'credencial do canal não pôde ser decifrada; mensagem não enviada',
        );
        throw new NonRetryableJobError('Credencial do canal não pôde ser decifrada', {
          context: { companyId, ...refFields(job), reason: error.reason },
        });
      }
      throw error;
    }
  }

  private numberChanged(companyId: CompanyId, job: ChannelJob): NonRetryableJobError {
    // O número da empresa mudou desde que a mensagem entrou (ou o job foi adulterado): quem recebeu
    // a mensagem não é mais o número desta empresa. Nada é enviado. Sem números em log.
    this.deps.logger.error(
      { companyId, ...refFields(job), jobKind: job.kind },
      'o número da empresa mudou desde o enfileiramento; mensagem descartada sem envio',
    );
    return new NonRetryableJobError('Número da empresa diferente do número do job', {
      context: { companyId, ...refFields(job) },
    });
  }

  /** A credencial da empresa está `TOKEN_INVALID`? Qualquer falha de leitura vale como "não". */
  private async isTokenInvalid(companyId: CompanyId): Promise<boolean> {
    try {
      return (await this.deps.credentials.forCompany(companyId)).kind === 'token_invalid';
    } catch {
      return false;
    }
  }

  private logTokenInvalid(companyId: CompanyId, job: ChannelJob): void {
    this.deps.logger.warn(
      { companyId, ...refFields(job), jobKind: job.kind },
      'credencial do canal recusada pela Meta (TOKEN_INVALID); nada é enviado e o job é descartado',
    );
  }

  /** Erro 190 (token inválido) com conexão própria: marca `TOKEN_INVALID`, condicional à versão. */
  private async markTokenInvalid(
    companyId: CompanyId,
    tokenVersion: number | 'legacy',
  ): Promise<void> {
    if (tokenVersion === 'legacy') return;
    try {
      const marked = await this.deps.connections.markTokenInvalid(
        companyId,
        tokenVersion,
        this.now(),
      );
      if (marked) {
        this.deps.logger.warn({ companyId }, 'conexão do canal marcada como TOKEN_INVALID');
        try {
          this.deps.metrics?.countChannelStateTransition('token_invalid');
        } catch {
          // Métrica é acessório.
        }
      }
    } catch (error) {
      this.deps.logger.error(
        { companyId, ...describeError(error) },
        'não foi possível marcar a conexão como TOKEN_INVALID',
      );
    }
  }

  private async classifySendFailure(
    companyId: CompanyId,
    job: ChannelJob,
    error: ExternalServiceError,
    tokenVersion: number | 'legacy',
  ): Promise<Error> {
    if (isRetryableSendError(error)) return error;
    if (error instanceof MessageSendError && error.providerCode === TOKEN_INVALID_CODE) {
      await this.markTokenInvalid(companyId, tokenVersion);
    }
    this.deps.logger.error(
      {
        companyId,
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
      context: { companyId, ...refFields(job) },
    });
  }

  /**
   * Falha do atendimento **antes** de existir resposta gravada. Transitória e ainda há tentativas:
   * devolve o erro para a fila retentar. Senão (permanente ou última tentativa), tenta uma vez o
   * texto padrão ao contato e devolve o erro final. As mensagens do contato seguem pendentes no banco
   * (a próxima mensagem dele agenda um novo `flush` que as responde juntas).
   */
  private async onAttendanceFailure(
    companyId: CompanyId,
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
        companyId,
        ...refFields(job),
        permanent,
        ...describeError(error),
      },
      'atendimento falhou sem resposta gravada; enviando o texto padrão ao contato',
    );
    await this.sendFallback(companyId, job);
    if (permanent) {
      return new NonRetryableJobError('Atendimento falhou de forma permanente', {
        cause: error,
        context: { companyId, ...refFields(job), ...describeError(error) },
      });
    }
    return error instanceof Error ? error : new Error('falha desconhecida no atendimento');
  }

  /** Melhor esforço: falhar aqui só gera log (o contato já ficaria sem resposta de qualquer jeito). */
  private async sendFallback(companyId: CompanyId, job: ChannelJob): Promise<void> {
    const refs = refFields(job);
    try {
      const target = await this.resolvePhoneNumber(companyId, job);
      // Suspenso: já logado em `resolvePhoneNumber`; nem o texto padrão sai.
      if (target.kind === 'suspended') return;
      if (target.kind === 'token_invalid') {
        this.logTokenInvalid(companyId, job);
        return;
      }
      if (target.kind === 'none') {
        this.deps.logger.warn({ companyId, ...refs }, 'sem número do canal para o texto padrão');
        return;
      }
      const sent = await this.deps.sender.sendText({
        phoneNumberId: target.phoneNumberId,
        accessToken: target.token,
        to: job.contactRef,
        text: ATTENDANCE_FALLBACK_TEXT,
      });
      if (
        !sent.ok &&
        sent.error instanceof MessageSendError &&
        sent.error.providerCode === TOKEN_INVALID_CODE
      ) {
        await this.markTokenInvalid(companyId, target.tokenVersion);
      }
      if (sent.ok) {
        this.deps.logger.info({ companyId, ...refs }, 'texto padrão enviado ao contato');
      } else {
        this.deps.logger.warn(
          {
            companyId,
            ...refs,
            ...describeError(sent.error),
            ...sendErrorFields(sent.error),
          },
          'falha ao enviar o texto padrão ao contato',
        );
      }
    } catch (error) {
      this.deps.logger.warn(
        { companyId, ...refs, ...describeError(error) },
        'falha ao enviar o texto padrão ao contato',
      );
    }
  }
}

/** Erro que repetir não resolve: empresa removida, entrada inválida (bug do enfileirador). A empresa suspensa (`ForbiddenError`) nem chega aqui: o job é descartado sem envio. */
/** Código do Graph para token inválido ou expirado (OAuthException 190). */
const TOKEN_INVALID_CODE = 190;

function isPermanentAttendanceError(error: unknown): boolean {
  return (
    error instanceof NotFoundError || error instanceof ValidationError || error instanceof ZodError
  );
}

function parseCompanyId(job: ChannelJob): CompanyId {
  try {
    return CompanyId.parse(job.companyId);
  } catch (error) {
    throw new NonRetryableJobError('companyId do job é inválido', { cause: error });
  }
}

/**
 * Referência para correlacionar linhas de log sem registrar dado do contato: `messageRef` (hash do
 * id da mensagem no canal, que carrega o telefone) em `text` e `notice`; `flushRef` (hash da
 * identidade do `flush`, que inclui a empresa e o contato) em `flush`.
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
    companyId: job.companyId,
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
