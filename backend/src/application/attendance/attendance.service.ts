import type {
  Company,
  CompanyId,
  Conversation,
  ListOptions,
  Message,
  MessageOrder,
  NotificationCreateResult,
  Page,
} from '../../domain/index.js';
import { isAiPaused, isReplyResendable } from '../../domain/index.js';
import { ConflictError, ForbiddenError } from '../../shared/errors/index.js';
import {
  type BatchLimits,
  batchLimitsSchema,
  contactRefSchema,
  type InboundMessage,
  inboundMessageSchema,
} from './attendance.schemas.js';
import { type LlmGenerateInput } from '../ports/llm-provider.js';
import { type KnowledgeSource } from './knowledge-prompt.js';
import {
  ATTENDANCE_HISTORY_LIMIT,
  ATTENDANCE_HISTORY_MAX_CHARS,
  type AcceptedMessage,
  type AttendanceReply,
  type AttendanceResult,
  type ConversationHistory,
  type ExistingState,
  RECEIVED_AT_MAX_FUTURE_MS,
  RECEIVED_AT_MAX_PAST_MS,
  type RespondToPendingOptions,
  type BatchResult,
  type AcceptInboundOptions,
  type AttendanceDeps,
  type ContactSubject,
  type HumanEchoInput,
  type HumanEchoResult,
  type PendingResponse,
} from './attendance.types.js';
import { AttendanceLlm, toolFields, usageFields } from './attendance-llm.js';
import { AttendancePrompt } from './attendance-prompt.js';
import { AttendanceTakeover, handoffFields } from './attendance-takeover.js';

// Spec 035, E4: tipos, prompt, chamada ao modelo e pausa da equipe moram em arquivos próprios; este
// módulo continua exportando o que exportava (os chamadores não mudam).
export * from './attendance.types.js';
export { ATTENDANCE_STYLE_INSTRUCTION, buildSystemPrompt } from './attendance-prompt.js';
export { humanEchoContent } from './attendance-takeover.js';

/**
 * Pipeline de atendimento (spec 010): mensagem do contato -> conversa -> LLM -> resposta.
 *
 * Isolamento: o `CompanyId` é sempre o primeiro argumento e chega a todo repositório; o
 * histórico enviado ao modelo e a persona vêm só dessa empresa.
 * Privacidade: nada de texto de mensagem nem de persona em log ou métrica (só ids, tamanhos
 * e resultado).
 * A chamada ao LLM acontece **fora** de qualquer transação do banco.
 */
export class AttendanceService {
  private readonly historyLimit: number;
  private readonly historyMaxChars: number;
  private readonly now: () => Date;
  private readonly llm: AttendanceLlm;
  private readonly prompt: AttendancePrompt;
  private readonly takeover: AttendanceTakeover;

  constructor(private readonly deps: AttendanceDeps) {
    this.historyLimit = deps.options.historyLimit ?? ATTENDANCE_HISTORY_LIMIT;
    this.historyMaxChars = deps.options.historyMaxChars ?? ATTENDANCE_HISTORY_MAX_CHARS;
    this.now = deps.options.now ?? (() => new Date());
    this.llm = new AttendanceLlm(deps, this.historyLimit, this.historyMaxChars);
    this.prompt = new AttendancePrompt(deps, this.llm);
    this.takeover = new AttendanceTakeover(deps, this.now, (companyId, value) =>
      this.plausibleReceivedAt(companyId, value),
    );
  }

  async handleInboundMessage(
    companyId: CompanyId,
    rawInput: InboundMessage,
  ): Promise<AttendanceResult> {
    const input = inboundMessageSchema.parse(rawInput);
    // Empresa inexistente/removido (404) ou suspenso (403): antes de gravar qualquer coisa.
    const company = await this.deps.companies.findById(companyId);
    if (company.status === 'SUSPENDED') {
      throw new ForbiddenError('Empresa suspensa', { context: { companyId } });
    }

    const pending = await this.acceptMessage(companyId, input);
    if (pending.kind === 'done') return pending.result;

    return this.respond(company, pending.message, {
      contactRef: input.contactRef,
      origin: 'simulator',
    });
  }

  /**
   * Etapa "aceitar" do canal (spec 013): grava a mensagem do contato (conversa por `contactRef` e
   * mensagem, idempotente por `externalId`) **sem chamar o LLM**. Quem chama agenda a resposta.
   * Mensagem já respondida volta como `answered` (nada a fazer); mensagem ainda sem resposta (uma
   * reentrega do canal ou a retentativa do job) volta como `pending`.
   */
  async acceptInboundMessage(
    companyId: CompanyId,
    rawInput: InboundMessage,
    options: AcceptInboundOptions = {},
  ): Promise<AcceptedMessage> {
    const input = inboundMessageSchema.parse(rawInput);
    // Empresa inexistente/removido (404) ou suspenso (403): antes de gravar qualquer coisa.
    const company = await this.deps.companies.findById(companyId);
    if (company.status === 'SUSPENDED') {
      throw new ForbiddenError('Empresa suspensa', { context: { companyId } });
    }

    const stored = await this.storeInbound(
      companyId,
      input,
      this.plausibleReceivedAt(companyId, options.receivedAt),
    );
    const [oldest] = await this.deps.messages.listPending(
      companyId,
      stored.message.conversationId,
      1,
    );
    this.deps.logger.info(
      {
        companyId,
        conversationId: stored.message.conversationId,
        messageId: stored.message.id,
        status: stored.status,
        inputChars: stored.message.content.length,
      },
      'mensagem do contato aceita',
    );
    return {
      conversationId: stored.message.conversationId,
      messageId: stored.message.id,
      status: stored.status,
      messageCreatedAt: stored.message.createdAt,
      oldestPendingAt: oldest?.createdAt ?? null,
    };
  }

  /**
   * Passo "responder" do canal (spec 013): junta as mensagens pendentes do contato (da mais antiga
   * para a mais nova, até os limites do lote) num único turno `user`, chama o LLM (com prazo e
   * fallback) **fora** de qualquer transação, grava **uma** resposta e marca todas as mensagens do
   * lote como atendidas na **mesma** transação. A resposta fica com `replyToId` = a última mensagem
   * do lote. Repetir a chamada depois de a resposta gravada não acha pendentes (devolve `resend`
   * se a resposta ainda não foi enviada, sem nova chamada ao modelo).
   *
   * Isolamento: tudo é lido e gravado pelo `CompanyId`; o histórico e a persona são só desta empresa.
   */
  async respondToPending(
    companyId: CompanyId,
    rawContactRef: string,
    rawLimits: BatchLimits,
    options: RespondToPendingOptions = {},
  ): Promise<PendingResponse> {
    const contactRef = contactRefSchema.parse(rawContactRef);
    const limits = batchLimitsSchema.parse(rawLimits);
    const company = await this.deps.companies.findById(companyId);
    if (company.status === 'SUSPENDED') {
      throw new ForbiddenError('Empresa suspensa', { context: { companyId } });
    }

    const conversation = await this.deps.conversations.findByContact(companyId, contactRef);
    if (conversation === null) return this.emptyResponse(null);

    // Um a mais que o limite: é assim que se sabe que sobrou excedente.
    let fetched = await this.deps.messages.listPending(
      companyId,
      conversation.id,
      limits.maxMessages + 1,
    );
    // Spec 039 (D1): a equipe respondeu pelo celular e a pausa vale: nada de LLM, resposta ou envio; o
    // que o contato escreveu durante a pausa é da equipe (sai das pendentes).
    if (isAiPaused(conversation.aiPausedUntil, this.now())) {
      return this.takeover.pausedResponse(companyId, conversation.id, fetched);
    }
    // A pausa já venceu, mas o que o contato escreveu ANTES do fim dela (e cujo `flush` só rodou
    // depois) também é da equipe (revisão da 039, S3): sai das pendentes antes de montar o lote.
    fetched = await this.takeover.dropWrittenDuringPause(
      companyId,
      conversation,
      fetched,
      limits.maxMessages + 1,
    );
    const first = fetched[0];
    if (first === undefined) {
      // Spec 035: a resposta gravada e não enviada só sai se ainda for reenviável (dentro da janela
      // e não segurada pela equipe ao assumir a conversa).
      const unsent = await this.findUnsentTail(companyId, conversation.id);
      return unsent === null ||
        options.skipUnsent === true ||
        !(await this.canResend(companyId, conversation, unsent))
        ? this.emptyResponse(conversation.id)
        : this.resendOrBlocked(company, conversation.id, unsent, false);
    }
    const [previous] = await this.deps.messages.listBefore(companyId, conversation.id, first.id, 1);
    if (previous?.role === 'ASSISTANT' && previous.sentAt === null) {
      // Spec 035 (D6): a resposta anterior que não saiu (envio recusado, ou o job em retentativa foi
      // trocado por este) vai ANTES das novas, em qualquer tentativa, para a ordem ficar a certa.
      if (
        options.skipUnsent !== true &&
        (await this.canResend(companyId, conversation, previous))
      ) {
        return this.resendOrBlocked(company, conversation.id, previous, true);
      }
      // Fora da janela, segurada pela equipe (spec 039), texto padrão ou reenvio que já falhou de vez
      // (revisão da 035): fica só gravada. Avisa, sem conteúdo.
      this.deps.logger.warn(
        {
          companyId,
          conversationId: conversation.id,
          replyId: previous.id,
          firstPendingId: first.id,
        },
        'a resposta do turno anterior não foi enviada e não será reenviada; respondendo as pendentes',
      );
      this.recordUnsentPrevious();
    }

    const batch = selectBatch(fetched, limits);
    const last = batch[batch.length - 1];
    if (last === undefined) return this.emptyResponse(conversation.id);
    const hasMorePending = fetched.length > batch.length;
    const startedAt = performance.now();

    // Cotas e módulos (spec 031): uma leitura por turno, ANTES de qualquer trabalho; esgotada (a que
    // estourar primeiro) ou assinatura inativa, o provedor não é chamado e nada sai ao contato.
    const subject = { conversationId: conversation.id, messageId: last.id };
    const entitlements = await this.llm.readEntitlements(company, subject);
    if (this.llm.blockedBy(company, subject, entitlements) !== null) {
      return {
        outcome: 'blocked',
        conversationId: conversation.id,
        reply: null,
        batchSize: 0,
        hasMorePending: false,
      };
    }

    const userMessage = batch.map((message) => message.content).join(BATCH_SEPARATOR);
    // O histórico é tudo o que veio ANTES da primeira mensagem do lote.
    const history = await this.llm.loadHistory(companyId, first);
    const prompt = await this.prompt.buildPrompt(
      company,
      subject,
      userMessage,
      history,
      { contactRef, origin: 'channel' },
      entitlements,
    );
    const recorder = this.takeover.handoffRecorder();
    const outcome = await this.llm.callProvider(
      companyId,
      { conversationId: conversation.id, messageId: last.id, inputChars: userMessage.length },
      {
        // Persona, estilo e (spec 026) o bloco de conhecimento vão no systemPrompt; o texto do
        // contato vai SEMPRE como `user`.
        systemPrompt: prompt.systemPrompt,
        history,
        userMessage,
      },
      prompt.tools,
      recorder,
    );
    const final = this.llm.finalizeReply(outcome, prompt.tools);
    const replyText = final.text;
    if (final.isFallback) this.llm.recordFallback();
    // Spec 038: o pedido de humano só vale com resposta do modelo (fallback nunca notifica).
    const handoff = outcome.ok ? recorder?.requested() : undefined;

    let reply: Message;
    let notification: NotificationCreateResult | undefined;
    try {
      // A resposta, a marca de "atendida" de todo o lote e a notificação de atendimento humano (spec 038)
      // confirmam (ou desfazem) juntas.
      reply = await this.deps.unitOfWork.run(async (tx) => {
        // Spec 039: a pausa é relida aqui (corrida eco x `flush`): se a equipe respondeu pelo celular
        // durante a chamada ao modelo, esta resposta não é gravada (a transação é desfeita).
        const current = await tx.conversations.findById(companyId, conversation.id);
        if (
          isAiPaused(current.aiPausedUntil, this.now()) ||
          (current.aiIgnoreBefore !== null &&
            first.createdAt.getTime() <= current.aiIgnoreBefore.getTime())
        ) {
          throw new AiPausedSignal();
        }
        const created = await tx.messages.create(companyId, {
          conversationId: conversation.id,
          role: 'ASSISTANT',
          content: replyText,
          isFallback: final.isFallback,
          replyToId: last.id,
          // Logo depois da última mensagem do lote e antes de qualquer outra que chegou durante o
          // atendimento (ou que sobrou do limite): na ordem da conversa a resposta fica no lugar
          // dela, e o histórico do turno seguinte a inclui.
          createdAt: new Date(last.createdAt.getTime() + 1),
        });
        const marked = await tx.messages.markAnswered(
          companyId,
          batch.map((message) => message.id),
          created.id,
        );
        if (marked !== batch.length) {
          // Outra execução já respondeu parte deste lote (lotes diferentes do mesmo contato em
          // paralelo): desfaz esta resposta (mesma transação) e deixa a retentativa resolver.
          throw new ConflictError('O lote já foi atendido, em parte, por outra execução', {
            context: { companyId },
          });
        }
        notification = await this.takeover.createHandoff(tx, companyId, handoff, created);
        return created;
      });
    } catch (error) {
      if (error instanceof AiPausedSignal) {
        const fresh = await this.deps.messages.listPending(
          companyId,
          conversation.id,
          limits.maxMessages + 1,
        );
        const latest = await this.deps.conversations.findById(companyId, conversation.id);
        if (isAiPaused(latest.aiPausedUntil, this.now())) {
          return this.takeover.pausedResponse(companyId, conversation.id, fresh);
        }
        // Reativada no meio: o que a equipe já tratou saiu das pendentes; o resto vai num turno novo.
        this.takeover.recordPausedTurn(companyId, conversation.id, 0);
        return {
          outcome: 'paused',
          conversationId: conversation.id,
          reply: null,
          batchSize: 0,
          hasMorePending: fresh.length > 0,
        };
      }
      if (!(error instanceof ConflictError)) throw error;
      // Outra execução respondeu este lote primeiro (a mensagem só aceita uma resposta).
      const existing = await this.deps.messages.findReplyTo(companyId, last.id);
      if (existing === null) throw error;
      // Não conta o lote de novo: quem respondeu primeiro já o contou.
      return {
        outcome: 'answered',
        conversationId: conversation.id,
        reply: toReply(existing),
        batchSize: batch.length,
        hasMorePending,
      };
    }

    this.recordBatch(batch.length, hasMorePending);
    this.takeover.recordHandoff(companyId, handoff, notification);
    this.deps.logger.info(
      {
        companyId,
        conversationId: conversation.id,
        messageId: last.id,
        replyId: reply.id,
        batchSize: batch.length,
        inputChars: userMessage.length,
        replyChars: reply.content.length,
        historyTurns: history.length,
        isFallback: reply.isFallback,
        hasMorePending,
        ...prompt.stats,
        ...usageFields(outcome),
        ...toolFields(outcome),
        ...handoffFields(handoff, notification),
        durationMs: Math.round(performance.now() - startedAt),
      },
      'lote de mensagens atendido',
    );
    return {
      outcome: 'answered',
      conversationId: conversation.id,
      reply: toReply(reply),
      batchSize: batch.length,
      hasMorePending,
    };
  }

  /** Spec 039: eco da equipe (ver `AttendanceTakeover.recordHumanEcho`). */
  recordHumanEcho(
    companyId: CompanyId,
    rawInput: HumanEchoInput,
    options: AcceptInboundOptions = {},
  ): Promise<HumanEchoResult> {
    return this.takeover.recordHumanEcho(companyId, rawInput, options);
  }

  /** Spec 039: até quando a IA está pausada nesta conversa, ou `null` se não está (ou se já passou). */
  activePause(conversation: Pick<Conversation, 'aiPausedUntil'>): Date | null {
    return this.takeover.activePause(conversation);
  }

  /** A IA está pausada neste contato agora? (Spec 039: segunda leitura antes do envio.) */
  isAiPausedFor(companyId: CompanyId, rawContactRef: string): Promise<boolean> {
    return this.takeover.isAiPausedFor(companyId, rawContactRef);
  }

  /** Reativa a IA numa conversa (spec 039, E4; ver `AttendanceTakeover.resumeAi`). */
  resumeAi(companyId: CompanyId, conversationId: string): Promise<void> {
    return this.takeover.resumeAi(companyId, conversationId);
  }

  /** Há mensagem do contato esperando resposta? (Usado ao tratar um job que falhou sem handler.) */
  async hasPendingMessages(companyId: CompanyId, rawContactRef: string): Promise<boolean> {
    const contactRef = contactRefSchema.parse(rawContactRef);
    const conversation = await this.deps.conversations.findByContact(companyId, contactRef);
    if (conversation === null) return false;
    const pending = await this.deps.messages.listPending(companyId, conversation.id, 1);
    return pending.length > 0;
  }

  async listConversations(
    companyId: CompanyId,
    options?: ListOptions,
  ): Promise<Page<Conversation>> {
    await this.deps.companies.findById(companyId);
    // Última atividade primeiro (spec 024).
    return this.deps.conversations.listByActivity(companyId, options);
  }

  /** Conversas por id, em lote (spec 038: rótulo do contato nas notificações). */
  async getConversationsByIds(
    companyId: CompanyId,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, Conversation>> {
    const rows = await this.deps.conversations.findByIds(companyId, ids);
    return new Map(rows.map((row) => [row.id, row]));
  }

  async listMessages(
    companyId: CompanyId,
    conversationId: string,
    options?: ListOptions,
    order?: MessageOrder,
  ): Promise<ConversationHistory> {
    await this.deps.companies.findById(companyId);
    // Conversa de outra empresa se comporta como inexistente (NotFoundError).
    const conversation = await this.deps.conversations.findById(companyId, conversationId);
    const page = await this.deps.messages.listByConversation(
      companyId,
      conversationId,
      options,
      order,
    );
    return { ...page, conversation };
  }

  /**
   * Passos 1 e 2: idempotência e gravação da mensagem do contato. Devolve a resposta já
   * gravada (duplicata) ou a mensagem do contato que ainda precisa de resposta.
   */
  private async acceptMessage(
    companyId: CompanyId,
    input: InboundMessage,
  ): Promise<
    | { readonly kind: 'done'; readonly result: AttendanceResult }
    | { readonly kind: 'respond'; readonly message: Message }
  > {
    const { contactRef, text, externalId } = input;

    if (externalId !== undefined) {
      const state = await this.inspectExisting(companyId, contactRef, externalId);
      const settled = this.settle(companyId, state);
      if (settled !== undefined) return settled;
    }

    try {
      // Transação curta: só conversa e mensagem do contato. Nada de chamada externa aqui.
      const message = await this.deps.unitOfWork.run(async (tx) => {
        const conversation = await tx.conversations.findOrCreateByContact(companyId, contactRef);
        return tx.messages.create(companyId, {
          conversationId: conversation.id,
          role: 'USER',
          content: text,
          ...(externalId === undefined ? {} : { externalId }),
        });
      });
      return { kind: 'respond', message };
    } catch (error) {
      if (!(error instanceof ConflictError) || externalId === undefined) throw error;
      // Corrida: outro pedido gravou o mesmo externalId entre a checagem e a gravação.
      const state = await this.inspectExisting(companyId, contactRef, externalId);
      if (state.kind === 'none') throw error;
      const settled = this.settle(companyId, state);
      if (settled !== undefined) return settled;
      throw this.inFlightError(companyId);
    }
  }

  /**
   * Grava a mensagem do contato (idempotente por `externalId`) e diz em que pé ela está:
   * recém-gravada, já gravada e pendente, ou já respondida.
   */
  private async storeInbound(
    companyId: CompanyId,
    input: InboundMessage,
    createdAt?: Date,
  ): Promise<{ readonly message: Message; readonly status: AcceptedMessage['status'] }> {
    const { contactRef, text, externalId } = input;

    if (externalId !== undefined) {
      const existing = await this.inspectAccepted(companyId, contactRef, externalId);
      if (existing !== null) return existing;
    }

    try {
      // Transação curta: só conversa e mensagem do contato. Nada de chamada externa aqui.
      const message = await this.deps.unitOfWork.run(async (tx) => {
        const conversation = await tx.conversations.findOrCreateByContact(companyId, contactRef);
        return tx.messages.create(companyId, {
          conversationId: conversation.id,
          role: 'USER',
          content: text,
          ...(externalId === undefined ? {} : { externalId }),
          ...(createdAt === undefined ? {} : { createdAt }),
        });
      });
      return { message, status: 'accepted' };
    } catch (error) {
      if (!(error instanceof ConflictError) || externalId === undefined) throw error;
      // Corrida: outro pedido gravou o mesmo externalId entre a checagem e a gravação.
      const existing = await this.inspectAccepted(companyId, contactRef, externalId);
      if (existing === null) throw error;
      return existing;
    }
  }

  /** O `receivedAt` do canal, se estiver numa faixa plausível; senão `undefined` (relógio do banco). */
  private plausibleReceivedAt(
    companyId: CompanyId,
    receivedAt: Date | undefined,
  ): Date | undefined {
    if (receivedAt === undefined) return undefined;
    const receivedMs = receivedAt.getTime();
    const nowMs = this.now().getTime();
    if (
      Number.isFinite(receivedMs) &&
      receivedMs >= nowMs - RECEIVED_AT_MAX_PAST_MS &&
      receivedMs <= nowMs + RECEIVED_AT_MAX_FUTURE_MS
    ) {
      return receivedAt;
    }
    // Só o id da empresa: nem o instante informado nem nada da mensagem.
    this.deps.logger.warn(
      { companyId },
      'instante de recebimento fora da faixa aceita; usando o relógio do banco',
    );
    return undefined;
  }

  private async inspectAccepted(
    companyId: CompanyId,
    contactRef: string,
    externalId: string,
  ): Promise<{ readonly message: Message; readonly status: 'pending' | 'answered' } | null> {
    const message = await this.deps.messages.findByExternalId(companyId, externalId);
    if (message === null) return null;

    const conversation = await this.deps.conversations.findById(companyId, message.conversationId);
    if (conversation.contactRef !== contactRef) {
      // O mesmo id de canal chegando para outro contato é erro de quem chama, não duplicata.
      throw new ConflictError('externalId já usado em outra conversa', { context: { companyId } });
    }
    const answered =
      message.answeredById !== null ||
      (await this.deps.messages.findReplyTo(companyId, message.id)) !== null;
    return { message, status: answered ? 'answered' : 'pending' };
  }

  /** A última mensagem da conversa, se for uma resposta ainda não enviada. */
  private async findUnsentTail(
    companyId: CompanyId,
    conversationId: string,
  ): Promise<Message | null> {
    const [last] = await this.deps.messages.listRecent(companyId, conversationId, 1);
    return last?.role === 'ASSISTANT' && last.sentAt === null ? last : null;
  }

  private emptyResponse(conversationId: string | null): PendingResponse {
    this.recordBatch(0, false);
    return {
      outcome: 'empty',
      conversationId,
      reply: null,
      batchSize: 0,
      hasMorePending: false,
    };
  }

  /**
   * A resposta gravada e não enviada pode sair de novo? Precisa ser reenviável (janela, equipe, texto
   * padrão, entrega incerta) e ter atendido um lote do canal: a resposta do simulador nunca atende lote
   * e nunca vai ao canal, mesmo com um `contactRef` em forma de telefone (revisão da 035, I1).
   */
  private async canResend(
    companyId: CompanyId,
    conversation: Pick<Conversation, 'aiIgnoreBefore'>,
    reply: Message,
  ): Promise<boolean> {
    if (!isReplyResendable(reply, conversation, this.now())) return false;
    return this.deps.messages.isBatchReply(companyId, reply.id);
  }

  /**
   * Revisão da 035 (I2): o reenvio também respeita cota e assinatura (spec 031). Bloqueado, nada sai ao
   * contato e o provedor não é chamado, como no turno normal.
   */
  private async resendOrBlocked(
    company: Company,
    conversationId: string,
    reply: Message,
    hasMorePending: boolean,
  ): Promise<PendingResponse> {
    const subject = { conversationId, messageId: reply.id };
    const entitlements = await this.llm.readEntitlements(company, subject);
    if (this.llm.blockedBy(company, subject, entitlements) !== null) {
      return {
        outcome: 'blocked',
        conversationId,
        reply: null,
        batchSize: 0,
        hasMorePending: false,
      };
    }
    return this.resendResponse(conversationId, reply, hasMorePending);
  }

  private resendResponse(
    conversationId: string,
    reply: Message,
    hasMorePending: boolean,
  ): PendingResponse {
    this.deps.logger.info(
      { companyId: reply.companyId, conversationId, replyId: reply.id },
      'resposta gravada ainda não enviada; reenviando sem nova chamada ao LLM',
    );
    return {
      outcome: 'resend',
      conversationId,
      reply: toReply(reply),
      batchSize: 0,
      hasMorePending,
    };
  }

  private recordUnsentPrevious(): void {
    try {
      this.deps.metrics?.countUnsentReply?.();
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica de resposta não enviada');
    }
  }

  private recordBatch(size: number, capped: boolean): void {
    const result: BatchResult = size === 0 ? 'empty' : capped ? 'capped' : 'answered';
    try {
      this.deps.metrics?.observeAttendanceBatch?.({ size, result });
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica do lote');
    }
  }

  /** `replied` vira resposta duplicada; `in-flight` vira 409; `stale` segue para responder. */
  private settle(
    companyId: CompanyId,
    state: ExistingState,
  ):
    | { readonly kind: 'done'; readonly result: AttendanceResult }
    | { readonly kind: 'respond'; readonly message: Message }
    | undefined {
    switch (state.kind) {
      case 'none':
        return undefined;
      case 'replied':
        return { kind: 'done', result: toResult(state.message, state.reply, true) };
      case 'in-flight':
        throw this.inFlightError(companyId);
      case 'stale':
        // A mensagem foi gravada mas ficou sem resposta (queda no meio): completa o fluxo.
        this.deps.logger.info(
          { companyId, messageId: state.message.id },
          'retomando mensagem sem resposta',
        );
        return { kind: 'respond', message: state.message };
    }
  }

  private inFlightError(companyId: CompanyId): ConflictError {
    return new ConflictError('Esta mensagem já está sendo processada', {
      context: { companyId },
    });
  }

  private async inspectExisting(
    companyId: CompanyId,
    contactRef: string,
    externalId: string,
  ): Promise<ExistingState> {
    const message = await this.deps.messages.findByExternalId(companyId, externalId);
    if (message === null) return { kind: 'none' };

    const conversation = await this.deps.conversations.findById(companyId, message.conversationId);
    if (conversation.contactRef !== contactRef) {
      // O mesmo id de canal chegando para outro contato é erro de quem chama, não duplicata.
      throw new ConflictError('externalId já usado em outra conversa', { context: { companyId } });
    }

    const reply = await this.deps.messages.findReplyTo(companyId, message.id);
    if (reply !== null) return { kind: 'replied', message, reply };

    const ageMs = this.now().getTime() - message.createdAt.getTime();
    return ageMs < this.deps.options.inFlightTimeoutMs
      ? { kind: 'in-flight' }
      : { kind: 'stale', message };
  }

  /** Passos 3 a 6: histórico, chamada ao LLM (com prazo), gravação da resposta ou do fallback. */
  private async respond(
    company: Company,
    message: Message,
    contact: ContactSubject,
  ): Promise<AttendanceResult> {
    const companyId = company.id;
    const startedAt = performance.now();

    // Cotas e módulos (spec 031): o simulador também respeita a cota; a mensagem fica gravada, sem resposta.
    const subject = { conversationId: message.conversationId, messageId: message.id };
    const entitlements = await this.llm.readEntitlements(company, subject);
    const blocked = this.llm.blockedBy(company, subject, entitlements);
    if (blocked !== null) {
      throw new ForbiddenError(
        blocked === 'inactive'
          ? 'Assinatura inativa: a IA está pausada'
          : 'Cota de uso da assinatura esgotada: a IA está pausada',
        { code: blocked === 'inactive' ? 'SUBSCRIPTION_INACTIVE' : 'QUOTA_EXCEEDED' },
      );
    }

    const history = await this.llm.loadHistory(companyId, message);
    const prompt = await this.prompt.buildPrompt(
      company,
      subject,
      message.content,
      history,
      contact,
      entitlements,
    );
    const input: LlmGenerateInput = {
      // Persona, estilo e (spec 026) o bloco de conhecimento vão no systemPrompt; o texto do
      // contato vai SEMPRE como `user`.
      systemPrompt: prompt.systemPrompt,
      history,
      userMessage: message.content,
    };
    const recorder = this.takeover.handoffRecorder();
    const outcome = await this.llm.callProvider(
      companyId,
      {
        conversationId: message.conversationId,
        messageId: message.id,
        inputChars: message.content.length,
      },
      input,
      prompt.tools,
      recorder,
    );

    const final = this.llm.finalizeReply(outcome, prompt.tools);
    const replyText = final.text;
    if (final.isFallback) this.llm.recordFallback();
    const handoff = outcome.ok ? recorder?.requested() : undefined;

    let reply: Message;
    let notification: NotificationCreateResult | undefined;
    try {
      // Resposta e notificação de atendimento humano (spec 038) confirmam (ou desfazem) juntas.
      reply = await this.deps.unitOfWork.run(async (tx) => {
        const created = await tx.messages.create(companyId, {
          conversationId: message.conversationId,
          role: 'ASSISTANT',
          content: replyText,
          isFallback: final.isFallback,
          replyToId: message.id,
          // A resposta nunca fica antes da pergunta, mesmo no mesmo milissegundo.
          createdAt: new Date(Math.max(this.now().getTime(), message.createdAt.getTime() + 1)),
        });
        notification = await this.takeover.createHandoff(tx, companyId, handoff, created);
        return created;
      });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      // Outra retentativa respondeu primeiro (a mensagem do contato só aceita uma resposta).
      const existing = await this.deps.messages.findReplyTo(companyId, message.id);
      if (existing === null) throw error;
      return toResult(message, existing, true);
    }

    this.deps.logger.info(
      {
        companyId,
        conversationId: message.conversationId,
        messageId: message.id,
        replyId: reply.id,
        inputChars: message.content.length,
        replyChars: reply.content.length,
        historyTurns: history.length,
        isFallback: reply.isFallback,
        ...prompt.stats,
        ...usageFields(outcome),
        ...toolFields(outcome),
        ...handoffFields(handoff, notification),
        durationMs: Math.round(performance.now() - startedAt),
      },
      'mensagem atendida',
    );
    this.takeover.recordHandoff(companyId, handoff, notification);
    return toResult(message, reply, false, prompt.sources);
  }
}

function toReply(reply: Message): AttendanceReply {
  return {
    id: reply.id,
    text: reply.content,
    isFallback: reply.isFallback,
    sentAt: reply.sentAt,
  };
}

function toResult(
  message: Message,
  reply: Message,
  duplicate: boolean,
  sources: readonly KnowledgeSource[] = [],
): AttendanceResult {
  return {
    conversationId: message.conversationId,
    messageId: message.id,
    reply: toReply(reply),
    duplicate,
    sources,
  };
}

/** Separador entre os textos das mensagens de um mesmo lote (um único turno `user`). */
const BATCH_SEPARATOR = '\n';

/**
 * As mensagens que cabem numa resposta: em ordem de chegada, até `maxMessages` e `maxChars`
 * caracteres somados (com os separadores). A primeira entra sempre, mesmo maior que o limite
 * (uma única mensagem enorme segue sozinha); o excedente vira o turno seguinte.
 */
function selectBatch(pending: readonly Message[], limits: BatchLimits): Message[] {
  const batch: Message[] = [];
  let chars = 0;
  for (const message of pending) {
    if (batch.length >= limits.maxMessages) break;
    const added = message.content.length + (batch.length === 0 ? 0 : BATCH_SEPARATOR.length);
    if (batch.length > 0 && chars + added > limits.maxChars) break;
    batch.push(message);
    chars += added;
  }
  return batch;
}

/**
 * Sinal interno (spec 039): a IA foi pausada no contato entre a leitura das pendentes e a gravação da
 * resposta. Lançado dentro da transação para desfazê-la; nunca sai do serviço.
 */
class AiPausedSignal extends Error {
  constructor() {
    super('IA pausada no contato durante o turno');
    this.name = 'AiPausedSignal';
  }
}
