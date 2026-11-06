import {
  LLM_ERROR_TYPE,
  LLM_TOOL_RESULT_TURN_LIMIT,
  LLM_TOOL_RESULT_UNAVAILABLE,
  type LlmGenerateInput,
  type LlmGenerateOptions,
  type LlmProvider,
  type LlmReply,
  type LlmToolCall,
  type LlmToolOutput,
  type LlmToolSet,
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

/** Quanto do texto do contato o mock devolve no eco (para a resposta caber no limite). */
const ECHO_MAX_CHARS = 500;
/** Quanto da persona o mock cita na resposta. */
const PERSONA_PREVIEW_CHARS = 60;

/**
 * Roteiro de um turno com ferramentas (spec 028): `rounds` são as chamadas que o "modelo" pede em cada
 * rodada (várias na mesma rodada = chamadas paralelas, executadas em sequência) e `finalText` é a
 * resposta depois das ferramentas (pode usar os resultados). Só vale quando o turno oferece `tools`.
 */
export interface MockToolScript {
  readonly rounds: readonly (readonly LlmToolCall[])[];
  readonly finalText: string | ((outputs: readonly LlmToolOutput[]) => string);
  /** Depois das rodadas, o provedor falha (erro genérico): prova o que o servidor faz se o laço cai depois de gravar. */
  readonly failAfterRounds?: boolean;
}

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
  /** Nomes das ferramentas oferecidas em cada chamada (só se `recordCalls`); `undefined` = sem ferramentas. */
  readonly toolsOffered: (readonly string[] | undefined)[] = [];
  private readonly toolScripts: MockToolScript[] = [];

  private readonly recordCalls: boolean;
  private gate: Promise<void> | undefined;

  constructor(options: MockLlmProviderOptions = {}) {
    this.recordCalls = options.recordCalls ?? false;
  }

  /** Enfileira o roteiro do próximo turno com ferramentas (spec 028). Só para testes. */
  scriptTools(...scripts: MockToolScript[]): void {
    this.toolScripts.push(...scripts);
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
    if (this.recordCalls) {
      this.calls.push(input);
      this.toolsOffered.push(options.tools?.definitions.map((definition) => definition.name));
    }
    if (this.gate !== undefined) await this.gate;

    if (options.tools !== undefined && this.toolScripts.length > 0) {
      const script = this.toolScripts.shift();
      if (script !== undefined) return runToolScript(script, options.tools, options.signal);
    }

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
    return Result.ok({
      text: `[mock] Recebi: ${echo} (persona: "${persona}"; histórico: ${String(input.history.length)})${knowledgeSummary(input.systemPrompt)}${scheduleSummary(input.systemPrompt)}`,
    });
  }
}

/**
 * Executa um roteiro com as mesmas regras do laço do provedor real: o pedido ao modelo seguinte ao teto
 * não é feito, a chamada acima do teto recebe `limite_turno` sem executar e o prazo do turno (a `signal`)
 * para o laço.
 */
async function runToolScript(
  script: MockToolScript,
  tools: LlmToolSet,
  signal: AbortSignal | undefined,
): Promise<Result<LlmReply, ExternalServiceError>> {
  const outputs: LlmToolOutput[] = [];
  let modelCalls = 1;
  let toolCalls = 0;
  for (const round of script.rounds) {
    if (isAborted(signal)) return aborted();
    if (modelCalls >= tools.limits.maxModelCalls) {
      return Result.err(
        new ExternalServiceError('O mock passou do limite de rodadas de ferramenta', {
          context: { provider: 'mock', errorType: LLM_ERROR_TYPE.toolRoundCap, retryable: false },
        }),
      );
    }
    modelCalls += 1;
    for (const call of round) {
      if (isAborted(signal)) return aborted();
      toolCalls += 1;
      if (toolCalls > tools.limits.maxToolCalls) {
        outputs.push(LLM_TOOL_RESULT_TURN_LIMIT);
        continue;
      }
      try {
        outputs.push(await tools.execute(call));
      } catch {
        outputs.push(LLM_TOOL_RESULT_UNAVAILABLE);
      }
    }
  }
  if (isAborted(signal)) return aborted();
  if (script.failAfterRounds === true) {
    return Result.err(
      new ExternalServiceError('Falha simulada do provedor mock depois das ferramentas', {
        context: { provider: 'mock', retryable: true },
      }),
    );
  }
  const text = typeof script.finalText === 'string' ? script.finalText : script.finalText(outputs);
  return Result.ok({ text, toolRounds: script.rounds.length, toolCalls });
}

function aborted(): Result<never, ExternalServiceError> {
  return Result.err(
    new ExternalServiceError('Chamada ao provedor mock cancelada', {
      context: { provider: 'mock', errorType: LLM_ERROR_TYPE.timeout, retryable: false },
    }),
  );
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

/** O estado do `AbortSignal` muda fora do fluxo: função à parte para o TypeScript não o fixar. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
