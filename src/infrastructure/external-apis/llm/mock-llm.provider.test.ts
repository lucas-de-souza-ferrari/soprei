import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExternalServiceError } from '../../../shared/errors/index.js';
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
  it('LLM_PROVIDER=mock cria o MockLlmProvider', () => {
    const provider = createLlmProvider({ LLM_PROVIDER: 'mock' });
    assert.ok(provider instanceof MockLlmProvider);
  });
});
