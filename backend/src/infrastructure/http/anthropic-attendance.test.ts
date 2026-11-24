import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import { ATTENDANCE_FALLBACK_TEXT } from '../../application/attendance/attendance.service.js';
import { CompanyService } from '../../application/companies/company.service.js';
import { Result } from '../../shared/types/index.js';
import { FakeAnthropicApi, textMessage } from '../../test-support/fake-anthropic-api.js';
import { InMemoryAttendanceStore } from '../../test-support/in-memory-attendance.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { AnthropicLlmProvider } from '../external-apis/llm/anthropic-llm.provider.js';
import { createMetrics } from '../metrics/index.js';
import { CompanyId } from '../../domain/index.js';
import { bearer, buildTestAuth } from '../../test-support/in-memory-auth.js';
import { buildServer } from './server.js';

/**
 * Spec 014, de ponta a ponta sem infraestrutura: rota administrativa -> AttendanceService ->
 * AnthropicLlmProvider (SDK real) -> servidor falso local. Nunca chama a API de verdade.
 */

const METRICS_TOKEN = `metrics-${randomUUID()}-${randomUUID()}`;
const API_KEY = `chave-falsa-${randomUUID()}`;
let auth: { authorization: string };
let membershipAuth: { authorization: string };

const SECRET_PERSONA = 'PERSONA-SECRETA-0a1b2c';
const SECRET_HISTORY = 'HISTORICO-SECRETO-3d4e5f';
const SECRET_CONTACT = 'CONTATO-SECRETO-5511988887777';

const fake = new FakeAnthropicApi();
let app: FastifyInstance;
let logs: ReturnType<typeof captureLogs>;
let companyId = '';

interface ReplyBody {
  reply: { text: string; isFallback: boolean };
}

async function startApp(options: { llmTimeoutMs?: number; maxRetries?: number } = {}) {
  const llmTimeoutMs = options.llmTimeoutMs ?? 400;
  logs = captureLogs();
  const companies = new InMemoryCompanyRepository();
  const store = new InMemoryAttendanceStore(() => new Date());
  const metrics = createMetrics();
  const testAuth = buildTestAuth({ logger: logs.logger, companies });
  app = buildServer({
    logger: logs.logger,
    metrics,
    metricsToken: METRICS_TOKEN,
    readiness: {
      database: () => Promise.resolve(Result.ok(undefined)),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    auth: testAuth.service,
    admin: {
      companies: new CompanyService(companies),
      attendance: new AttendanceService({
        companies,
        conversations: store.conversations,
        messages: store.messages,
        unitOfWork: store,
        llm: new AnthropicLlmProvider({
          apiKey: API_KEY,
          baseUrl: fake.baseUrl,
          model: 'claude-haiku-5-5',
          effort: 'low',
          maxOutputTokens: 1024,
          maxRetries: options.maxRetries ?? 1,
          timeoutMs: llmTimeoutMs,
        }),
        logger: logs.logger,
        metrics,
        options: { llmTimeoutMs, inFlightTimeoutMs: 60_000 },
      }),
    },
  });
  await app.ready();
  auth = bearer((await testAuth.platformToken()).accessToken);
  const created = await app.inject({
    method: 'POST',
    url: '/admin/companies',
    headers: auth,
    payload: { name: 'Empresa Teste', slug: 'empresa-014' },
  });
  companyId = created.json<{ id: string }>().id;
  membershipAuth = bearer((await testAuth.membershipToken(CompanyId.parse(companyId))).accessToken);
  // Spec 044 (D8): a persona só entra pela rota da própria empresa.
  const patched = await app.inject({
    method: 'PUT',
    url: `/admin/companies/${companyId}/persona`,
    headers: membershipAuth,
    payload: { persona: SECRET_PERSONA },
  });
  assert.equal(patched.statusCode, 200);
}

const send = (text: string, contactRef = 'c1') =>
  app.inject({
    method: 'POST',
    url: `/admin/companies/${companyId}/messages`,
    headers: membershipAuth,
    payload: { contactRef, text },
  });

async function metricsBody(): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  });
  assert.equal(response.statusCode, 200);
  return response.body;
}

before(async () => {
  await fake.start();
});
after(async () => {
  await fake.stop();
});
afterEach(async () => {
  fake.reset();
  await app.close();
});

describe('atendimento com o provedor Anthropic (servidor falso)', () => {
  it('sucesso: devolve a resposta do modelo, loga tokens como números e expõe llm_tokens_total', async () => {
    await startApp();
    fake.script(
      textMessage('Abrimos às 9h.', {
        usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100 },
      }),
    );
    const response = await send(SECRET_CONTACT);
    assert.equal(response.statusCode, 201);
    const body = response.json<ReplyBody>();
    assert.equal(body.reply.text, 'Abrimos às 9h.');
    assert.equal(body.reply.isFallback, false);

    // O pedido real ao modelo levou a persona primeiro, a instrução de estilo e o texto como `user`.
    const sent = fake.requests[0]?.body;
    assert.ok(typeof sent?.['system'] === 'string' && sent['system'].startsWith(SECRET_PERSONA));
    assert.deepEqual(sent['messages'], [{ role: 'user', content: SECRET_CONTACT }]);

    const line = logs.lines().find((l) => l['msg'] === 'mensagem atendida');
    assert.ok(line);
    assert.equal(line['inputTokens'], 120);
    assert.equal(line['outputTokens'], 30);
    assert.equal(line['cacheReadTokens'], 100);

    const metrics = await metricsBody();
    assert.match(metrics, /llm_requests_total\{provider="anthropic",result="ok"\} 1/);
    assert.match(metrics, /llm_tokens_total\{provider="anthropic",type="input"\} 120/);
    assert.match(metrics, /llm_tokens_total\{provider="anthropic",type="output"\} 30/);
    assert.match(metrics, /llm_tokens_total\{provider="anthropic",type="cache_read"\} 100/);
    assert.doesNotMatch(metrics, /(companyId|company_id)=/i, 'nenhum label de empresa');
    assert.ok(!metrics.includes(companyId), 'o id da empresa não aparece em /metrics');
    for (const secret of [SECRET_PERSONA, SECRET_CONTACT, API_KEY, 'Abrimos']) {
      assert.ok(!metrics.includes(secret), `${secret} apareceu em /metrics`);
      assert.ok(!logs.raw().includes(secret), `${secret} apareceu no log`);
    }
  });

  const cases: readonly (readonly [string, Parameters<FakeAnthropicApi['script']>[0], string])[] = [
    ['refusal', textMessage('não', { stopReason: 'refusal' }), 'refusal'],
    ['max_tokens', textMessage('meio', { stopReason: 'max_tokens' }), 'truncated'],
    ['pause_turn', textMessage('x', { stopReason: 'pause_turn' }), 'error'],
    ['resposta vazia', { kind: 'message', content: [] }, 'error'],
  ];
  for (const [label, behavior, result] of cases) {
    it(`${label}: o contato recebe o texto padrão e a métrica é ${result}`, async () => {
      await startApp();
      fake.always(behavior);
      const response = await send('oi');
      assert.equal(response.statusCode, 201);
      const body = response.json<ReplyBody>();
      assert.equal(body.reply.text, ATTENDANCE_FALLBACK_TEXT);
      assert.equal(body.reply.isFallback, true);
      assert.match(
        await metricsBody(),
        new RegExp(`llm_requests_total\\{provider="anthropic",result="${result}"\\} 1`),
      );
      assert.ok(!(await metricsBody()).includes('meio'));
    });
  }

  it('429 persistente: repete uma vez (LLM_MAX_RETRIES=1), cai no texto padrão e conta error', async () => {
    await startApp();
    fake.always({ kind: 'error', status: 429 });
    const response = await send('oi');
    assert.equal(response.json<ReplyBody>().reply.isFallback, true);
    assert.equal(fake.requests.length, 2);
    assert.match(
      await metricsBody(),
      /llm_requests_total\{provider="anthropic",result="error"\} 1/,
    );
    const warn = logs.lines().find((l) => String(l['msg']).startsWith('LLM sem resposta'));
    assert.ok(warn);
    assert.equal(warn['result'], 'error');
  });

  it('cancelamento real: o prazo estoura, o contato recebe o texto padrão e a conexão com o servidor é encerrada', async () => {
    await startApp({ llmTimeoutMs: 300 });
    fake.always({ kind: 'hang' });
    const started = Date.now();
    const response = await send(SECRET_CONTACT);
    assert.equal(response.statusCode, 201);
    assert.equal(response.json<ReplyBody>().reply.text, ATTENDANCE_FALLBACK_TEXT);
    assert.ok(Date.now() - started < 3_000, 'respondeu perto do prazo, não depois das repetições');

    assert.ok(await fake.waitForClientClose(1), 'o provedor não seguiu rodando: conexão encerrada');
    assert.match(
      await metricsBody(),
      /llm_requests_total\{provider="anthropic",result="timeout"\} 1/,
    );
    // Cancelado: o SDK não repete a chamada depois do prazo.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fake.requests.length, 1);
  });

  it('o prazo total do atendimento corta a soma das repetições (servidor lento nos dois pedidos)', async () => {
    await startApp({ llmTimeoutMs: 400, maxRetries: 3 });
    // O servidor só responde depois de 5 s: o prazo do atendimento (400 ms) corta tudo antes.
    fake.always({ kind: 'message', delayMs: 5_000 });
    const response = await send('oi');
    assert.equal(response.json<ReplyBody>().reply.isFallback, true);
    assert.match(
      await metricsBody(),
      /llm_requests_total\{provider="anthropic",result="timeout"\} 1/,
    );
    assert.ok(await fake.waitForClientClose(1));
  });

  it('privacidade: servidor que ecoa o pedido no erro não vaza persona, histórico, texto nem chave (log, resposta, métricas)', async () => {
    await startApp();
    // Primeiro turno com sucesso: vira histórico do segundo, que falha com o eco.
    fake.script(textMessage(SECRET_HISTORY));
    const first = await send(`${SECRET_CONTACT} primeiro`);
    assert.equal(first.statusCode, 201);
    fake.always({ kind: 'error', status: 500, echoRequest: true });
    const second = await send(`${SECRET_CONTACT} segundo`);
    assert.equal(second.statusCode, 201);
    const secondBody = second.json<ReplyBody>();
    assert.equal(secondBody.reply.isFallback, true);
    assert.ok(
      fake.requests.at(-1)?.raw.includes(SECRET_HISTORY),
      'o histórico foi enviado ao modelo',
    );

    const everywhere = [second.body, logs.raw(), await metricsBody()];
    for (const text of everywhere) {
      for (const secret of [SECRET_PERSONA, SECRET_CONTACT, API_KEY, 'pedido recebido']) {
        assert.ok(!text.includes(secret), `${secret} vazou`);
      }
    }
    // O texto de erro do SDK (e o histórico dentro dele) nunca chegam ao log.
    assert.ok(!logs.raw().includes(SECRET_HISTORY));
    assert.ok(!second.body.includes(SECRET_HISTORY));
    const failure = logs.lines().find((l) => String(l['msg']).startsWith('LLM sem resposta'));
    assert.ok(failure, 'a falha foi logada');
    assert.equal(failure['provider'], 'anthropic');
    const errField = failure['err'] as Record<string, unknown> | undefined;
    assert.ok(errField);
    assert.deepEqual(errField['context'], {
      provider: 'anthropic',
      status: 500,
      errorType: 'api_error',
      retryable: true,
    });
    assert.equal(errField['cause'], undefined);
  });
});
