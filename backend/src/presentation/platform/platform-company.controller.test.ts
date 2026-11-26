import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { PlatformAuthService } from '../../application/platform/platform-auth.service.js';
import { PlatformCompanyService } from '../../application/platform/platform-company.service.js';
import { CompanyId, MembershipId } from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth, TEST_PASSWORD } from '../../test-support/in-memory-auth.js';
import {
  codeAt,
  enrollTestAdmin,
  InMemoryPlatformAuditRepository,
  InMemoryPlatformCompanyUnitOfWork,
  InMemoryPlatformSessionStore,
  ManualClock,
  testPlatformCipher,
} from '../../test-support/in-memory-platform.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { ACCOUNT_COOKIE } from '../auth/account.controller.js';
import { PLATFORM_COOKIE } from './platform-auth.controller.js';

// Spec 045, E3a: as ações do admin da plataforma sobre empresas e vínculos, de ponta a ponta pelo Fastify
// (cookie com segundo fator, origem, corpo strict, confirmação com código novo, 404 uniforme, privacidade).

const ORIGIN = 'https://soadm.exemplo.test';
const WRITE_HEADERS = { origin: ORIGIN, 'x-soprei-app': 'admin' } as const;
const ALL_UP = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};
const SLUG = 'padaria-do-teste-e3a';
/** Nome da empresa: só existe aqui, para provar que nunca sai em log ou métrica. */
const NAME = 'Padaria Sigilosa Ltda';

interface World {
  readonly app: FastifyInstance;
  readonly uow: InMemoryPlatformCompanyUnitOfWork;
  readonly audit: InMemoryPlatformAuditRepository;
  readonly calls: string[];
  readonly logs: ReturnType<typeof captureLogs>;
  readonly auth: ReturnType<typeof buildTestAuth>;
  readonly cipher: ReturnType<typeof testPlatformCipher>;
  readonly clock: ManualClock;
  readonly cookie: string;
  readonly secret: Buffer;
  readonly company: CompanyId;
  readonly owner: MembershipId;
  readonly agent: MembershipId;
  readonly foreign: MembershipId;
}

async function setup(): Promise<World> {
  const logs = captureLogs();
  const clock = new ManualClock();
  const cipher = testPlatformCipher();
  const auth = buildTestAuth({
    logger: logs.logger,
    maxFailures: 3,
    platformTotp: { cipher, now: clock.now },
  });
  const sessions = new InMemoryPlatformSessionStore(clock.now, 1_800, 43_200);
  const audit = new InMemoryPlatformAuditRepository();
  const uow = new InMemoryPlatformCompanyUnitOfWork(audit);
  const company = CompanyId.parse(randomUUID());
  const other = CompanyId.parse(randomUUID());
  uow.addCompany(company, SLUG, NAME);
  // Spec 045, E5: a empresa tem canal (conexão), para a rota de desconectar ter o que fazer.
  uow.channels.set(company, { wabaId: '1234567890', tokenCiphertext: 'cifrado' });
  uow.addCompany(other, 'outra-e3a', 'Outra');
  const owner = MembershipId.parse(randomUUID());
  const agent = MembershipId.parse(randomUUID());
  const foreign = MembershipId.parse(randomUUID());
  const account = { status: 'ACTIVE' as const, verified: true };
  uow.addMembership(company, owner, { role: 'OWNER', status: 'ACTIVE', account });
  uow.addMembership(company, agent, { role: 'AGENT', status: 'ACTIVE', account });
  uow.addMembership(other, foreign, { role: 'AGENT', status: 'ACTIVE', account });
  const calls: string[] = [];
  const metrics = createMetrics();
  const app = buildServer({
    logger: logs.logger,
    readiness: ALL_UP,
    metrics,
    metricsToken: 'token-de-metricas-de-teste-com-32-chars',
    auth: auth.service,
    platform: {
      auth: new PlatformAuthService({
        credentials: auth.service,
        admins: auth.platformAdmins,
        sessions,
        audit,
        logger: logs.logger,
        metrics,
      }),
      origin: ORIGIN,
      maxAgeSeconds: 43_200,
      companies: new PlatformCompanyService({
        companies: uow,
        confirmer: auth.service,
        bearerSessions: {
          revokeAllSessions: (scope, subject) => {
            calls.push(`bearer:${scope}:${subject}`);
            return Promise.resolve();
          },
        },
        // O canal é um dublê: o efeito real está em platform-channel.integration.test.ts.
        channel: {
          unsubscribeRemoved: (companyId) => {
            calls.push(`unsubscribe:${companyId}`);
            return Promise.resolve();
          },
          disconnect: (actor) => {
            calls.push(`disconnect:${actor.companyId}:${actor.reason}`);
            return Promise.resolve(true);
          },
        },
        logger: logs.logger,
        metrics,
      }),
    },
  });
  await app.ready();
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
  return {
    app,
    uow,
    audit,
    calls,
    logs,
    auth,
    cipher,
    clock,
    cookie,
    secret: admin.secret,
    company,
    owner,
    agent,
    foreign,
  };
}

function actions(world: World): string[] {
  return world.audit.events.map((event) => event.action).filter((a) => !a.startsWith('PLATFORM_'));
}

/** Um código novo (o passo seguinte ao do login, ou ao último usado). */
function freshCode(world: World): string {
  world.clock.advanceSeconds(30);
  return codeAt(world.secret, world.clock.ms);
}

function routes(
  companyId: string,
  membershipId: string,
): readonly (readonly [string, Record<string, unknown>])[] {
  const base = `/platform/companies/${companyId}`;
  return [
    [`${base}/rename`, { name: 'Outro nome', reason: 'OTHER' }],
    [`${base}/remove`, { reason: 'ABUSE', slug: SLUG, code: '123456' }],
    [`${base}/restore`, { reason: 'OTHER', code: '123456' }],
    [`${base}/channel/disconnect`, { reason: 'OTHER', code: '123456' }],
    [`${base}/memberships/${membershipId}/role`, { role: 'VIEWER', reason: 'OTHER' }],
    [`${base}/memberships/${membershipId}/disable`, { reason: 'OTHER' }],
    [`${base}/memberships/${membershipId}/enable`, { reason: 'OTHER' }],
  ];
}

function errorCode(response: { json: () => unknown }): string {
  return (response.json() as { error: { code: string } }).error.code;
}

describe('/platform/companies/:companyId/* ações sobre empresa e vínculos (spec 045, E3a)', () => {
  it('sem o cookie do admin, com Bearer de plataforma ou de vínculo ou com o cookie da conta: 401; sem origem ou cabeçalho: 403; nada gravado', async () => {
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
        for (const [url, payload] of routes(world.company, world.agent)) {
          const response = await world.app.inject({
            method: 'POST',
            url,
            headers: { ...WRITE_HEADERS, ...headers },
            payload,
          });
          assert.equal(response.statusCode, 401, url);
        }
      }
      for (const headers of [
        { cookie: world.cookie },
        { cookie: world.cookie, origin: ORIGIN },
        { cookie: world.cookie, 'x-soprei-app': 'admin' },
        { cookie: world.cookie, origin: 'https://www.exemplo.test', 'x-soprei-app': 'admin' },
      ]) {
        for (const [url, payload] of routes(world.company, world.agent)) {
          const response = await world.app.inject({ method: 'POST', url, headers, payload });
          assert.equal(response.statusCode, 403, `${url} ${JSON.stringify(headers)}`);
        }
      }
      assert.deepEqual(actions(world), []);
      assert.deepEqual(world.calls, []);
      assert.equal(world.uow.names.get(world.company), NAME);
    } finally {
      await world.app.close();
    }
  });

  it('corpo strict (motivo fora da lista, campo a mais, papel ou código inválido) = 400; ids malformados, inexistentes ou de outra empresa = 404; nada gravado', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      for (const [url, payload] of routes(world.company, world.agent)) {
        for (const bad of [{}, { ...payload, reason: 'CALOTE' }, { ...payload, nota: 'x' }]) {
          const response = await world.app.inject({ method: 'POST', url, headers, payload: bad });
          assert.equal(response.statusCode, 400, `${url} ${JSON.stringify(bad)}`);
        }
      }
      const base = `/platform/companies/${world.company}`;
      for (const [url, payload] of [
        [`${base}/rename`, { name: '   ', reason: 'OTHER' }],
        [`${base}/rename`, { name: 'x'.repeat(121), reason: 'OTHER' }],
        [`${base}/memberships/${world.agent}/role`, { role: 'DONO', reason: 'OTHER' }],
        [
          `${base}/memberships/${world.agent}/role`,
          { role: 'OWNER', reason: 'OTHER', code: '12a' },
        ],
        [`${base}/remove`, { reason: 'OTHER', slug: SLUG, code: '1234567' }],
      ] as const) {
        const response = await world.app.inject({ method: 'POST', url, headers, payload });
        assert.equal(response.statusCode, 400, `${url} ${JSON.stringify(payload)}`);
      }
      for (const [companyId, membershipId] of [
        ['nao-uuid', world.agent],
        [randomUUID(), world.agent],
        [world.company, 'nao-uuid'],
        [world.company, randomUUID()],
        // O vínculo existe, mas é de outra empresa.
        [world.company, world.foreign],
      ] as const) {
        for (const [url, payload] of routes(companyId, membershipId)) {
          // As rotas da empresa só se aplicam quando o id da empresa é o ruim.
          if (companyId === world.company && !url.includes('/memberships/')) continue;
          const response = await world.app.inject({ method: 'POST', url, headers, payload });
          assert.equal(response.statusCode, 404, url);
        }
      }
      assert.deepEqual(actions(world), []);
      assert.deepEqual(world.calls, []);
    } finally {
      await world.app.close();
    }
  });

  it('remover: slug errado = 400 CONFIRMATION_MISMATCH; sem código, errado ou o do login = 400 CONFIRMATION_INVALID; com código novo = 204 e trilha; restaurar = 204', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      const url = `/platform/companies/${world.company}/remove`;
      const mismatch = await world.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { reason: 'ABUSE', slug: 'outro-slug', code: freshCode(world) },
      });
      assert.equal(mismatch.statusCode, 400);
      assert.equal(errorCode(mismatch), 'CONFIRMATION_MISMATCH');
      const loginCode = codeAt(world.secret, world.clock.ms - 30_000);
      for (const payload of [
        { reason: 'ABUSE', slug: SLUG },
        { reason: 'ABUSE', slug: SLUG, code: loginCode === '000000' ? '000001' : '000000' },
        { reason: 'ABUSE', slug: SLUG, code: loginCode },
      ]) {
        const response = await world.app.inject({ method: 'POST', url, headers, payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
        assert.equal(errorCode(response), 'CONFIRMATION_INVALID');
      }
      assert.equal(world.uow.removed.has(world.company), false);
      assert.deepEqual(actions(world), []);

      const ok = await world.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { reason: 'ABUSE', slug: SLUG, code: freshCode(world) },
      });
      assert.equal(ok.statusCode, 204);
      assert.equal(world.uow.removed.has(world.company), true);
      assert.deepEqual(actions(world), ['COMPANY_REMOVED']);

      const restore = await world.app.inject({
        method: 'POST',
        url: `/platform/companies/${world.company}/restore`,
        headers,
        payload: { reason: 'OWNER_REQUEST', code: freshCode(world) },
      });
      assert.equal(restore.statusCode, 204);
      assert.equal(world.uow.removed.has(world.company), false);
      assert.deepEqual(actions(world), ['COMPANY_REMOVED', 'COMPANY_RESTORED']);
    } finally {
      await world.app.close();
    }
  });

  it('papel: OWNER exige código; o último dono = 409 LAST_OWNER; transferir a propriedade; desativar e reativar; a Bearer é revogada', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      const base = `/platform/companies/${world.company}/memberships`;
      const noCode = await world.app.inject({
        method: 'POST',
        url: `${base}/${world.agent}/role`,
        headers,
        payload: { role: 'OWNER', reason: 'OWNER_REQUEST' },
      });
      assert.equal(noCode.statusCode, 400);
      assert.equal(errorCode(noCode), 'CONFIRMATION_INVALID');
      const last = await world.app.inject({
        method: 'POST',
        url: `${base}/${world.owner}/role`,
        headers,
        payload: { role: 'ADMIN', reason: 'OWNER_REQUEST', code: freshCode(world) },
      });
      assert.equal(last.statusCode, 409);
      assert.equal(errorCode(last), 'LAST_OWNER');
      for (const [membershipId, role] of [
        [world.agent, 'OWNER'],
        [world.owner, 'ADMIN'],
      ] as const) {
        const response = await world.app.inject({
          method: 'POST',
          url: `${base}/${membershipId}/role`,
          headers,
          payload: { role, reason: 'OWNER_REQUEST', code: freshCode(world) },
        });
        assert.equal(response.statusCode, 204, `${membershipId} -> ${role}`);
      }
      const disable = await world.app.inject({
        method: 'POST',
        url: `${base}/${world.owner}/disable`,
        headers,
        payload: { reason: 'OTHER' },
      });
      assert.equal(disable.statusCode, 204);
      const lastOwnerDisable = await world.app.inject({
        method: 'POST',
        url: `${base}/${world.agent}/disable`,
        headers,
        payload: { reason: 'OTHER' },
      });
      assert.equal(lastOwnerDisable.statusCode, 409);
      const enable = await world.app.inject({
        method: 'POST',
        url: `${base}/${world.owner}/enable`,
        headers,
        payload: { reason: 'OTHER' },
      });
      assert.equal(enable.statusCode, 204);
      assert.deepEqual(actions(world), [
        'MEMBERSHIP_ROLE_CHANGED_BY_PLATFORM',
        'MEMBERSHIP_ROLE_CHANGED_BY_PLATFORM',
        'MEMBERSHIP_DISABLED_BY_PLATFORM',
        'MEMBERSHIP_ENABLED_BY_PLATFORM',
      ]);
      assert.deepEqual(world.calls, [
        `bearer:${world.company}:${world.agent}`,
        `bearer:${world.company}:${world.owner}`,
        `bearer:${world.company}:${world.owner}`,
      ]);
    } finally {
      await world.app.close();
    }
  });

  it('privacidade: nenhuma resposta, log ou métrica traz nome, slug ou código; as métricas novas aparecem', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      const codes: string[] = [];
      const bodies: string[] = [];
      const rename = await world.app.inject({
        method: 'POST',
        url: `/platform/companies/${world.company}/rename`,
        headers,
        payload: { name: 'Nome Novo Sigiloso', reason: 'OTHER' },
      });
      bodies.push(rename.body);
      const promote = freshCode(world);
      codes.push(promote);
      bodies.push(
        (
          await world.app.inject({
            method: 'POST',
            url: `/platform/companies/${world.company}/memberships/${world.agent}/role`,
            headers,
            payload: { role: 'OWNER', reason: 'OTHER', code: promote },
          })
        ).body,
      );
      const remove = freshCode(world);
      codes.push(remove);
      bodies.push(
        (
          await world.app.inject({
            method: 'POST',
            url: `/platform/companies/${world.company}/remove`,
            headers,
            payload: { reason: 'OTHER', slug: SLUG, code: remove },
          })
        ).body,
      );
      const metrics = await world.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer token-de-metricas-de-teste-com-32-chars' },
      });
      for (const action of [
        'company_renamed',
        'membership_role_changed_by_platform',
        'company_removed',
      ]) {
        assert.ok(metrics.body.includes(`action="${action}"`), action);
      }
      const raw = world.logs.raw();
      for (const secret of [NAME, 'Nome Novo Sigiloso', SLUG, ...codes]) {
        assert.ok(!logContains(raw, secret), `log: ${secret}`);
        assert.ok(!metrics.body.includes(secret), `métrica: ${secret}`);
        for (const body of bodies) assert.ok(!body.includes(secret), `resposta: ${secret}`);
      }
    } finally {
      await world.app.close();
    }
  });

  it('desconectar o canal (spec 045, E5): sem código ou com o do login = 400 CONFIRMATION_INVALID sem efeito; com código novo = 204 e o canal é chamado como a plataforma', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      const url = `/platform/companies/${world.company}/channel/disconnect`;
      const loginCode = codeAt(world.secret, world.clock.ms);
      for (const payload of [{ reason: 'ABUSE' }, { reason: 'ABUSE', code: loginCode }]) {
        const response = await world.app.inject({ method: 'POST', url, headers, payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
        assert.equal(errorCode(response), 'CONFIRMATION_INVALID');
        assert.ok(!response.body.includes(loginCode));
      }
      assert.deepEqual(world.calls, []);
      const ok = await world.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { reason: 'ABUSE', code: freshCode(world) },
      });
      assert.equal(ok.statusCode, 204);
      assert.equal(ok.body, '');
      assert.deepEqual(world.calls, [`disconnect:${world.company}:ABUSE`]);
    } finally {
      await world.app.close();
    }
  });
});
