import {
  LLM_ERROR_TYPE,
  type LlmGenerateInput,
  type LlmGenerateOptions,
  type LlmProvider,
  type LlmReply,
} from '../../../application/ports/llm-provider.js';
import { ATTENDANCE_STYLE_INSTRUCTION } from '../../../application/attendance/attendance.service.js';
import {
  KNOWLEDGE_BLOCK_CLOSE,
  KNOWLEDGE_BLOCK_OPEN,
  KNOWLEDGE_HEADER_MARKER,
} from '../../../application/attendance/knowledge-prompt.js';
import {
  SCHEDULE_BLOCK_CLOSE,
  SCHEDULE_BLOCK_OPEN,
  SCHEDULE_HEADER_MARKER,
} from '../../../application/attendance/schedule-prompt.js';
import { ExternalServiceError } from '../../../shared/errors/index.js';
import { Result } from '../../../shared/types/index.js';

/** Texto do contato com este marcador faz o mock devolver erro (`Result.err`). */
export const MOCK_FAIL_MARKER = '[[mock:fail]]';
/** Texto do contato com este marcador faz o mock nunca responder (para testar timeout). */
export const MOCK_HANG_MARKER = '[[mock:hang]]';
/** Texto do contato com este marcador faz o mock responder com texto vazio (resposta inválida). */
export const MOCK_EMPTY_MARKER = '[[mock:empty]]';
/** Texto do contato com este marcador faz o mock responder com texto grande demais. */
export const MOCK_HUGE_MARKER = '[[mock:huge]]';

/**
 * Spec 030: com `allowHandoff`, o mock pede atendimento humano quando o texto do contato (minúsculas,
 * sem acento) contém um destes trechos. Determinístico, para testes e demonstração.
 */
export const MOCK_HANDOFF_TRIGGERS = ['atendente', 'humano', 'falar com uma pessoa'] as const;
/** Sufixo da resposta do mock quando ele pede atendimento humano. */
export const MOCK_HANDOFF_SUFFIX = ' (atendimento humano solicitado)';

/** Quanto do texto do contato o mock devolve no eco (para a resposta caber no limite). */
const ECHO_MAX_CHARS = 500;
/** Quanto da persona o mock cita na resposta. */
const PERSONA_PREVIEW_CHARS = 60;

export interface MockLlmProviderOptions {
  /**
   * Guarda as entradas recebidas em `calls`, para os testes inspecionarem. Desligado por
   * padrão: num servidor de verdade isso seria memória crescendo com dado pessoal dentro.
   */
  readonly recordCalls?: boolean;
}

/**
 * Provedor de mentira: resposta determinística, sem rede, para testes e desenvolvimento
 * offline. A resposta ecoa o texto recebido, cita o começo da persona e quantos turnos de
 * histórico chegaram, para os testes verem o que o serviço enviou.
 *
 * Modos acionáveis pela entrada: marcadores no texto do contato (`MOCK_*_MARKER`) e `hold()`,
 * que segura as chamadas até a liberação (para provar o que acontece "durante" a chamada).
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  /** Entradas recebidas, na ordem (só se `recordCalls`). Somente para testes. */
  readonly calls: LlmGenerateInput[] = [];

  private readonly recordCalls: boolean;
  private gate: Promise<void> | undefined;

  constructor(options: MockLlmProviderOptions = {}) {
    this.recordCalls = options.recordCalls ?? false;
  }

  /** Segura toda chamada nova até a função devolvida ser chamada. Só para testes. */
  hold(): () => void {
    let release: () => void = () => undefined;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      release();
      this.gate = undefined;
    };
  }

  async generate(
    input: LlmGenerateInput,
    options: LlmGenerateOptions = {},
  ): Promise<Result<LlmReply, ExternalServiceError>> {
    if (this.recordCalls) this.calls.push(input);
    if (this.gate !== undefined) await this.gate;

    const text = input.userMessage;
    if (text.includes(MOCK_HANG_MARKER)) return waitForAbort(options.signal);
    if (text.includes(MOCK_FAIL_MARKER)) {
      // Nunca ecoa o texto do contato no erro (contrato do LlmProvider).
      return Result.err(new ExternalServiceError('Falha simulada do provedor mock'));
    }
    if (text.includes(MOCK_EMPTY_MARKER)) return Result.ok({ text: '' });
    if (text.includes(MOCK_HUGE_MARKER)) return Result.ok({ text: 'x'.repeat(5000) });

    // Cita só o começo da persona: a instrução fixa de estilo (spec 014) vem depois dela e não entra.
    // Com o bloco de conhecimento (spec 026) a instrução de estilo deixa de ser o fim do prompt:
    // corta no primeiro "\n\n<estilo>".
    const marker = `\n\n${ATTENDANCE_STYLE_INSTRUCTION}`;
    const styleAt = input.systemPrompt.indexOf(marker);
    const personaText = styleAt === -1 ? input.systemPrompt : input.systemPrompt.slice(0, styleAt);
    const persona = personaText.slice(0, PERSONA_PREVIEW_CHARS);
    const echo = text.slice(0, ECHO_MAX_CHARS);
    const handoff = input.allowHandoff === true && asksForHuman(text);
    return Result.ok({
      text: `[mock] Recebi: ${echo} (persona: "${persona}"; histórico: ${String(input.history.length)})${knowledgeSummary(input.systemPrompt)}${scheduleSummary(input.systemPrompt)}${handoff ? MOCK_HANDOFF_SUFFIX : ''}`,
      ...(handoff ? { handoff: { reason: 'CONTACT_REQUESTED' as const } } : {}),
    });
  }
}

function asksForHuman(text: string): boolean {
  const normalized = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return MOCK_HANDOFF_TRIGGERS.some((trigger) => normalized.includes(trigger));
}

/**
 * Quando o `systemPrompt` traz o bloco de conhecimento (spec 026), conta as linhas `[Documento]` e
 * `[Produto]` dentro dos delimitadores, para a demonstração e os testes determinísticos. Sem bloco,
 * nada é acrescentado.
 */
function knowledgeSummary(systemPrompt: string): string {
  if (!systemPrompt.includes(KNOWLEDGE_HEADER_MARKER)) return '';
  const open = systemPrompt.indexOf(KNOWLEDGE_BLOCK_OPEN);
  const close = systemPrompt.indexOf(KNOWLEDGE_BLOCK_CLOSE);
  const block = open === -1 || close < open ? '' : systemPrompt.slice(open, close);
  const passages = block.match(/^\[Documento\] /gm)?.length ?? 0;
  const products = block.match(/^\[Produto\] /gm)?.length ?? 0;
  return ` (conhecimento: ${String(passages)} trechos, ${String(products)} produtos)`;
}

/**
 * Quando o `systemPrompt` traz o bloco de agenda (spec 027, E3), conta as linhas `[Serviço]` dentro dos
 * delimitadores, para a demonstração e os testes determinísticos. Sem bloco, nada é acrescentado.
 */
function scheduleSummary(systemPrompt: string): string {
  if (!systemPrompt.includes(SCHEDULE_HEADER_MARKER)) return '';
  const open = systemPrompt.indexOf(SCHEDULE_BLOCK_OPEN);
  const close = systemPrompt.indexOf(SCHEDULE_BLOCK_CLOSE);
  const block = open === -1 || close < open ? '' : systemPrompt.slice(open, close);
  const services = block.match(/^\[Serviço\] /gm)?.length ?? 0;
  return ` (agenda: ${String(services)} serviços)`;
}

/** Nunca responde, mas termina (como um provedor de verdade) quando a chamada é cancelada. */
function waitForAbort(
  signal: AbortSignal | undefined,
): Promise<Result<LlmReply, ExternalServiceError>> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    const cancelled = (): void => {
      resolve(
        Result.err(
          new ExternalServiceError('Chamada ao provedor mock cancelada', {
            context: { provider: 'mock', errorType: LLM_ERROR_TYPE.timeout, retryable: false },
          }),
        ),
      );
    };
    if (signal.aborted) cancelled();
    else signal.addEventListener('abort', cancelled, { once: true });
  });
}
