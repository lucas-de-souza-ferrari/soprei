import type { ExternalServiceError } from '../../shared/errors/index.js';
import type { Result } from '../../shared/types/index.js';

/** Um turno do histórico enviado ao modelo. */
export interface LlmTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface LlmGenerateInput {
  /** Persona e regras da empresa. Só texto nosso: o texto do contato nunca entra aqui. */
  readonly systemPrompt: string;
  /** Mensagens anteriores da conversa, da mais antiga para a mais recente. */
  readonly history: readonly LlmTurn[];
  /** A mensagem nova do contato; sempre um turno `user`, nunca misturada ao `systemPrompt`. */
  readonly userMessage: string;
}

/** Tokens gastos numa chamada (só números; nunca texto). */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Parte da entrada lida do cache do provedor, quando ele informa. */
  readonly cacheReadTokens?: number;
}

export interface LlmReply {
  readonly text: string;
  readonly usage?: LlmUsage;
}

export interface LlmGenerateOptions {
  /**
   * Cancela a chamada: o chamador aborta quando o prazo estoura. Provedor que suporta
   * cancelamento encerra a requisição (e a conexão); quem não suporta pode ignorar.
   */
  readonly signal?: AbortSignal;
}

/**
 * Categorias de falha que o provedor marca em `error.context.errorType` e que o atendimento
 * traduz em resultado de métrica: `timeout` (prazo), `refusal` (o modelo recusou) e
 * `max_tokens` (resposta cortada). Qualquer outra vira `error`.
 */
export const LLM_ERROR_TYPE = {
  timeout: 'timeout',
  refusal: 'refusal',
  maxTokens: 'max_tokens',
} as const;

/**
 * Porta única para qualquer modelo de linguagem (o modelo é peça trocável: trocar é mudar
 * configuração, não código de negócio). Erro esperado (rede, cota, resposta inválida) volta
 * como `Result.err(ExternalServiceError)`, nunca como exceção.
 *
 * Contrato de privacidade: a mensagem e o contexto de qualquer erro devolvido **nunca**
 * contêm o texto do contato, o histórico nem a persona; o serviço os loga como estão. Isso inclui
 * o `message`, o corpo e o objeto de erro do SDK do provedor: nunca vão como `cause`.
 */
export interface LlmProvider {
  /** Nome estável do provedor (`mock`...), usado como label de métrica. */
  readonly name: string;
  generate(
    input: LlmGenerateInput,
    options?: LlmGenerateOptions,
  ): Promise<Result<LlmReply, ExternalServiceError>>;
}
