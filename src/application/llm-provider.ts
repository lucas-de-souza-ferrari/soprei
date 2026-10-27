import type { ExternalServiceError } from '../shared/errors/index.js';
import type { Result } from '../shared/types/index.js';

/** Um turno do histórico enviado ao modelo. */
export interface LlmTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface LlmGenerateInput {
  /** Persona e regras do cliente. Só texto nosso: o texto do contato nunca entra aqui. */
  readonly systemPrompt: string;
  /** Mensagens anteriores da conversa, da mais antiga para a mais recente. */
  readonly history: readonly LlmTurn[];
  /** A mensagem nova do contato; sempre um turno `user`, nunca misturada ao `systemPrompt`. */
  readonly userMessage: string;
}

export interface LlmReply {
  readonly text: string;
}

/**
 * Porta única para qualquer modelo de linguagem (o modelo é peça trocável: trocar é mudar
 * configuração, não código de negócio). Erro esperado (rede, cota, resposta inválida) volta
 * como `Result.err(ExternalServiceError)`, nunca como exceção.
 *
 * Contrato de privacidade: a mensagem e o contexto de qualquer erro devolvido **nunca**
 * contêm o texto do contato, o histórico nem a persona; o serviço os loga como estão.
 */
export interface LlmProvider {
  /** Nome estável do provedor (`mock`...), usado como label de métrica. */
  readonly name: string;
  generate(input: LlmGenerateInput): Promise<Result<LlmReply, ExternalServiceError>>;
}
