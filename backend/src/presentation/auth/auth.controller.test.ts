import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ClientService } from '../../application/clients/client.service.js';
import type { ClientId } from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics, type Metrics } from '../../infrastructure/metrics/index.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import {
  bearer,
  buildTestAuth,
  InMemorySessionStore,
  type TestAuth,
  TEST_JWT_SECRET,
  TEST_PASSWORD,
} from '../../test-support/in-memory-auth.js';
import { forgeJwt } from '../../test-support/forge-jwt.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';

interface ErrorBody {
  error: { code: string; message: string; requestId: string; retryAfter?: number };
}
interface TokensBody {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}

const ALL_UP = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};

const EMAIL = 'pessoa@exemplo.test';

/** O corpo de erro sem o requestId (que muda a cada requisição). */
function stable(response: { body: string }): unknown {
  const parsed = JSON.parse(response.body) as ErrorBody;
  return { error: { ...parsed.error, requestId: 'x' } };
}

interface Env {
  app: FastifyInstance;
  auth: TestAuth;
  logs: LogCapture;
  metrics: Metrics;
  store: InMemorySessionStore;
  clientId: ClientId;
}

async function setup(maxFailures = 3): Promise<Env> {
  const logs = captureLogs();
  const metrics = createMetrics();
  const store = new InMemorySessionStore({ maxFailures, lockSeconds: 900 });
  const auth = buildTestAuth({ logger: logs.logger, metrics, sessions: store, maxFailures });
  const client = await auth.clients.create({ name: 'Cliente A', slug: 'cliente-a' });
  await auth.users.create(client.id, {
    email: EMAIL,
    passwordHash: await auth.hasher.hash(TEST_PASSWORD),
    role: 'OWNER',
  });
  const app = buildServer({
    logger: logs.logger,
    readiness: ALL_UP,
    metrics,
    auth: auth.service,
    admin: { clients: new ClientService(auth.clients) },
  });
  await app.ready();
  return { app, auth, logs, metrics, store, clientId: client.id };
}

const login = (env: Env, body: unknown) =>
  env.app.inject({ method: 'POST', url: '/auth/login', payload: body as object });
const goodLogin = { clientSlug: 'cliente-a', email: EMAIL, password: TEST_PASSWORD };

describe('POST /auth/login e /auth/platform/login', () => {
  let env: Env;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env.app.close();
  });

  it('login válido: 200 com os tokens, tokenType, expiresIn e Cache-Control: no-store', async () => {
    const response = await login(env, goodLogin);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const body = response.json<TokensBody>();
    assert.deepEqual(Object.keys(body).sort(), [
      'accessToken',
      'expiresIn',
      'refreshToken',
      'tokenType',
    ]);
    assert.equal(body.tokenType, 'Bearer');
    assert.equal(body.expiresIn, 900);
  });

  it('e-mail com maiúsculas, espaços e forma Unicode diferente é normalizado', async () => {
    const response = await login(env, { ...goodLogin, email: `  ${EMAIL.toUpperCase()} ` });
    assert.equal(response.statusCode, 200);
  });

  it('login de PlatformAdmin: 200 e no-store', async () => {
    await env.auth.platformAdmins.create({
      email: 'admin@exemplo.test',
      passwordHash: await env.auth.hasher.hash(TEST_PASSWORD),
    });
    const response = await env.app.inject({
      method: 'POST',
      url: '/auth/platform/login',
      payload: { email: 'admin@exemplo.test', password: TEST_PASSWORD },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.json<TokensBody>().refreshToken, /^platform\./);
  });

  it('todas as recusas: mesmo 401, mesmo código, mesma mensagem e mesmo corpo', async () => {
    const wrongs = [
      { ...goodLogin, clientSlug: 'nao-existe' },
      { ...goodLogin, email: 'ninguem@exemplo.test' },
      { ...goodLogin, password: 'senha-errada-qualquer' },
    ];
    const bodies: unknown[] = [];
    for (const wrong of wrongs) {
      const response = await login(env, wrong);
      assert.equal(response.statusCode, 401);
      assert.equal(response.json<ErrorBody>().error.code, 'UNAUTHORIZED');
      assert.equal(response.json<ErrorBody>().error.message, 'Credenciais inválidas');
      bodies.push(stable(response));
    }
    for (const body of bodies) assert.deepEqual(body, bodies[0]);
    const platform = await env.app.inject({
      method: 'POST',
      url: '/auth/platform/login',
      payload: { email: 'ninguem@exemplo.test', password: 'senha-errada-qualquer' },
    });
    assert.deepEqual(stable(platform), bodies[0]);
  });

  it('corpo inválido: 400 sem ecoar o valor, e não conta como falha de login', async () => {
    const secret = 'valor-secreto-no-corpo-invalido';
    for (const body of [
      {},
      { clientSlug: 'x', email: secret, password: TEST_PASSWORD },
      { ...goodLogin, password: '' },
      { ...goodLogin, password: 'a'.repeat(129) },
      { ...goodLogin, password: 'com\u0000nul' },
      { ...goodLogin, clientSlug: 'Maiúsculas Com Espaço' },
      { ...goodLogin, extra: secret },
      { clientSlug: 'cliente-a', email: 'x@y.test' },
    ]) {
      const response = await login(env, body);
      assert.equal(response.statusCode, 400, JSON.stringify(body).slice(0, 60));
      assert.ok(!response.body.includes(secret));
      assert.ok(!response.body.includes(TEST_PASSWORD));
    }
    const noBody = await env.app.inject({ method: 'POST', url: '/auth/login' });
    assert.equal(noBody.statusCode, 400);
    // 400 não alimentou o bloqueio: a conta entra normalmente (o teto aqui é 3 falhas).
    assert.equal((await login(env, goodLogin)).statusCode, 200);
  });
});

describe('bloqueio por conta (429)', () => {
  it('após o limite de falhas: 429 com Retry-After, sem verificar a senha; vale para e-mail inexistente', async () => {
    const env = await setup(3);
    try {
      for (let i = 0; i < 3; i += 1) {
        assert.equal(
          (await login(env, { ...goodLogin, password: 'errada-errada-1' })).statusCode,
          401,
        );
      }
      const before = env.auth.hasher.verifyCalls;
      const locked = await login(env, goodLogin);
      assert.equal(locked.statusCode, 429);
      assert.equal(locked.headers['retry-after'], '900');
      assert.equal(locked.json<ErrorBody>().error.code, 'RATE_LIMITED');
      assert.equal(locked.json<ErrorBody>().error.retryAfter, 900);
      assert.equal(env.auth.hasher.verifyCalls, before, 'nenhum hash gasto');

      const ghost = { ...goodLogin, email: 'fantasma@exemplo.test' };
      for (let i = 0; i < 3; i += 1) await login(env, ghost);
      assert.equal((await login(env, ghost)).statusCode, 429);
    } finally {
      await env.app.close();
    }
  });
});

describe('POST /auth/refresh, /auth/logout e /auth/logout-all', () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });
  after(async () => {
    await env.app.close();
  });

  const post = (url: string, payload?: object, headers?: Record<string, string>) =>
    env.app.inject({
      method: 'POST',
      url,
      ...(payload === undefined ? {} : { payload }),
      ...(headers === undefined ? {} : { headers }),
    });

  it('refresh devolve um par novo (no-store) e o antigo vira reuso: 401 igual ao de refresh inválido', async () => {
    const first = (await login(env, goodLogin)).json<TokensBody>();
    const second = await post('/auth/refresh', { refreshToken: first.refreshToken });
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers['cache-control'], 'no-store');
    const reuse = await post('/auth/refresh', { refreshToken: first.refreshToken });
    const invalid = await post('/auth/refresh', { refreshToken: 'lixo' });
    assert.equal(reuse.statusCode, 401);
    assert.deepEqual(stable(reuse), stable(invalid));
    assert.equal(reuse.json<ErrorBody>().error.message, 'Sessão inválida');
    // A sessão caiu: o refresh mais novo também falha.
    assert.equal(
      (await post('/auth/refresh', { refreshToken: second.json<TokensBody>().refreshToken }))
        .statusCode,
      401,
    );
    // O contador de reuso foi para a métrica, com o rótulo fixo.
    assert.match(await env.metrics.render(), /auth_refresh_total\{result="reuse"\} 1/);
  });

  it('logout: 204, idempotente (204 para refresh desconhecido) e derruba o access token da sessão', async () => {
    const tokens = (await login(env, goodLogin)).json<TokensBody>();
    assert.equal(
      (await post('/auth/logout', { refreshToken: tokens.refreshToken })).statusCode,
      204,
    );
    assert.equal(
      (await post('/auth/logout', { refreshToken: tokens.refreshToken })).statusCode,
      204,
    );
    assert.equal((await post('/auth/logout', { refreshToken: 'desconhecido' })).statusCode, 204);
    assert.equal((await post('/auth/logout', {})).statusCode, 400);
    const me = await env.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(tokens.accessToken),
    });
    assert.equal(me.statusCode, 401);
  });

  it('logout-all: 401 sem token, 204 com token, e derruba todos os access tokens do usuário', async () => {
    const one = (await login(env, goodLogin)).json<TokensBody>();
    const two = (await login(env, goodLogin)).json<TokensBody>();
    assert.equal((await post('/auth/logout-all')).statusCode, 401);
    assert.equal(
      (await post('/auth/logout-all', undefined, bearer(one.accessToken))).statusCode,
      204,
    );
    for (const tokens of [one, two]) {
      const me = await env.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: bearer(tokens.accessToken),
      });
      assert.equal(me.statusCode, 401);
    }
  });

  it('GET /auth/me: identidade de User e de PlatformAdmin, nunca o hash', async () => {
    const user = (await login(env, goodLogin)).json<TokensBody>();
    const me = await env.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(user.accessToken),
    });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json<Record<string, unknown>>(), {
      kind: 'user',
      id: me.json<{ id: string }>().id,
      email: EMAIL,
      role: 'OWNER',
      client: { id: env.clientId, name: 'Cliente A', slug: 'cliente-a' },
    });
    assert.ok(
      !me.body.includes('assword') && !me.body.includes('scrypt') && !me.body.includes('fake$'),
    );

    const admin = await env.auth.platformToken('plataforma@exemplo.test');
    const adminMe = await env.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(admin.accessToken),
    });
    assert.deepEqual(adminMe.json<Record<string, unknown>>(), {
      kind: 'platform',
      id: admin.userId,
      email: 'plataforma@exemplo.test',
    });
  });
});

describe('hook authenticate', () => {
  let env: Env;
  let valid: string;
  before(async () => {
    env = await setup();
    valid = (await login(env, goodLogin)).json<TokensBody>().accessToken;
  });
  after(async () => {
    await env.app.close();
  });

  const me = (headers?: Record<string, string>) =>
    env.app.inject({
      method: 'GET',
      url: '/auth/me',
      ...(headers === undefined ? {} : { headers }),
    });

  function sign(options: {
    iss?: string;
    aud?: string;
    typ?: string;
    alg?: string;
    exp?: number;
    kind?: string;
    role?: string;
    withSub?: boolean;
  }): string {
    const iat = Math.floor(Date.now() / 1000);
    return forgeJwt({
      header: { alg: options.alg ?? 'HS256', typ: options.typ ?? 'at+jwt' },
      payload: {
        kind: options.kind ?? 'user',
        cid: env.clientId,
        role: options.role ?? 'OWNER',
        sid: randomUUID(),
        iss: options.iss ?? 'soprei',
        aud: options.aud ?? 'soprei-api',
        iat,
        exp: options.exp ?? iat + 900,
        ...(options.withSub === false ? {} : { sub: randomUUID() }),
      },
      secret: TEST_JWT_SECRET,
    });
  }

  it('token expirado, de outro iss/aud, com typ ou algoritmo errados, sem sub ou com papel desconhecido: 401 igual, com WWW-Authenticate', async () => {
    const past = Math.floor(Date.now() / 1000) - 3_600;
    const tokens = [
      sign({ exp: past }),
      sign({ iss: 'outro' }),
      sign({ aud: 'outra' }),
      sign({ typ: 'JWT' }),
      sign({ alg: 'HS384' }),
      sign({ withSub: false }),
      sign({ kind: 'root' }),
      sign({ role: 'ROOT' }),
      `${valid.slice(0, -3)}abc`,
      'a.b.c',
    ];
    const bodies: unknown[] = [];
    for (const token of tokens) {
      const response = await me(bearer(token));
      assert.equal(response.statusCode, 401, token.slice(0, 30));
      assert.equal(response.headers['www-authenticate'], 'Bearer');
      assert.ok(!response.body.includes(token));
      bodies.push(stable(response));
    }
    for (const body of bodies) assert.deepEqual(body, bodies[0]);
    assert.deepEqual(stable(await me()), bodies[0]);
  });

  it('Bearer malformado ou esquema errado: 401 igual; as categorias vão só à métrica', async () => {
    for (const authorization of [
      'Bearer',
      'Bearer ',
      `Basic ${valid}`,
      valid,
      `Bearer ${valid} x`,
      'Bearer a b',
    ]) {
      const response = await me({ authorization });
      assert.equal(response.statusCode, 401, authorization.slice(0, 20));
      assert.equal(response.headers['www-authenticate'], 'Bearer');
    }
    const text = await env.metrics.render();
    for (const reason of ['missing', 'malformed', 'invalid', 'expired']) {
      assert.match(
        text,
        new RegExp(`auth_token_rejections_total\\{reason="${reason}"\\} [1-9]`),
        reason,
      );
    }
  });

  it('authenticate preenche userId e clientId no contexto: o log da requisição os traz', async () => {
    const response = await me({ ...bearer(valid), 'x-request-id': 'req-auth-ctx-001' });
    assert.equal(response.statusCode, 200);
    const lines = env.logs.lines().filter((line) => line.requestId === 'req-auth-ctx-001');
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.equal(line.clientId, env.clientId);
      assert.equal(typeof line.userId, 'string');
    }
    const end = lines.find((line) => line.msg === 'requisição concluída');
    assert.ok(end);
    assert.equal(end.route, '/auth/me');
  });

  it('com o store fora: 503 SERVICE_UNAVAILABLE e a rota não executa', async () => {
    env.store.failWith = new ServiceUnavailableError();
    try {
      const response = await me(bearer(valid));
      assert.equal(response.statusCode, 503);
      assert.equal(response.json<ErrorBody>().error.code, 'SERVICE_UNAVAILABLE');
      assert.match(
        await env.metrics.render(),
        /auth_token_rejections_total\{reason="unavailable"\} 1/,
      );
      const loginResponse = await login(env, goodLogin);
      assert.equal(loginResponse.statusCode, 503);
      assert.equal(loginResponse.json<ErrorBody>().error.code, 'SERVICE_UNAVAILABLE');
      assert.ok(!loginResponse.body.includes('accessToken'));
      const refresh = await env.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: `platform.${randomUUID()}.${'a'.repeat(64)}` },
      });
      assert.equal(refresh.statusCode, 503);
      const logout = await env.app.inject({
        method: 'POST',
        url: '/auth/logout',
        payload: { refreshToken: `platform.${randomUUID()}.${'a'.repeat(64)}` },
      });
      assert.equal(logout.statusCode, 503);
    } finally {
      env.store.failWith = undefined;
    }
  });
});
