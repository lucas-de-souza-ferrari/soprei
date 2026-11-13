import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { CompanyService } from '../../application/companies/company.service.js';
import type { Company, MembershipRole } from '../../domain/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer } from '../../test-support/in-memory-auth.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { ToggleProxy } from '../../test-support/toggle-proxy.js';
import { createAuthRedis, type AuthRedisHandle } from '../auth/auth-redis.js';
import { type AuthComponents, createAuthComponents } from '../auth/create-auth.js';
import { ScryptPasswordHasher } from '../auth/scrypt-password-hasher.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import { createRateLimitRedis, type RateLimitRedisHandle } from '../cache/rate-limit-redis.js';
import { createDatabase, type Database, PrismaCompanyRepository } from '../database/index.js';
import { createMetrics, type Metrics } from '../metrics/index.js';
import { type RateLimitProfiles } from './rate-limit/rate-limit.js';
import { buildServer } from './server.js';

const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();
const PASSWORD = `senha-secreta-${randomUUID()}`;
const NEW_PASSWORD = `nova-senha-secreta-${randomUUID()}`;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

class CountingHasher extends ScryptPasswordHasher {
  verifyCalls = 0;
  constructor() {
    super({ cost: { N: 1024, r: 8, p: 1 } });
  }
  override verify(password: string, storedHash: string): Promise<boolean> {
    this.verifyCalls += 1;
    return super.verify(password, storedHash);
  }
}

function profiles(overrides: Partial<RateLimitProfiles> = {}): RateLimitProfiles {
  return {
    public: { max: 1_000, windowSeconds: 60 },
    admin: { max: 1_000, windowSeconds: 60 },
    webhook: { max: 1_000, windowSeconds: 60 },
    login: { max: 1_000, windowSeconds: 60 },
    refresh: { max: 1_000, windowSeconds: 60 },
    contact: { max: 1_000, windowSeconds: 60 },
    ...overrides,
  };
}

let database: Database;
let tenants: TestTenants;
let main: RedisHandle;

before(() => {
  database = createDatabase(config, captureLogs().logger);
  tenants = new TestTenants(database.prisma);
  main = createRedis(config, captureLogs().logger);
});

after(async () => {
  try {
    await tenants.cleanup();
    await keyspace.cleanup(main.client);
  } finally {
    await main.close();
    await database.close();
  }
});

interface Harness {
  readonly app: FastifyInstance;
  readonly logs: LogCapture;
  readonly metrics: Metrics;
  readonly auth: AuthComponents;
  readonly hasher: CountingHasher;
  close(): Promise<void>;
}

async function createHarness(
  options: {
    rateRedisUrl?: string;
    maxFailures?: number;
    profiles?: RateLimitProfiles;
  } = {},
): Promise<Harness> {
  const logs = captureLogs();
  const metrics = createMetrics();
  const hasher = new CountingHasher();
  const authRedis: AuthRedisHandle = createAuthRedis(
    { REDIS_URL: config.REDIS_URL, AUTH_REDIS_TIMEOUT_MS: 300 },
    logs.logger,
  );
  const rateRedis: RateLimitRedisHandle = createRateLimitRedis(
    { REDIS_URL: options.rateRedisUrl ?? config.REDIS_URL, RATE_LIMIT_REDIS_TIMEOUT_MS: 300 },
    logs.logger,
  );
  assert.ok(await authRedis.waitUntilReady(5_000));
  assert.ok(await rateRedis.waitUntilReady(5_000));
  const auth = createAuthComponents({
    config: {
      ...config,
      AUTH_REDIS_PREFIX: keyspace.scopedPrefix(`rbac-${randomUUID()}`),
      AUTH_LOGIN_MAX_FAILURES: options.maxFailures ?? 3,
    },
    logger: logs.logger,
    prisma: database.prisma,
    authRedis,
    metrics,
    hasher,
  });
  const app = buildServer({
    logger: logs.logger,
    readiness: {
      database: () => database.check(),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    metrics,
    auth: auth.service,
    membershipAdmin: auth.membershipAdmin,
    admin: { companies: new CompanyService(new PrismaCompanyRepository(database.prisma)) },
    rateLimit: {
      redis: rateRedis.client,
      profiles: options.profiles ?? profiles(),
      keyPrefix: keyspace.scopedPrefix(`rbac-rl-${randomUUID()}`),
    },
  });
  await app.ready();
  return {
    app,
    logs,
    metrics,
    auth,
    hasher,
    async close() {
      try {
        await app.close();
      } finally {
        await authRedis.close();
        await rateRedis.close();
      }
    },
  };
}

async function withHarness(
  options: Parameters<typeof createHarness>[0],
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

const emailFor = (label: string): string =>
  `${label}-${randomBytes(5).toString('hex')}@rbac-it.test`;

interface Person {
  readonly id: string;
  readonly email: string;
  accessToken: string;
  refreshToken: string;
}

async function enroll(h: Harness, company: Company, role: MembershipRole): Promise<Person> {
  const email = emailFor(role.toLowerCase());
  const membership = await h.auth.memberships.create(company.id, {
    email,
    passwordHash: await h.auth.hasher.hash(PASSWORD),
    role,
  });
  const response = await h.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { companySlug: company.slug, email, password: PASSWORD },
    remoteAddress: '203.0.113.10',
  });
  assert.equal(response.statusCode, 200, response.body);
  const tokens = response.json<{ accessToken: string; refreshToken: string }>();
  return { id: membership.id, email, ...tokens };
}

const as = (
  h: Harness,
  who: Person,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
) =>
  h.app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    remoteAddress: '203.0.113.10',
    ...(payload === undefined ? {} : { payload }),
  });

const stable = (response: LightMyRequestResponse): string =>
  response.body.replace(/"requestId":"[^"]*"/, '');

describe('RBAC de ponta a ponta (Postgres e Redis reais, duas empresas)', () => {
  it('o OWNER de A com :companyId ou membershipId de B recebe 404 idêntico ao de inexistente; nada de B muda; o CompanyId vem do token', async () => {
    await withHarness({}, async (h) => {
      const a = await tenants.createCompany('rbac-a');
      const b = await tenants.createCompany('rbac-b');
      const ownerA = await enroll(h, a, 'OWNER');
      const victim = await enroll(h, b, 'AGENT');
      await enroll(h, b, 'OWNER');
      const ghost = randomUUID();

      const alienCompany = [
        await as(h, ownerA, 'GET', `/admin/companies/${b.id}/memberships`),
        await as(h, ownerA, 'PATCH', `/admin/companies/${b.id}/memberships/${victim.id}`, {
          role: 'VIEWER',
        }),
      ];
      const ghostCompany = [
        await as(h, ownerA, 'GET', `/admin/companies/${ghost}/memberships`),
        await as(h, ownerA, 'PATCH', `/admin/companies/${ghost}/memberships/${victim.id}`, {
          role: 'VIEWER',
        }),
      ];
      for (const response of [...alienCompany, ...ghostCompany])
        assert.equal(response.statusCode, 404);
      assert.deepEqual(alienCompany.map(stable), ghostCompany.map(stable));

      const alienMembership = [
        await as(h, ownerA, 'PATCH', `/admin/companies/${a.id}/memberships/${victim.id}`, {
          role: 'VIEWER',
        }),
        await as(h, ownerA, 'POST', `/admin/companies/${a.id}/memberships/${victim.id}/password`, {
          newPassword: NEW_PASSWORD,
        }),
      ];
      const ghostMembership = [
        await as(h, ownerA, 'PATCH', `/admin/companies/${a.id}/memberships/${ghost}`, {
          role: 'VIEWER',
        }),
        await as(h, ownerA, 'POST', `/admin/companies/${a.id}/memberships/${ghost}/password`, {
          newPassword: NEW_PASSWORD,
        }),
      ];
      for (const response of [...alienMembership, ...ghostMembership])
        assert.equal(response.statusCode, 404);
      assert.deepEqual(alienMembership.map(stable), ghostMembership.map(stable));

      // Nada de B foi lido nem alterado, e a trilha de B continua vazia.
      assert.equal((await h.auth.memberships.findById(b.id, victim.id)).role, 'AGENT');
      assert.equal(await h.auth.memberships.countActiveOwners(b.id), 1);
      const login = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { companySlug: b.slug, email: victim.email, password: PASSWORD },
      });
      assert.equal(login.statusCode, 200, 'a senha do alvo de B não mudou');

      // Um usuário criado por A nasce em A, mesmo com o :companyId (conferido) igual ao do token.
      const created = await as(h, ownerA, 'POST', `/admin/companies/${a.id}/memberships`, {
        email: emailFor('novo'),
        password: PASSWORD,
        role: 'AGENT',
      });
      assert.equal(created.statusCode, 201);
      const createdId = created.json<{ id: string }>().id;
      assert.equal((await h.auth.memberships.findById(a.id, createdId)).companyId, a.id);
      await assert.rejects(h.auth.memberships.findById(b.id, createdId));
    });
  });

  it('GET /audit-events: cada empresa lê só a própria trilha (Postgres real), com cursor, e o VIEWER recebe 403', async () => {
    await withHarness({}, async (h) => {
      const a = await tenants.createCompany('rbac-aud-a');
      const b = await tenants.createCompany('rbac-aud-b');
      const ownerA = await enroll(h, a, 'OWNER');
      const ownerB = await enroll(h, b, 'OWNER');
      const viewer = await enroll(h, a, 'VIEWER');
      const agentA = await enroll(h, a, 'AGENT');
      const agentB = await enroll(h, b, 'AGENT');
      for (const role of ['VIEWER', 'ADMIN', 'AGENT'] as const) {
        const done = await as(
          h,
          ownerA,
          'PATCH',
          `/admin/companies/${a.id}/memberships/${agentA.id}`,
          {
            role,
          },
        );
        assert.equal(done.statusCode, 200);
        await sleep(3);
      }
      assert.equal(
        (
          await as(h, ownerB, 'PATCH', `/admin/companies/${b.id}/memberships/${agentB.id}`, {
            role: 'ADMIN',
          })
        ).statusCode,
        200,
      );
      interface Page {
        items: {
          id: string;
          action: string;
          actorMembershipId: string;
          targetMembershipId: string;
          toRole: string | null;
        }[];
        nextCursor: string | null;
      }
      const seen: Page['items'] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const response = await as(
          h,
          ownerA,
          'GET',
          `/admin/companies/${a.id}/audit-events?limit=2${cursor === undefined ? '' : `&cursor=${cursor}`}`,
        );
        assert.equal(response.statusCode, 200);
        const page = response.json<Page>();
        seen.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined);
      assert.equal(pages, 2);
      assert.deepEqual(
        seen.map((event) => event.toRole),
        ['AGENT', 'ADMIN', 'VIEWER'],
        'mais recentes primeiro',
      );
      assert.ok(
        seen.every(
          (event) =>
            event.actorMembershipId === ownerA.id && event.targetMembershipId === agentA.id,
        ),
      );
      const fromB = (
        await as(h, ownerB, 'GET', `/admin/companies/${b.id}/audit-events`)
      ).json<Page>();
      assert.equal(fromB.items.length, 1);
      assert.ok(!seen.some((event) => fromB.items.some((other) => other.id === event.id)));
      assert.equal(
        (await as(h, viewer, 'GET', `/admin/companies/${a.id}/audit-events`)).statusCode,
        403,
      );
      assert.equal(
        (await as(h, ownerA, 'GET', `/admin/companies/${b.id}/audit-events`)).statusCode,
        404,
      );
    });
  });

  it('mudar papel, desativar e redefinir senha derrubam o access token ainda válido e o refresh (Redis real); o login traz o papel novo', async () => {
    await withHarness({}, async (h) => {
      const company = await tenants.createCompany('rbac-sess');
      const other = await tenants.createCompany('rbac-sess-b');
      const owner = await enroll(h, company, 'OWNER');
      const bystander = await enroll(h, company, 'AGENT');
      const alien = await enroll(h, other, 'AGENT');
      const url = (id: string): string => `/admin/companies/${company.id}/memberships/${id}`;

      const demoted = await enroll(h, company, 'ADMIN');
      assert.equal((await as(h, demoted, 'GET', '/auth/me')).statusCode, 200);
      assert.equal(
        (await as(h, owner, 'PATCH', url(demoted.id), { role: 'AGENT' })).statusCode,
        200,
      );
      assert.equal((await as(h, demoted, 'GET', '/auth/me')).statusCode, 401);
      const refresh = await h.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: demoted.refreshToken },
      });
      assert.equal(refresh.statusCode, 401);
      const relogin = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { companySlug: company.slug, email: demoted.email, password: PASSWORD },
      });
      assert.equal(relogin.statusCode, 200);
      const reborn: Person = {
        ...demoted,
        ...relogin.json<{ accessToken: string; refreshToken: string }>(),
      };
      assert.equal(
        (await as(h, reborn, 'GET', `/admin/companies/${company.id}/memberships`)).statusCode,
        403,
      );

      const disabled = await enroll(h, company, 'AGENT');
      assert.equal(
        (await as(h, owner, 'PATCH', url(disabled.id), { status: 'DISABLED' })).statusCode,
        200,
      );
      assert.equal((await as(h, disabled, 'GET', '/auth/me')).statusCode, 401);
      const blocked = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { companySlug: company.slug, email: disabled.email, password: PASSWORD },
      });
      assert.equal(blocked.statusCode, 401);

      const reset = await enroll(h, company, 'AGENT');
      const resetResponse = await as(h, owner, 'POST', `${url(reset.id)}/password`, {
        newPassword: NEW_PASSWORD,
      });
      assert.equal(resetResponse.statusCode, 204);
      assert.equal((await as(h, reset, 'GET', '/auth/me')).statusCode, 401);
      const withNew = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { companySlug: company.slug, email: reset.email, password: NEW_PASSWORD },
      });
      assert.equal(withNew.statusCode, 200);

      // Outras pessoas, do mesma empresa e de outro, não foram afetadas.
      for (const who of [owner, bystander, alien]) {
        assert.equal((await as(h, who, 'GET', '/auth/me')).statusCode, 200);
      }
    });
  });

  it('POST /auth/password: errada conta e bloqueia (429 antes do hash); certa troca e derruba todas as sessões (Redis real)', async () => {
    await withHarness({}, async (h) => {
      const company = await tenants.createCompany('rbac-pw');
      const person = await enroll(h, company, 'VIEWER');
      const wrong = { currentPassword: `${PASSWORD}-x`, newPassword: NEW_PASSWORD };
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await as(h, person, 'POST', '/auth/password', wrong)).statusCode, 401);
      }
      const before = h.hasher.verifyCalls;
      const locked = await as(h, person, 'POST', '/auth/password', {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      assert.equal(locked.statusCode, 429);
      assert.match(String(locked.headers['retry-after']), /^[1-9]\d*$/);
      assert.equal(h.hasher.verifyCalls, before, '429 vem antes de gastar hash');

      // Outra pessoa troca a sua sem problema (o contador é por pessoa).
      const other = await enroll(h, company, 'AGENT');
      const second = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { companySlug: company.slug, email: other.email, password: PASSWORD },
      });
      const secondSession = second.json<{ accessToken: string; refreshToken: string }>();
      const changed = await as(h, other, 'POST', '/auth/password', {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      assert.equal(changed.statusCode, 204);
      assert.equal((await as(h, other, 'GET', '/auth/me')).statusCode, 401);
      const viaSecond = await h.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: bearer(secondSession.accessToken),
      });
      assert.equal(viaSecond.statusCode, 401, 'a outra sessão da pessoa também caiu');
      const refresh = await h.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: secondSession.refreshToken },
      });
      assert.equal(refresh.statusCode, 401);
      const relogin = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { companySlug: company.slug, email: other.email, password: NEW_PASSWORD },
      });
      assert.equal(relogin.statusCode, 200);
    });
  });

  it(
    'POST /auth/password com o Redis do limiter fora: 503, sem verificar a senha e sem trocá-la (fail-closed)',
    { timeout: 60_000 },
    async () => {
      const url = new URL(config.REDIS_URL);
      const proxy = new ToggleProxy(url.hostname, Number(url.port || '6379'));
      await proxy.start();
      const viaProxy = new URL(config.REDIS_URL);
      viaProxy.hostname = '127.0.0.1';
      viaProxy.port = String(proxy.listeningPort);
      try {
        await withHarness({ rateRedisUrl: viaProxy.toString() }, async (h) => {
          const company = await tenants.createCompany('rbac-pw-down');
          const person = await enroll(h, company, 'AGENT');
          for (const mode of ['blackhole', 'stop'] as const) {
            if (mode === 'blackhole') proxy.mode = 'blackhole';
            else {
              proxy.mode = 'forward';
              await proxy.stop();
            }
            const before = h.hasher.verifyCalls;
            const response = await as(h, person, 'POST', '/auth/password', {
              currentPassword: PASSWORD,
              newPassword: NEW_PASSWORD,
            });
            assert.equal(response.statusCode, 503, mode);
            assert.equal(
              response.json<{ error: { code: string } }>().error.code,
              'SERVICE_UNAVAILABLE',
            );
            assert.equal(h.hasher.verifyCalls, before, 'nenhuma senha foi verificada');
          }
          await proxy.start();
          const stillValid = await h.app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: { companySlug: company.slug, email: person.email, password: PASSWORD },
          });
          const deadline = Date.now() + 15_000;
          let status = stillValid.statusCode;
          while (status !== 200 && Date.now() < deadline) {
            await sleep(100);
            status = (
              await h.app.inject({
                method: 'POST',
                url: '/auth/login',
                payload: { companySlug: company.slug, email: person.email, password: PASSWORD },
              })
            ).statusCode;
          }
          assert.equal(status, 200, 'a senha antiga segue valendo');
        });
      } finally {
        await proxy.stop();
      }
    },
  );

  it('senhas, e-mails, tokens e hashes nunca aparecem em log, métrica nem corpo de erro das rotas novas', async () => {
    await withHarness({}, async (h) => {
      const company = await tenants.createCompany('rbac-priv');
      const owner = await enroll(h, company, 'OWNER');
      const secretEmail = emailFor('segredo');
      const errorBodies: string[] = [];
      const created = await as(h, owner, 'POST', `/admin/companies/${company.id}/memberships`, {
        email: secretEmail,
        password: NEW_PASSWORD,
        role: 'AGENT',
      });
      assert.equal(created.statusCode, 201);
      const id = created.json<{ id: string }>().id;
      for (const response of [
        await as(h, owner, 'POST', `/admin/companies/${company.id}/memberships`, {
          email: secretEmail,
          password: NEW_PASSWORD,
          role: 'AGENT',
        }),
        await as(h, owner, 'POST', `/admin/companies/${company.id}/memberships`, {
          email: 'invalido',
          password: NEW_PASSWORD,
          role: 'AGENT',
        }),
        await as(h, owner, 'PATCH', `/admin/companies/${company.id}/memberships/${id}`, {
          role: 'ROOT',
        }),
        await as(h, owner, 'POST', '/auth/password', {
          currentPassword: `${PASSWORD}-errada`,
          newPassword: NEW_PASSWORD,
        }),
      ]) {
        assert.ok(response.statusCode >= 400);
        errorBodies.push(response.body);
      }
      await as(h, owner, 'PATCH', `/admin/companies/${company.id}/memberships/${id}`, {
        role: 'VIEWER',
      });
      await as(h, owner, 'POST', `/admin/companies/${company.id}/memberships/${id}/password`, {
        newPassword: NEW_PASSWORD,
      });
      const stored = await h.auth.memberships.findCredentialsById(company.id, id);
      const everything = `${h.logs.raw()}\n${await h.metrics.render()}\n${errorBodies.join('\n')}`;
      for (const secret of [
        PASSWORD,
        NEW_PASSWORD,
        `${PASSWORD}-errada`,
        secretEmail,
        owner.email,
        owner.accessToken,
        owner.refreshToken,
        stored.passwordHash,
      ]) {
        assert.ok(!everything.includes(secret), `vazou: ${secret.slice(0, 10)}`);
      }
      assert.match(
        await h.metrics.render(),
        /membership_admin_actions_total\{action="MEMBERSHIP_CREATED"\} 1/,
      );
    });
  });
});
