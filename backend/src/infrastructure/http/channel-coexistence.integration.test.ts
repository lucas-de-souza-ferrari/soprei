import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { ChannelConnectionService } from '../../application/channel/channel-connection.service.js';
import { CompanyService } from '../../application/companies/company.service.js';
import type { Company, MembershipRole } from '../../domain/index.js';
import { Result } from '../../shared/types/index.js';
import { buildChannelCredentials } from '../../test-support/channel-credentials.js';
import { FakeGraphApi, FULL_SCOPES, graphError } from '../../test-support/fake-graph-api.js';
import { bearer } from '../../test-support/in-memory-auth.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, type LogCapture } from '../../test-support/log-capture.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createAuthRedis } from '../auth/auth-redis.js';
import { type AuthComponents, createAuthComponents } from '../auth/create-auth.js';
import { ScryptPasswordHasher } from '../auth/scrypt-password-hasher.js';
import { createRedis, type RedisHandle } from '../cache/redis.client.js';
import {
  createDatabase,
  type Database,
  PrismaChannelUnitOfWork,
  PrismaCompanyRepository,
} from '../database/index.js';
import { WhatsappGraphAdminClient } from '../external-apis/whatsapp/whatsapp-graph-admin.client.js';
import { createMetrics, type Metrics } from '../metrics/index.js';
import { buildServer } from './server.js';

const config = loadIntegrationConfig();
const keyspace = new TestKeyspace();
const PASSWORD = `senha-secreta-${randomUUID()}`;
const APP_ID = '1234567890123';
const APP_SECRET = `app-secret-${randomUUID()}`;

const graph = new FakeGraphApi();
let database: Database;
let tenants: TestTenants;
let main: RedisHandle;

before(async () => {
  await graph.start();
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
    await graph.stop();
  }
});

afterEach(() => {
  graph.reset();
});

const digits = (): string => `9${randomBytes(6).readUIntBE(0, 6).toString().padStart(15, '0')}`;
const newToken = (): string => `EAAG-token-${randomUUID()}`;
const newCode = (): string => `code-secreto-${randomUUID()}`;
const emailFor = (label: string): string => `${label}-${randomBytes(5).toString('hex')}@es-it.test`;

interface Harness {
  readonly app: FastifyInstance;
  readonly logs: LogCapture;
  readonly metrics: Metrics;
  readonly auth: AuthComponents;
  readonly stack: ReturnType<typeof buildChannelCredentials>;
  close(): Promise<void>;
}

async function createHarness(
  options: { withChannel?: boolean; coexistence?: boolean } = {},
): Promise<Harness> {
  const logs = captureLogs();
  const metrics = createMetrics();
  const authRedis = createAuthRedis(
    { REDIS_URL: config.REDIS_URL, AUTH_REDIS_TIMEOUT_MS: 300 },
    logs.logger,
  );
  assert.ok(await authRedis.waitUntilReady(5_000));
  const auth = createAuthComponents({
    config: { ...config, AUTH_REDIS_PREFIX: keyspace.scopedPrefix(`es-${randomUUID()}`) },
    logger: logs.logger,
    prisma: database.prisma,
    authRedis,
    metrics,
    hasher: new ScryptPasswordHasher({ cost: { N: 1024, r: 8, p: 1 } }),
  });
  const companies = new PrismaCompanyRepository(database.prisma);
  const stack = buildChannelCredentials(database.prisma);
  const channel = new ChannelConnectionService({
    companies,
    connections: stack.connections,
    unitOfWork: new PrismaChannelUnitOfWork(database.prisma),
    cipher: stack.cipher,
    provisioner: new WhatsappGraphAdminClient({
      baseUrl: graph.baseUrl,
      graphApiVersion: 'v26.0',
      appId: APP_ID,
      appSecret: APP_SECRET,
      timeoutMs: 400,
    }),
    appId: APP_ID,
    logger: logs.logger,
    metrics,
  });
  const app = buildServer({
    logger: logs.logger,
    metrics,
    metricsToken: 'm'.repeat(40),
    readiness: {
      database: () => database.check(),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    auth: auth.service,
    membershipAdmin: auth.membershipAdmin,
    admin: {
      companies: new CompanyService(companies),
      ...(options.withChannel === false ? {} : { channel }),
      // Spec 039: a coexistência só existe com a flag (padrão ligada nestes testes).
      channelSetup: {
        appId: APP_ID,
        embeddedSignupConfigId: '5550001',
        graphApiVersion: 'v26.0',
        manualConnect: false,
        coexistence: { enabled: options.coexistence !== false, configId: '5550001' },
      },
    },
  });
  await app.ready();
  return {
    app,
    logs,
    metrics,
    auth,
    stack,
    async close() {
      try {
        await app.close();
      } finally {
        await authRedis.close();
      }
    },
  };
}

async function withHarness(
  body: (harness: Harness) => Promise<void>,
  options: Parameters<typeof createHarness>[0] = {},
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

interface Person {
  readonly id: string;
  accessToken: string;
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
  return { id: membership.id, accessToken: response.json<{ accessToken: string }>().accessToken };
}

const signup = (h: Harness, who: Person, companyId: string, payload: object) =>
  h.app.inject({
    method: 'POST',
    url: `/admin/companies/${companyId}/channel/embedded-signup`,
    headers: bearer(who.accessToken),
    remoteAddress: '203.0.113.10',
    payload,
  });

const call = (
  h: Harness,
  who: Person,
  method: 'GET' | 'PUT' | 'DELETE',
  companyId: string,
  payload?: object,
) =>
  h.app.inject({
    method,
    url: `/admin/companies/${companyId}/channel`,
    headers: bearer(who.accessToken),
    remoteAddress: '203.0.113.10',
    ...(payload === undefined ? {} : { payload }),
  });

interface ChannelBody {
  state: string;
  phoneNumberId: string | null;
  wabaId: string | null;
}

const errorCode = (response: LightMyRequestResponse): string =>
  response.json<{ error: { code: string } }>().error.code;

async function dbState(companyId: string) {
  const [company, connection, events] = await Promise.all([
    database.prisma.company.findFirst({ where: { id: companyId } }),
    database.prisma.channelConnection.findFirst({ where: { companyId } }),
    database.prisma.auditEvent.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } }),
  ]);
  return { number: company?.whatsappPhoneNumberId ?? null, connection, events };
}

/** Um cenário: WABA com o número, token do nosso app que a enxerga e o `code` que o troca por ele. */
function givenSignup() {
  const number = digits();
  const waba = digits();
  const token = newToken();
  graph.addWaba(waba, [number]);
  graph.addToken(token, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [waba] });
  const code = newCode();
  graph.addCode(code, token);
  graph.expectedApp = { id: APP_ID, secret: APP_SECRET };
  return { number, waba, token, code };
}

/** Outro `code` válido para o mesmo token. */
function freshCode(token: string): string {
  const code = newCode();
  graph.addCode(code, token);
  return code;
}

interface CoexistenceBody extends ChannelBody {
  mode: string | null;
}

describe('Conexão por coexistência (spec 039, E2; Postgres e Redis reais, Graph falso)', () => {
  it('feliz: prova a posse, NÃO chama o /register, grava mode = COEXISTENCE sem PIN e não vaza nada', async () => {
    await withHarness(async (h) => {
      const company = await tenants.createCompany('coex-ok');
      const owner = await enroll(h, company, 'OWNER');
      const { number, waba, token, code } = givenSignup();

      const response = await signup(h, owner, company.id, {
        code,
        wabaId: waba,
        phoneNumberId: number,
        mode: 'coexistence',
      });

      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<CoexistenceBody>();
      assert.equal(body.state, 'CONNECTED');
      assert.equal(body.mode, 'COEXISTENCE');
      assert.equal(body.phoneNumberId, number);
      assert.deepEqual(
        graph.requests.map((request) => request.operation),
        ['oauth_token', 'debug_token', 'phone_numbers', 'subscribe'],
        'sem /register: o número já está registrado pelo aplicativo (S3)',
      );
      const stored = await dbState(company.id);
      assert.equal(stored.number, number);
      assert.ok(stored.connection !== null);
      assert.equal(stored.connection.mode, 'COEXISTENCE');
      assert.equal(stored.connection.registrationPinCiphertext, null);
      assert.equal(
        h.stack.cipher.decrypt(company.id, stored.connection.tokenCiphertext).reveal(),
        token,
      );
      assert.deepEqual(
        stored.events.map((event) => event.action),
        ['CHANNEL_CONNECTED'],
      );
      assert.deepEqual((await call(h, owner, 'GET', company.id)).json<CoexistenceBody>(), body);
      const metricsBody = await h.metrics.render();
      for (const secret of [code, token, stored.connection.tokenCiphertext, APP_SECRET]) {
        assert.ok(!response.body.includes(secret));
        assert.ok(!h.logs.raw().includes(secret), 'log');
        assert.ok(!metricsBody.includes(secret), 'métricas');
      }
      assert.match(metricsBody, /channel_connections_total{action="coexistence",result="ok"} 1/);
    });
  });

  it('sem phoneNumberId: usa o número único da WABA; zero ou vários = CHANNEL_NUMBER_AMBIGUOUS sem gravar', async () => {
    await withHarness(async (h) => {
      const single = await tenants.createCompany('coex-single');
      const owner = await enroll(h, single, 'OWNER');
      const { number, waba, code } = givenSignup();
      const ok = await signup(h, owner, single.id, { code, wabaId: waba, mode: 'coexistence' });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json<CoexistenceBody>().phoneNumberId, number);

      for (const numbers of [[], [digits(), digits()]]) {
        const company = await tenants.createCompany('coex-ambiguous');
        const who = await enroll(h, company, 'OWNER');
        const otherWaba = digits();
        const otherToken = newToken();
        graph.addWaba(otherWaba, numbers);
        graph.addToken(otherToken, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [otherWaba] });
        const response = await signup(h, who, company.id, {
          code: freshCode(otherToken),
          wabaId: otherWaba,
          mode: 'coexistence',
        });
        assert.equal(response.statusCode, 400, response.body);
        assert.equal(errorCode(response), 'CHANNEL_NUMBER_AMBIGUOUS');
        for (const id of numbers) assert.ok(!response.body.includes(id), 'nenhum id na resposta');
        const stored = await dbState(company.id);
        assert.equal(stored.connection, null);
        assert.equal(stored.number, null);
        assert.equal(stored.events.length, 0);
      }
      assert.match(
        await h.metrics.render(),
        /channel_connections_total{action="coexistence",result="ambiguous"} 2/,
      );
    });
  });

  it('app errado, escopo faltando, número fora da WABA e code inválido: códigos de sempre, nada gravado', async () => {
    await withHarness(async (h) => {
      const company = await tenants.createCompany('coex-refused');
      const owner = await enroll(h, company, 'OWNER');
      const { waba, token } = givenSignup();
      const foreignToken = newToken();
      graph.addToken(foreignToken, { appId: '999', scopes: FULL_SCOPES, wabaIds: [waba] });
      const noScopeToken = newToken();
      graph.addToken(noScopeToken, {
        appId: APP_ID,
        scopes: ['whatsapp_business_messaging'],
        wabaIds: [waba],
      });
      const cases: [object, string][] = [
        [{ code: freshCode(foreignToken), wabaId: waba }, 'CHANNEL_WRONG_APP'],
        [{ code: freshCode(noScopeToken), wabaId: waba }, 'CHANNEL_MISSING_SCOPE'],
        [
          { code: freshCode(token), wabaId: waba, phoneNumberId: digits() },
          'CHANNEL_NUMBER_NOT_IN_WABA',
        ],
        [{ code: newCode(), wabaId: waba }, 'CHANNEL_CODE_INVALID'],
      ];
      for (const [payload, expected] of cases) {
        const response = await signup(h, owner, company.id, { ...payload, mode: 'coexistence' });
        assert.equal(response.statusCode, 400, expected);
        assert.equal(errorCode(response), expected);
        assert.ok(!response.body.includes(token));
      }
      const stored = await dbState(company.id);
      assert.equal(stored.connection, null);
      assert.equal(stored.events.length, 0);
      assert.ok(!h.logs.raw().includes(token), 'o Graph falso ecoa o token nos erros: nada no log');
      assert.equal(graph.ofOperation('register').length, 0);
    });
  });

  it('número de outra empresa: 409 antes de gravar; Meta fora do ar: 502', async () => {
    await withHarness(async (h) => {
      const first = await tenants.createCompany('coex-first');
      const second = await tenants.createCompany('coex-second');
      const ownerA = await enroll(h, first, 'OWNER');
      const ownerB = await enroll(h, second, 'OWNER');
      const { number, waba, token, code } = givenSignup();
      const connected = await signup(h, ownerA, first.id, {
        code,
        wabaId: waba,
        phoneNumberId: number,
        mode: 'coexistence',
      });
      assert.equal(connected.statusCode, 200, connected.body);

      const conflict = await signup(h, ownerB, second.id, {
        code: freshCode(token),
        wabaId: waba,
        mode: 'coexistence',
      });
      assert.equal(conflict.statusCode, 409);
      assert.equal(errorCode(conflict), 'CHANNEL_NUMBER_IN_USE');
      assert.equal((await dbState(second.id)).connection, null);

      graph.failOperation('phone_numbers', graphError(500, 1));
      const down = await signup(h, ownerB, second.id, {
        code: freshCode(token),
        wabaId: waba,
        mode: 'coexistence',
      });
      assert.equal(down.statusCode, 502, down.body);
      assert.equal((await dbState(second.id)).connection, null);
    });
  });

  it('matriz: AGENT e VIEWER 403; :companyId alheio 404; nada gravado', async () => {
    await withHarness(async (h) => {
      const company = await tenants.createCompany('coex-matrix');
      const other = await tenants.createCompany('coex-matrix-b');
      const ownerOther = await enroll(h, other, 'OWNER');
      const { waba, code } = givenSignup();
      for (const role of ['AGENT', 'VIEWER'] as const) {
        const who = await enroll(h, company, role);
        const response = await signup(h, who, company.id, {
          code,
          wabaId: waba,
          mode: 'coexistence',
        });
        assert.equal(response.statusCode, 403, role);
      }
      const foreign = await signup(h, ownerOther, company.id, {
        code,
        wabaId: waba,
        mode: 'coexistence',
      });
      assert.equal(foreign.statusCode, 404);
      assert.equal((await dbState(company.id)).connection, null);
      assert.equal(graph.requests.length, 0, 'nenhuma chamada à Meta');
    });
  });

  it('PUT manual ou Embedded Signup sem mode depois da coexistência voltam o modo a API_ONLY', async () => {
    await withHarness(async (h) => {
      const company = await tenants.createCompany('coex-switch');
      const owner = await enroll(h, company, 'OWNER');
      const { number, waba, token, code } = givenSignup();
      await signup(h, owner, company.id, { code, wabaId: waba, mode: 'coexistence' });
      const put = await call(h, owner, 'PUT', company.id, {
        phoneNumberId: number,
        wabaId: waba,
        accessToken: token,
      });
      assert.equal(put.statusCode, 200, put.body);
      assert.equal(put.json<CoexistenceBody>().mode, 'API_ONLY');
      assert.equal((await dbState(company.id)).connection?.mode, 'API_ONLY');
    });
  });

  it('sem WHATSAPP_COEXISTENCE_ENABLED: mode coexistence é 400 e nada chega à Meta; sem mode segue igual', async () => {
    await withHarness(
      async (h) => {
        const company = await tenants.createCompany('coex-off');
        const owner = await enroll(h, company, 'OWNER');
        const { number, waba, code } = givenSignup();
        const refused = await signup(h, owner, company.id, {
          code,
          wabaId: waba,
          phoneNumberId: number,
          mode: 'coexistence',
        });
        assert.equal(refused.statusCode, 400);
        assert.equal(errorCode(refused), 'CHANNEL_COEXISTENCE_DISABLED');
        assert.equal(graph.requests.length, 0);
        const setup = await h.app.inject({
          method: 'GET',
          url: `/admin/companies/${company.id}/channel/setup`,
          headers: bearer(owner.accessToken),
          remoteAddress: '203.0.113.10',
        });
        assert.deepEqual(setup.json<{ coexistence: unknown }>().coexistence, {
          available: false,
          configId: null,
        });
        // Sem `mode`, o contrato da 015b: `phoneNumberId` obrigatório.
        const missing = await signup(h, owner, company.id, { code, wabaId: waba });
        assert.equal(missing.statusCode, 400);
        const ok = await signup(h, owner, company.id, {
          code,
          wabaId: waba,
          phoneNumberId: number,
        });
        assert.equal(ok.statusCode, 200, ok.body);
        assert.equal(ok.json<CoexistenceBody>().mode, 'API_ONLY');
      },
      { coexistence: false },
    );
  });

  it('GET .../channel/setup com a coexistência: só valores públicos', async () => {
    await withHarness(async (h) => {
      const company = await tenants.createCompany('coex-setup');
      const owner = await enroll(h, company, 'OWNER');
      const response = await h.app.inject({
        method: 'GET',
        url: `/admin/companies/${company.id}/channel/setup`,
        headers: bearer(owner.accessToken),
        remoteAddress: '203.0.113.10',
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json<{ coexistence: unknown }>().coexistence, {
        available: true,
        configId: '5550001',
      });
      assert.ok(!response.body.includes(APP_SECRET));
    });
  });
});
