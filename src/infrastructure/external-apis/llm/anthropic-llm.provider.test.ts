import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { after, afterEach, before, describe, it } from 'node:test';
import type { LlmGenerateInput } from '../../../application/ports/llm-provider.js';
import { ExternalServiceError } from '../../../shared/errors/index.js';
import {
  FakeAnthropicApi,
  textMessage,
  type AnthropicBehavior,
} from '../../../test-support/fake-anthropic-api.js';
import {
  AnthropicLlmProvider,
  type AnthropicLlmProviderOptions,
} from './anthropic-llm.provider.js';

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

function makeProvider(overrides: Partial<AnthropicLlmProviderOptions> = {}): AnthropicLlmProvider {
  return new AnthropicLlmProvider({
    apiKey: API_KEY,
    baseUrl: fake.baseUrl,
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxOutputTokens: 1024,
    maxRetries: 1,
    timeoutMs: 5_000,
    ...overrides,
  });
}

const input = (overrides: Partial<LlmGenerateInput> = {}): LlmGenerateInput => ({
  systemPrompt: 'Persona X.\n\nResponda curto.',
  history: [],
  userMessage: 'Qual o horário?',
  ...overrides,
});

function body(index = 0): Record<string, unknown> {
  const request = fake.requests[index];
  assert.ok(request?.body, 'havia um pedido com corpo JSON');
  return request.body;
}

function context(error: ExternalServiceError): Record<string, unknown> {
  return { ...error.context };
}

describe('AnthropicLlmProvider: pedido', () => {
  it('envia model, max_tokens, system, messages em ordem e output_config.effort, sem parâmetros recusados', async () => {
    const result = await makeProvider().generate(
      input({
        history: [
          { role: 'user', content: 'oi' },
          { role: 'assistant', content: 'olá!' },
        ],
      }),
    );
    assert.ok(result.ok);

    assert.equal(fake.requests.length, 1);
    const request = fake.requests[0];
    assert.ok(request);
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v1/messages');
    const sent = body();
    assert.equal(sent['model'], 'claude-haiku-5-5');
    assert.equal(sent['max_tokens'], 1024);
    assert.equal(sent['system'], 'Persona X.\n\nResponda curto.');
    assert.deepEqual(sent['messages'], [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'olá!' },
      { role: 'user', content: 'Qual o horário?' },
    ]);
    assert.deepEqual(sent['output_config'], { effort: 'low' });
    for (const forbidden of ['temperature', 'top_p', 'top_k', 'tool_choice', 'tools', 'thinking']) {
      assert.ok(!(forbidden in sent), `não deve enviar ${forbidden}`);
    }
    const messages = sent['messages'] as { role: string }[];
    assert.equal(messages.at(-1)?.role, 'user', 'sem prefill: o último turno é do usuário');
  });

  it('usa o modelo, o esforço e o teto de tokens da configuração', async () => {
    await makeProvider({ model: 'claude-outro-1', effort: 'high', maxOutputTokens: 256 }).generate(
      input(),
    );
    const sent = body();
    assert.equal(sent['model'], 'claude-outro-1');
    assert.equal(sent['max_tokens'], 256);
    assert.deepEqual(sent['output_config'], { effort: 'high' });
  });

  it('a chave vai só em cabeçalho do SDK: nunca na URL nem no corpo', async () => {
    await makeProvider().generate(input());
    const request = fake.requests[0];
    assert.ok(request);
    const headerNames = Object.entries(request.headers)
      .filter(([, value]) => String(value).includes(API_KEY))
      .map(([name]) => name);
    assert.ok(headerNames.length >= 1, 'a chave foi enviada em algum cabeçalho de autenticação');
    for (const name of headerNames) {
      assert.match(name, /^(x-api-key|authorization)$/);
    }
    assert.ok(!request.path.includes(API_KEY));
    assert.ok(!request.raw.includes(API_KEY));
  });

  it('histórico que começa pelo assistente perde os turnos iniciais do assistente', async () => {
    await makeProvider().generate(
      input({
        history: [
          { role: 'assistant', content: 'resposta antiga 1' },
          { role: 'assistant', content: 'resposta antiga 2' },
          { role: 'user', content: 'pergunta' },
          { role: 'assistant', content: 'resposta' },
        ],
      }),
    );
    assert.deepEqual(body()['messages'], [
      { role: 'user', content: 'pergunta' },
      { role: 'assistant', content: 'resposta' },
      { role: 'user', content: 'Qual o horário?' },
    ]);
  });

  it('histórico só de turnos do assistente vira só a mensagem nova; histórico vazio idem', async () => {
    await makeProvider().generate(
      input({ history: [{ role: 'assistant', content: 'só o assistente' }] }),
    );
    await makeProvider().generate(input());
    const expected = [{ role: 'user', content: 'Qual o horário?' }];
    assert.deepEqual(body(0)['messages'], expected);
    assert.deepEqual(body(1)['messages'], expected);
  });

  it('turnos vizinhos do mesmo papel são mantidos e conteúdo vazio nunca é enviado', async () => {
    await makeProvider().generate(
      input({
        history: [
          { role: 'assistant', content: '   ' },
          { role: 'user', content: 'a' },
          { role: 'user', content: '' },
          { role: 'user', content: 'b' },
          { role: 'assistant', content: 'c' },
        ],
      }),
    );
    assert.deepEqual(body()['messages'], [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'Qual o horário?' },
    ]);
  });

  it('não guarda estado entre chamadas: duas chamadas intercaladas de dois clientes não se misturam', async () => {
    fake.always(textMessage('ok', { delayMs: 40 }));
    const provider = makeProvider();
    const [a, b] = await Promise.all([
      provider.generate({
        systemPrompt: 'PERSONA-A',
        history: [{ role: 'user', content: 'HIST-A' }],
        userMessage: 'MSG-A',
      }),
      provider.generate({
        systemPrompt: 'PERSONA-B',
        history: [{ role: 'user', content: 'HIST-B' }],
        userMessage: 'MSG-B',
      }),
    ]);
    assert.ok(a.ok && b.ok);
    assert.equal(fake.requests.length, 2);
    for (const request of fake.requests) {
      const raw = request.raw;
      const isA = raw.includes('PERSONA-A');
      const own = isA ? 'A' : 'B';
      const other = isA ? 'B' : 'A';
      assert.ok(raw.includes(`HIST-${own}`) && raw.includes(`MSG-${own}`));
      assert.ok(!raw.includes(`PERSONA-${other}`));
      assert.ok(!raw.includes(`HIST-${other}`));
      assert.ok(!raw.includes(`MSG-${other}`));
    }
  });
});

describe('AnthropicLlmProvider: resposta', () => {
  it('junta os blocos text, ignora os de pensamento e devolve usage', async () => {
    fake.script(
      textMessage('', {
        content: [
          { type: 'thinking', thinking: 'raciocínio interno', signature: 'sig' },
          { type: 'text', text: 'Olá, ' },
          { type: 'text', text: 'tudo bem?' },
        ],
        usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100 },
      }),
    );
    const result = await makeProvider().generate(input());
    assert.ok(result.ok);
    assert.equal(result.value.text, 'Olá, tudo bem?');
    assert.deepEqual(result.value.usage, {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 100,
    });
  });

  it('usage sem leitura de cache não traz cacheReadTokens', async () => {
    fake.script({ kind: 'message', usage: { input_tokens: 9, output_tokens: 3 } });
    const result = await makeProvider().generate(input());
    assert.ok(result.ok);
    assert.deepEqual(result.value.usage, { inputTokens: 9, outputTokens: 3 });
  });

  const failures: readonly (readonly [string, AnthropicBehavior, string])[] = [
    ['resposta sem blocos', { kind: 'message', content: [] }, 'empty_response'],
    [
      'só pensamento, sem texto',
      { kind: 'message', content: [{ type: 'thinking', thinking: 'x' }] },
      'empty_response',
    ],
    ['texto em branco', textMessage('   \n '), 'empty_response'],
    ['refusal', textMessage('não posso', { stopReason: 'refusal' }), 'refusal'],
    ['max_tokens', textMessage('pela metade', { stopReason: 'max_tokens' }), 'max_tokens'],
    ['pause_turn', textMessage('pausa', { stopReason: 'pause_turn' }), 'pause_turn'],
    ['tool_use', textMessage('x', { stopReason: 'tool_use' }), 'unexpected_stop_reason'],
    ['stop_reason nulo', textMessage('x', { stopReason: null }), 'unexpected_stop_reason'],
  ];
  for (const [label, behavior, errorType] of failures) {
    it(`${label} vira Result.err (${errorType}) sem repetir`, async () => {
      fake.always(behavior);
      const result = await makeProvider().generate(input());
      assert.equal(result.ok, false);
      assert.ok(result.error instanceof ExternalServiceError);
      assert.equal(result.error.context['errorType'], errorType);
      assert.equal(fake.requests.length, 1);
    });
  }
});

describe('AnthropicLlmProvider: erros HTTP, repetição e rede', () => {
  const statuses: readonly (readonly [number, string, boolean])[] = [
    [400, 'invalid_request_error', false],
    [401, 'authentication_error', false],
    [403, 'permission_error', false],
    [404, 'invalid_request_error', false],
    [429, 'rate_limit_error', true],
    [500, 'api_error', true],
    [529, 'overloaded_error', true],
  ];
  for (const [status, errorType, retryable] of statuses) {
    it(`${String(status)} vira ExternalServiceError só com provider, status, errorType e retryable`, async () => {
      fake.always({ kind: 'error', status, errorType: 'tipo-vindo-do-servidor' });
      const result = await makeProvider().generate(input());
      assert.equal(result.ok, false);
      assert.ok(result.error instanceof ExternalServiceError);
      assert.deepEqual(context(result.error), {
        provider: 'anthropic',
        status,
        errorType,
        retryable,
      });
      assert.equal(result.error.cause, undefined);
      // 429, 5xx: repetido até maxRetries (1); 4xx de pedido ou credencial: uma tentativa só.
      assert.equal(fake.requests.length, retryable ? 2 : 1);
    });
  }

  it('LLM_MAX_RETRIES manda: 0 repetições, 1 ou 3', async () => {
    for (const [maxRetries, expected] of [
      [0, 1],
      [1, 2],
      [3, 4],
    ] as const) {
      fake.reset();
      fake.always({ kind: 'error', status: 500 });
      await makeProvider({ maxRetries }).generate(input());
      assert.equal(fake.requests.length, expected, `maxRetries=${String(maxRetries)}`);
    }
  });

  it('um 5xx seguido de sucesso é repetido e vira resposta', async () => {
    fake.script({ kind: 'error', status: 500 }, { kind: 'error', status: 529 });
    const result = await makeProvider({ maxRetries: 2 }).generate(input());
    assert.ok(result.ok, 'a terceira tentativa responde com o sucesso padrão');
    assert.equal(fake.requests.length, 3);
  });

  it('falha de conexão é repetida e, esgotadas as tentativas, vira connection_error', async () => {
    fake.always({ kind: 'drop' });
    const result = await makeProvider().generate(input());
    assert.equal(result.ok, false);
    assert.deepEqual(context(result.error), {
      provider: 'anthropic',
      status: null,
      errorType: 'connection_error',
      retryable: true,
    });
    assert.equal(fake.requests.length, 2);
  });

  it('o prazo de uma tentativa no SDK vira errorType timeout e fecha a conexão', async () => {
    fake.always({ kind: 'hang' });
    const result = await makeProvider({ timeoutMs: 150, maxRetries: 0 }).generate(input());
    assert.equal(result.ok, false);
    assert.equal(result.error.context['errorType'], 'timeout');
    assert.ok(await fake.waitForClientClose(1), 'o SDK encerrou a conexão');
  });
});

describe('AnthropicLlmProvider: cancelamento', () => {
  it('abortar o sinal encerra a requisição, devolve erro de prazo e fecha a conexão com o servidor', async () => {
    fake.always({ kind: 'hang' });
    const controller = new AbortController();
    const pending = makeProvider().generate(input(), { signal: controller.signal });
    // Espera o servidor ter recebido o pedido antes de cancelar.
    const deadline = Date.now() + 5_000;
    while (fake.requests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(fake.requests.length, 1);
    controller.abort();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.context['errorType'], 'timeout');
    assert.ok(await fake.waitForClientClose(1), 'a conexão com o servidor foi encerrada');
    // Cancelado não repete: continua em um único pedido.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fake.requests.length, 1);
  });

  it('sinal já abortado não chega a enviar o pedido', async () => {
    const result = await makeProvider().generate(input(), { signal: AbortSignal.abort() });
    assert.equal(result.ok, false);
    assert.equal(result.error.context['errorType'], 'timeout');
    assert.equal(fake.requests.length, 0);
  });

  it('abortar durante a espera entre repetições interrompe as repetições (exatamente 1 pedido)', async () => {
    // O 500 chega com retry-after longo: o SDK dorme antes da segunda tentativa.
    fake.always({ kind: 'error', status: 500, retryAfterMs: 8_000 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = makeProvider({ maxRetries: 3 }).generate(input(), {
      signal: controller.signal,
    });
    const deadline = Date.now() + 5_000;
    while (fake.requests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(fake.requests.length, 1, 'o primeiro 500 chegou ao servidor');
    // Dá tempo de o SDK ler o 500 e entrar no sono da repetição antes de abortar.
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.context['errorType'], 'timeout');
    assert.ok(Date.now() - started < 4_000, 'não esperou o retry-after de 8 s');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fake.requests.length, 1, 'nenhuma repetição depois do abort');
  });
});

describe('AnthropicLlmProvider: redirecionamento e ambiente', () => {
  const SECRET = 'TEXTO-SECRETO-REDIRECT-4411';

  it('um redirecionamento (307) não é seguido: erro seguro e o segundo servidor não recebe corpo algum', async () => {
    const other = new FakeAnthropicApi();
    await other.start();
    try {
      for (const status of [301, 302, 307, 308]) {
        fake.reset();
        other.reset();
        fake.always({ kind: 'redirect', status, location: `${other.baseUrl}/v1/messages` });
        const result = await makeProvider({ maxRetries: 0 }).generate({
          systemPrompt: 'PERSONA-REDIRECT',
          history: [],
          userMessage: SECRET,
        });
        assert.equal(result.ok, false, `status ${String(status)}`);
        assert.ok(result.error instanceof ExternalServiceError);
        assert.deepEqual(Object.keys(result.error.context).sort(), [
          'errorType',
          'provider',
          'retryable',
          'status',
        ]);
        const everything = `${result.error.message}${inspect(result.error, { depth: 10 })}`;
        assert.ok(!everything.includes(SECRET));
        assert.ok(!everything.includes('PERSONA-REDIRECT'));
        assert.ok(!everything.includes(API_KEY));
        assert.equal(fake.requests.length, 1);
        assert.equal(other.requests.length, 0, 'o destino do redirect não recebeu nada');
      }
    } finally {
      await other.stop();
    }
  });

  it('ANTHROPIC_CUSTOM_HEADERS do ambiente é ignorado e o ambiente é restaurado', async () => {
    const previous = process.env['ANTHROPIC_CUSTOM_HEADERS'];
    process.env['ANTHROPIC_CUSTOM_HEADERS'] = 'x-vazamento: segredo-do-ambiente';
    try {
      const provider = makeProvider();
      assert.equal(process.env['ANTHROPIC_CUSTOM_HEADERS'], 'x-vazamento: segredo-do-ambiente');
      await provider.generate(input());
      assert.equal(fake.requests.length, 1);
      assert.equal(fake.requests[0]?.headers['x-vazamento'], undefined);
    } finally {
      if (previous === undefined) delete process.env['ANTHROPIC_CUSTOM_HEADERS'];
      else process.env['ANTHROPIC_CUSTOM_HEADERS'] = previous;
    }
  });
});

describe('AnthropicLlmProvider: privacidade do erro', () => {
  const SECRETS = {
    persona: 'PERSONA-SECRETA-77a1',
    history: 'HISTORICO-SECRETO-91bc',
    contact: 'CONTATO-SECRETO-5511999990000',
  };

  it('um servidor que ecoa o pedido no corpo do erro não vaza persona, histórico, texto nem chave', async () => {
    for (const status of [400, 401, 429, 500, 529]) {
      fake.reset();
      fake.always({ kind: 'error', status, echoRequest: true });
      const result = await makeProvider().generate({
        systemPrompt: SECRETS.persona,
        history: [{ role: 'user', content: SECRETS.history }],
        userMessage: SECRETS.contact,
      });
      assert.equal(result.ok, false);
      assert.ok(fake.requests.length >= 1);
      const error = result.error;
      const everything = [
        error.message,
        error.stack ?? '',
        JSON.stringify(error),
        JSON.stringify(error.context),
        inspect(error, { depth: 10, showHidden: true }),
      ].join('\n');
      for (const secret of [...Object.values(SECRETS), API_KEY, 'pedido recebido']) {
        assert.ok(!everything.includes(secret), `${secret} vazou no erro ${String(status)}`);
      }
      assert.equal(error.cause, undefined, 'o erro do SDK não vai como cause');
      assert.deepEqual(Object.keys(error.context).sort(), [
        'errorType',
        'provider',
        'retryable',
        'status',
      ]);
    }
  });

  it('erro de rede também não carrega nada do pedido', async () => {
    fake.always({ kind: 'drop' });
    const result = await makeProvider().generate({
      systemPrompt: SECRETS.persona,
      history: [],
      userMessage: SECRETS.contact,
    });
    assert.equal(result.ok, false);
    const everything = `${result.error.message}${inspect(result.error, { depth: 10 })}`;
    assert.ok(!everything.includes(SECRETS.contact));
    assert.ok(!everything.includes(SECRETS.persona));
    assert.ok(!everything.includes(API_KEY));
  });

  it('o SDK não escreve nada no console durante falhas e repetições', async () => {
    const written: string[] = [];
    const originals = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
      debug: console.debug,
    };
    const capture =
      () =>
      (...args: unknown[]): void => {
        written.push(args.map(String).join(' '));
      };
    console.log = capture();
    console.warn = capture();
    console.error = capture();
    console.info = capture();
    console.debug = capture();
    try {
      fake.always({ kind: 'error', status: 500, echoRequest: true });
      await makeProvider().generate({ ...input(), userMessage: SECRETS.contact });
    } finally {
      Object.assign(console, originals);
    }
    assert.deepEqual(written, []);
  });
});
