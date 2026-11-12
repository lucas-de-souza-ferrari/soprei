import Anthropic from '@anthropic-ai/sdk';
import {
  LLM_ERROR_TYPE,
  LLM_TOOL_RESULT_TURN_LIMIT,
  LLM_TOOL_RESULT_UNAVAILABLE,
  type LlmGenerateInput,
  type LlmGenerateOptions,
  type LlmProvider,
  type LlmReply,
  type LlmToolOutput,
  type LlmToolSet,
  type LlmTurn,
  type LlmUsage,
} from '../../../application/ports/llm-provider.js';
import { ExternalServiceError } from '../../../shared/errors/index.js';
import { Result } from '../../../shared/types/index.js';

export interface AnthropicLlmProviderOptions {
  /** Segredo: só vai ao SDK; nunca a log, métrica, erro nem resposta. */
  readonly apiKey: string;
  /** Só para os testes (servidor falso); sem ele, a API oficial. */
  readonly baseUrl?: string | undefined;
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high';
  readonly maxOutputTokens: number;
  readonly maxRetries: number;
  /** Prazo de cada tentativa no SDK (`LLM_TIMEOUT_MS`); o prazo total é do `AbortSignal` do serviço. */
  readonly timeoutMs: number;
}

type Category = {
  readonly errorType: string;
  readonly message: string;
  readonly retryable: boolean;
};

/** Texto fixo por categoria de falha: o `message` do SDK pode citar o pedido e nunca é copiado. */
const CATEGORY = {
  timeout: {
    errorType: LLM_ERROR_TYPE.timeout,
    message: 'O provedor de LLM não respondeu no prazo',
    retryable: false,
  },
  connection: {
    errorType: 'connection_error',
    message: 'Falha de rede ao chamar o provedor de LLM',
    retryable: true,
  },
  authentication: {
    errorType: 'authentication_error',
    message: 'O provedor de LLM recusou a credencial',
    retryable: false,
  },
  permission: {
    errorType: 'permission_error',
    message: 'O provedor de LLM negou a permissão',
    retryable: false,
  },
  invalidRequest: {
    errorType: 'invalid_request_error',
    message: 'O provedor de LLM recusou o pedido como inválido',
    retryable: false,
  },
  rateLimit: {
    errorType: 'rate_limit_error',
    message: 'Limite de taxa do provedor de LLM atingido',
    retryable: true,
  },
  overloaded: {
    errorType: 'overloaded_error',
    message: 'O provedor de LLM está sobrecarregado',
    retryable: true,
  },
  unavailable: {
    errorType: 'api_error',
    message: 'O provedor de LLM está indisponível',
    retryable: true,
  },
  unknown: {
    errorType: 'unknown_error',
    message: 'Falha inesperada ao chamar o provedor de LLM',
    retryable: false,
  },
  refusal: {
    errorType: LLM_ERROR_TYPE.refusal,
    message: 'O modelo recusou responder',
    retryable: false,
  },
  maxTokens: {
    errorType: LLM_ERROR_TYPE.maxTokens,
    message: 'A resposta do modelo foi cortada pelo limite de tokens',
    retryable: false,
  },
  pauseTurn: {
    errorType: 'pause_turn',
    message: 'O modelo pausou o turno sem concluir a resposta',
    retryable: false,
  },
  stopReason: {
    errorType: 'unexpected_stop_reason',
    message: 'O modelo terminou por um motivo inesperado',
    retryable: false,
  },
  toolRoundCap: {
    errorType: LLM_ERROR_TYPE.toolRoundCap,
    message: 'O modelo passou do limite de rodadas de ferramenta do atendimento',
    retryable: false,
  },
  emptyResponse: {
    errorType: 'empty_response',
    message: 'O modelo respondeu sem texto utilizável',
    retryable: false,
  },
} as const satisfies Record<string, Category>;

/**
 * Provedor Claude (Anthropic) atrás do `LlmProvider` (spec 014), pelo SDK oficial.
 *
 * Privacidade: o `ExternalServiceError` devolvido leva **só** `{ provider, status, errorType,
 * retryable }` e uma mensagem fixa por categoria. `message`, corpo, cabeçalhos e o objeto de erro do
 * SDK (que pode ecoar o pedido) nunca são copiados nem anexados como `cause`. A chave só vai ao SDK.
 * Sem estado entre chamadas: cada pedido leva só a persona, o histórico e a mensagem de uma empresa.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';

  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: AnthropicLlmProviderOptions['effort'];
  private readonly maxOutputTokens: number;

  constructor(options: AnthropicLlmProviderOptions) {
    this.model = options.model;
    this.effort = options.effort;
    this.maxOutputTokens = options.maxOutputTokens;
    this.client = withoutCustomHeadersEnv(
      () =>
        new Anthropic({
          apiKey: options.apiKey,
          ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
          timeout: options.timeoutMs,
          maxRetries: options.maxRetries,
          // O SDK escreveria no console (fora do Pino e sem redact) e emitiria spans de tracing.
          logLevel: 'off',
          openTelemetry: false,
          // O SDK segue redirecionamentos e reenviaria o corpo (persona, histórico, texto do contato)
          // a outro host: redirecionar vira erro de rede (seguro), nunca um segundo envio.
          fetchOptions: { redirect: 'error' },
        }),
    );
  }

  async generate(
    input: LlmGenerateInput,
    options: LlmGenerateOptions = {},
  ): Promise<Result<LlmReply, ExternalServiceError>> {
    try {
      if (options.tools !== undefined) {
        return await this.generateWithTools(input, options.signal, options.tools);
      }
      // Sem `temperature`, `top_p`, `top_k`, prefill, `tool_choice` nem `thinking`: o Haiku 5.5 recusa
      // os primeiros (400) e usa pensamento adaptivo por padrão, guiado por `effort`.
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxOutputTokens,
          system: input.systemPrompt,
          messages: toMessages(input),
          output_config: { effort: this.effort },
        },
        options.signal === undefined ? {} : { signal: options.signal },
      );

      switch (response.stop_reason) {
        case 'refusal':
          return failure(CATEGORY.refusal);
        case 'max_tokens':
          return failure(CATEGORY.maxTokens);
        case 'pause_turn':
          return failure(CATEGORY.pauseTurn);
        case 'end_turn':
        case 'stop_sequence':
          break;
        default:
          return failure(CATEGORY.stopReason);
      }

      // Só blocos `text`; blocos de pensamento (ou outros) são ignorados.
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      if (text.trim().length === 0) return failure(CATEGORY.emptyResponse);
      return Result.ok({ text, usage: toUsage(response.usage) });
    } catch (error) {
      return mapError(error);
    }
  }

  /**
   * Laço de ferramentas (spec 028). O pedido é o de sempre mais `tools` (`name`, `description`,
   * `input_schema`): continuam proibidos `temperature`, `top_p`, `top_k`, prefill, `thinking` explícito,
   * `tool_choice` e `strict`. Os ids de `tool_use` e os blocos de pensamento assinados ficam aqui dentro:
   * o assistente volta ao modelo com o conteúdo **intacto e na mesma ordem** (omitir o pensamento é 400).
   * Chamadas paralelas rodam em sequência e todas recebem `tool_result`. Nada é executado quando a
   * resposta foi cortada (`max_tokens`), recusada ou pausada, nem na última chamada permitida (não haveria
   * pedido seguinte para consumir o resultado). Uma única `signal` (prazo total do turno, do chamador)
   * vale para todo o laço.
   */
  private async generateWithTools(
    input: LlmGenerateInput,
    signal: AbortSignal | undefined,
    tools: LlmToolSet,
  ): Promise<Result<LlmReply, ExternalServiceError>> {
    const messages = toMessages(input);
    const definitions: Anthropic.Tool[] = tools.definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      input_schema: definition.inputSchema as Anthropic.Tool.InputSchema,
    }));
    const requestOptions = signal === undefined ? {} : { signal };
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens: number | undefined;
    let modelCalls = 0;
    let toolCalls = 0;
    let rounds = 0;

    for (;;) {
      if (isAborted(signal)) return failure(CATEGORY.timeout);
      modelCalls += 1;
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxOutputTokens,
          system: input.systemPrompt,
          messages,
          tools: definitions,
          output_config: { effort: this.effort },
        },
        requestOptions,
      );
      const usage = toUsage(response.usage);
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      if (usage.cacheReadTokens !== undefined) {
        cacheReadTokens = (cacheReadTokens ?? 0) + usage.cacheReadTokens;
      }

      switch (response.stop_reason) {
        case 'refusal':
          return failure(CATEGORY.refusal);
        // Cortada: um `tool_use` pode estar pela metade; nada é executado.
        case 'max_tokens':
          return failure(CATEGORY.maxTokens);
        case 'pause_turn':
          return failure(CATEGORY.pauseTurn);
        case 'end_turn':
        case 'stop_sequence': {
          const text = response.content
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('');
          if (text.trim().length === 0) return failure(CATEGORY.emptyResponse);
          return Result.ok({
            text,
            usage: {
              inputTokens,
              outputTokens,
              ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
            },
            toolRounds: rounds,
            toolCalls,
          });
        }
        case 'tool_use':
          break;
        default:
          return failure(CATEGORY.stopReason);
      }

      const uses = response.content.flatMap((block) => (block.type === 'tool_use' ? [block] : []));
      if (uses.length === 0) return failure(CATEGORY.stopReason);
      // Sem outro pedido possível, o resultado não teria quem o lesse: nada é executado.
      if (modelCalls >= tools.limits.maxModelCalls) return failure(CATEGORY.toolRoundCap);
      rounds += 1;

      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        if (isAborted(signal)) return failure(CATEGORY.timeout);
        toolCalls += 1;
        const output: LlmToolOutput =
          toolCalls > tools.limits.maxToolCalls
            ? LLM_TOOL_RESULT_TURN_LIMIT
            : await executeSafely(tools, use.name, use.input);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: output.content,
          is_error: output.isError,
        });
      }
      messages.push({ role: 'user', content: results });
    }
  }
}

async function executeSafely(
  tools: LlmToolSet,
  name: string,
  input: unknown,
): Promise<LlmToolOutput> {
  try {
    return await tools.execute({ name, input });
  } catch {
    // O executor não deve lançar; se lançar, o erro (que pode ter dado do contato) não é copiado.
    return LLM_TOOL_RESULT_UNAVAILABLE;
  }
}

/**
 * O SDK lê `ANTHROPIC_CUSTOM_HEADERS` direto de `process.env` ao criar o cliente do SDK e o mescla nos
 * cabeçalhos de toda requisição: fora da nossa config e da validação. Aqui ele é ignorado (some só
 * durante a construção, e é restaurado em seguida).
 */
function withoutCustomHeadersEnv<T>(build: () => T): T {
  const saved = process.env['ANTHROPIC_CUSTOM_HEADERS'];
  delete process.env['ANTHROPIC_CUSTOM_HEADERS'];
  try {
    return build();
  } finally {
    if (saved !== undefined) process.env['ANTHROPIC_CUSTOM_HEADERS'] = saved;
  }
}

/**
 * Histórico e mensagem nova no formato da API: a primeira mensagem precisa ser `user`, então turnos
 * iniciais do assistente (efeito do corte de histórico) saem; conteúdo vazio nunca é enviado; turnos
 * vizinhos do mesmo papel seguem como estão (a API os junta).
 */
function toMessages(input: LlmGenerateInput): Anthropic.MessageParam[] {
  const turns: LlmTurn[] = input.history.filter((turn) => turn.content.trim().length > 0);
  const firstUser = turns.findIndex((turn) => turn.role === 'user');
  const history = firstUser === -1 ? [] : turns.slice(firstUser);
  return [
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user' as const, content: input.userMessage },
  ];
}

function toUsage(usage: Anthropic.Usage): LlmUsage {
  const cacheRead = usage.cache_read_input_tokens;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(typeof cacheRead === 'number' ? { cacheReadTokens: cacheRead } : {}),
  };
}

function mapError(error: unknown): Result<never, ExternalServiceError> {
  // Cancelamento pelo chamador (prazo do atendimento) ou prazo da tentativa no SDK.
  if (error instanceof Anthropic.APIUserAbortError) return failure(CATEGORY.timeout);
  if (error instanceof Anthropic.APIConnectionTimeoutError) return failure(CATEGORY.timeout);
  if (error instanceof Anthropic.APIConnectionError) return failure(CATEGORY.connection);
  if (error instanceof Anthropic.APIError) {
    const status: unknown = error.status;
    const code = typeof status === 'number' ? status : undefined;
    return failure(categoryForStatus(code), code);
  }
  return failure(CATEGORY.unknown);
}

/** O status HTTP decide a categoria; o `type` do corpo do erro (texto do servidor) nunca é copiado. */
function categoryForStatus(status: number | undefined): Category {
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return CATEGORY.invalidRequest;
  }
  if (status === 401) return CATEGORY.authentication;
  if (status === 403) return CATEGORY.permission;
  if (status === 408) return CATEGORY.timeout;
  if (status === 429) return CATEGORY.rateLimit;
  if (status === 529) return CATEGORY.overloaded;
  if (status === 409 || (status !== undefined && status >= 500)) return CATEGORY.unavailable;
  return CATEGORY.unknown;
}

function failure(category: Category, status?: number): Result<never, ExternalServiceError> {
  return Result.err(
    new ExternalServiceError(category.message, {
      context: {
        provider: 'anthropic',
        status: status ?? null,
        errorType: category.errorType,
        retryable: category.retryable,
      },
    }),
  );
}

/** Função à parte: o estado do `AbortSignal` muda fora do fluxo e o TypeScript não deve fixá-lo. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
