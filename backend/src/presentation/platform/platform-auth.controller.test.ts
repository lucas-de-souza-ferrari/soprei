import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { PlatformAuthService } from '../../application/platform/platform-auth.service.js';
import { CompanyId } from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth, TEST_PASSWORD } from '../../test-support/in-memory-auth.js';
import {
  codeAt,
  enrollTestAdmin,
  InMemoryPlatformAuditRepository,
  InMemoryPlatformSessionStore,
  ManualClock,
  testPlatformCipher,
} from '../../test-support/in-memory-platform.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { PLATFORM_COOKIE } from './platform-auth.controller.js';

const ORIGIN = 'https://soadm.exemplo.test';
const WRITE_HEADERS = { origin: ORIGIN, 'x-soprei-app': 'admin' } as const;
const ALL_UP = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};

interface World {
  readonly app: FastifyInstance;
  readonly clock: ManualClock;
  readonly auth: ReturnType<typeof buildTestAuth>;
  readonly sessions: InMemoryPlatformSessionStore;
  readonly audit: InMemoryPlatformAuditRepository;
  readonly cipher: ReturnType<typeof testPlatformCipher>;
  readonly raw: () => string;
}

async function setup(options: { maxFailures?: number; platform?: boolean } = {}): Promise<World> {
  const capture = captureLogs();
  const logger = capture.logger;
  const clock = new ManualClock();
  const cipher = testPlatformCipher();
  const auth = buildTestAuth({
    logger: logger,
    platformTotp: { cipher, now: clock.now },
    ...(options.maxFailures === undefined ? {} : { maxFailures: options.maxFailures }),
  });
  const sessions = new InMemoryPlatformSessionStore(clock.now, 1_800, 43_200);
  const audit = new InMemoryPlatformAuditRepository();
  const metrics = createMetrics();
  const app = buildServer({
    logger: logger,
    readiness: ALL_UP,
    metrics,
    metricsToken: 'm'.repeat(32),
    auth: auth.service,
    ...(options.platform === false
      ? {}
      : {
          platform: {
            auth: new PlatformAuthService({
              credentials: auth.service,
              admins: auth.platformAdmins,
              sessions,
              audit,
              logger: logger,
              metrics,
            }),
            origin: ORIGIN,
            maxAgeSeconds: 43_200,
          },
        }),
  });
  await app.ready();
  return { app, clock, auth, sessions, audit, cipher, raw: () => capture.raw() };
}

function cookieOf(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(header !== undefined, 'set-cookie ausente');
  const value = header.split(';')[0] ?? '';
  assert.ok(value.startsWith(`${PLATFORM_COOKIE}=`));
  return value;
}

async function login(world: World, body: Record<string, unknown>) {
  return world.app.inject({
    method: 'POST',
    url: '/platform/auth/login',
    headers: WRITE_HEADERS,
    payload: body,
  });
}

async function enter(world: World): Promise<{ cookie: string; adminId: string; email: string }> {
  const admin = await enrollTestAdmin(world.auth, world.cipher);
  const response = await login(world, {
    email: admin.email,
    password: TEST_PASSWORD,
    code: codeAt(admin.secret, world.clock.ms),
  });
  assert.equal(response.statusCode, 204);
  return {
    cookie: cookieOf(response.headers['set-cookie']),
    adminId: admin.adminId,
    email: admin.email,
  };
}

describe('/platform/auth (spec 044, E1)', () => {
  it('sem o admin ligado, /platform/* não existe (404) e o login Bearer aceita o corpo antigo', async () => {
    const { logger } = captureLogs();
    const auth = buildTestAuth({ logger: logger });
    const app = buildServer({ logger: logger, readiness: ALL_UP, auth: auth.service });
    await app.ready();
    try {
      for (const [method, url] of [
        ['POST', '/platform/auth/login'],
        ['POST', '/platform/auth/logout'],
        ['GET', '/platform/auth/session'],
      ] as const) {
        const response = await app.inject({ method, url, headers: WRITE_HEADERS, payload: {} });
        assert.equal(response.statusCode, 404, `${method} ${url}`);
      }
      const issued = await auth.platformToken();
      assert.ok(issued.accessToken.length > 0);
    } finally {
      await app.close();
    }
  });

  it('entrada certa: 204, cookie __Host- seguro, só o hash no armazenamento e PLATFORM_LOGIN na trilha', async () => {
    const world = await setup();
    try {
      const admin = await enrollTestAdmin(world.auth, world.cipher);
      const before = world.auth.hasher.verifyCalls;
      const code = codeAt(admin.secret, world.clock.ms);
      const response = await login(world, { email: admin.email, password: TEST_PASSWORD, code });
      assert.equal(response.statusCode, 204);
      assert.equal(world.auth.hasher.verifyCalls - before, 1);
      assert.equal(response.headers['cache-control'], 'no-store');
      const header = String(response.headers['set-cookie']);
      assert.match(header, /^__Host-soprei_platform=[A-Za-z0-9_-]{43}; /);
      for (const attribute of [
        'HttpOnly',
        'Secure',
        'SameSite=Strict',
        'Path=/',
        'Max-Age=43200',
      ]) {
        assert.ok(header.split('; ').includes(attribute), attribute);
      }
      assert.doesNotMatch(header, /Domain=/i);
      const secret = cookieOf(response.headers['set-cookie']).split('=')[1] ?? '';
      assert.deepEqual(
        [...world.sessions.entries.keys()],
        [InMemoryPlatformSessionStore.hash(secret)],
      );
      assert.deepEqual(
        world.audit.events.map((event) => [event.action, event.adminId]),
        [['PLATFORM_LOGIN', admin.adminId]],
      );
      const logs = world.raw();
      assert.equal(logs.includes(admin.email), false);
      assert.equal(logs.includes(TEST_PASSWORD), false);
      assert.equal(logContains(logs, code), false);
      assert.equal(logs.includes(secret), false);
    } finally {
      await world.app.close();
    }
  });

  it('a mesma 401 para cada falha, com um verify de senha em cada uma, e nada gravado', async () => {
    const world = await setup({ maxFailures: 100 });
    try {
      const good = await enrollTestAdmin(world.auth, world.cipher);
      const disabled = await enrollTestAdmin(world.auth, world.cipher);
      world.auth.platformAdmins.setStatus(disabled.adminId, 'DISABLED');
      const noFactor = await world.auth.platformAdmins.create({
        email: `p-${randomUUID()}@exemplo.test`,
        passwordHash: await world.auth.hasher.hash(TEST_PASSWORD),
      });
      const goodCode = codeAt(good.secret, world.clock.ms);
      const wrongCode = goodCode === '000000' ? '111111' : '000000';
      const cases: Record<string, Record<string, unknown>> = {
        'e-mail inexistente': {
          email: `x-${randomUUID()}@exemplo.test`,
          password: TEST_PASSWORD,
          code: goodCode,
        },
        'admin desativado': {
          email: disabled.email,
          password: TEST_PASSWORD,
          code: codeAt(disabled.secret, world.clock.ms),
        },
        'admin sem fator': { email: noFactor.email, password: TEST_PASSWORD, code: goodCode },
        'senha errada': { email: good.email, password: 'senha-errada-mas-longa', code: goodCode },
        'código errado': { email: good.email, password: TEST_PASSWORD, code: wrongCode },
      };
      const bodies: string[] = [];
      for (const [label, body] of Object.entries(cases)) {
        const before = world.auth.hasher.verifyCalls;
        const response = await login(world, body);
        assert.equal(response.statusCode, 401, label);
        assert.equal(world.auth.hasher.verifyCalls - before, 1, `${label}: um verify`);
        assert.equal(response.headers['set-cookie'], undefined, label);
        const parsed = response.json<{ error: { code: string; message: string } }>();
        bodies.push(`${parsed.error.code}|${parsed.error.message}`);
      }
      assert.equal(new Set(bodies).size, 1);
      // Código repetido: entra uma vez, a segunda é a mesma 401.
      const first = await login(world, {
        email: good.email,
        password: TEST_PASSWORD,
        code: goodCode,
      });
      assert.equal(first.statusCode, 204);
      const again = await login(world, {
        email: good.email,
        password: TEST_PASSWORD,
        code: goodCode,
      });
      assert.equal(again.statusCode, 401);
      const parsed = again.json<{ error: { code: string; message: string } }>();
      assert.equal(`${parsed.error.code}|${parsed.error.message}`, bodies[0]);
      assert.equal(world.sessions.entries.size, 1);
      assert.deepEqual(
        world.audit.events.map((event) => event.action),
        ['PLATFORM_LOGIN'],
      );
    } finally {
      await world.app.close();
    }
  });

  it('código em formato inválido é 400 e não conta no bloqueio nem gasta hash', async () => {
    const world = await setup({ maxFailures: 1 });
    try {
      const admin = await enrollTestAdmin(world.auth, world.cipher);
      const before = world.auth.hasher.verifyCalls;
      for (const code of ['12345', 'abcdef', undefined]) {
        const response = await login(world, { email: admin.email, password: TEST_PASSWORD, code });
        assert.equal(response.statusCode, 400);
      }
      assert.equal(world.auth.hasher.verifyCalls, before);
      const ok = await login(world, {
        email: admin.email,
        password: TEST_PASSWORD,
        code: codeAt(admin.secret, world.clock.ms),
      });
      assert.equal(ok.statusCode, 204);
    } finally {
      await world.app.close();
    }
  });

  it('bloqueio por conta: depois das falhas, 429 com Retry-After antes de gastar hash', async () => {
    const world = await setup({ maxFailures: 2 });
    try {
      const admin = await enrollTestAdmin(world.auth, world.cipher);
      const wrong = { email: admin.email, password: 'senha-errada-mas-longa', code: '123456' };
      assert.equal((await login(world, wrong)).statusCode, 401);
      assert.equal((await login(world, wrong)).statusCode, 401);
      const before = world.auth.hasher.verifyCalls;
      const locked = await login(world, {
        email: admin.email,
        password: TEST_PASSWORD,
        code: codeAt(admin.secret, world.clock.ms),
      });
      assert.equal(locked.statusCode, 429);
      assert.ok(Number(locked.headers['retry-after']) > 0);
      assert.equal(world.auth.hasher.verifyCalls, before);
    } finally {
      await world.app.close();
    }
  });

  it('escrita sem Origin do admin ou sem X-Soprei-App: admin é 403 e nada é gravado', async () => {
    const world = await setup();
    try {
      const admin = await enrollTestAdmin(world.auth, world.cipher);
      const body = {
        email: admin.email,
        password: TEST_PASSWORD,
        code: codeAt(admin.secret, world.clock.ms),
      };
      for (const headers of [
        {},
        { origin: ORIGIN },
        { 'x-soprei-app': 'admin' },
        { origin: 'https://www.exemplo.test', 'x-soprei-app': 'admin' },
        { origin: ORIGIN, 'x-soprei-app': 'web' },
      ]) {
        const response = await world.app.inject({
          method: 'POST',
          url: '/platform/auth/login',
          headers,
          payload: body,
        });
        assert.equal(response.statusCode, 403, JSON.stringify(headers));
      }
      assert.equal(world.sessions.entries.size, 0);
      assert.equal(world.audit.events.length, 0);
    } finally {
      await world.app.close();
    }
  });

  it('sessão: lê o próprio e-mail; sem cookie, com Bearer ou com o cookie da conta é 401', async () => {
    const world = await setup();
    try {
      const { cookie, email } = await enter(world);
      const ok = await world.app.inject({
        method: 'GET',
        url: '/platform/auth/session',
        headers: { cookie },
      });
      assert.equal(ok.statusCode, 200);
      assert.deepEqual(ok.json(), { email });
      assert.equal(ok.headers['cache-control'], 'no-store');

      const company = await world.auth.companies.create({
        name: 'Empresa',
        slug: `e-${randomUUID().slice(0, 8)}`,
      });
      const membership = await world.auth.membershipToken(CompanyId.parse(company.id));
      for (const headers of [
        {},
        bearer(membership.accessToken),
        { cookie: `soprei_session=${'a'.repeat(43)}` },
        { cookie: `${PLATFORM_COOKIE}=${'a'.repeat(43)}` },
        { cookie: `${cookie}; ${cookie}` },
      ]) {
        const response = await world.app.inject({
          method: 'GET',
          url: '/platform/auth/session',
          headers,
        });
        assert.equal(response.statusCode, 401, JSON.stringify(headers));
      }
    } finally {
      await world.app.close();
    }
  });

  it('o Bearer da plataforma não entra em /platform/* (o segundo fator só existe no cookie)', async () => {
    const { logger } = captureLogs();
    const plain = buildTestAuth({ logger: logger });
    const issued = await plain.platformToken();
    const world = await setup();
    try {
      const response = await world.app.inject({
        method: 'GET',
        url: '/platform/auth/session',
        headers: bearer(issued.accessToken),
      });
      assert.equal(response.statusCode, 401);
    } finally {
      await world.app.close();
    }
  });

  it('prazo ocioso e teto absoluto derrubam a sessão', async () => {
    const world = await setup();
    try {
      const { cookie } = await enter(world);
      const read = () =>
        world.app.inject({ method: 'GET', url: '/platform/auth/session', headers: { cookie } });
      world.clock.advanceSeconds(1_700);
      assert.equal((await read()).statusCode, 200);
      world.clock.advanceSeconds(1_801);
      assert.equal((await read()).statusCode, 401);

      const second = await enter(world);
      const readSecond = () =>
        world.app.inject({
          method: 'GET',
          url: '/platform/auth/session',
          headers: { cookie: second.cookie },
        });
      for (let elapsed = 0; elapsed < 43_200 - 1_500; elapsed += 1_500) {
        world.clock.advanceSeconds(1_500);
        assert.equal((await readSecond()).statusCode, 200);
      }
      world.clock.advanceSeconds(1_500);
      assert.equal((await readSecond()).statusCode, 401);
    } finally {
      await world.app.close();
    }
  });

  it('desativar o admin ou recadastrar o fator derruba a sessão na requisição seguinte', async () => {
    const world = await setup();
    try {
      const first = await enter(world);
      world.auth.platformAdmins.setStatus(
        (await world.auth.platformAdmins.findCredentialsByEmail(first.email))?.admin.id ??
          assert.fail('admin'),
        'DISABLED',
      );
      const afterDisable = await world.app.inject({
        method: 'GET',
        url: '/platform/auth/session',
        headers: { cookie: first.cookie },
      });
      assert.equal(afterDisable.statusCode, 401);

      const second = await enter(world);
      const found = await world.auth.platformAdmins.findCredentialsByEmail(second.email);
      assert.ok(found !== null);
      await world.auth.platformAdmins.setTotpSecret(found.admin.id, null);
      const afterReset = await world.app.inject({
        method: 'GET',
        url: '/platform/auth/session',
        headers: { cookie: second.cookie },
      });
      assert.equal(afterReset.statusCode, 401);
    } finally {
      await world.app.close();
    }
  });

  it('logout: 204 idempotente, apaga a sessão, limpa o cookie e grava PLATFORM_LOGOUT uma vez', async () => {
    const world = await setup();
    try {
      const { cookie, adminId } = await enter(world);
      for (let i = 0; i < 2; i += 1) {
        const response = await world.app.inject({
          method: 'POST',
          url: '/platform/auth/logout',
          headers: { ...WRITE_HEADERS, cookie },
        });
        assert.equal(response.statusCode, 204);
        assert.match(
          String(response.headers['set-cookie']),
          /^__Host-soprei_platform=; .*Max-Age=0/,
        );
      }
      assert.equal(world.sessions.entries.size, 0);
      assert.deepEqual(
        world.audit.events.map((event) => [event.action, event.adminId]),
        [
          ['PLATFORM_LOGIN', adminId],
          ['PLATFORM_LOGOUT', adminId],
        ],
      );
      const after = await world.app.inject({
        method: 'GET',
        url: '/platform/auth/session',
        headers: { cookie },
      });
      assert.equal(after.statusCode, 401);
    } finally {
      await world.app.close();
    }
  });

  it('Redis fora: 503 na entrada e na sessão (fail-closed)', async () => {
    const world = await setup();
    try {
      const { cookie } = await enter(world);
      world.sessions.failing = true;
      const session = await world.app.inject({
        method: 'GET',
        url: '/platform/auth/session',
        headers: { cookie },
      });
      assert.equal(session.statusCode, 503);
      const admin = await enrollTestAdmin(world.auth, world.cipher);
      const response = await login(world, {
        email: admin.email,
        password: TEST_PASSWORD,
        code: codeAt(admin.secret, world.clock.ms),
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.headers['set-cookie'], undefined);
    } finally {
      await world.app.close();
    }
  });

  it('com o admin ligado, o login Bearer da plataforma exige o código', async () => {
    const world = await setup({ maxFailures: 100 });
    try {
      const admin = await enrollTestAdmin(world.auth, world.cipher);
      const send = (payload: Record<string, unknown>) =>
        world.app.inject({ method: 'POST', url: '/auth/platform/login', payload });
      assert.equal((await send({ email: admin.email, password: TEST_PASSWORD })).statusCode, 401);
      const code = codeAt(admin.secret, world.clock.ms);
      const wrong = code === '000000' ? '111111' : '000000';
      assert.equal(
        (await send({ email: admin.email, password: TEST_PASSWORD, code: wrong })).statusCode,
        401,
      );
      const ok = await send({ email: admin.email, password: TEST_PASSWORD, code });
      assert.equal(ok.statusCode, 200);
      assert.ok(ok.json<{ accessToken: string }>().accessToken.length > 0);
    } finally {
      await world.app.close();
    }
  });

  it('métricas da sessão sem id, e-mail nem segredo', async () => {
    const world = await setup();
    try {
      const { cookie } = await enter(world);
      await world.app.inject({
        method: 'POST',
        url: '/platform/auth/logout',
        headers: { ...WRITE_HEADERS, cookie },
      });
      const metrics = await world.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: bearer('m'.repeat(32)),
      });
      assert.match(metrics.body, /platform_sessions_total\{result="created"\} 1/);
      assert.match(metrics.body, /platform_sessions_total\{result="revoked"\} 1/);
      assert.match(metrics.body, /platform_actions_total\{action="platform_login"\} 1/);
      assert.match(metrics.body, /platform_actions_total\{action="platform_logout"\} 1/);
      assert.equal(metrics.body.includes(cookie.split('=')[1] ?? '-'), false);
      assert.doesNotMatch(metrics.body, /@exemplo\.test/);
    } finally {
      await world.app.close();
    }
  });

  it('sem o plugin da plataforma, nada de /platform (setup do teste)', async () => {
    const world = await setup({ platform: false });
    try {
      const response = await world.app.inject({ method: 'GET', url: '/platform/auth/session' });
      assert.equal(response.statusCode, 404);
    } finally {
      await world.app.close();
    }
  });
});
