import Anthropic from '@anthropic-ai/sdk';
import { HANDOFF_REASONS, isHandoffReason, type HandoffReason } from '../../../domain/index.js';
import {
  HANDOFF_DEFAULT_REPLY,
  LLM_ERROR_TYPE,
  type LlmGenerateInput,
  type LlmGenerateOptions,
  type LlmProvider,
  type LlmReply,
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

/** Nome da única ferramenta oferecida ao modelo (spec 030): só um sinal, nunca executa nada. */
export const HANDOFF_TOOL_NAME = 'solicitar_atendimento_humano';

/**
 * Linha fixa acrescentada ao `systemPrompt` só com `allowHandoff` (spec 030). Texto nosso; o do contato
 * continua só no turno `user`.
 */
export const HANDOFF_SYSTEM_INSTRUCTION =
  'Se o contato pedir para falar com uma pessoa, ou se você não puder resolver o pedido (assunto fora do que você sabe, reclamação, urgência ou assunto sensível), use a ferramenta solicitar_atendimento_humano e, na mesma resposta, diga ao contato que a equipe foi avisada. Não use a ferramenta em conversas comuns que você consegue atender. Nunca prometa prazo e nunca diga que uma pessoa já está na conversa.';

/** A ferramenta de sinal: um único campo, enum fechado, `strict` (o modelo não inventa campos). */
const HANDOFF_TOOL: Anthropic.Tool = {
  name: HANDOFF_TOOL_NAME,
  description:
    'Avisa a equipe da empresa que esta conversa precisa de atendimento humano. Use quando o contato pedir uma pessoa ou quando você não puder resolver o pedido. Não executa nenhuma ação para o contato: continue respondendo a ele normalmente.',
  input_schema: {
    type: 'object',
    properties: {
      motivo: {
        type: 'string',
        enum: [...HANDOFF_REASONS],
        description:
          'CONTACT_REQUESTED: o contato pediu uma pessoa; CANNOT_HELP: fora do que você sabe ou pode fazer; COMPLAINT: reclamação ou insatisfação; SENSITIVE: urgência, saúde, jurídico ou financeiro; OTHER: outro motivo.',
      },
    },
    required: ['motivo'],
    additionalProperties: false,
  },
  strict: true,
};

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
  unknownTool: {
    errorType: 'unexpected_tool_use',
    message: 'O modelo pediu uma ferramenta que não foi oferecida',
    retryable: false,
  },
  stopReason: {
    errorType: 'unexpected_stop_reason',
    message: 'O modelo terminou por um motivo inesperado',
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
      // Sem `temperature`, `top_p`, `top_k`, prefill, `tool_choice` nem `thinking`: o Haiku 5.5 recusa
      // os primeiros (400) e usa pensamento adaptivo por padrão, guiado por `effort`.
      const allowHandoff = input.allowHandoff === true;
      // Sem `allowHandoff` o pedido é idêntico ao de antes da spec 030 (nem `tools`, nem a linha extra).
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxOutputTokens,
          system: allowHandoff
            ? `${input.systemPrompt}\n\n${HANDOFF_SYSTEM_INSTRUCTION}`
            : input.systemPrompt,
          messages: toMessages(input),
          output_config: { effort: this.effort },
          // Sem `tool_choice`: o padrão é `auto` (o Haiku 5.5 recusa o forçado).
          ...(allowHandoff ? { tools: [HANDOFF_TOOL] } : {}),
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
        case 'tool_use':
          break;
        default:
          return failure(CATEGORY.stopReason);
      }

      // Só a ferramenta oferecida conta; qualquer outra (ou ferramenta sem `allowHandoff`) é erro.
      const toolUses = response.content.filter((block) => block.type === 'tool_use');
      if (toolUses.some((block) => !allowHandoff || block.name !== HANDOFF_TOOL_NAME)) {
        return failure(CATEGORY.unknownTool);
      }
      if (response.stop_reason === 'tool_use' && toolUses.length === 0) {
        return failure(CATEGORY.stopReason);
      }
      const handoff = toolUses.length === 0 ? undefined : { reason: handoffReason(toolUses) };

      // Só blocos `text`; blocos de pensamento (ou outros) são ignorados.
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      const usage = toUsage(response.usage);
      if (text.trim().length === 0) {
        // Só o sinal, sem texto: o contato recebe o texto constante (sem segunda chamada).
        if (handoff !== undefined)
          return Result.ok({ text: HANDOFF_DEFAULT_REPLY, usage, handoff });
        return failure(CATEGORY.emptyResponse);
      }
      return Result.ok({ text, usage, ...(handoff === undefined ? {} : { handoff }) });
    } catch (error) {
      return mapError(error);
    }
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

/**
 * Primeiro motivo válido entre as chamadas da ferramenta. Motivo ausente ou fora da lista vira `OTHER`:
 * o modelo quis um humano, o motivo é secundário. O `input` nunca vai a log nem a erro.
 */
function handoffReason(blocks: readonly Anthropic.ToolUseBlock[]): HandoffReason {
  for (const block of blocks) {
    const input: unknown = block.input;
    if (typeof input === 'object' && input !== null && 'motivo' in input) {
      const motivo: unknown = input.motivo;
      if (isHandoffReason(motivo)) return motivo;
    }
  }
  return 'OTHER';
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
