import type {
  AttendanceUnitOfWork,
  Client,
  ClientId,
  ClientRepository,
  Conversation,
  ConversationRepository,
  ListOptions,
  Message,
  MessageRepository,
  Page,
} from '../../domain/index.js';
import { MESSAGE_CONTENT_MAX_LENGTH } from '../../domain/index.js';
import { ConflictError, ExternalServiceError, ForbiddenError } from '../../shared/errors/index.js';
import { TimeoutError, withTimeout } from '../../shared/utils/index.js';
import {
  type BatchLimits,
  batchLimitsSchema,
  contactRefSchema,
  type InboundMessage,
  inboundMessageSchema,
} from './attendance.schemas.js';
import type { LlmGenerateInput, LlmProvider, LlmTurn } from '../ports/llm-provider.js';

/** Quantas mensagens anteriores da conversa vão ao modelo. */
export const ATTENDANCE_HISTORY_LIMIT = 20;
/** Teto de caracteres do histórico enviado ao modelo; o corte mantém as mais recentes. */
export const ATTENDANCE_HISTORY_MAX_CHARS = 12_000;
/** Texto enviado ao contato quando o modelo falha, estoura o prazo ou responde algo inutilizável. */
export const ATTENDANCE_FALLBACK_TEXT =
  'Desculpe, estou com dificuldades no momento. Tente novamente em instantes.';

export type LlmRequestResult = 'ok' | 'error' | 'timeout';

/** Métricas do atendimento (o registry fica na infraestrutura; sem `clientId` em label). */
export interface AttendanceMetrics {
  observeLlmRequest(sample: {
    readonly provider: string;
    readonly result: LlmRequestResult;
    readonly durationSeconds: number;
  }): void;
  countAttendanceFallback(): void;
  /**
   * Uma resposta de lote terminou (spec 013). `size` é quantas mensagens ela juntou (0 em `empty`);
   * `result` é `answered`, `empty` (nada pendente) ou `capped` (sobrou excedente).
   */
  observeAttendanceBatch?(sample: { readonly size: number; readonly result: BatchResult }): void;
  /**
   * A resposta do turno anterior ficou gravada sem `sentAt` e este turno saiu mesmo assim (spec 013).
   * Contador sem labels.
   */
  countUnsentReply?(): void;
}

export type BatchResult = 'answered' | 'empty' | 'capped';

/**
 * O que o serviço precisa do logger. O do Pino serve; o contexto da requisição (`requestId`,
 * `clientId`) entra pelo `mixin` do logger. **Nunca** passe texto de mensagem nem persona.
 */
export interface AttendanceLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface AttendanceOptions {
  /** Prazo da chamada ao LLM (`LLM_TIMEOUT_MS`). */
  readonly llmTimeoutMs: number;
  /** Idade a partir da qual uma mensagem do contato sem resposta deixa de estar "em andamento". */
  readonly inFlightTimeoutMs: number;
  readonly historyLimit?: number;
  readonly historyMaxChars?: number;
  /** Relógio injetável, para os testes. */
  readonly now?: () => Date;
}

export interface AttendanceDeps {
  readonly clients: ClientRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  /** Transação do banco: só para gravar conversa e mensagem; nunca envolve a chamada ao LLM. */
  readonly unitOfWork: AttendanceUnitOfWork;
  readonly llm: LlmProvider;
  readonly logger: AttendanceLogger;
  readonly metrics?: AttendanceMetrics;
  readonly options: AttendanceOptions;
}

export interface AttendanceReply {
  readonly id: string;
  readonly text: string;
  readonly isFallback: boolean;
  /** Quando a resposta foi entregue ao canal; nulo = ainda não enviada (spec 011). */
  readonly sentAt: Date | null;
}

export interface AttendanceResult {
  readonly conversationId: string;
  /** Id da mensagem do contato. */
  readonly messageId: string;
  readonly reply: AttendanceReply;
  /** Verdadeiro quando o `externalId` já tinha sido atendido: devolve a resposta gravada. */
  readonly duplicate: boolean;
}

/** O que `acceptInboundMessage` fez com a mensagem do contato (spec 013). */
export interface AcceptedMessage {
  readonly conversationId: string;
  /** Id da mensagem do contato. */
  readonly messageId: string;
  /**
   * `accepted`: gravada agora; `pending`: já estava gravada e sem resposta (reentrega do canal ou
   * retentativa do job); `answered`: já foi respondida (nada a fazer).
   */
  readonly status: 'accepted' | 'pending' | 'answered';
  /** Quando esta mensagem foi gravada (relógio do banco). */
  readonly messageCreatedAt: Date;
  /** Quando a mais antiga mensagem pendente do contato foi gravada; nulo se nada está pendente. */
  readonly oldestPendingAt: Date | null;
}

/**
 * Resultado de `respondToPending` (spec 013).
 * - `answered`: o lote foi respondido agora (ou já tinha sido, por outra execução: resposta repetida).
 * - `resend`: não havia o que responder, mas a última resposta gravada ainda não tem `sentAt`: o
 *   chamador a envia (sem nova chamada ao LLM).
 * - `empty`: nada pendente e nada a reenviar.
 */
export interface PendingResponse {
  readonly outcome: 'answered' | 'resend' | 'empty';
  readonly conversationId: string | null;
  readonly reply: AttendanceReply | null;
  /** Quantas mensagens do contato a resposta juntou (0 em `resend` e `empty`). */
  readonly batchSize: number;
  /** Sobraram mensagens pendentes (excederam o limite do lote ou chegaram depois): há outro turno. */
  readonly hasMorePending: boolean;
}

export interface RespondToPendingOptions {
  /**
   * Retentativa de um job que já falhou: se a resposta do turno anterior foi gravada mas não
   * enviada, ela sai primeiro (antes de responder as pendentes), para não ficar perdida.
   */
  readonly resumeUnsent?: boolean;
}

type ExistingState =
  | { readonly kind: 'none' }
  | { readonly kind: 'replied'; readonly message: Message; readonly reply: Message }
  | { readonly kind: 'in-flight' }
  | { readonly kind: 'stale'; readonly message: Message };

/** O que a chamada ao LLM precisa saber da(s) mensagem(ns) atendida(s), para log e métrica. */
interface LlmSubject {
  readonly conversationId: string;
  /** Id da mensagem (a última do lote, quando há mais de uma). */
  readonly messageId: string;
  readonly inputChars: number;
}

type LlmOutcome = { readonly ok: true; readonly text: string } | { readonly ok: false };

/** Persona padrão, usada quando o cliente não definiu a sua. */
export function buildSystemPrompt(client: Pick<Client, 'name' | 'persona'>): string {
  if (client.persona !== null) return client.persona;
  return `Você é o assistente de atendimento de ${client.name}. Responda em português do Brasil, de forma educada, clara e objetiva.`;
}

/**
 * Pipeline de atendimento (spec 010): mensagem do contato -> conversa -> LLM -> resposta.
 *
 * Isolamento: o `ClientId` é sempre o primeiro argumento e chega a todo repositório; o
 * histórico enviado ao modelo e a persona vêm só desse cliente.
 * Privacidade: nada de texto de mensagem nem de persona em log ou métrica (só ids, tamanhos
 * e resultado).
 * A chamada ao LLM acontece **fora** de qualquer transação do banco.
 */
export class AttendanceService {
  private readonly historyLimit: number;
  private readonly historyMaxChars: number;
  private readonly now: () => Date;

  constructor(private readonly deps: AttendanceDeps) {
    this.historyLimit = deps.options.historyLimit ?? ATTENDANCE_HISTORY_LIMIT;
    this.historyMaxChars = deps.options.historyMaxChars ?? ATTENDANCE_HISTORY_MAX_CHARS;
    this.now = deps.options.now ?? (() => new Date());
  }

  async handleInboundMessage(
    clientId: ClientId,
    rawInput: InboundMessage,
  ): Promise<AttendanceResult> {
    const input = inboundMessageSchema.parse(rawInput);
    // Cliente inexistente/removido (404) ou suspenso (403): antes de gravar qualquer coisa.
    const client = await this.deps.clients.findById(clientId);
    if (client.status === 'SUSPENDED') {
      throw new ForbiddenError('Cliente suspenso', { context: { clientId } });
    }

    const pending = await this.acceptMessage(clientId, input);
    if (pending.kind === 'done') return pending.result;

    return this.respond(client, pending.message);
  }

  /**
   * Etapa "aceitar" do canal (spec 013): grava a mensagem do contato (conversa por `contactRef` e
   * mensagem, idempotente por `externalId`) **sem chamar o LLM**. Quem chama agenda a resposta.
   * Mensagem já respondida volta como `answered` (nada a fazer); mensagem ainda sem resposta (uma
   * reentrega do canal ou a retentativa do job) volta como `pending`.
   */
  async acceptInboundMessage(
    clientId: ClientId,
    rawInput: InboundMessage,
  ): Promise<AcceptedMessage> {
    const input = inboundMessageSchema.parse(rawInput);
    // Cliente inexistente/removido (404) ou suspenso (403): antes de gravar qualquer coisa.
    const client = await this.deps.clients.findById(clientId);
    if (client.status === 'SUSPENDED') {
      throw new ForbiddenError('Cliente suspenso', { context: { clientId } });
    }

    const stored = await this.storeInbound(clientId, input);
    const [oldest] = await this.deps.messages.listPending(
      clientId,
      stored.message.conversationId,
      1,
    );
    this.deps.logger.info(
      {
        clientId,
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
   * Isolamento: tudo é lido e gravado pelo `ClientId`; o histórico e a persona são só deste cliente.
   */
  async respondToPending(
    clientId: ClientId,
    rawContactRef: string,
    rawLimits: BatchLimits,
    options: RespondToPendingOptions = {},
  ): Promise<PendingResponse> {
    const contactRef = contactRefSchema.parse(rawContactRef);
    const limits = batchLimitsSchema.parse(rawLimits);
    const client = await this.deps.clients.findById(clientId);
    if (client.status === 'SUSPENDED') {
      throw new ForbiddenError('Cliente suspenso', { context: { clientId } });
    }

    const conversation = await this.deps.conversations.findByContact(clientId, contactRef);
    if (conversation === null) return this.emptyResponse(null);

    // Um a mais que o limite: é assim que se sabe que sobrou excedente.
    const fetched = await this.deps.messages.listPending(
      clientId,
      conversation.id,
      limits.maxMessages + 1,
    );
    const first = fetched[0];
    if (first === undefined) {
      const unsent = await this.findUnsentTail(clientId, conversation.id);
      return unsent === null
        ? this.emptyResponse(conversation.id)
        : this.resendResponse(conversation.id, unsent, false);
    }
    const [previous] = await this.deps.messages.listBefore(clientId, conversation.id, first.id, 1);
    if (previous?.role === 'ASSISTANT' && previous.sentAt === null) {
      if (options.resumeUnsent === true) {
        return this.resendResponse(conversation.id, previous, true);
      }
      // Não é retentativa: a resposta anterior não saiu (envio recusado de vez, ou o job em
      // retentativa foi trocado por este) e não será reenviada. Fica só gravada: avisa, sem conteúdo.
      this.deps.logger.warn(
        {
          clientId,
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

    const userMessage = batch.map((message) => message.content).join(BATCH_SEPARATOR);
    // O histórico é tudo o que veio ANTES da primeira mensagem do lote.
    const history = await this.loadHistory(clientId, first);
    const outcome = await this.callProvider(
      clientId,
      { conversationId: conversation.id, messageId: last.id, inputChars: userMessage.length },
      {
        // A persona é a única coisa que vai no systemPrompt; o texto do contato vai como `user`.
        systemPrompt: buildSystemPrompt(client),
        history,
        userMessage,
      },
    );
    const replyText = outcome.ok ? outcome.text : ATTENDANCE_FALLBACK_TEXT;
    if (!outcome.ok) this.recordFallback();

    let reply: Message;
    try {
      // A resposta e a marca de "atendida" de todo o lote confirmam (ou desfazem) juntas.
      reply = await this.deps.unitOfWork.run(async (tx) => {
        const created = await tx.messages.create(clientId, {
          conversationId: conversation.id,
          role: 'ASSISTANT',
          content: replyText,
          isFallback: !outcome.ok,
          replyToId: last.id,
          // Logo depois da última mensagem do lote e antes de qualquer outra que chegou durante o
          // atendimento (ou que sobrou do limite): na ordem da conversa a resposta fica no lugar
          // dela, e o histórico do turno seguinte a inclui.
          createdAt: new Date(last.createdAt.getTime() + 1),
        });
        const marked = await tx.messages.markAnswered(
          clientId,
          batch.map((message) => message.id),
          created.id,
        );
        if (marked !== batch.length) {
          // Outra execução já respondeu parte deste lote (lotes diferentes do mesmo contato em
          // paralelo): desfaz esta resposta (mesma transação) e deixa a retentativa resolver.
          throw new ConflictError('O lote já foi atendido, em parte, por outra execução', {
            context: { clientId },
          });
        }
        return created;
      });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      // Outra execução respondeu este lote primeiro (a mensagem só aceita uma resposta).
      const existing = await this.deps.messages.findReplyTo(clientId, last.id);
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
    this.deps.logger.info(
      {
        clientId,
        conversationId: conversation.id,
        messageId: last.id,
        replyId: reply.id,
        batchSize: batch.length,
        inputChars: userMessage.length,
        replyChars: reply.content.length,
        historyTurns: history.length,
        isFallback: reply.isFallback,
        hasMorePending,
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

  /** Há mensagem do contato esperando resposta? (Usado ao tratar um job que falhou sem handler.) */
  async hasPendingMessages(clientId: ClientId, rawContactRef: string): Promise<boolean> {
    const contactRef = contactRefSchema.parse(rawContactRef);
    const conversation = await this.deps.conversations.findByContact(clientId, contactRef);
    if (conversation === null) return false;
    const pending = await this.deps.messages.listPending(clientId, conversation.id, 1);
    return pending.length > 0;
  }

  async listConversations(clientId: ClientId, options?: ListOptions): Promise<Page<Conversation>> {
    await this.deps.clients.findById(clientId);
    return this.deps.conversations.list(clientId, options);
  }

  async listMessages(
    clientId: ClientId,
    conversationId: string,
    options?: ListOptions,
  ): Promise<Page<Message>> {
    await this.deps.clients.findById(clientId);
    // Conversa de outro cliente se comporta como inexistente (NotFoundError).
    await this.deps.conversations.findById(clientId, conversationId);
    return this.deps.messages.listByConversation(clientId, conversationId, options);
  }

  /**
   * Passos 1 e 2: idempotência e gravação da mensagem do contato. Devolve a resposta já
   * gravada (duplicata) ou a mensagem do contato que ainda precisa de resposta.
   */
  private async acceptMessage(
    clientId: ClientId,
    input: InboundMessage,
  ): Promise<
    | { readonly kind: 'done'; readonly result: AttendanceResult }
    | { readonly kind: 'respond'; readonly message: Message }
  > {
    const { contactRef, text, externalId } = input;

    if (externalId !== undefined) {
      const state = await this.inspectExisting(clientId, contactRef, externalId);
      const settled = this.settle(clientId, state);
      if (settled !== undefined) return settled;
    }

    try {
      // Transação curta: só conversa e mensagem do contato. Nada de chamada externa aqui.
      const message = await this.deps.unitOfWork.run(async (tx) => {
        const conversation = await tx.conversations.findOrCreateByContact(clientId, contactRef);
        return tx.messages.create(clientId, {
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
      const state = await this.inspectExisting(clientId, contactRef, externalId);
      if (state.kind === 'none') throw error;
      const settled = this.settle(clientId, state);
      if (settled !== undefined) return settled;
      throw this.inFlightError(clientId);
    }
  }

  /**
   * Grava a mensagem do contato (idempotente por `externalId`) e diz em que pé ela está:
   * recém-gravada, já gravada e pendente, ou já respondida.
   */
  private async storeInbound(
    clientId: ClientId,
    input: InboundMessage,
  ): Promise<{ readonly message: Message; readonly status: AcceptedMessage['status'] }> {
    const { contactRef, text, externalId } = input;

    if (externalId !== undefined) {
      const existing = await this.inspectAccepted(clientId, contactRef, externalId);
      if (existing !== null) return existing;
    }

    try {
      // Transação curta: só conversa e mensagem do contato. Nada de chamada externa aqui.
      const message = await this.deps.unitOfWork.run(async (tx) => {
        const conversation = await tx.conversations.findOrCreateByContact(clientId, contactRef);
        return tx.messages.create(clientId, {
          conversationId: conversation.id,
          role: 'USER',
          content: text,
          ...(externalId === undefined ? {} : { externalId }),
        });
      });
      return { message, status: 'accepted' };
    } catch (error) {
      if (!(error instanceof ConflictError) || externalId === undefined) throw error;
      // Corrida: outro pedido gravou o mesmo externalId entre a checagem e a gravação.
      const existing = await this.inspectAccepted(clientId, contactRef, externalId);
      if (existing === null) throw error;
      return existing;
    }
  }

  private async inspectAccepted(
    clientId: ClientId,
    contactRef: string,
    externalId: string,
  ): Promise<{ readonly message: Message; readonly status: 'pending' | 'answered' } | null> {
    const message = await this.deps.messages.findByExternalId(clientId, externalId);
    if (message === null) return null;

    const conversation = await this.deps.conversations.findById(clientId, message.conversationId);
    if (conversation.contactRef !== contactRef) {
      // O mesmo id de canal chegando para outro contato é erro de quem chama, não duplicata.
      throw new ConflictError('externalId já usado em outra conversa', { context: { clientId } });
    }
    const answered =
      message.answeredById !== null ||
      (await this.deps.messages.findReplyTo(clientId, message.id)) !== null;
    return { message, status: answered ? 'answered' : 'pending' };
  }

  /** A última mensagem da conversa, se for uma resposta ainda não enviada. */
  private async findUnsentTail(
    clientId: ClientId,
    conversationId: string,
  ): Promise<Message | null> {
    const [last] = await this.deps.messages.listRecent(clientId, conversationId, 1);
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

  private resendResponse(
    conversationId: string,
    reply: Message,
    hasMorePending: boolean,
  ): PendingResponse {
    this.deps.logger.info(
      { clientId: reply.clientId, conversationId, replyId: reply.id },
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
    clientId: ClientId,
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
        throw this.inFlightError(clientId);
      case 'stale':
        // A mensagem foi gravada mas ficou sem resposta (queda no meio): completa o fluxo.
        this.deps.logger.info(
          { clientId, messageId: state.message.id },
          'retomando mensagem sem resposta',
        );
        return { kind: 'respond', message: state.message };
    }
  }

  private inFlightError(clientId: ClientId): ConflictError {
    return new ConflictError('Esta mensagem já está sendo processada', {
      context: { clientId },
    });
  }

  private async inspectExisting(
    clientId: ClientId,
    contactRef: string,
    externalId: string,
  ): Promise<ExistingState> {
    const message = await this.deps.messages.findByExternalId(clientId, externalId);
    if (message === null) return { kind: 'none' };

    const conversation = await this.deps.conversations.findById(clientId, message.conversationId);
    if (conversation.contactRef !== contactRef) {
      // O mesmo id de canal chegando para outro contato é erro de quem chama, não duplicata.
      throw new ConflictError('externalId já usado em outra conversa', { context: { clientId } });
    }

    const reply = await this.deps.messages.findReplyTo(clientId, message.id);
    if (reply !== null) return { kind: 'replied', message, reply };

    const ageMs = this.now().getTime() - message.createdAt.getTime();
    return ageMs < this.deps.options.inFlightTimeoutMs
      ? { kind: 'in-flight' }
      : { kind: 'stale', message };
  }

  /** Passos 3 a 6: histórico, chamada ao LLM (com prazo), gravação da resposta ou do fallback. */
  private async respond(client: Client, message: Message): Promise<AttendanceResult> {
    const clientId = client.id;
    const startedAt = performance.now();

    const history = await this.loadHistory(clientId, message);
    const input: LlmGenerateInput = {
      // A persona é a única coisa que vai no systemPrompt; o texto do contato vai como `user`.
      systemPrompt: buildSystemPrompt(client),
      history,
      userMessage: message.content,
    };
    const outcome = await this.callProvider(
      clientId,
      {
        conversationId: message.conversationId,
        messageId: message.id,
        inputChars: message.content.length,
      },
      input,
    );

    const replyText = outcome.ok ? outcome.text : ATTENDANCE_FALLBACK_TEXT;
    if (!outcome.ok) this.recordFallback();

    let reply: Message;
    try {
      reply = await this.deps.messages.create(clientId, {
        conversationId: message.conversationId,
        role: 'ASSISTANT',
        content: replyText,
        isFallback: !outcome.ok,
        replyToId: message.id,
        // A resposta nunca fica antes da pergunta, mesmo no mesmo milissegundo.
        createdAt: new Date(Math.max(this.now().getTime(), message.createdAt.getTime() + 1)),
      });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      // Outra retentativa respondeu primeiro (a mensagem do contato só aceita uma resposta).
      const existing = await this.deps.messages.findReplyTo(clientId, message.id);
      if (existing === null) throw error;
      return toResult(message, existing, true);
    }

    this.deps.logger.info(
      {
        clientId,
        conversationId: message.conversationId,
        messageId: message.id,
        replyId: reply.id,
        inputChars: message.content.length,
        replyChars: reply.content.length,
        historyTurns: history.length,
        isFallback: reply.isFallback,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'mensagem atendida',
    );
    return toResult(message, reply, false);
  }

  private async loadHistory(clientId: ClientId, current: Message): Promise<readonly LlmTurn[]> {
    // Consulta já "anterior a esta mensagem": vale também ao retomar uma mensagem antiga, mesmo
    // com muitas mais novas na conversa (spec 011).
    const before = await this.deps.messages.listBefore(
      clientId,
      current.conversationId,
      current.id,
      this.historyLimit,
    );

    // Teto de caracteres: corta as mais antigas, mantém as mais recentes.
    const kept: Message[] = [];
    let total = 0;
    for (const candidate of before.toReversed()) {
      total += candidate.content.length;
      if (total > this.historyMaxChars) break;
      kept.push(candidate);
    }
    return kept.reverse().map((candidate) => ({
      role: candidate.role === 'USER' ? 'user' : 'assistant',
      content: candidate.content,
    }));
  }

  /**
   * Chama o provedor com prazo. Falha, prazo estourado ou resposta inutilizável (vazia ou
   * maior que o limite; nunca truncada em silêncio) viram `ok: false`, o que leva ao fallback.
   * O log e a métrica só têm ids, tamanhos e resultado.
   */
  private async callProvider(
    clientId: ClientId,
    subject: LlmSubject,
    input: LlmGenerateInput,
  ): Promise<LlmOutcome> {
    const provider = this.deps.llm.name;
    const startedAt = performance.now();
    let result: LlmRequestResult = 'error';
    let reason = 'provider_error';
    let cause: Error | undefined;
    let text: string | undefined;

    try {
      const outcome = await withTimeout(
        this.deps.llm.generate(input),
        this.deps.options.llmTimeoutMs,
        'llm',
      );
      if (!outcome.ok) {
        cause = outcome.error;
      } else if (outcome.value.text.trim().length === 0) {
        reason = 'empty_reply';
      } else if (outcome.value.text.length > MESSAGE_CONTENT_MAX_LENGTH) {
        reason = 'reply_too_long';
      } else if (outcome.value.text.includes('\u0000')) {
        // O Postgres não aceita NUL em texto: resposta inutilizável (o texto nunca vai ao log).
        reason = 'invalid_reply';
      } else {
        result = 'ok';
        text = outcome.value.text;
      }
    } catch (error) {
      if (error instanceof TimeoutError) {
        result = 'timeout';
        reason = 'timeout';
        cause = error;
      } else {
        // O provedor violou o contrato (lançou em vez de devolver Result): só o tipo vai ao log.
        reason = 'provider_threw';
        cause = new ExternalServiceError('O provedor de LLM lançou uma exceção', {
          context: { errorName: error instanceof Error ? error.name : typeof error },
        });
      }
    }

    const durationSeconds = (performance.now() - startedAt) / 1000;
    this.observe({ provider, result, durationSeconds });

    if (result === 'ok' && text !== undefined) return { ok: true, text };

    this.deps.logger.warn(
      {
        clientId,
        conversationId: subject.conversationId,
        messageId: subject.messageId,
        provider,
        result,
        reason,
        inputChars: subject.inputChars,
        durationMs: Math.round(durationSeconds * 1000),
        ...(cause === undefined ? {} : { err: cause }),
      },
      'LLM sem resposta utilizável; respondendo com o texto padrão',
    );
    return { ok: false };
  }

  private observe(sample: Parameters<AttendanceMetrics['observeLlmRequest']>[0]): void {
    try {
      this.deps.metrics?.observeLlmRequest(sample);
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica do LLM');
    }
  }

  private recordFallback(): void {
    try {
      this.deps.metrics?.countAttendanceFallback();
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica de fallback');
    }
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

function toResult(message: Message, reply: Message, duplicate: boolean): AttendanceResult {
  return {
    conversationId: message.conversationId,
    messageId: message.id,
    reply: toReply(reply),
    duplicate,
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
