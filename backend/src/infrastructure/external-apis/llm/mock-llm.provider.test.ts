import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExternalServiceError, ValidationError } from '../../../shared/errors/index.js';
import { parseConfig } from '../../config/parse-config.js';
import { AnthropicLlmProvider } from './anthropic-llm.provider.js';
import { createLlmProvider } from './create-llm-provider.js';
import {
  MOCK_EMPTY_MARKER,
  MOCK_FAIL_MARKER,
  MOCK_HANG_MARKER,
  MOCK_HUGE_MARKER,
  MockLlmProvider,
} from './mock-llm.provider.js';

const input = (userMessage: string, history = 0) => ({
  systemPrompt: 'Persona de teste',
  history: Array.from({ length: history }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `turno ${String(i)}`,
  })),
  userMessage,
});

describe('MockLlmProvider', () => {
  it('responde de forma determinística, citando persona e turnos de histórico', async () => {
    const mock = new MockLlmProvider();
    const first = await mock.generate(input('Olá', 3));
    const second = await mock.generate(input('Olá', 3));
    assert.deepEqual(first, second);
    assert.ok(first.ok);
    assert.equal(
      first.value.text,
      '[mock] Recebi: Olá (persona: "Persona de teste"; histórico: 3)',
    );
    assert.equal(mock.name, 'mock');
  });

  it('o eco é limitado, para a resposta caber sempre no limite de mensagem', async () => {
    const result = await new MockLlmProvider().generate(input('a'.repeat(4000)));
    assert.ok(result.ok);
    assert.ok(result.value.text.length < 4000);
  });

  it('não registra as entradas por padrão (nada de dado pessoal acumulando em memória)', async () => {
    const mock = new MockLlmProvider();
    await mock.generate(input('oi'));
    assert.equal(mock.calls.length, 0);
  });

  it('com recordCalls guarda as entradas recebidas, na ordem', async () => {
    const mock = new MockLlmProvider({ recordCalls: true });
    await mock.generate(input('um'));
    await mock.generate(input('dois', 2));
    assert.deepEqual(
      mock.calls.map((call) => call.userMessage),
      ['um', 'dois'],
    );
    assert.equal(mock.calls[1]?.history.length, 2);
  });

  it('modo de falha: marcador no texto devolve ExternalServiceError sem ecoar o texto', async () => {
    const result = await new MockLlmProvider().generate(input(`segredo ${MOCK_FAIL_MARKER}`));
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof ExternalServiceError);
    assert.ok(!result.error.message.includes('segredo'));
  });

  it('marcadores de resposta vazia e grande demais', async () => {
    const mock = new MockLlmProvider();
    const empty = await mock.generate(input(MOCK_EMPTY_MARKER));
    assert.ok(empty.ok);
    assert.equal(empty.value.text, '');
    const huge = await mock.generate(input(MOCK_HUGE_MARKER));
    assert.ok(huge.ok);
    assert.ok(huge.value.text.length > 4000);
  });

  it('marcador de travamento nunca resolve', async () => {
    const mock = new MockLlmProvider();
    const outcome = await Promise.race([
      mock.generate(input(MOCK_HANG_MARKER)).then(() => 'respondeu'),
      new Promise((resolve) =>
        setTimeout(() => {
          resolve('travado');
        }, 30),
      ),
    ]);
    assert.equal(outcome, 'travado');
  });

  it('marcador de travamento termina com erro de prazo quando a chamada é abortada (e se já veio abortada)', async () => {
    const mock = new MockLlmProvider();
    const controller = new AbortController();
    const pending = mock.generate(input(MOCK_HANG_MARKER), { signal: controller.signal });
    controller.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.context['errorType'], 'timeout');

    const already = await mock.generate(input(MOCK_HANG_MARKER), { signal: AbortSignal.abort() });
    assert.equal(already.ok, false);
  });

  it('hold() segura as chamadas até a liberação', async () => {
    const mock = new MockLlmProvider({ recordCalls: true });
    const release = mock.hold();
    let done = false;
    const pending = mock.generate(input('oi')).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(done, false);
    assert.equal(mock.calls.length, 1);
    release();
    await pending;
    assert.equal(done, true);
  });
});

describe('createLlmProvider', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379/0',
    JWT_SECRET: 'j'.repeat(32),
  };

  it('LLM_PROVIDER=mock cria o MockLlmProvider', () => {
    const parsed = parseConfig({ ...base, LLM_PROVIDER: 'mock' });
    assert.ok(parsed.ok);
    assert.ok(createLlmProvider(parsed.value) instanceof MockLlmProvider);
  });

  it('LLM_PROVIDER=anthropic cria o AnthropicLlmProvider (sem chamar a rede)', () => {
    const parsed = parseConfig({
      ...base,
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'chave-de-teste-com-mais-de-20-caracteres',
    });
    assert.ok(parsed.ok);
    const provider = createLlmProvider(parsed.value);
    assert.ok(provider instanceof AnthropicLlmProvider);
    assert.equal(provider.name, 'anthropic');
  });

  it('anthropic sem chave (config inconsistente) falha com ValidationError tipado, sem valor', () => {
    const parsed = parseConfig({
      ...base,
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'chave-de-teste-com-mais-de-20-caracteres',
    });
    assert.ok(parsed.ok);
    assert.throws(
      () => createLlmProvider({ ...parsed.value, ANTHROPIC_API_KEY: undefined }),
      (error: unknown) =>
        error instanceof ValidationError && error.context['variable'] === 'ANTHROPIC_API_KEY',
    );
  });
});

describe('MockLlmProvider roteirizado com ferramentas (spec 028)', () => {
  const OK = { content: 'ok: resultado', isError: false };
  const tools = (executed: string[] = []) => ({
    definitions: [{ name: 'listar_horarios', description: 'd', inputSchema: { type: 'object' } }],
    execute: (call: { name: string; input: unknown }) => {
      executed.push(`${call.name}:${JSON.stringify(call.input)}`);
      return Promise.resolve(OK);
    },
    limits: { maxModelCalls: 4, maxToolCalls: 6 },
  });

  it('sem roteiro, ou sem ferramentas, comporta-se como hoje', async () => {
    const mock = new MockLlmProvider();
    const plain = await mock.generate(input('Olá'));
    const offered = await mock.generate(input('Olá'), { tools: tools() });
    assert.deepEqual(plain, offered);
    mock.scriptTools({ rounds: [], finalText: 'roteiro' });
    // O roteiro só vale quando o turno oferece ferramentas.
    assert.deepEqual(await mock.generate(input('Olá')), plain);
    const scripted = await mock.generate(input('Olá'), { tools: tools() });
    assert.ok(scripted.ok);
    assert.equal(scripted.value.text, 'roteiro');
  });

  it('emite a sequência, chama o executor e devolve o texto final (que vê os resultados)', async () => {
    const executed: string[] = [];
    const mock = new MockLlmProvider();
    mock.scriptTools({
      rounds: [
        [{ name: 'listar_horarios', input: { servico: 'a' } }],
        [
          { name: 'listar_horarios', input: { servico: 'b' } },
          { name: 'listar_horarios', input: { servico: 'c' } },
        ],
      ],
      finalText: (outputs) => `final com ${String(outputs.length)} resultados`,
    });
    const result = await mock.generate(input('x'), { tools: tools(executed) });
    assert.ok(result.ok);
    assert.equal(result.value.text, 'final com 3 resultados');
    assert.equal(result.value.toolRounds, 2);
    assert.equal(result.value.toolCalls, 3);
    assert.deepEqual(executed, [
      'listar_horarios:{"servico":"a"}',
      'listar_horarios:{"servico":"b"}',
      'listar_horarios:{"servico":"c"}',
    ]);
  });

  it('respeita os tetos como o provedor real: rodadas, chamadas e prazo', async () => {
    const mock = new MockLlmProvider();
    const call = { name: 'listar_horarios', input: {} };
    mock.scriptTools({ rounds: [[call], [call], [call], [call]], finalText: 'x' });
    const capped = await mock.generate(input('x'), { tools: tools() });
    assert.equal(capped.ok, false);
    assert.equal(capped.error.context['errorType'], 'tool_round_cap');

    const executed: string[] = [];
    mock.scriptTools({
      rounds: [Array.from({ length: 7 }, () => call)],
      finalText: (outputs) => outputs.at(-1)?.content ?? '',
    });
    const limited = await mock.generate(input('x'), { tools: tools(executed) });
    assert.ok(limited.ok);
    assert.match(limited.value.text, /^limite_turno:/);
    assert.equal(executed.length, 6);

    mock.scriptTools({ rounds: [[call]], finalText: 'x' });
    const late = await mock.generate(input('x'), {
      tools: tools(),
      signal: AbortSignal.abort(),
    });
    assert.equal(late.ok, false);
    assert.equal(late.error.context['errorType'], 'timeout');
  });

  it('registra os nomes das ferramentas oferecidas (só com recordCalls)', async () => {
    const mock = new MockLlmProvider({ recordCalls: true });
    await mock.generate(input('a'));
    await mock.generate(input('b'), { tools: tools() });
    assert.deepEqual(mock.toolsOffered, [undefined, ['listar_horarios']]);
  });
});
