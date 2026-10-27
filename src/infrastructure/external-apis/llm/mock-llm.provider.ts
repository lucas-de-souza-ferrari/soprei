import type {
  LlmGenerateInput,
  LlmProvider,
  LlmReply,
} from '../../../application/ports/llm-provider.js';
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

  async generate(input: LlmGenerateInput): Promise<Result<LlmReply, ExternalServiceError>> {
    if (this.recordCalls) this.calls.push(input);
    if (this.gate !== undefined) await this.gate;

    const text = input.userMessage;
    if (text.includes(MOCK_HANG_MARKER)) return new Promise(() => undefined);
    if (text.includes(MOCK_FAIL_MARKER)) {
      // Nunca ecoa o texto do contato no erro (contrato do LlmProvider).
      return Result.err(new ExternalServiceError('Falha simulada do provedor mock'));
    }
    if (text.includes(MOCK_EMPTY_MARKER)) return Result.ok({ text: '' });
    if (text.includes(MOCK_HUGE_MARKER)) return Result.ok({ text: 'x'.repeat(5000) });

    const persona = input.systemPrompt.slice(0, PERSONA_PREVIEW_CHARS);
    const echo = text.slice(0, ECHO_MAX_CHARS);
    return Result.ok({
      text: `[mock] Recebi: ${echo} (persona: "${persona}"; histórico: ${String(input.history.length)})`,
    });
  }
}
