import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  LLM_TOOL_RESULT_TURN_LIMIT,
  type LlmGenerateInput,
  type LlmToolCall,
  type LlmToolOutput,
  type LlmToolSet,
} from '../../../application/ports/llm-provider.js';
import {
  FakeAnthropicApi,
  textMessage,
  toolUseMessage,
} from '../../../test-support/fake-anthropic-api.js';
import { AnthropicLlmProvider } from './anthropic-llm.provider.js';

const API_KEY = 'chave-de-mentira-ANTHROPIC-0123456789';

const fake = new FakeAnthropicApi();
before(async () => {
  await fake.start();
});
after(async () => {
  await fake.stop();
});
afterEach(() => {
  fake.reset();
});

function makeProvider(): AnthropicLlmProvider {
  return new AnthropicLlmProvider({
    apiKey: API_KEY,
    baseUrl: fake.baseUrl,
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxOutputTokens: 1024,
    maxRetries: 0,
    timeoutMs: 5_000,
  });
}

const input = (overrides: Partial<LlmGenerateInput> = {}): LlmGenerateInput => ({
  systemPrompt: 'Persona X.\n\nResponda curto.',
  history: [],
  userMessage: 'Tem horário amanhã?',
  ...overrides,
});

const OK: LlmToolOutput = { content: 'ok: resultado do servidor', isError: false };

function makeTools(
  execute: (call: LlmToolCall) => Promise<LlmToolOutput> = () => Promise.resolve(OK),
  limits: Partial<LlmToolSet['limits']> = {},
): LlmToolSet & { readonly executed: LlmToolCall[] } {
  const executed: LlmToolCall[] = [];
  return {
    definitions: [
      {
        name: 'listar_horarios',
        description: 'Lista horários livres.',
        inputSchema: {
          type: 'object',
          properties: { servico: { type: 'string' } },
          required: ['servico'],
          additionalProperties: false,
        },
      },
    ],
    execute: async (call) => {
      executed.push(call);
      return execute(call);
    },
    limits: { maxModelCalls: 4, maxToolCalls: 6, ...limits },
    executed,
  };
}

function body(index: number): Record<string, unknown> {
  const request = fake.requests[index];
  assert.ok(request?.body, 'havia um pedido com corpo JSON');
  return request.body;
}

type Message = { role: string; content: unknown };
const messagesOf = (index: number): Message[] => body(index)['messages'] as Message[];

describe('AnthropicLlmProvider com ferramentas: pedido', () => {
  it('sem tools o pedido é o de sempre: nenhuma chave de ferramenta nem parâmetro recusado', async () => {
    const result = await makeProvider().generate(input());
    assert.ok(result.ok);
    assert.equal(result.value.toolRounds, undefined);
    const sent = body(0);
    assert.deepEqual(Object.keys(sent).sort(), [
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'system',
    ]);
  });

  it('com tools leva name, description e input_schema e nenhuma chave proibida; a chave só no cabeçalho', async () => {
    const result = await makeProvider().generate(input(), { tools: makeTools() });
    assert.ok(result.ok);
    const sent = body(0);
    assert.deepEqual(sent['tools'], [
      {
        name: 'listar_horarios',
        description: 'Lista horários livres.',
        input_schema: {
          type: 'object',
          properties: { servico: { type: 'string' } },
          required: ['servico'],
          additionalProperties: false,
        },
      },
    ]);
    for (const forbidden of ['temperature', 'top_p', 'top_k', 'tool_choice', 'thinking']) {
      assert.ok(!(forbidden in sent), `não deve enviar ${forbidden}`);
    }
    assert.ok(!JSON.stringify(sent['tools']).includes('strict'));
    assert.deepEqual(sent['output_config'], { effort: 'low' });
    const request = fake.requests[0];
    assert.ok(request);
    assert.ok(!request.raw.includes(API_KEY));
    assert.ok(!request.path.includes(API_KEY));
  });
});

describe('AnthropicLlmProvider com ferramentas: laço', () => {
  it('tool_use -> executor -> tool_result com o mesmo id -> end_turn; soma o uso das chamadas', async () => {
    fake.script(
      toolUseMessage([{ id: 'toolu_abc', name: 'listar_horarios', input: { servico: 'Corte' } }]),
      textMessage('Tenho às 9h.'),
    );
    const tools = makeTools();
    const result = await makeProvider().generate(input(), { tools });
    assert.ok(result.ok);
    assert.equal(result.value.text, 'Tenho às 9h.');
    assert.equal(result.value.toolRounds, 1);
    assert.equal(result.value.toolCalls, 1);
    assert.deepEqual(tools.executed, [{ name: 'listar_horarios', input: { servico: 'Corte' } }]);
    // 40 + 42 de entrada, 9 + 7 de saída, 3 + 5 de cache.
    assert.deepEqual(result.value.usage, {
      inputTokens: 82,
      outputTokens: 16,
      cacheReadTokens: 8,
    });

    assert.equal(fake.requests.length, 2);
    const second = messagesOf(1);
    assert.equal(second.length, 3);
    assert.equal(second[1]?.role, 'assistant');
    assert.equal(second[2]?.role, 'user');
    assert.deepEqual(second[2].content, [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_abc',
        content: OK.content,
        is_error: false,
      },
    ]);
    // O segundo pedido continua com as mesmas ferramentas e sem parâmetros proibidos.
    assert.ok(Array.isArray(body(1)['tools']));
    assert.ok(!('tool_choice' in body(1)));
  });

  it('os blocos de pensamento voltam idênticos e na mesma ordem; texto e tool_use também', async () => {
    const before = [
      { type: 'thinking' as const, thinking: 'raciocínio A', signature: 'assinatura-A' },
      { type: 'redacted_thinking' as const, data: 'dado-opaco' },
      { type: 'text' as const, text: 'Vou consultar.' },
    ];
    fake.script(
      toolUseMessage([{ id: 'toolu_1', name: 'listar_horarios', input: { servico: 'x' } }], {
        before,
      }),
      textMessage('Pronto.'),
    );
    const result = await makeProvider().generate(input(), { tools: makeTools() });
    assert.ok(result.ok);
    const assistant = messagesOf(1)[1];
    assert.equal(assistant?.role, 'assistant');
    const content = assistant.content as { type: string }[];
    assert.deepEqual(
      content.map((block) => block.type),
      ['thinking', 'redacted_thinking', 'text', 'tool_use'],
    );
    assert.deepEqual(content[0], before[0]);
    assert.deepEqual(content[1], before[1]);
    assert.equal(result.value.text, 'Pronto.', 'só o texto final vira resposta');
  });

  it('vários tool_use no mesmo turno: executados em sequência e todos recebem tool_result', async () => {
    fake.script(
      toolUseMessage([
        { id: 'toolu_a', name: 'listar_horarios', input: { servico: 'a' } },
        { id: 'toolu_b', name: 'listar_horarios', input: { servico: 'b' } },
        { id: 'toolu_c', name: 'listar_horarios', input: { servico: 'c' } },
      ]),
      textMessage('Feito.'),
    );
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const tools = makeTools(async (call) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(JSON.stringify(call.input));
      running -= 1;
      return OK;
    });
    const result = await makeProvider().generate(input(), { tools });
    assert.ok(result.ok);
    assert.equal(maxRunning, 1, 'nunca em paralelo');
    assert.deepEqual(order, ['{"servico":"a"}', '{"servico":"b"}', '{"servico":"c"}']);
    const results = messagesOf(1)[2]?.content as { tool_use_id: string }[];
    assert.deepEqual(
      results.map((item) => item.tool_use_id),
      ['toolu_a', 'toolu_b', 'toolu_c'],
    );
    assert.equal(result.value.toolRounds, 1);
    assert.equal(result.value.toolCalls, 3);
  });

  it('o id do fornecedor nunca chega ao executor', async () => {
    fake.script(
      toolUseMessage([
        { id: 'toolu_segredo_id', name: 'listar_horarios', input: { servico: 'x' } },
      ]),
      textMessage('ok'),
    );
    const tools = makeTools();
    await makeProvider().generate(input(), { tools });
    assert.ok(!JSON.stringify(tools.executed).includes('toolu_segredo_id'));
    assert.deepEqual(Object.keys(tools.executed[0] ?? {}).sort(), ['input', 'name']);
  });
});

describe('AnthropicLlmProvider com ferramentas: tetos e prazo', () => {
  it('o 5º pedido ao modelo não é feito: erro de rodadas e nada executado na última chamada', async () => {
    fake.always(toolUseMessage([{ name: 'listar_horarios', input: { servico: 'x' } }]));
    const tools = makeTools();
    const result = await makeProvider().generate(input(), { tools });
    assert.equal(result.ok, false);
    assert.equal(result.error.context['errorType'], 'tool_round_cap');
    assert.equal(fake.requests.length, 4, 'exatamente 4 pedidos ao modelo');
    // 3 rodadas executadas; o tool_use da 4ª chamada não tem pedido seguinte para consumi-lo.
    assert.equal(tools.executed.length, 3);
  });

  it('a 7ª chamada de ferramenta recebe limite_turno sem chegar ao executor', async () => {
    fake.script(
      toolUseMessage(
        Array.from({ length: 7 }, (_, index) => ({
          id: `toolu_${String(index)}`,
          name: 'listar_horarios',
          input: { servico: String(index) },
        })),
      ),
      textMessage('fim'),
    );
    const tools = makeTools();
    const result = await makeProvider().generate(input(), { tools });
    assert.ok(result.ok);
    assert.equal(tools.executed.length, 6);
    assert.equal(result.value.toolCalls, 7);
    const results = messagesOf(1)[2]?.content as { content: string; is_error: boolean }[];
    assert.equal(results.length, 7);
    assert.equal(results[6]?.content, LLM_TOOL_RESULT_TURN_LIMIT.content);
    assert.equal(results[6].is_error, true);
  });

  it('o prazo do turno (sinal) aborta a chamada em andamento e para o laço', async () => {
    fake.script(toolUseMessage([{ name: 'listar_horarios', input: { servico: 'x' } }]), {
      kind: 'hang',
    });
    const controller = new AbortController();
    const pending = makeProvider().generate(input(), {
      tools: makeTools(),
      signal: controller.signal,
    });
    const deadline = Date.now() + 5_000;
    while (fake.requests.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(fake.requests.length, 2);
    controller.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.context['errorType'], 'timeout');
    assert.ok(await fake.waitForClientClose(1));
    assert.equal(fake.requests.length, 2, 'nenhum pedido novo depois do prazo');
  });

  it('sinal que estoura durante a ferramenta: não faz o pedido seguinte', async () => {
    fake.always(toolUseMessage([{ name: 'listar_horarios', input: { servico: 'x' } }]));
    const controller = new AbortController();
    const tools = makeTools(() => {
      controller.abort();
      return Promise.resolve(OK);
    });
    const result = await makeProvider().generate(input(), { tools, signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.error.context['errorType'], 'timeout');
    assert.equal(fake.requests.length, 1);
  });
});

describe('AnthropicLlmProvider com ferramentas: stop_reason e erros', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['pause_turn', 'pause_turn'],
    ['algo_novo', 'unexpected_stop_reason'],
  ];
  for (const [stopReason, errorType] of cases) {
    it(`${stopReason} no meio de um tool_use: erro fixo e nada é executado`, async () => {
      fake.always(
        toolUseMessage([{ name: 'listar_horarios', input: { servico: 'x' } }], { stopReason }),
      );
      const tools = makeTools();
      const result = await makeProvider().generate(input(), { tools });
      assert.equal(result.ok, false);
      assert.equal(result.error.context['errorType'], errorType);
      assert.equal(tools.executed.length, 0);
      assert.equal(fake.requests.length, 1);
    });
  }

  it('tool_use sem bloco tool_use é erro de stop_reason inesperado', async () => {
    fake.always({
      kind: 'message',
      content: [{ type: 'text', text: 'oi' }],
      stopReason: 'tool_use',
    });
    const tools = makeTools();
    const result = await makeProvider().generate(input(), { tools });
    assert.equal(result.ok, false);
    assert.equal(result.error.context['errorType'], 'unexpected_stop_reason');
  });

  it('executor que lança vira resultado de erro para o modelo (o erro não é copiado) e o laço segue', async () => {
    fake.script(
      toolUseMessage([{ id: 'toolu_x', name: 'listar_horarios', input: { servico: 'x' } }]),
      textMessage('Vou confirmar com a equipe.'),
    );
    const tools = makeTools(() => Promise.reject(new Error('NOME-SECRETO-no-erro')));
    const result = await makeProvider().generate(input(), { tools });
    assert.ok(result.ok);
    const sent = JSON.stringify(messagesOf(1)[2]?.content);
    assert.ok(sent.includes('indisponivel'));
    assert.ok(!sent.includes('NOME-SECRETO-no-erro'));
  });

  it('resposta final vazia depois das ferramentas é erro', async () => {
    fake.script(toolUseMessage([{ name: 'listar_horarios', input: { servico: 'x' } }]), {
      kind: 'message',
      content: [{ type: 'text', text: '  ' }],
      stopReason: 'end_turn',
    });
    const result = await makeProvider().generate(input(), { tools: makeTools() });
    assert.equal(result.ok, false);
    assert.equal(result.error.context['errorType'], 'empty_response');
  });

  it('erro HTTP no meio do laço: nada do pedido (que o servidor ecoa) vaza no erro', async () => {
    const SECRET = 'ARGUMENTO-SECRETO-corte-5511999990000';
    fake.script(toolUseMessage([{ name: 'listar_horarios', input: { servico: SECRET } }]), {
      kind: 'error',
      status: 400,
      echoRequest: true,
    });
    const tools = makeTools(() =>
      Promise.resolve({ content: `ok: RESULTADO-SECRETO-${SECRET}`, isError: false }),
    );
    const result = await makeProvider().generate(input({ userMessage: 'TEXTO-SECRETO-9' }), {
      tools,
    });
    assert.equal(result.ok, false);
    const error = result.error;
    const everything = [
      error.message,
      error.stack ?? '',
      JSON.stringify(error),
      inspect(error, { depth: 10, showHidden: true }),
    ].join('\n');
    for (const secret of [
      SECRET,
      'RESULTADO-SECRETO',
      'TEXTO-SECRETO-9',
      API_KEY,
      'pedido recebido',
    ]) {
      assert.ok(!everything.includes(secret), `${secret} vazou no erro`);
    }
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error.context).sort(), [
      'errorType',
      'provider',
      'retryable',
      'status',
    ]);
  });
});
