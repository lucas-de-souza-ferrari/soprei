// Tipos, constantes e contratos do atendimento (spec 035, E4: separados de attendance.service.ts).
import type {
  AttendanceUnitOfWork,
  CompanyRepository,
  Conversation,
  ConversationRepository,
  Message,
  MessageRepository,
  HandoffReason,
  NotificationCreateResult,
  Page,
} from '../../domain/index.js';
import { type QuotaBlockReason } from '../../domain/index.js';
import { type LlmProvider, type LlmUsage } from '../ports/llm-provider.js';
import type { EntitlementReader } from '../ports/entitlement-reader.js';
import type { KnowledgeRetriever } from '../ports/knowledge-retriever.js';
import type { UsageMeter } from '../ports/usage-meter.js';
import type { ScheduleAvailabilityReader } from '../ports/schedule-availability-reader.js';
import type { ContactScheduling } from '../schedule/contact-scheduling.service.js';
import { type KnowledgeSource } from './knowledge-prompt.js';
import { type ScheduleToolLabel, type ScheduleToolResult } from './schedule-tools.js';

/** Quantas mensagens anteriores da conversa vão ao modelo. */
export const ATTENDANCE_HISTORY_LIMIT = 20;
/** Teto de caracteres do histórico enviado ao modelo; o corte mantém as mais recentes. */
export const ATTENDANCE_HISTORY_MAX_CHARS = 12_000;
/** Texto enviado ao contato quando o modelo falha, estoura o prazo ou responde algo inutilizável. */
export const ATTENDANCE_FALLBACK_TEXT =
  'Desculpe, estou com dificuldades no momento. Tente novamente em instantes.';

/**
 * `ok`; `error` (falha ou resposta inutilizável); `timeout` (prazo); `refusal` (o modelo recusou);
 * `truncated` (resposta cortada por limite de tokens). Conjunto fixo: vai a label de métrica.
 */
export type LlmRequestResult = 'ok' | 'error' | 'timeout' | 'refusal' | 'truncated';

export type LlmTokenType = 'input' | 'output' | 'cache_read';

/** Métricas do atendimento (o registry fica na infraestrutura; sem `companyId` em label). */
export interface AttendanceMetrics {
  observeLlmRequest(sample: {
    readonly provider: string;
    readonly result: LlmRequestResult;
    readonly durationSeconds: number;
  }): void;
  countAttendanceFallback(): void;
  /** Tokens gastos por uma chamada que respondeu (spec 014). Só números; sem `companyId` em label. */
  observeLlmTokens?(sample: {
    readonly provider: string;
    readonly type: LlmTokenType;
    readonly tokens: number;
  }): void;
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
  /** Um turno não respondeu porque a IA está pausada no contato (spec 039). Sem labels. */
  countPausedTurn?(): void;
  /** A IA foi reativada numa conversa pelo painel (spec 039). Sem labels. */
  countAiResume?(): void;
  /** Uma recuperação da base de conhecimento terminou (spec 026). Conjunto fixo; nunca a consulta. */
  countKnowledgeRetrieval?(result: 'hit' | 'empty' | 'skipped' | 'error' | 'timeout'): void;
  /** Uma consulta de horários livres para o prompt terminou (spec 027, E3). Conjunto fixo. */
  countScheduleContext?(result: 'hit' | 'empty' | 'skipped' | 'error' | 'timeout'): void;
  /** O modelo pediu atendimento humano (spec 038), antes da deduplicação. Conjunto fixo de motivos. */
  countHandoff?(reason: HandoffReason): void;
  /** O que aconteceu com a notificação do pedido (spec 038): `created`, `deduplicated` ou `capped`. */
  countNotificationCreated?(result: NotificationCreateResult): void;
  /** Uma chamada de ferramenta da agenda terminou (spec 028). Conjuntos fixos; nunca argumento nem resultado. */
  countScheduleToolCall?(tool: ScheduleToolLabel, result: ScheduleToolResult): void;
  /** Um turno com ferramentas terminou (spec 028). Conjunto fixo. */
  countScheduleToolTurn?(result: ScheduleToolTurnResult): void;
  /** Rodadas de ferramenta de um turno com ferramentas oferecidas (spec 028). */
  observeScheduleToolRounds?(rounds: number): void;
  /** A IA deixou de responder por cota esgotada ou assinatura inativa (spec 031). Conjunto fixo. */
  countQuotaBlock?(reason: QuotaBlockReason): void;
  /** A medição de uso falhou e a resposta seguiu (spec 031). Contador sem labels. */
  countUsageMeterError?(): void;
  /** A leitura das cotas falhou e o atendimento seguiu sem limite (fail-open, spec 031). Sem labels. */
  countEntitlementError?(): void;
}

/**
 * `used` (alguma ferramenta rodou), `round_cap` (passou do teto de rodadas), `provider_error`,
 * `deterministic_summary` (o servidor montou o resumo do que gravou), `guard_replaced` (a guarda trocou uma
 * afirmação sem escrita confirmada) e `disabled_fail_safe` (cotas indisponíveis: turno só de leitura).
 */
export type ScheduleToolTurnResult =
  | 'used'
  | 'round_cap'
  | 'provider_error'
  | 'deterministic_summary'
  | 'guard_replaced'
  | 'disabled_fail_safe';

export type BatchResult = 'answered' | 'empty' | 'capped';

/**
 * O que o serviço precisa do logger. O do Pino serve; o contexto da requisição (`requestId`,
 * `companyId`) entra pelo `mixin` do logger. **Nunca** passe texto de mensagem nem persona.
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
  /** Prazo da recuperação da base de conhecimento (spec 026); padrão 1.500 ms. */
  readonly knowledgeTimeoutMs?: number;
  /** Prazo da leitura da agenda (spec 027, E3); padrão 1.500 ms. */
  readonly scheduleTimeoutMs?: number;
  /**
   * Chave global das ferramentas de agenda da IA (`SCHEDULE_AI_ENABLED`, spec 028); padrão desligada.
   * Desligada, o pedido ao provedor é idêntico ao da spec 027.
   */
  readonly scheduleAiEnabled?: boolean;
  /**
   * Spec 038: oferece ao modelo a ferramenta de pedir atendimento humano em todo turno. Desligado por padrão
   * (o pedido ao provedor fica o de antes); o `index.ts` liga.
   */
  readonly handoffEnabled?: boolean;
  /** Teto de notificações abertas por empresa (spec 038); padrão `NOTIFICATION_MAX_OPEN`. */
  readonly notificationMaxOpen?: number;
  /** Prazo total do laço de ferramentas (spec 028); padrão `SCHEDULE_AI_TURN_TIMEOUT_MS`. */
  readonly scheduleAiTurnTimeoutMs?: number;
}

/** De onde veio a mensagem: o canal real ou o simulador do painel (spec 028). */
export type AttendanceOrigin = 'channel' | 'simulator';

export interface ContactSubject {
  /** Do job do canal ou do corpo do simulador; **nunca** de argumento de ferramenta. */
  readonly contactRef: string;
  readonly origin: AttendanceOrigin;
}

/** Uma página do histórico mais a conversa a que ela pertence (o painel abre o histórico pelo id). */
export interface ConversationHistory extends Page<Message> {
  readonly conversation: Conversation;
}

export interface AttendanceDeps {
  readonly companies: CompanyRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  /** Transação do banco: só para gravar conversa e mensagem; nunca envolve a chamada ao LLM. */
  readonly unitOfWork: AttendanceUnitOfWork;
  readonly llm: LlmProvider;
  readonly logger: AttendanceLogger;
  readonly metrics?: AttendanceMetrics;
  readonly options: AttendanceOptions;
  /** Base de conhecimento da empresa (spec 026). Sem isto, o atendimento é o de sempre. */
  readonly knowledge?: KnowledgeRetriever;
  /** Horários livres da empresa para o prompt (spec 027, E3). Sem isto, o atendimento é o de sempre. */
  readonly schedule?: ScheduleAvailabilityReader;
  /**
   * Escritas da IA na agenda (spec 028, E2 e E3): solicitar, cancelar e remarcar. Sem isto, ou com a
   * opção da empresa desligada, as ferramentas são só de consulta.
   */
  readonly scheduling?: ContactScheduling;
  /**
   * Cotas e módulos da empresa (spec 031). Só existe com `BILLING_ENABLED`; sem isto o atendimento é o de
   * sempre, sem nenhuma leitura extra.
   */
  readonly entitlements?: EntitlementReader;
  /** Medição de tokens por assinatura (spec 031). Só existe com `BILLING_ENABLED`. */
  readonly usage?: Pick<UsageMeter, 'record'>;
}

/** Um bloco do `systemPrompt` (conhecimento ou agenda) com as fontes e os números que ele traz. */
export interface PromptPart {
  readonly block: string;
  readonly sources: readonly KnowledgeSource[];
  readonly stats: object;
  /** A agenda tem serviço ativo e foi lida: o turno pode oferecer as ferramentas (spec 028). */
  readonly toolsEligible?: boolean;
  /** Opções da empresa para a IA (spec 028); só existe quando a agenda foi lida. */
  readonly ai?: { readonly bookingEnabled: boolean; readonly autoConfirm: boolean };
}

export const EMPTY_PART: PromptPart = { block: '', sources: [], stats: {} };

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
  /** De onde veio a resposta (spec 026): só rótulos, nunca conteúdo. Vazio em resposta repetida. */
  readonly sources: readonly KnowledgeSource[];
}

/**
 * Faixa em que o instante de recebimento informado pelo canal é aceito (spec 034). Fora dela (job
 * muito antigo, relógio errado ou job adulterado) a mensagem usa o relógio do banco.
 */
export const RECEIVED_AT_MAX_PAST_MS = 24 * 60 * 60 * 1000;
export const RECEIVED_AT_MAX_FUTURE_MS = 60 * 1000;

export interface AcceptInboundOptions {
  /**
   * Instante em que o webhook recebeu a mensagem (spec 034): vira o `createdAt` dela, para que a
   * ordem das mensagens do contato não dependa da ordem em que os jobs são processados. Ausente ou
   * implausível: vale o relógio do banco.
   */
  readonly receivedAt?: Date;
}

/** Eco de uma mensagem que a equipe enviou pelo aplicativo (spec 039). */
export interface HumanEchoInput {
  /** O contato a quem a equipe escreveu (o `to` do eco). */
  readonly contactRef: string;
  /** Id do eco no canal (idempotência). */
  readonly externalId: string;
  /** Texto enviado; ausente = mídia (vira o texto fixo do servidor, a mídia nunca é guardada). */
  readonly text?: string | undefined;
}

/** `recorded`: gravado e IA pausada; `duplicate`: já gravado; `own`: eco de resposta nossa (ignorado). */
export type HumanEchoResult =
  | { readonly result: 'recorded'; readonly conversationId: string }
  | { readonly result: 'duplicate' | 'own' };

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
 * - `paused`: a IA está pausada no contato (spec 039): nada foi gerado nem deve ser enviado; o que estava
 *   pendente passou a ser da equipe.
 * - `blocked`: cota esgotada ou assinatura inativa (spec 031): o provedor NÃO foi chamado e nada deve ser
 *   enviado ao contato; as mensagens seguem pendentes.
 */
export interface PendingResponse {
  readonly outcome: 'answered' | 'resend' | 'empty' | 'blocked' | 'paused';
  readonly conversationId: string | null;
  readonly reply: AttendanceReply | null;
  /** Quantas mensagens do contato a resposta juntou (0 em `resend` e `empty`). */
  readonly batchSize: number;
  /** Sobraram mensagens pendentes (excederam o limite do lote ou chegaram depois): há outro turno. */
  readonly hasMorePending: boolean;
}

export interface RespondToPendingOptions {
  /**
   * Revisão da 035 (B1): o reenvio da resposta anterior já falhou de vez neste contato; o turno não a
   * tenta de novo (fica só gravada, com aviso e métrica) e responde as pendentes.
   */
  readonly skipUnsent?: boolean;
}

export type ExistingState =
  | { readonly kind: 'none' }
  | { readonly kind: 'replied'; readonly message: Message; readonly reply: Message }
  | { readonly kind: 'in-flight' }
  | { readonly kind: 'stale'; readonly message: Message };

/** O que a chamada ao LLM precisa saber da(s) mensagem(ns) atendida(s), para log e métrica. */
export interface LlmSubject {
  readonly conversationId: string;
  /** Id da mensagem (a última do lote, quando há mais de uma). */
  readonly messageId: string;
  readonly inputChars: number;
}

export type LlmOutcome =
  | {
      readonly ok: true;
      readonly text: string;
      readonly usage: LlmUsage | undefined;
      readonly toolRounds: number | undefined;
      readonly toolCalls: number | undefined;
    }
  | { readonly ok: false };
