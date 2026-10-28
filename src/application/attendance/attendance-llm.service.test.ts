import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MockLlmProvider } from '../../infrastructure/external-apis/llm/mock-llm.provider.js';
import { ExternalServiceError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryClientRepository } from '../../test-support/in-memory-client.repository.js';
import { keepEventLoopAlive } from '../../test-support/keep-alive.js';
import { captureLogs } from '../../test-support/log-capture.js';
import {
  ATTENDANCE_FALLBACK_TEXT,
  ATTENDANCE_STYLE_INSTRUCTION,
  AttendanceService,
  buildSystemPrompt,
  type AttendanceMetrics,
  type LlmRequestResult,
  type LlmTokenType,
} from './attendance.service.js';
import type {
  LlmGenerateInput,
  LlmGenerateOptions,
  LlmProvider,
  LlmReply,
} from '../ports/llm-provider.js';

/** Spec 014: cancelamento por AbortSignal, tokens (usage), resultados novos e instrução de estilo. */

class FakeMetrics implements AttendanceMetrics {
  readonly llm: LlmRequestResult[] = [];
  readonly tokens: { type: LlmTokenType; tokens: number }[] = [];
  observeLlmRequest(sample: { result: LlmRequestResult }): void {
    this.llm.push(sample.result);
  }
  observeLlmTokens(sample: { type: LlmTokenType; tokens: number }): void {
    this.tokens.push({ type: sample.type, tokens: sample.tokens });
  }
  countAttendanceFallback(): void {
    // não interessa aqui
  }
}

/** Provedor programável: guarda o sinal recebido e responde como o teste mandar. */
class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly signals: (AbortSignal | undefined)[] = [];
  constructor(
    private readonly script: (
      input: LlmGenerateInput,
      options: LlmGenerateOptions | undefined,
    ) => Promise<Result<LlmReply, ExternalServiceError>>,
  ) {}
  generate(
    input: LlmGenerateInput,
    options?: LlmGenerateOptions,
  ): Promise<Result<LlmReply, ExternalServiceError>> {
    this.signals.push(options?.signal);
    return this.script(input, options);
  }
}

async function run(provider: LlmProvider, llmTimeoutMs = 1_000, text = 'oi') {
  const clients = new InMemoryClientRepository();
  const store = new InMemoryAttendanceStore(() => new Date());
  const metrics = new FakeMetrics();
  const logs = captureLogs();
  const service = new AttendanceService({
    clients,
    conversations: store.conversations,
    messages: store.messages,
    unitOfWork: store,
    llm: provider,
    logger: logs.logger,
    metrics,
    options: { llmTimeoutMs, inFlightTimeoutMs: 60_000 },
  });
  const client = await clients.create({ name: 'Empresa', slug: 'empresa-llm' });
  const result = await service.handleInboundMessage(client.id, { contactRef: 'c1', text });
  return { result, metrics, logs };
}

describe('AttendanceService: cancelamento, tokens e estilo (spec 014)', () => {
  it('passa um AbortSignal ao provedor e o aborta ao terminar a chamada', async () => {
    const provider = new ScriptedProvider(() => Promise.resolve(Result.ok({ text: 'olá' })));
    await run(provider);
    const signal = provider.signals[0];
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, true);
  });

  it('aborta o sinal quando o prazo estoura e responde o texto padrão com resultado timeout', async (t) => {
    t.after(keepEventLoopAlive());
    let aborted = false;
    const provider = new ScriptedProvider((_input, options) => {
      const signal = options?.signal;
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          resolve(Result.err(new ExternalServiceError('cancelada')));
        });
      });
    });
    const { result, metrics } = await run(provider, 30);
    assert.equal(result.reply.text, ATTENDANCE_FALLBACK_TEXT);
    assert.deepEqual(metrics.llm, ['timeout']);
    assert.equal(aborted, true, 'o provedor foi cancelado');
  });

  it('erro do provedor com errorType refusal ou max_tokens vira resultado refusal ou truncated', async () => {
    for (const [errorType, expected] of [
      ['refusal', 'refusal'],
      ['max_tokens', 'truncated'],
      ['rate_limit_error', 'error'],
    ] as const) {
      const provider = new ScriptedProvider(() =>
        Promise.resolve(Result.err(new ExternalServiceError('x', { context: { errorType } }))),
      );
      const { result, metrics } = await run(provider);
      assert.equal(result.reply.isFallback, true);
      assert.deepEqual(metrics.llm, [expected]);
    }
  });

  it('registra usage como números no log e na métrica de tokens, sem texto', async () => {
    const secret = 'TEXTO-SECRETO-USAGE';
    const provider = new ScriptedProvider(() =>
      Promise.resolve(
        Result.ok({
          text: 'resposta',
          usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100 },
        }),
      ),
    );
    const { metrics, logs } = await run(provider, 1_000, secret);
    assert.deepEqual(metrics.tokens, [
      { type: 'input', tokens: 120 },
      { type: 'output', tokens: 30 },
      { type: 'cache_read', tokens: 100 },
    ]);
    const line = logs.lines().find((l) => l['msg'] === 'mensagem atendida');
    assert.ok(line);
    assert.equal(line['inputTokens'], 120);
    assert.equal(line['outputTokens'], 30);
    assert.equal(line['cacheReadTokens'], 100);
    assert.ok(!logs.raw().includes(secret));
  });

  it('o mock continua sem usage: nenhuma métrica de tokens', async () => {
    const { metrics } = await run(new MockLlmProvider());
    assert.deepEqual(metrics.tokens, []);
  });

  it('o log de falha do LLM carrega só o erro seguro do provedor (nada do texto)', async () => {
    const secret = 'SEGREDO-NO-ERRO';
    const provider = new ScriptedProvider(() =>
      Promise.resolve(
        Result.err(
          new ExternalServiceError('Falha fixa', {
            context: { provider: 'scripted', status: 500, errorType: 'api_error', retryable: true },
          }),
        ),
      ),
    );
    const { logs } = await run(provider, 1_000, secret);
    assert.ok(!logs.raw().includes(secret));
    assert.ok(logs.lines().some((l) => String(l['msg']).startsWith('LLM sem resposta')));
  });

  it('buildSystemPrompt: persona primeiro, instrução de estilo depois; o texto do contato nunca entra', async () => {
    const withPersona = buildSystemPrompt({ name: 'Empresa', persona: 'Persona-X' });
    assert.ok(withPersona.startsWith('Persona-X'));
    assert.ok(withPersona.endsWith(ATTENDANCE_STYLE_INSTRUCTION));
    assert.ok(withPersona.indexOf('Persona-X') < withPersona.indexOf(ATTENDANCE_STYLE_INSTRUCTION));

    const fallback = buildSystemPrompt({ name: 'Empresa', persona: null });
    assert.ok(fallback.includes('Empresa'));
    assert.ok(fallback.endsWith(ATTENDANCE_STYLE_INSTRUCTION));

    const mock = new MockLlmProvider({ recordCalls: true });
    await run(mock, 1_000, 'TEXTO-DO-CONTATO');
    assert.ok(!mock.calls[0]?.systemPrompt.includes('TEXTO-DO-CONTATO'));
    assert.equal(mock.calls[0]?.userMessage, 'TEXTO-DO-CONTATO');
  });
});
