import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { PlatformAuthService } from '../../application/platform/platform-auth.service.js';
import { PlatformMonitorService } from '../../application/platform/platform-monitor.service.js';
import { CompanyId } from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics, readPlatformProcessCounters } from '../../infrastructure/metrics/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth, TEST_PASSWORD } from '../../test-support/in-memory-auth.js';
import {
  codeAt,
  enrollTestAdmin,
  FakePlatformReadModel,
  InMemoryPlatformAuditRepository,
  InMemoryPlatformCompanyUnitOfWork,
  InMemoryPlatformSessionStore,
  ManualClock,
  testPlatformCipher,
} from '../../test-support/in-memory-platform.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { PLATFORM_COOKIE } from './platform-auth.controller.js';
import type {
  PlatformAccountListResponse,
  PlatformHealthResponse,
  PlatformOverviewResponse,
} from './platform-monitor.controller.js';

const ORIGIN = 'https://soadm.exemplo.test';
const WRITE_HEADERS = { origin: ORIGIN, 'x-soprei-app': 'admin' } as const;
const ALL_UP = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};
const ACCOUNT_ID = randomUUID();
const COMPANY_ID = CompanyId.parse(randomUUID());

const GET_ROUTES = [
  '/platform/overview',
  '/platform/companies',
  `/platform/companies/${COMPANY_ID}`,
  '/platform/accounts',
  `/platform/accounts/${ACCOUNT_ID}`,
  '/platform/billing/orders',
  '/platform/billing/notices',
  '/platform/health',
] as const;
const POST_ROUTES = [
  `/platform/companies/${COMPANY_ID}/suspend`,
  `/platform/companies/${COMPANY_ID}/reactivate`,
] as const;

interface World {
  readonly app: FastifyInstance;
  readonly reads: FakePlatformReadModel;
  readonly audit: InMemoryPlatformAuditRepository;
  readonly companies: InMemoryPlatformCompanyUnitOfWork;
  readonly auth: ReturnType<typeof buildTestAuth>;
  readonly cookie: string;
  readonly adminId: string;
  readonly clock: ManualClock;
  readonly cipher: ReturnType<typeof testPlatformCipher>;
}

async function setup(options: { platform?: boolean } = {}): Promise<World> {
  const { logger } = captureLogs();
  const clock = new ManualClock();
  const cipher = testPlatformCipher();
  const auth = buildTestAuth({ logger, platformTotp: { cipher, now: clock.now } });
  const sessions = new InMemoryPlatformSessionStore(clock.now, 1_800, 43_200);
  const audit = new InMemoryPlatformAuditRepository();
  const companies = new InMemoryPlatformCompanyUnitOfWork(audit);
  companies.statuses.set(COMPANY_ID, 'ACTIVE');
  const metrics = createMetrics();
  const reads = new FakePlatformReadModel({
    accountDetail: (id) =>
      Promise.resolve(
        id === ACCOUNT_ID
          ? {
              id,
              email: 'lucia@exemplo.com',
              status: 'ACTIVE',
              verified: true,
              createdAt: new Date('2026-11-01T00:00:00.000Z'),
              companies: [],
            }
          : null,
      ),
    listAccounts: () =>
      Promise.resolve({
        items: [
          {
            id: ACCOUNT_ID,
            emailMasked: 'l***@exemplo.com',
            status: 'ACTIVE',
            verified: true,
            createdAt: new Date('2026-11-01T00:00:00.000Z'),
            companies: 1,
            hasSubscription: false,
          },
        ],
        nextCursor: null,
      }),
  });
  const app = buildServer({
    logger,
    readiness: ALL_UP,
    metrics,
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
              logger,
              metrics,
            }),
            origin: ORIGIN,
            maxAgeSeconds: 43_200,
            monitor: new PlatformMonitorService({
              reads,
              onboarding: {
                read: () =>
                  Promise.resolve({
                    dismissed: false,
                    persona: false,
                    knowledge: false,
                    schedule: false,
                    inventory: false,
                  }),
              },
              companies,
              audit,
              health: {
                ...ALL_UP,
                counters: () => readPlatformProcessCounters(metrics.registry),
                bootedAt: new Date('2026-11-24T10:00:00.000Z'),
              },
              logger,
              metrics,
            }),
          },
        }),
  });
  await app.ready();
  if (options.platform === false) {
    return { app, reads, audit, companies, auth, cookie: '', adminId: '', clock, cipher };
  }
  const admin = await enrollTestAdmin(auth, cipher);
  const login = await app.inject({
    method: 'POST',
    url: '/platform/auth/login',
    headers: WRITE_HEADERS,
    payload: { email: admin.email, password: TEST_PASSWORD, code: codeAt(admin.secret, clock.ms) },
  });
  assert.equal(login.statusCode, 204);
  const setCookie = login.headers['set-cookie'];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = (header ?? '').split(';')[0] ?? '';
  assert.ok(cookie.startsWith(`${PLATFORM_COOKIE}=`));
  return { app, reads, audit, companies, auth, cookie, adminId: admin.adminId, clock, cipher };
}

function actions(world: World): string[] {
  return world.audit.events.map((event) => event.action).filter((a) => !a.startsWith('PLATFORM_'));
}

describe('/platform/* leituras e ações (spec 044, E2)', () => {
  it('sem o admin ligado, as rotas da E2 não existem (404)', async () => {
    const world = await setup({ platform: false });
    try {
      for (const url of GET_ROUTES) {
        assert.equal((await world.app.inject({ method: 'GET', url })).statusCode, 404, url);
      }
      for (const url of POST_ROUTES) {
        const response = await world.app.inject({
          method: 'POST',
          url,
          headers: WRITE_HEADERS,
          payload: { reason: 'OTHER' },
        });
        assert.equal(response.statusCode, 404, url);
      }
    } finally {
      await world.app.close();
    }
  });

  it('sem o cookie, com Bearer de plataforma ou de vínculo: 401 em toda rota, e nada é lido nem gravado', async () => {
    const world = await setup();
    try {
      // Bearer de plataforma VÁLIDO, emitido por esta mesma instância (login com senha e segundo fator) e
      // aceito pelo `authenticate`: ainda assim não entra em /platform/*, que só aceita o cookie (revisão da
      // E2, M7).
      const other = await enrollTestAdmin(world.auth, world.cipher);
      const issued = await world.auth.service.loginPlatform({
        email: other.email,
        password: TEST_PASSWORD,
        code: codeAt(other.secret, world.clock.ms),
      });
      assert.ok(issued.ok);
      assert.ok((await world.auth.service.authenticate(issued.value.accessToken)).ok);
      const platformBearer = bearer(issued.value.accessToken);
      const membershipBearer = bearer(
        (
          await world.auth.membershipToken(
            CompanyId.parse(
              (
                await world.auth.companies.create({
                  name: 'X',
                  slug: `x-${randomUUID().slice(0, 8)}`,
                })
              ).id,
            ),
          )
        ).accessToken,
      );
      for (const headers of [{}, platformBearer, membershipBearer]) {
        for (const url of GET_ROUTES) {
          const response = await world.app.inject({ method: 'GET', url, headers });
          assert.equal(response.statusCode, 401, url);
        }
        for (const url of POST_ROUTES) {
          const response = await world.app.inject({
            method: 'POST',
            url,
            headers: { ...WRITE_HEADERS, ...headers },
            payload: { reason: 'OTHER' },
          });
          assert.equal(response.statusCode, 401, url);
        }
      }
      assert.equal(world.reads.calls.length, 0);
      assert.deepEqual(actions(world), []);
    } finally {
      await world.app.close();
    }
  });

  it('com a sessão: 200, no-store, datas em ISO; o overview e a saúde seguem o contrato', async () => {
    const world = await setup();
    try {
      const headers = { cookie: world.cookie };
      for (const url of GET_ROUTES.filter((u) => !u.includes(COMPANY_ID))) {
        const response = await world.app.inject({ method: 'GET', url, headers });
        assert.equal(response.statusCode, 200, url);
        assert.equal(response.headers['cache-control'], 'no-store', url);
      }
      const overview = (
        await world.app.inject({ method: 'GET', url: '/platform/overview', headers })
      ).json<PlatformOverviewResponse>();
      assert.ok(!Number.isNaN(Date.parse(overview.generatedAt)));
      assert.equal(overview.billingEnabled, false);
      assert.equal(overview.subscriptions, null);
      assert.equal(overview.paidOrdersThisMonth, null);
      assert.deepEqual(overview.companies, { active: 0, suspended: 0 });

      const health = (
        await world.app.inject({ method: 'GET', url: '/platform/health', headers })
      ).json<PlatformHealthResponse>();
      assert.equal(health.bootedAt, '2026-11-24T10:00:00.000Z');
      assert.equal(health.database, 'up');
      assert.deepEqual(health.queue, { state: 'disabled' });
      assert.deepEqual(health.resume, { state: 'disabled' });
      assert.equal(health.counters.salesContactRequests.sent, 0);
    } finally {
      await world.app.close();
    }
  });

  it('listas: limite padrão 30, teto 50, filtros em minúsculas; valor fora da lista é 400', async () => {
    const world = await setup();
    try {
      const headers = { cookie: world.cookie };
      await world.app.inject({
        method: 'GET',
        url: '/platform/companies?status=suspended&q=acme&attention=token_expiring',
        headers,
      });
      const call = world.reads.calls.find((entry) => entry.method === 'listCompanies');
      assert.deepEqual(call?.args.slice(0, 2), [
        { status: 'SUSPENDED', q: 'acme', attention: 'token_expiring' },
        { limit: 30, cursor: undefined },
      ]);
      for (const url of [
        '/platform/companies?limit=51',
        '/platform/companies?limit=0',
        '/platform/companies?status=removed',
        '/platform/companies?attention=qualquer',
        `/platform/companies?q=${'x'.repeat(65)}`,
        '/platform/companies?q=acme%00',
        '/platform/companies?outro=1',
        '/platform/accounts?verified=talvez',
        '/platform/accounts?status=ACTIVE',
        '/platform/billing/orders?status=pago',
        '/platform/billing/notices?kind=qualquer',
      ]) {
        const response = await world.app.inject({ method: 'GET', url, headers });
        assert.equal(response.statusCode, 400, url);
      }
      const ok = await world.app.inject({
        method: 'GET',
        url: '/platform/accounts?limit=50&status=disabled&verified=false',
        headers,
      });
      assert.equal(ok.statusCode, 200);
      const accounts = world.reads.calls.filter((entry) => entry.method === 'listAccounts').at(-1);
      assert.deepEqual(accounts?.args, [
        { status: 'DISABLED', verified: false },
        { limit: 50, cursor: undefined },
      ]);
    } finally {
      await world.app.close();
    }
  });

  it('id malformado ou inexistente: 404 uniforme (empresa e conta)', async () => {
    const world = await setup();
    try {
      const headers = { cookie: world.cookie };
      for (const url of [
        '/platform/companies/nao-uuid',
        `/platform/companies/${randomUUID()}`,
        '/platform/accounts/nao-uuid',
        `/platform/accounts/${randomUUID()}`,
      ]) {
        const response = await world.app.inject({ method: 'GET', url, headers });
        assert.equal(response.statusCode, 404, url);
      }
      const suspend = await world.app.inject({
        method: 'POST',
        url: '/platform/companies/nao-uuid/suspend',
        headers: { ...WRITE_HEADERS, cookie: world.cookie },
        payload: { reason: 'OTHER' },
      });
      assert.equal(suspend.statusCode, 404);
      assert.deepEqual(actions(world), []);
    } finally {
      await world.app.close();
    }
  });

  it('a lista de contas traz só o e-mail mascarado e não grava; o detalhe traz o completo e grava ACCOUNT_EMAIL_VIEWED', async () => {
    const world = await setup();
    try {
      const headers = { cookie: world.cookie };
      const list = await world.app.inject({ method: 'GET', url: '/platform/accounts', headers });
      assert.equal(
        list.json<PlatformAccountListResponse>().items[0]?.emailMasked,
        'l***@exemplo.com',
      );
      assert.ok(!list.body.includes('lucia@'));
      assert.deepEqual(actions(world), []);

      const detail = await world.app.inject({
        method: 'GET',
        url: `/platform/accounts/${ACCOUNT_ID}`,
        headers,
      });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json<{ email: string }>().email, 'lucia@exemplo.com');
      assert.deepEqual(actions(world), ['ACCOUNT_EMAIL_VIEWED']);
      const event = world.audit.events.at(-1);
      assert.equal(event?.adminId, world.adminId);
      assert.equal(event.subjectAccountId, ACCOUNT_ID);
    } finally {
      await world.app.close();
    }
  });

  it('suspender e reativar: origem exigida (403 sem gravar), motivo da lista (400), 204 idempotente', async () => {
    const world = await setup();
    try {
      const url = `/platform/companies/${COMPANY_ID}/suspend`;
      for (const headers of [
        { cookie: world.cookie },
        { cookie: world.cookie, origin: ORIGIN },
        { cookie: world.cookie, 'x-soprei-app': 'admin' },
        { cookie: world.cookie, origin: 'https://www.exemplo.test', 'x-soprei-app': 'admin' },
        { cookie: world.cookie, origin: ORIGIN, 'x-soprei-app': 'web' },
      ]) {
        const response = await world.app.inject({
          method: 'POST',
          url,
          headers,
          payload: { reason: 'PAYMENT' },
        });
        assert.equal(response.statusCode, 403, JSON.stringify(headers));
      }
      assert.equal(world.companies.statuses.get(COMPANY_ID), 'ACTIVE');
      assert.deepEqual(actions(world), []);

      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      for (const payload of [
        {},
        { reason: 'payment' },
        { reason: 'CALOTE' },
        { reason: 'OTHER', note: 'x' },
      ]) {
        const response = await world.app.inject({ method: 'POST', url, headers, payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
      }
      assert.deepEqual(actions(world), []);

      const first = await world.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { reason: 'PAYMENT' },
      });
      assert.equal(first.statusCode, 204);
      const again = await world.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { reason: 'ABUSE' },
      });
      assert.equal(again.statusCode, 204);
      assert.equal(world.companies.statuses.get(COMPANY_ID), 'SUSPENDED');
      assert.deepEqual(actions(world), ['COMPANY_SUSPENDED']);
      assert.equal(world.audit.events.at(-1)?.reason, 'PAYMENT');

      const back = await world.app.inject({
        method: 'POST',
        url: `/platform/companies/${COMPANY_ID}/reactivate`,
        headers,
        payload: { reason: 'OWNER_REQUEST' },
      });
      assert.equal(back.statusCode, 204);
      assert.equal(world.companies.statuses.get(COMPANY_ID), 'ACTIVE');
      assert.deepEqual(actions(world), ['COMPANY_SUSPENDED', 'COMPANY_REACTIVATED']);
    } finally {
      await world.app.close();
    }
  });
});
