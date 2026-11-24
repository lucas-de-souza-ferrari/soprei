// Chamada ao modelo, histórico, cotas e medição do atendimento (spec 035, E4: separados de
// attendance.service.ts, sem mudar a lógica).
import type { Company, CompanyEntitlements, CompanyId, Message } from '../../domain/index.js';
import {
  MESSAGE_CONTENT_MAX_LENGTH,
  SCHEDULE_AI_TURN_TIMEOUT_MS,
  type QuotaBlockReason,
  quotaBlockReason,
} from '../../domain/index.js';
import { ExternalServiceError } from '../../shared/errors/index.js';
import { TimeoutError, withTimeout } from '../../shared/utils/index.js';
import {
  LLM_ERROR_TYPE,
  type LlmGenerateInput,
  type LlmTurn,
  type LlmUsage,
} from '../ports/llm-provider.js';
import { type ScheduleToolSet } from './schedule-tools.js';
import { composeToolSet, type HandoffRecorder } from './handoff-tool.js';
import { finalizeScheduleReply, summaryReply } from './schedule-guard.js';
import {
  ATTENDANCE_FALLBACK_TEXT,
  type AttendanceDeps,
  type AttendanceMetrics,
  type LlmOutcome,
  type LlmRequestResult,
  type LlmSubject,
  type ScheduleToolTurnResult,
} from './attendance.types.js';

/**
 * A parte do turno que fala com o provedor de LLM: histórico enviado ao modelo, a chamada com prazo, o
 * texto final (guarda da agenda), cotas e módulos (spec 031), medição de tokens e as métricas do modelo.
 * Só o `AttendanceService` a usa.
 */
export class AttendanceLlm {
  constructor(
    private readonly deps: AttendanceDeps,
    private readonly historyLimit: number,
    private readonly historyMaxChars: number,
  ) {}

  async loadHistory(companyId: CompanyId, current: Message): Promise<readonly LlmTurn[]> {
    // Consulta já "anterior a esta mensagem": vale também ao retomar uma mensagem antiga, mesmo
    // com muitas mais novas na conversa (spec 011).
    const before = await this.deps.messages.listBefore(
      companyId,
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
    // Spec 039: a mensagem da equipe pelo celular (`HUMAN`) é o lado da empresa: turno do assistente.
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
  async callProvider(
    companyId: CompanyId,
    subject: LlmSubject,
    input: LlmGenerateInput,
    tools?: ScheduleToolSet,
    handoff?: HandoffRecorder,
  ): Promise<LlmOutcome> {
    // Spec 038: a ferramenta de humano entra no mesmo conjunto das da agenda (028).
    const toolSet = handoff === undefined ? tools?.toolSet : composeToolSet(handoff, tools);
    const provider = this.deps.llm.name;
    const startedAt = performance.now();
    let result: LlmRequestResult = 'error';
    let reason = 'provider_error';
    let cause: Error | undefined;
    let text: string | undefined;
    let usage: LlmUsage | undefined;
    let toolRounds: number | undefined;
    let toolCalls: number | undefined;
    // Estourou o prazo (ou terminou): aborta, para o provedor não seguir rodando e gastando cota.
    const controller = new AbortController();

    try {
      const outcome = await withTimeout(
        this.deps.llm.generate(input, {
          signal: controller.signal,
          ...(toolSet === undefined ? {} : { tools: toolSet }),
        }),
        // Com ferramentas da agenda, o prazo é o do laço inteiro; cada chamada ao modelo segue com o seu. Só
        // com a de humano (spec 038) são no máximo duas chamadas: o dobro do prazo de uma.
        tools !== undefined
          ? (this.deps.options.scheduleAiTurnTimeoutMs ?? SCHEDULE_AI_TURN_TIMEOUT_MS)
          : toolSet === undefined
            ? this.deps.options.llmTimeoutMs
            : this.deps.options.llmTimeoutMs * 2,
        'llm',
      );
      if (!outcome.ok) {
        cause = outcome.error;
        result = resultForProviderError(outcome.error);
        reason = result === 'error' ? 'provider_error' : result;
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
        usage = outcome.value.usage;
        toolRounds = outcome.value.toolRounds;
        toolCalls = outcome.value.toolCalls;
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
    } finally {
      controller.abort();
    }

    // Fecha o turno: nenhuma ferramenta nova roda e uma escrita que já estava no banco termina antes de se
    // decidir o texto (o servidor nunca abandona uma escrita no meio por prazo de aplicação).
    if (tools !== undefined) await tools.close();

    const durationSeconds = (performance.now() - startedAt) / 1000;
    this.observe({ provider, result, durationSeconds });
    if (tools !== undefined) this.recordToolTurn(result, cause, toolRounds ?? 0);

    if (result === 'ok' && text !== undefined) {
      this.recordTokens(provider, usage);
      await this.recordUsage(companyId, subject, usage);
      return { ok: true, text, usage, toolRounds, toolCalls };
    }

    this.deps.logger.warn(
      {
        companyId,
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

  /**
   * Texto final do turno (spec 028, decisão 7), **só com o que o servidor gravou**: (a) o laço falhou depois
   * de uma escrita confirmada -> o resumo determinístico (nunca o texto padrão); (b) sem escrita e a resposta
   * afirma ter marcado/cancelado -> o texto seguro; (c) escrita confirmada e a resposta sem a hora gravada ->
   * o resumo acrescentado. Sem ferramentas no turno o texto é o de sempre.
   */
  finalizeReply(
    outcome: LlmOutcome,
    tools: ScheduleToolSet | undefined,
  ): { readonly text: string; readonly isFallback: boolean } {
    const writes = tools?.writes() ?? [];
    if (!outcome.ok) {
      if (writes.length === 0) return { text: ATTENDANCE_FALLBACK_TEXT, isFallback: true };
      this.recordToolTurnResult('deterministic_summary');
      return { text: summaryReply(writes), isFallback: false };
    }
    // A guarda vale em todo turno com ferramentas (também no modo só de consulta, em que a IA não marca nada).
    if (tools === undefined) return { text: outcome.text, isFallback: false };
    const final = finalizeScheduleReply(outcome.text, writes, MESSAGE_CONTENT_MAX_LENGTH);
    if (final.kind !== 'as_is') this.recordToolTurnResult(final.kind);
    return { text: final.text, isFallback: false };
  }

  recordToolTurnResult(result: ScheduleToolTurnResult): void {
    try {
      this.deps.metrics?.countScheduleToolTurn?.(result);
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica das ferramentas de agenda');
    }
  }

  /** Métricas do turno com ferramentas (spec 028): conjuntos fixos, nenhum id nem texto. */
  recordToolTurn(result: LlmRequestResult, cause: Error | undefined, rounds: number): void {
    try {
      this.deps.metrics?.observeScheduleToolRounds?.(rounds);
      if (result === 'ok') {
        if (rounds > 0) this.deps.metrics?.countScheduleToolTurn?.('used');
        return;
      }
      const errorType =
        cause instanceof ExternalServiceError ? cause.context['errorType'] : undefined;
      this.deps.metrics?.countScheduleToolTurn?.(
        errorType === LLM_ERROR_TYPE.toolRoundCap ? 'round_cap' : 'provider_error',
      );
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica das ferramentas de agenda');
    }
  }

  observe(sample: Parameters<AttendanceMetrics['observeLlmRequest']>[0]): void {
    try {
      this.deps.metrics?.observeLlmRequest(sample);
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica do LLM');
    }
  }

  /**
   * Cotas e módulos do turno (spec 031): **uma leitura por turno**, no início. Sem leitor (cobrança
   * desligada) devolve `undefined` sem custo algum. **Fail-open**: falha da leitura atende sem limite
   * (não se bloqueia o contato por falha nossa; o custo fica limitado pelo teto de turno), com `warn`
   * só de ids e a métrica de erro.
   */
  async readEntitlements(
    company: Company,
    subject: { readonly conversationId: string; readonly messageId: string },
  ): Promise<CompanyEntitlements | undefined> {
    const reader = this.deps.entitlements;
    if (reader === undefined) return undefined;
    try {
      return await reader.forCompany(company.id);
    } catch (error) {
      try {
        this.deps.metrics?.countEntitlementError?.();
      } catch (err) {
        this.deps.logger.warn({ err }, 'falha ao registrar métrica de cota');
      }
      this.deps.logger.warn(
        {
          companyId: company.id,
          conversationId: subject.conversationId,
          messageId: subject.messageId,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'cotas da assinatura indisponíveis; atendendo sem limite',
      );
      return undefined;
    }
  }

  /** Por que a IA não responde agora (ou `null`); registra a métrica e o log (só ids e o motivo). */
  blockedBy(
    company: Company,
    subject: { readonly conversationId: string; readonly messageId: string },
    entitlements: CompanyEntitlements | undefined,
  ): QuotaBlockReason | null {
    if (entitlements === undefined) return null;
    const reason = quotaBlockReason(entitlements);
    if (reason === null) return null;
    try {
      this.deps.metrics?.countQuotaBlock?.(reason);
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica de cota');
    }
    this.deps.logger.info(
      {
        companyId: company.id,
        conversationId: subject.conversationId,
        messageId: subject.messageId,
        reason,
      },
      'IA em pausa por cota ou assinatura; nada enviado ao contato e as mensagens seguem pendentes',
    );
    return reason;
  }

  /**
   * Soma os tokens do turno (`inputTokens + outputTokens`, o turno inteiro com as rodadas de ferramenta) à
   * assinatura da empresa (spec 031). Resposta sem `usage` não conta. **Falha da medição nunca derruba a
   * resposta** (`warn` só de ids e `usage_meter_errors_total`).
   */
  async recordUsage(
    companyId: CompanyId,
    subject: LlmSubject,
    usage: LlmUsage | undefined,
  ): Promise<void> {
    const meter = this.deps.usage;
    if (meter === undefined || usage === undefined) return;
    const tokens = usage.inputTokens + usage.outputTokens;
    if (!(tokens > 0)) return;
    try {
      await meter.record(companyId, tokens);
    } catch (error) {
      try {
        this.deps.metrics?.countUsageMeterError?.();
      } catch (err) {
        this.deps.logger.warn({ err }, 'falha ao registrar métrica de medição');
      }
      this.deps.logger.warn(
        {
          companyId,
          conversationId: subject.conversationId,
          messageId: subject.messageId,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'falha ao medir o uso de tokens; a resposta segue',
      );
    }
  }

  recordTokens(provider: string, usage: LlmUsage | undefined): void {
    if (usage === undefined) return;
    try {
      const { inputTokens, outputTokens, cacheReadTokens } = usage;
      this.deps.metrics?.observeLlmTokens?.({ provider, type: 'input', tokens: inputTokens });
      this.deps.metrics?.observeLlmTokens?.({ provider, type: 'output', tokens: outputTokens });
      if (cacheReadTokens !== undefined) {
        this.deps.metrics?.observeLlmTokens?.({
          provider,
          type: 'cache_read',
          tokens: cacheReadTokens,
        });
      }
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica de tokens do LLM');
    }
  }

  recordFallback(): void {
    try {
      this.deps.metrics?.countAttendanceFallback();
    } catch (err) {
      this.deps.logger.warn({ err }, 'falha ao registrar métrica de fallback');
    }
  }
}

/** Traduz a categoria que o provedor marcou no erro em resultado de métrica (conjunto fixo). */
function resultForProviderError(error: ExternalServiceError): LlmRequestResult {
  switch (error.context['errorType']) {
    case LLM_ERROR_TYPE.timeout:
      return 'timeout';
    case LLM_ERROR_TYPE.refusal:
      return 'refusal';
    case LLM_ERROR_TYPE.maxTokens:
      return 'truncated';
    default:
      return 'error';
  }
}

/** Tokens do turno para o log (só números), quando o provedor os informou. */
export function usageFields(outcome: LlmOutcome): object {
  if (!outcome.ok || outcome.usage === undefined) return {};
  return {
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
    ...(outcome.usage.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: outcome.usage.cacheReadTokens }),
  };
}

/** Rodadas e chamadas de ferramenta do turno para o log (só números). */
export function toolFields(outcome: LlmOutcome): object {
  if (!outcome.ok || outcome.toolRounds === undefined) return {};
  return { toolRounds: outcome.toolRounds, toolCalls: outcome.toolCalls ?? 0 };
}
