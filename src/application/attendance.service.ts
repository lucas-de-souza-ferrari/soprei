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
} from '../domain/index.js';
import { MESSAGE_CONTENT_MAX_LENGTH } from '../domain/index.js';
import { ConflictError, ExternalServiceError, ForbiddenError } from '../shared/errors/index.js';
import { TimeoutError, withTimeout } from '../shared/utils/index.js';
import { type InboundMessage, inboundMessageSchema } from './attendance.schemas.js';
import type { LlmGenerateInput, LlmProvider, LlmTurn } from './llm-provider.js';

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
}

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
}

export interface AttendanceResult {
  readonly conversationId: string;
  /** Id da mensagem do contato. */
  readonly messageId: string;
  readonly reply: AttendanceReply;
  /** Verdadeiro quando o `externalId` já tinha sido atendido: devolve a resposta gravada. */
  readonly duplicate: boolean;
}

type ExistingState =
  | { readonly kind: 'none' }
  | { readonly kind: 'replied'; readonly message: Message; readonly reply: Message }
  | { readonly kind: 'in-flight' }
  | { readonly kind: 'stale'; readonly message: Message };

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
    const outcome = await this.callProvider(clientId, message, input);

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
    // Uma a mais que o limite: a mensagem atual, já gravada, também vem na lista.
    const recent = await this.deps.messages.listRecent(
      clientId,
      current.conversationId,
      this.historyLimit + 1,
    );
    const before = recent
      .filter((candidate) => isBefore(candidate, current))
      .slice(-this.historyLimit);

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
    message: Message,
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
        conversationId: message.conversationId,
        messageId: message.id,
        provider,
        result,
        reason,
        inputChars: message.content.length,
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

/** A mensagem `candidate` vem antes de `current` na ordem da conversa (`createdAt`, depois `id`). */
function isBefore(candidate: Message, current: Message): boolean {
  if (candidate.id === current.id) return false;
  const delta = candidate.createdAt.getTime() - current.createdAt.getTime();
  return delta < 0 || (delta === 0 && candidate.id < current.id);
}

function toResult(message: Message, reply: Message, duplicate: boolean): AttendanceResult {
  return {
    conversationId: message.conversationId,
    messageId: message.id,
    reply: { id: reply.id, text: reply.content, isFallback: reply.isFallback },
    duplicate,
  };
}
