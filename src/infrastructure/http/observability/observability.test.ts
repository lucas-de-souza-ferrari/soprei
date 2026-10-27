import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ClientService } from '../../../application/clients/client.service.js';
import { BaseError } from '../../../shared/errors/index.js';
import { setClientId } from '../../../shared/request-context/index.js';
import { Result } from '../../../shared/types/index.js';
import { InMemoryClientRepository } from '../../../test-support/in-memory-client.repository.js';
import { captureLogs, type LogCapture, type LogLine } from '../../../test-support/log-capture.js';
import { createMetrics, type Metrics } from '../../metrics/index.js';
import { buildServer } from '../server.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const ALL_UP = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const END_MESSAGE = 'requisição concluída';

interface Harness {
  readonly app: FastifyInstance;
  readonly capture: LogCapture;
  readonly metrics: Metrics;
}

/** Serviço de mentira: usa o logger RAIZ (não o `request.log`), depois de um `await`. */
async function fakeService(capture: LogCapture, label: string, delayMs: number): Promise<void> {
  await sleep(delayMs);
  capture.logger.info({ label }, 'service depois do await');
}

class BoomError extends BaseError {
  constructor() {
    super({ message: 'falha de teste', code: 'BOOM', statusCode: 500 });
  }
}

function numberHeader(value: string | string[] | undefined): number {
  return typeof value === 'string' ? Number(value) : 0;
}

function buildHarness(options: { admin?: string; metricsToken?: string } = {}): Harness {
  const capture = captureLogs();
  const metrics = createMetrics();
  const app = buildServer({
    logger: capture.logger,
    readiness: ALL_UP,
    metrics,
    ...(options.metricsToken === undefined ? {} : { metricsToken: options.metricsToken }),
    ...(options.admin === undefined
      ? {}
      : {
          admin: {
            apiKey: options.admin,
            clients: new ClientService(new InMemoryClientRepository()),
          },
        }),
  });

  // Hook de teste: define o cliente (como a autenticação fará) e loga depois de um await.
  app.addHook('preHandler', async (request) => {
    const clientId = request.headers['x-test-client'];
    if (typeof clientId === 'string') setClientId(clientId);
    await sleep(numberHeader(request.headers['x-test-hook-delay']));
    capture.logger.info({ label: 'hook' }, 'hook depois do await');
  });

  app.get('/test/work', async (request) => {
    await fakeService(capture, 'work', numberHeader(request.headers['x-test-handler-delay']));
    return { ok: true };
  });
  app.post('/test/work', async (request) => {
    await fakeService(capture, 'work', numberHeader(request.headers['x-test-handler-delay']));
    return { ok: true, echo: request.body };
  });
  app.get('/test/boom', async () => {
    await sleep(5);
    throw new BoomError();
  });
  app.get('/test/set-client', async () => {
    setClientId('client-from-handler');
    await sleep(5);
    return { ok: true };
  });
  app.get('/test/boom-with-client', async () => {
    setClientId('client-from-handler');
    await sleep(5);
    throw new BoomError();
  });
  app.get('/test/items/:id', () => ({ ok: true }));
  return { app, capture, metrics };
}

function byRequestId(lines: readonly LogLine[], requestId: string): LogLine[] {
  return lines.filter((line) => line.requestId === requestId);
}

function endLine(lines: readonly LogLine[], requestId: string): LogLine | undefined {
  return byRequestId(lines, requestId).find((line) => line.msg === END_MESSAGE);
}

describe('contexto por requisição (inject)', () => {
  let h: Harness;
  before(async () => {
    h = buildHarness();
    await h.app.ready();
  });
  after(async () => {
    await h.app.close();
  });

  it('duas requisições concorrentes, com atrasos intercalados, não misturam requestId nem clientId', async () => {
    const idA = 'req-aaaaaaaa-0001';
    const idB = 'req-bbbbbbbb-0002';
    const [a, b] = await Promise.all([
      h.app.inject({
        method: 'GET',
        url: '/test/work',
        headers: {
          'x-request-id': idA,
          'x-test-client': 'client-A',
          'x-test-hook-delay': '40',
          'x-test-handler-delay': '10',
        },
      }),
      h.app.inject({
        method: 'GET',
        url: '/test/work',
        headers: {
          'x-request-id': idB,
          'x-test-client': 'client-B',
          'x-test-hook-delay': '5',
          'x-test-handler-delay': '50',
        },
      }),
    ]);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);

    for (const [id, client] of [
      [idA, 'client-A'],
      [idB, 'client-B'],
    ] as const) {
      const lines = byRequestId(h.capture.lines(), id);
      assert.deepEqual(
        lines.map((line) => line.label ?? line.msg),
        ['hook', 'work', END_MESSAGE],
        `logs de ${id}`,
      );
      for (const line of lines) {
        assert.equal(line.clientId, client, `clientId errado em ${JSON.stringify(line)}`);
        assert.equal(line.operation, 'GET /test/work');
      }
    }
    // Nenhum log de aplicação ficou sem requestId (o mixin cobre o logger raiz).
    const orphans = h.capture
      .lines()
      .filter((line) => (line.label === 'hook' || line.label === 'work') && !line.requestId);
    assert.deepEqual(orphans, []);
  });

  it('não repete a chave requestId no JSON do log (mixin + binding do Fastify)', () => {
    const raw = h.capture.raw().split('\n').filter(Boolean);
    assert.ok(raw.length > 0);
    for (const line of raw) {
      assert.equal(line.split('"requestId"').length - 1, 1, line);
    }
  });

  it('o contexto definido no handler chega ao log de requisição', async () => {
    const id = 'req-setclient-0001';
    const response = await h.app.inject({
      method: 'GET',
      url: '/test/set-client',
      headers: { 'x-request-id': id },
    });
    assert.equal(response.statusCode, 200);
    const done = endLine(h.capture.lines(), id);
    assert.ok(done);
    assert.equal(done.clientId, 'client-from-handler');
    assert.equal(done.operation, 'GET /test/set-client');
  });

  it('o contexto chega ao log do error handler quando o handler lança', async () => {
    const id = 'req-boom-0001';
    const response = await h.app.inject({
      method: 'GET',
      url: '/test/boom-with-client',
      headers: { 'x-request-id': id },
    });
    assert.equal(response.statusCode, 500);
    const lines = byRequestId(h.capture.lines(), id);
    const errorLog = lines.find((line) => line.msg === 'erro de aplicação');
    assert.ok(errorLog, 'esperava o log do error handler');
    assert.equal(errorLog.clientId, 'client-from-handler');
    assert.equal(errorLog.operation, 'GET /test/boom-with-client');
    const done = endLine(h.capture.lines(), id);
    assert.ok(done);
    assert.equal(done.clientId, 'client-from-handler');
    assert.equal(done.statusCode, 500);
    assert.equal(done.level, 50);
  });
});

describe('contexto por requisição (servidor HTTP real, corpo e keep-alive)', () => {
  let h: Harness;
  let baseUrl: string;
  before(async () => {
    h = buildHarness();
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${String((h.app.server.address() as AddressInfo).port)}`;
  });
  after(async () => {
    await h.app.close();
  });

  const post = (
    id: string,
    client: string,
    hookDelay: number,
    handlerDelay: number,
  ): Promise<Response> =>
    fetch(`${baseUrl}/test/work`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': id,
        'x-test-client': client,
        'x-test-hook-delay': String(hookDelay),
        'x-test-handler-delay': String(handlerDelay),
      },
      body: JSON.stringify({ client }),
    });

  it('POST concorrentes com corpo (o parse do corpo roda fora do als.run) mantêm o contexto', async () => {
    for (const round of [0, 1, 2]) {
      const idA = `req-post-a-${String(round)}-xxxx`;
      const idB = `req-post-b-${String(round)}-xxxx`;
      const [a, b] = await Promise.all([
        post(idA, 'client-A', 30, 10),
        post(idB, 'client-B', 5, 40),
      ]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      for (const [id, client] of [
        [idA, 'client-A'],
        [idB, 'client-B'],
      ] as const) {
        const lines = byRequestId(h.capture.lines(), id);
        assert.deepEqual(
          lines.map((line) => line.label ?? line.msg),
          ['hook', 'work', END_MESSAGE],
          `logs de ${id}`,
        );
        for (const line of lines) {
          assert.equal(line.clientId, client, JSON.stringify(line));
          assert.equal(line.operation, 'POST /test/work');
        }
      }
    }
  });

  it('corpo malformado (erro do parse) também sai com requestId e operation no log', async () => {
    const id = 'req-badjson-0001';
    const response = await fetch(`${baseUrl}/test/work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': id },
      body: '{ invalido',
    });
    assert.equal(response.status, 400);
    const lines = byRequestId(h.capture.lines(), id);
    assert.ok(lines.length >= 2);
    for (const line of lines) assert.equal(line.operation, 'POST /test/work');
  });
});

describe('request id', () => {
  let h: Harness;
  before(async () => {
    h = buildHarness();
    await h.app.ready();
  });
  after(async () => {
    await h.app.close();
  });

  it('reaproveita x-request-id válido e o devolve no header', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'abc.DEF_123-456' },
    });
    assert.equal(response.headers['x-request-id'], 'abc.DEF_123-456');
    assert.ok(byRequestId(h.capture.lines(), 'abc.DEF_123-456').length > 0);
  });

  const invalid: readonly (readonly [string, string])[] = [
    ['curto', 'abc123'],
    ['com espaço', 'abc def 12345'],
    ['longo demais', 'a'.repeat(129)],
    ['com caractere inválido', 'abc/def/12345'],
    ['vazio', ''],
  ];
  for (const [label, value] of invalid) {
    it(`substitui x-request-id inválido (${label}) por UUID`, async () => {
      const response = await h.app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': value },
      });
      const header = response.headers['x-request-id'];
      assert.equal(typeof header, 'string');
      assert.match(header as string, UUID);
    });
  }

  it('x-request-id repetido (não string) é tratado como inválido', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': ['aaaaaaaa-1111', 'bbbbbbbb-2222'] as unknown as string },
    });
    assert.match(response.headers['x-request-id'] as string, UUID);
  });

  it('sem o header, gera UUID; o requestId do corpo de erro é o mesmo do header', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/nao-existe' });
    assert.equal(response.statusCode, 404);
    const header = response.headers['x-request-id'] as string;
    assert.match(header, UUID);
    assert.equal(response.json<{ error: { requestId: string } }>().error.requestId, header);
  });

  it('o requestId do header também é o do erro 5xx e do log', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/test/boom',
      headers: { 'x-request-id': 'req-erro-12345' },
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.headers['x-request-id'], 'req-erro-12345');
    assert.equal(
      response.json<{ error: { requestId: string } }>().error.requestId,
      'req-erro-12345',
    );
    assert.ok(endLine(h.capture.lines(), 'req-erro-12345'));
  });
});

describe('log de requisição', () => {
  const KEY = `k-${randomUUID()}-${randomUUID()}`;
  let h: Harness;
  before(async () => {
    h = buildHarness({ admin: KEY });
    await h.app.ready();
  });
  after(async () => {
    await h.app.close();
  });

  it('usa o padrão da rota, nunca o id real, com método, status e duração', async () => {
    const id = randomUUID();
    const response = await h.app.inject({
      method: 'GET',
      url: `/admin/clients/${id}`,
      headers: { authorization: `Bearer ${KEY}`, 'x-request-id': 'req-route-0001' },
    });
    assert.equal(response.statusCode, 404);
    const line = endLine(h.capture.lines(), 'req-route-0001');
    assert.ok(line);
    assert.equal(line.route, '/admin/clients/:id');
    assert.equal(line.method, 'GET');
    assert.equal(line.statusCode, 404);
    assert.equal(typeof line.durationMs, 'number');
    assert.equal(line.operation, 'GET /admin/clients/:id');
    assert.equal(line.level, 40);
    assert.ok(!h.capture.raw().includes(id), 'o id real da URL não pode aparecer no log');
  });

  it('a rota "/" do prefixo aparece sem barra final', async () => {
    await h.app.inject({
      method: 'GET',
      url: '/admin/clients',
      headers: { authorization: `Bearer ${KEY}`, 'x-request-id': 'req-list-00001' },
    });
    const line = endLine(h.capture.lines(), 'req-list-00001');
    assert.ok(line);
    assert.equal(line.route, '/admin/clients');
    assert.equal(line.level, 30);
  });

  it('níveis: 2xx info, 4xx warn, 5xx error', async () => {
    await h.app.inject({
      method: 'GET',
      url: '/test/items/1',
      headers: { 'x-request-id': 'req-lvl-200-01' },
    });
    await h.app.inject({
      method: 'GET',
      url: '/nada',
      headers: { 'x-request-id': 'req-lvl-404-01' },
    });
    await h.app.inject({
      method: 'GET',
      url: '/test/boom',
      headers: { 'x-request-id': 'req-lvl-500-01' },
    });
    assert.equal(endLine(h.capture.lines(), 'req-lvl-200-01')?.level, 30);
    assert.equal(endLine(h.capture.lines(), 'req-lvl-404-01')?.level, 40);
    assert.equal(endLine(h.capture.lines(), 'req-lvl-500-01')?.level, 50);
  });

  it('/health e /health/ready logam em debug', async () => {
    await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-health-001' },
    });
    await h.app.inject({
      method: 'GET',
      url: '/health/ready',
      headers: { 'x-request-id': 'req-ready-0001' },
    });
    for (const id of ['req-health-001', 'req-ready-0001']) {
      assert.equal(endLine(h.capture.lines(), id)?.level, 20, id);
    }
  });

  it('com nível info, a requisição de /health não gera linha nenhuma', async () => {
    const quiet = captureLogs('info');
    const app = buildServer({ logger: quiet.logger, readiness: ALL_UP });
    await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    assert.deepEqual(quiet.lines(), []);
  });
});

describe('redação de segredos', () => {
  const KEY = `k-${randomUUID()}-${randomUUID()}`;

  it('campos sensíveis saem como [Redacted], na raiz e aninhados', () => {
    const capture = captureLogs();
    const secrets = {
      authorization: 'Bearer segredo-1',
      cookie: 'sid=segredo-2',
      password: 'segredo-3',
      refreshToken: 'segredo-4',
      accessToken: 'segredo-5',
      token: 'segredo-6',
      apiKey: 'segredo-7',
    };
    capture.logger.info({ ...secrets, visivel: 'ok' }, 'raiz');
    capture.logger.info({ dados: secrets, visivel: 'ok' }, 'aninhado');
    capture.logger.info(
      {
        req: { headers: { authorization: 'Bearer segredo-8', cookie: 'sid=segredo-9' } },
        headers: { authorization: 'Bearer segredo-10', cookie: 'sid=segredo-11' },
      },
      'cabeçalhos',
    );

    const [root, nested, headers] = capture.lines();
    for (const key of Object.keys(secrets)) {
      assert.equal(root?.[key], '[Redacted]', `raiz.${key}`);
      assert.equal((nested?.dados as Record<string, unknown>)[key], '[Redacted]', `dados.${key}`);
    }
    assert.equal(root?.visivel, 'ok');
    const req = headers?.req as { headers: Record<string, unknown> };
    const top = headers?.headers as Record<string, unknown>;
    assert.equal(req.headers.authorization, '[Redacted]');
    assert.equal(req.headers.cookie, '[Redacted]');
    assert.equal(top.authorization, '[Redacted]');
    assert.equal(top.cookie, '[Redacted]');
    assert.ok(!capture.raw().includes('segredo-'));
  });

  it('a chave de admin usada numa requisição (certa ou errada) não aparece em nenhuma linha', async () => {
    const h = buildHarness({ admin: KEY });
    await h.app.ready();
    await h.app.inject({
      method: 'GET',
      url: '/admin/clients',
      headers: { authorization: `Bearer ${KEY}` },
    });
    await h.app.inject({
      method: 'GET',
      url: '/admin/clients',
      headers: { authorization: `Bearer ${KEY}-errada`, cookie: `sid=${KEY}` },
    });
    await h.app.inject({ method: 'GET', url: '/admin/clients' });
    await h.app.close();

    const raw = h.capture.raw();
    assert.ok(raw.length > 0);
    assert.ok(!raw.includes(KEY), 'a chave apareceu no log');
    const refused = h.capture
      .lines()
      .filter((line) => line.msg === 'acesso administrativo recusado');
    assert.equal(refused.length, 2);
    for (const line of refused) assert.equal(line.route, '/admin/clients');
  });
});

describe('GET /metrics e métricas HTTP', () => {
  const TOKEN = `m-${randomUUID()}-${randomUUID()}`;
  const KEY = `k-${randomUUID()}-${randomUUID()}`;
  const bearer = { authorization: `Bearer ${TOKEN}` };

  it('sem METRICS_TOKEN a rota não existe (404), com ou sem Authorization', async () => {
    const h = buildHarness();
    await h.app.ready();
    const plain = await h.app.inject({ method: 'GET', url: '/metrics' });
    const withAuth = await h.app.inject({ method: 'GET', url: '/metrics', headers: bearer });
    await h.app.close();
    assert.equal(plain.statusCode, 404);
    assert.equal(withAuth.statusCode, 404);
  });

  it('token vazio vale como ausente', async () => {
    const h = buildHarness({ metricsToken: '' });
    await h.app.ready();
    const response = await h.app.inject({ method: 'GET', url: '/metrics' });
    await h.app.close();
    assert.equal(response.statusCode, 404);
  });

  it('401 sem token ou com token errado; 200 com o certo', async () => {
    const h = buildHarness({ metricsToken: TOKEN });
    await h.app.ready();
    const none = await h.app.inject({ method: 'GET', url: '/metrics' });
    const wrong = await h.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}x` },
    });
    const basic = await h.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Basic ${TOKEN}` },
    });
    await h.app.inject({ method: 'GET', url: '/health' });
    const ok = await h.app.inject({ method: 'GET', url: '/metrics', headers: bearer });
    await h.app.close();

    assert.equal(none.statusCode, 401);
    assert.equal(wrong.statusCode, 401);
    assert.equal(basic.statusCode, 401);
    assert.equal(ok.statusCode, 200);
    assert.match(String(ok.headers['content-type']), /^text\/plain/);
    assert.match(ok.body, /http_requests_total/);
    assert.match(ok.body, /process_cpu_user_seconds_total/);
    assert.ok(!h.capture.raw().includes(TOKEN), 'o token apareceu no log');
    const refused = h.capture.lines().filter((line) => line.msg === 'acesso a /metrics recusado');
    assert.equal(refused.length, 3);
  });

  it('label route é o padrão (não o UUID) e "unmatched" para rota inexistente; /metrics não conta a si mesmo', async () => {
    const h = buildHarness({ metricsToken: TOKEN, admin: KEY });
    await h.app.ready();
    const admin = { authorization: `Bearer ${KEY}` };
    await h.app.inject({ method: 'GET', url: `/admin/clients/${randomUUID()}`, headers: admin });
    await h.app.inject({ method: 'GET', url: `/admin/clients/${randomUUID()}`, headers: admin });
    await h.app.inject({ method: 'GET', url: '/rota/que/nao/existe/1' });
    await h.app.inject({ method: 'GET', url: '/rota/que/nao/existe/2' });
    await h.app.inject({ method: 'GET', url: '/metrics', headers: bearer });
    const response = await h.app.inject({ method: 'GET', url: '/metrics', headers: bearer });
    await h.app.close();

    const body = response.body;
    assert.match(
      body,
      /http_requests_total\{method="GET",route="\/admin\/clients\/:id",status_class="4xx"\} 2/,
    );
    assert.match(
      body,
      /http_requests_total\{method="GET",route="unmatched",status_class="4xx"\} 2/,
    );
    assert.doesNotMatch(body, /route="\/metrics"/);
    assert.doesNotMatch(body, UUID_ANYWHERE);
    assert.doesNotMatch(body, /clientId/i);
    assert.match(body, /http_request_duration_seconds_bucket\{le="0\.005"/);
    assert.match(body, /http_request_duration_seconds_bucket\{le="10"/);
  });

  it('401 em /admin entra com o padrão da rota, não com a URL', async () => {
    const h = buildHarness({ metricsToken: TOKEN, admin: KEY });
    await h.app.ready();
    await h.app.inject({ method: 'GET', url: `/admin/clients/${randomUUID()}` });
    const response = await h.app.inject({ method: 'GET', url: '/metrics', headers: bearer });
    await h.app.close();
    assert.match(
      response.body,
      /http_requests_total\{method="GET",route="\/admin\/clients\/:id",status_class="4xx"\} 1/,
    );
  });
});

describe('falha de métrica', () => {
  it('uma falha forçada ao registrar métrica não muda status nem corpo da resposta', async () => {
    const capture = captureLogs();
    const metrics = createMetrics();
    metrics.observeHttpRequest = () => {
      throw new Error('métrica quebrada de propósito');
    };
    const app = buildServer({ logger: capture.logger, readiness: ALL_UP, metrics });
    app.get('/test/ok', () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/test/ok' });
    const missing = await app.inject({ method: 'GET', url: '/nao-existe' });
    await app.close();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
    assert.equal(missing.statusCode, 404);
    const warnings = capture
      .lines()
      .filter((line) => line.msg === 'falha ao registrar métrica HTTP');
    assert.equal(warnings.length, 2);
    assert.equal(warnings[0]?.level, 40);
  });
});

describe('requisição abortada pelo cliente', () => {
  it('o log e a métrica de fim saem uma única vez', async () => {
    const capture = captureLogs();
    const metrics = createMetrics();
    const app = buildServer({ logger: capture.logger, readiness: ALL_UP, metrics });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.get('/test/lento', async () => {
      await gate;
      return { ok: true };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${String(port)}/test/lento`, {
      headers: { 'x-request-id': 'req-abort-0001' },
      signal: controller.signal,
    }).catch(() => undefined);
    await sleep(100);
    controller.abort();
    await pending;
    await sleep(100);
    release();
    await sleep(100);
    await app.close();

    const ends = byRequestId(capture.lines(), 'req-abort-0001').filter(
      (line) => line.msg === END_MESSAGE,
    );
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.statusCode, 499);
    assert.equal(ends[0].route, '/test/lento');
    assert.equal(ends[0].operation, 'GET /test/lento');
    assert.match(
      await metrics.render(),
      /http_requests_total\{method="GET",route="\/test\/lento",status_class="4xx"\} 1/,
    );
  });
});
