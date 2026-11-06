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
  /** Soma das chamadas do turno (com ferramentas, o laço faz várias). */
  readonly usage?: LlmUsage;
  /** Rodadas de ferramenta do turno (spec 028); ausente sem ferramentas. */
  readonly toolRounds?: number;
  /** Chamadas de ferramenta executadas (ou recusadas por limite) no turno (spec 028). */
  readonly toolCalls?: number;
}

/** Definição neutra de fornecedor de uma ferramenta (spec 028). */
export interface LlmToolDefinition {
  /** Nome fixo, só letras minúsculas, dígitos e `_`. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema do objeto de argumentos. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** O que o modelo pediu: o nome e os argumentos (nunca o id do fornecedor; ele fica no adaptador). */
export interface LlmToolCall {
  readonly name: string;
  /** Argumentos como o modelo os emitiu: dado **não confiável**, quem executa valida. */
  readonly input: unknown;
}

/** Resultado de uma ferramenta: texto do **servidor**, de formato fixo; nunca do contato. */
export interface LlmToolOutput {
  readonly content: string;
  readonly isError: boolean;
}

/**
 * Resultado fixo quando o teto de chamadas de ferramenta do turno foi passado (o adaptador o devolve
 * sem executar nada) e quando o executor falha de forma inesperada.
 */
export const LLM_TOOL_RESULT_TURN_LIMIT: LlmToolOutput = {
  content:
    'limite_turno: o limite de consultas deste atendimento foi atingido; responda ao contato com o que já sabe.',
  isError: true,
};
export const LLM_TOOL_RESULT_UNAVAILABLE: LlmToolOutput = {
  content:
    'indisponivel: nao foi possivel executar agora; diga ao contato que a equipe confirmara.',
  isError: true,
};

/**
 * Ferramentas oferecidas ao modelo num turno (spec 028). `execute` é **código nosso** e nunca deve
 * lançar; o modelo só produz argumentos. O provedor conduz o laço e guarda consigo os ids e os blocos
 * de pensamento do fornecedor.
 */
export interface LlmToolSet {
  readonly definitions: readonly LlmToolDefinition[];
  execute(call: LlmToolCall): Promise<LlmToolOutput>;
  readonly limits: {
    /** Pedidos ao modelo por turno (o seguinte ao teto não é feito). */
    readonly maxModelCalls: number;
    /** Chamadas de ferramenta por turno; as seguintes recebem `LLM_TOOL_RESULT_TURN_LIMIT`. */
    readonly maxToolCalls: number;
  };
}

export interface LlmGenerateOptions {
  /**
   * Cancela a chamada: o chamador aborta quando o prazo estoura. Provedor que suporta
   * cancelamento encerra a requisição (e a conexão); quem não suporta pode ignorar.
   */
  readonly signal?: AbortSignal;
  /** Ferramentas do turno (spec 028). Sem elas, o pedido é idêntico ao de antes. */
  readonly tools?: LlmToolSet;
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
  /** O laço de ferramentas passou do teto de pedidos ao modelo (spec 028). */
  toolRoundCap: 'tool_round_cap',
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
