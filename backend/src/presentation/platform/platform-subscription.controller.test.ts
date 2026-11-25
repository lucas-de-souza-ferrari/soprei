import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { PlatformAuthService } from '../../application/platform/platform-auth.service.js';
import { CompanyId } from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { ConflictError } from '../../shared/errors/index.js';
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
import { captureLogs } from '../../test-support/log-capture.js';
import { ACCOUNT_COOKIE } from '../auth/account.controller.js';
import { PLATFORM_COOKIE } from './platform-auth.controller.js';
import type { PlatformSubscriptionRoutes } from './platform-subscription.controller.js';

// Spec 045, E4: as rotas da assinatura pelo Fastify (cookie com segundo fator, origem, corpo strict, 204 e
// os 409 passando como vieram). O serviço é um dublê que registra as chamadas; as regras estão em
// `platform-subscription.service.test.ts` e na integração.

const ORIGIN = 'https://soadm.exemplo.test';
const WRITE = { origin: ORIGIN, 'x-soprei-app': 'admin' } as const;
const ACCOUNT = randomUUID();

interface World {
  readonly app: FastifyInstance;
  readonly calls: { method: string; args: unknown[] }[];
  readonly auth: ReturnType<typeof buildTestAuth>;
  readonly cipher: ReturnType<typeof testPlatformCipher>;
  readonly clock: ManualClock;
  readonly cookie: string;
  failWith: Error | undefined;
}

async function setup(): Promise<World> {
  const logs = captureLogs();
  const clock = new ManualClock();
  const cipher = testPlatformCipher();
  const auth = buildTestAuth({ logger: logs.logger, platformTotp: { cipher, now: clock.now } });
  const calls: { method: string; args: unknown[] }[] = [];
  const world = { calls, failWith: undefined as Error | undefined };
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args: args.slice(1) });
      return world.failWith === undefined ? Promise.resolve(true) : Promise.reject(world.failWith);
    };
  const subscriptions = {
    startTrial: record('trial'),
    extend: record('extend'),
    setModules: record('modules'),
    changePlan: record('plan'),
    setCancelAtPeriodEnd: record('cancel'),
    end: record('end'),
  } as unknown as PlatformSubscriptionRoutes;
  const metrics = createMetrics();
  const app = buildServer({
    logger: logs.logger,
    readiness: {
      database: () => Promise.resolve(Result.ok(undefined)),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    metrics,
    auth: auth.service,
    platform: {
      auth: new PlatformAuthService({
        credentials: auth.service,
        admins: auth.platformAdmins,
        sessions: new InMemoryPlatformSessionStore(clock.now, 1_800, 43_200),
        audit: new InMemoryPlatformAuditRepository(),
        logger: logs.logger,
        metrics,
      }),
      origin: ORIGIN,
      maxAgeSeconds: 43_200,
      subscriptions,
    },
  });
  await app.ready();
  const admin = await enrollTestAdmin(auth, cipher);
  const login = await app.inject({
    method: 'POST',
    url: '/platform/auth/login',
    headers: WRITE,
    payload: { email: admin.email, password: TEST_PASSWORD, code: codeAt(admin.secret, clock.ms) },
  });
  assert.equal(login.statusCode, 204);
  const header = login.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0] : header)?.split(';')[0] ?? '';
  assert.ok(cookie.startsWith(`${PLATFORM_COOKIE}=`));
  return Object.assign(world, { app, auth, cipher, clock, cookie });
}

const base = `/platform/accounts/${ACCOUNT}/subscription`;
const ROUTES: readonly (readonly [string, Record<string, unknown>])[] = [
  [`${base}/trial`, { reason: 'OTHER' }],
  [`${base}/extend`, { days: 30, reason: 'PAYMENT' }],
  [`${base}/modules`, { agenda: true, stock: false, reason: 'OWNER_REQUEST' }],
  [`${base}/plan`, { planCode: 'SCALE', reason: 'OTHER' }],
  [`${base}/cancel`, { reason: 'OTHER' }],
  [`${base}/reactivate`, { reason: 'OTHER' }],
  [`${base}/end`, { reason: 'ABUSE', code: '123456' }],
];

describe('/platform/accounts/:accountId/subscription/* (spec 045, E4)', () => {
  it('sem o cookie do admin, com Bearer de plataforma ou de vínculo ou com o cookie da conta: 401; sem origem: 403; o serviço não é chamado', async () => {
    const world = await setup();
    try {
      const other = await enrollTestAdmin(world.auth, world.cipher);
      const issued = await world.auth.service.loginPlatform({
        email: other.email,
        password: TEST_PASSWORD,
        code: codeAt(other.secret, world.clock.ms),
      });
      assert.ok(issued.ok);
      const tenant = await world.auth.companies.create({
        name: 'X',
        slug: `x-${randomUUID().slice(0, 8)}`,
      });
      const membership = await world.auth.membershipToken(CompanyId.parse(tenant.id));
      for (const headers of [
        {},
        bearer(issued.value.accessToken),
        bearer(membership.accessToken),
        { cookie: `${ACCOUNT_COOKIE}=${'a'.repeat(43)}` },
      ]) {
        for (const [url, payload] of ROUTES) {
          const response = await world.app.inject({
            method: 'POST',
            url,
            headers: { ...WRITE, ...headers },
            payload,
          });
          assert.equal(response.statusCode, 401, url);
        }
      }
      for (const [url, payload] of ROUTES) {
        const response = await world.app.inject({
          method: 'POST',
          url,
          headers: {
            cookie: world.cookie,
            origin: 'https://www.exemplo.test',
            'x-soprei-app': 'admin',
          },
          payload,
        });
        assert.equal(response.statusCode, 403, url);
      }
      assert.deepEqual(world.calls, []);
    } finally {
      await world.app.close();
    }
  });

  it('corpo strict: motivo, dias, plano, módulos ou código inválidos e campo a mais = 400 sem chamar o serviço', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE, cookie: world.cookie };
      for (const [url, payload] of ROUTES) {
        for (const bad of [{}, { ...payload, reason: 'CALOTE' }, { ...payload, nota: 'x' }]) {
          const response = await world.app.inject({ method: 'POST', url, headers, payload: bad });
          assert.equal(response.statusCode, 400, `${url} ${JSON.stringify(bad)}`);
        }
      }
      for (const [url, payload] of [
        [`${base}/extend`, { days: 0, reason: 'OTHER' }],
        [`${base}/extend`, { days: 91, reason: 'OTHER' }],
        [`${base}/extend`, { days: '10', reason: 'OTHER' }],
        [`${base}/plan`, { planCode: 'ENTERPRISE', reason: 'OTHER' }],
        [`${base}/modules`, { agenda: 'sim', stock: false, reason: 'OTHER' }],
        [`${base}/end`, { reason: 'OTHER', code: '12345' }],
      ] as const) {
        const response = await world.app.inject({ method: 'POST', url, headers, payload });
        assert.equal(response.statusCode, 400, `${url} ${JSON.stringify(payload)}`);
      }
      assert.deepEqual(world.calls, []);
    } finally {
      await world.app.close();
    }
  });

  it('caminho feliz: 204 sem corpo e o corpo chega ao serviço; 409 BILLING_DISABLED e ORDER_PENDING passam como vieram', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE, cookie: world.cookie };
      for (const [url, payload] of ROUTES) {
        const response = await world.app.inject({ method: 'POST', url, headers, payload });
        assert.equal(response.statusCode, 204, url);
        assert.equal(response.body, '');
      }
      assert.deepEqual(
        world.calls.map((call) => [call.method, call.args]),
        [
          ['trial', [ACCOUNT, 'OTHER']],
          ['extend', [ACCOUNT, 30, 'PAYMENT']],
          ['modules', [ACCOUNT, { agenda: true, stock: false }, 'OWNER_REQUEST']],
          ['plan', [ACCOUNT, 'SCALE', 'OTHER']],
          ['cancel', [ACCOUNT, true, 'OTHER']],
          ['cancel', [ACCOUNT, false, 'OTHER']],
          ['end', [ACCOUNT, 'ABUSE', '123456']],
        ],
      );
      for (const code of ['BILLING_DISABLED', 'ORDER_PENDING', 'PLAN_DOWNGRADE_BLOCKED']) {
        world.failWith = new ConflictError('x', { code });
        const response = await world.app.inject({
          method: 'POST',
          url: `${base}/extend`,
          headers,
          payload: { days: 5, reason: 'OTHER' },
        });
        assert.equal(response.statusCode, 409);
        assert.equal(response.json<{ error: { code: string } }>().error.code, code);
      }
    } finally {
      await world.app.close();
    }
  });
});
