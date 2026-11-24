// Atendimento humano: a equipe e a IA no mesmo chat (spec 039: eco da equipe, pausa da IA e turno
// pausado) e o pedido de humano feito pelo modelo (spec 038). Spec 035, E4: separados de
// attendance.service.ts, sem mudar a lógica.
import type {
  AttendanceTransaction,
  CompanyId,
  Conversation,
  HandoffReason,
  Message,
  NotificationCreateResult,
} from '../../domain/index.js';
import {
  AI_TAKEOVER_PAUSE_MS,
  HUMAN_MEDIA_PLACEHOLDER,
  isAiPaused,
  MESSAGE_CONTENT_MAX_LENGTH,
  NOTIFICATION_MAX_OPEN,
} from '../../domain/index.js';
import { createHandoffRecorder, type HandoffRecorder } from './handoff-tool.js';
import { ConflictError, ForbiddenError } from '../../shared/errors/index.js';
import { contactRefSchema } from './attendance.schemas.js';
import {
  type AcceptInboundOptions,
  type AttendanceDeps,
  type HumanEchoInput,
  type HumanEchoResult,
  type PendingResponse,
} from './attendance.types.js';

/**
 * Texto gravado do eco: o da equipe, cortado no teto de uma mensagem; vazio ou ausente vira o texto fixo
 * de mídia (spec 039).
 */
export function humanEchoContent(rawText: string | undefined): string {
  // NUL e os outros caracteres de controle (exceto tabulação e quebra de linha) saem: o Postgres recusa
  // NUL em texto e o eco se perderia nas retentativas (revisão da 039, S2).
  // eslint-disable-next-line no-control-regex -- remover caracteres de controle é o objetivo
  const text = rawText?.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  if (text === undefined || text.trim() === '') return HUMAN_MEDIA_PLACEHOLDER;
  return Array.from(text).length > MESSAGE_CONTENT_MAX_LENGTH
    ? Array.from(text).slice(0, MESSAGE_CONTENT_MAX_LENGTH).join('')
    : text;
}

/**
 * Atendimento humano: eco da equipe e pausa da IA (spec 039) e o pedido de humano feito pelo modelo
 * (spec 038). Só o `AttendanceService` a usa.
 */
export class AttendanceTakeover {
  constructor(
    private readonly deps: AttendanceDeps,
    private readonly now: () => Date,
    /** O instante de recebimento plausível (spec 034), do serviço. */
    private readonly receivedAt: (
      companyId: CompanyId,
      value: Date | undefined,
    ) => Date | undefined,
  ) {}

  /**
   * Eco de uma mensagem que a equipe enviou pelo aplicativo WhatsApp Business (spec 039, E3). Grava a
   * mensagem `HUMAN` (idempotente por `externalId`) com `createdAt` = instante de recebimento e, na mesma
   * transação, pausa a IA no contato (`aiPausedUntil` = recebimento + 12 h; renova, nunca encurta) e
   * marca como tratado pela equipe tudo o que o contato escreveu até ali (`aiIgnoreBefore`). Eco de uma
   * resposta que o próprio Soprei enviou (`channelMessageId` conhecido) é ignorado (`own`). O pedido de
   * atendimento humano aberto (038) NÃO é resolvido aqui (D4). Empresa suspensa: `ForbiddenError`.
   * Nada do texto nem do contato vai a log (só ids).
   */
  async recordHumanEcho(
    companyId: CompanyId,
    rawInput: HumanEchoInput,
    options: AcceptInboundOptions = {},
  ): Promise<HumanEchoResult> {
    const contactRef = contactRefSchema.parse(rawInput.contactRef);
    const externalId = rawInput.externalId;
    const content = humanEchoContent(rawInput.text);
    const company = await this.deps.companies.findById(companyId);
    if (company.status === 'SUSPENDED') {
      throw new ForbiddenError('Empresa suspensa', { context: { companyId } });
    }
    const own = await this.deps.messages.findByChannelMessageId(companyId, externalId);
    if (own !== null) return { result: 'own' };
    if ((await this.deps.messages.findByExternalId(companyId, externalId)) !== null) {
      return { result: 'duplicate' };
    }
    const receivedAt = this.receivedAt(companyId, options.receivedAt);
    try {
      const recorded = await this.deps.unitOfWork.run(async (tx) => {
        const conversation = await tx.conversations.findOrCreateByContact(companyId, contactRef);
        const message = await tx.messages.create(companyId, {
          conversationId: conversation.id,
          role: 'HUMAN',
          content,
          externalId,
          ...(receivedAt === undefined ? {} : { createdAt: receivedAt }),
        });
        // A pausa conta do instante da mensagem da equipe (o gravado: o do canal ou, implausível, o do banco).
        await tx.conversations.extendAiPause(companyId, conversation.id, {
          pausedUntil: new Date(message.createdAt.getTime() + AI_TAKEOVER_PAUSE_MS),
          ignoreBefore: message.createdAt,
        });
        return message;
      });
      this.deps.logger.info(
        {
          companyId,
          conversationId: recorded.conversationId,
          messageId: recorded.id,
          contentChars: recorded.content.length,
        },
        'mensagem da equipe pelo aplicativo gravada; IA pausada no contato',
      );
      return { result: 'recorded', conversationId: recorded.conversationId };
    } catch (error) {
      // Corrida: outro job gravou o mesmo eco entre a checagem e a gravação.
      if (
        error instanceof ConflictError &&
        (await this.deps.messages.findByExternalId(companyId, externalId)) !== null
      ) {
        return { result: 'duplicate' };
      }
      throw error;
    }
  }

  /** Spec 039: até quando a IA está pausada nesta conversa, ou `null` se não está (ou se já passou). */
  activePause(conversation: Pick<Conversation, 'aiPausedUntil'>): Date | null {
    return isAiPaused(conversation.aiPausedUntil, this.now()) ? conversation.aiPausedUntil : null;
  }

  /** A IA está pausada neste contato agora? (Spec 039: segunda leitura antes do envio.) */
  async isAiPausedFor(companyId: CompanyId, rawContactRef: string): Promise<boolean> {
    const contactRef = contactRefSchema.parse(rawContactRef);
    const conversation = await this.deps.conversations.findByContact(companyId, contactRef);
    return conversation !== null && isAiPaused(conversation.aiPausedUntil, this.now());
  }

  /**
   * Reativa a IA numa conversa (spec 039, E4): zera a pausa, mantém o `aiIgnoreBefore` (o que a equipe
   * já tratou não é respondido depois). Idempotente. Conversa malformada, inexistente ou de outra
   * empresa: `NotFoundError` (o mesmo 404). Sem auditoria (D5): log só com ids e métrica.
   */
  async resumeAi(companyId: CompanyId, conversationId: string): Promise<void> {
    await this.deps.companies.findById(companyId);
    await this.deps.conversations.findById(companyId, conversationId);
    await this.deps.conversations.clearAiPause(companyId, conversationId);
    try {
      this.deps.metrics?.countAiResume?.();
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica de reativação da IA');
    }
    this.deps.logger.info({ companyId, conversationId }, 'IA reativada na conversa pelo painel');
  }

  /**
   * Turno em pausa (spec 039): o que estava pendente (até o mais recente lido) passa a ser da equipe
   * (`aiIgnoreBefore`), sem chamar o modelo, sem gravar resposta e sem enviar nada.
   */
  async pausedResponse(
    companyId: CompanyId,
    conversationId: string,
    pending: readonly Message[],
  ): Promise<PendingResponse> {
    const newest = pending[pending.length - 1];
    let hasMorePending = false;
    if (newest !== undefined) {
      await this.deps.conversations.extendAiPause(companyId, conversationId, {
        ignoreBefore: newest.createdAt,
      });
      hasMorePending =
        (await this.deps.messages.listPending(companyId, conversationId, 1)).length > 0;
    }
    this.recordPausedTurn(companyId, conversationId, pending.length);
    return {
      outcome: 'paused',
      conversationId,
      reply: null,
      batchSize: 0,
      hasMorePending,
    };
  }

  /**
   * Pendentes gravadas antes do fim de uma pausa já vencida (`createdAt < aiPausedUntil`) passam a ser da
   * equipe: `aiIgnoreBefore` avança até a última delas (só para a frente) e a lista é relida. Reativar a
   * IA zera `aiPausedUntil`, então depois de "Reativar a IA" nada disso se aplica. Laço limitado: cada
   * volta tira ao menos uma mensagem.
   */
  async dropWrittenDuringPause(
    companyId: CompanyId,
    conversation: Pick<Conversation, 'id' | 'aiPausedUntil'>,
    pending: readonly Message[],
    limit: number,
  ): Promise<readonly Message[]> {
    const pausedUntil = conversation.aiPausedUntil;
    if (pausedUntil === null) return pending;
    let current = pending;
    let ignored = 0;
    for (let round = 0; round < 50; round += 1) {
      const during = current.filter((message) => message.createdAt < pausedUntil);
      const newest = during[during.length - 1];
      if (newest === undefined) break;
      ignored += during.length;
      await this.deps.conversations.extendAiPause(companyId, conversation.id, {
        ignoreBefore: newest.createdAt,
      });
      current = await this.deps.messages.listPending(companyId, conversation.id, limit);
    }
    if (ignored > 0) {
      this.deps.logger.info(
        { companyId, conversationId: conversation.id, ignoredMessages: ignored },
        'mensagens escritas durante a pausa da IA ficaram com a equipe',
      );
    }
    return current;
  }

  recordPausedTurn(companyId: CompanyId, conversationId: string, ignored: number): void {
    try {
      this.deps.metrics?.countPausedTurn?.();
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica de turno pausado');
    }
    this.deps.logger.info(
      { companyId, conversationId, ignoredMessages: ignored },
      'IA pausada no contato (a equipe respondeu pelo celular); nada foi respondido',
    );
  }

  /** Um registrador por turno quando a ferramenta de humano está ligada (spec 038). */
  handoffRecorder(): HandoffRecorder | undefined {
    return this.deps.options.handoffEnabled === true ? createHandoffRecorder() : undefined;
  }

  /**
   * Grava a notificação de atendimento humano (spec 038) dentro da transação da resposta: se a
   * transação desfaz, não sobra notificação. Sem pedido do modelo, nada é feito.
   */
  async createHandoff(
    tx: AttendanceTransaction,
    companyId: CompanyId,
    handoff: HandoffReason | undefined,
    reply: Message,
  ): Promise<NotificationCreateResult | undefined> {
    if (handoff === undefined) return undefined;
    return tx.notifications.createHandoff(
      companyId,
      {
        reason: handoff,
        conversationId: reply.conversationId,
        messageId: reply.id,
        createdAt: reply.createdAt,
      },
      this.deps.options.notificationMaxOpen ?? NOTIFICATION_MAX_OPEN,
    );
  }

  /** Métricas do pedido de humano, depois do commit. Falha de métrica nunca derruba o atendimento. */
  recordHandoff(
    companyId: CompanyId,
    handoff: HandoffReason | undefined,
    notification: NotificationCreateResult | undefined,
  ): void {
    if (handoff === undefined) return;
    try {
      this.deps.metrics?.countHandoff?.(handoff);
      if (notification !== undefined) this.deps.metrics?.countNotificationCreated?.(notification);
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica de atendimento humano');
    }
    if (notification === 'capped') {
      this.deps.logger.warn(
        { companyId, reason: 'notification_cap' },
        'teto de notificações abertas da empresa atingido; pedido de atendimento humano não gravado',
      );
    }
  }
}

/** Campos de log do pedido de humano (spec 038): só o motivo (enum) e o resultado, nunca texto. */
export function handoffFields(
  handoff: HandoffReason | undefined,
  notification: NotificationCreateResult | undefined,
): object {
  if (handoff === undefined) return {};
  return { handoff: true, handoffReason: handoff, notification: notification ?? null };
}
