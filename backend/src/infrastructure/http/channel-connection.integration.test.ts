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
const VERSION = 'v26.0';

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
const emailFor = (label: string): string =>
  `${label}-${randomBytes(5).toString('hex')}@channel-it.test`;
const newToken = (): string => `EAAG-token-${randomUUID()}`;

/** Registra uma WABA com números e um token do nosso app que a enxerga. */
function givenWaba(wabaId: string, numbers: string[], token = newToken()): string {
  graph.addWaba(wabaId, numbers);
  graph.addToken(token, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [wabaId] });
  return token;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly logs: LogCapture;
  readonly metrics: Metrics;
  readonly auth: AuthComponents;
  readonly stack: ReturnType<typeof buildChannelCredentials>;
  close(): Promise<void>;
}

async function createHarness(options: { withChannel?: boolean } = {}): Promise<Harness> {
  const logs = captureLogs();
  const metrics = createMetrics();
  const authRedis = createAuthRedis(
    { REDIS_URL: config.REDIS_URL, AUTH_REDIS_TIMEOUT_MS: 300 },
    logs.logger,
  );
  assert.ok(await authRedis.waitUntilReady(5_000));
  const hasher = new ScryptPasswordHasher({ cost: { N: 1024, r: 8, p: 1 } });
  const auth = createAuthComponents({
    config: {
      ...config,
      AUTH_REDIS_PREFIX: keyspace.scopedPrefix(`chan-${randomUUID()}`),
    },
    logger: logs.logger,
    prisma: database.prisma,
    authRedis,
    metrics,
    hasher,
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
      graphApiVersion: VERSION,
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

const as = (
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
  tokenExpiresAt: string | null;
  connectedAt: string | null;
  tokenInvalidAt: string | null;
}
interface ErrorBody {
  error: { code: string; message: string };
}

const errorCode = (response: LightMyRequestResponse): string =>
  response.json<ErrorBody>().error.code;

async function dbState(companyId: string) {
  const [company, connection, events] = await Promise.all([
    database.prisma.company.findFirst({ where: { id: companyId } }),
    database.prisma.channelConnection.findFirst({ where: { companyId } }),
    database.prisma.auditEvent.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } }),
  ]);
  return { number: company?.whatsappPhoneNumberId ?? null, connection, events };
}

describe('canal da empresa: PUT/GET/DELETE (spec 015, Postgres e Redis reais, Graph falso)', () => {
  it('PUT feliz: conecta, cifra o token, assina o app, audita na mesma transação e não vaza o token', async () => {
    await withHarness(async (h) => {
      const company = await tenants.createCompany('chan-ok');
      const owner = await enroll(h, company, 'OWNER');
      const number = digits();
      const waba = digits();
      const token = givenWaba(waba, [number, digits()]);

      const put = await as(h, owner, 'PUT', company.id, {
        phoneNumberId: number,
        wabaId: waba,
        accessToken: token,
      });

      assert.equal(put.statusCode, 200, put.body);
      const body = put.json<ChannelBody>();
      assert.equal(body.state, 'CONNECTED');
      assert.equal(body.phoneNumberId, number);
      assert.equal(body.wabaId, waba);
      assert.equal(body.tokenExpiresAt, null);
      assert.deepEqual(
        (await as(h, owner, 'GET', company.id)).json<ChannelBody>(),
        body,
        'o GET devolve o mesmo corpo',
      );

      const stored = await dbState(company.id);
      assert.equal(stored.number, number);
      assert.ok(stored.connection !== null);
      assert.notEqual(stored.connection.tokenCiphertext, token);
      assert.ok(!stored.connection.tokenCiphertext.includes(token));
      assert.equal(
        h.stack.cipher.decrypt(company.id, stored.connection.tokenCiphertext).reveal(),
        token,
      );
      assert.equal(stored.connection.tokenVersion, 1);
      assert.equal(stored.events.length, 1);
      assert.equal(stored.events[0]?.action, 'CHANNEL_CONNECTED');
      assert.equal(stored.events[0].actorMembershipId, owner.id);
      assert.equal(stored.events[0].targetMembershipId, null);
      assert.ok(graph.subscribed.has(waba));

      // O debug_token vai com o token de app em cabeçalho; as demais, com o token da empresa.
      const [inspect] = graph.ofOperation('debug_token');
      assert.equal(inspect?.headers.authorization, `Bearer ${APP_ID}|${APP_SECRET}`);
      for (const operation of ['phone_numbers', 'subscribe'] as const) {
        const [call] = graph.ofOperation(operation);
        assert.equal(call?.headers.authorization, `Bearer ${token}`, operation);
        assert.ok(!call.path.includes(token), 'token só em cabeçalho');
      }
      assert.ok(!inspect.path.includes(APP_SECRET), 'segredo do app nunca na URL');

      // Nada vaza: resposta, log, métricas.
      const metricsBody = await h.metrics.render();
      for (const secret of [token, stored.connection.tokenCiphertext, APP_SECRET]) {
        assert.ok(!put.body.includes(secret));
        assert.ok(!h.logs.raw().includes(secret));
        assert.ok(!metricsBody.includes(secret));
      }
      assert.match(metricsBody, /channel_connections_total{action="connect",result="ok"} 1/);
      const audit = h.logs.lines().find((line) => line.event === 'audit');
      assert.equal(audit?.action, 'CHANNEL_CONNECTED');
      assert.ok(!JSON.stringify(audit).includes(number));
    });
  });

  it('PUT recusado: nada é gravado (nem número, nem conexão, nem auditoria) e a Meta nunca vaza', async () => {
    await withHarness(async (h) => {
      const company = await tenants.createCompany('chan-refused');
      const owner = await enroll(h, company, 'OWNER');
      const number = digits();
      const waba = digits();
      const good = givenWaba(waba, [number]);
      const otherApp = newToken();
      graph.addToken(otherApp, { appId: '999', scopes: FULL_SCOPES, wabaIds: [waba] });
      const noScope = newToken();
      graph.addToken(noScope, {
        appId: APP_ID,
        scopes: ['whatsapp_business_messaging'],
        wabaIds: [waba],
      });
      const foreignWaba = newToken();
      const otherWaba = digits();
      graph.addWaba(otherWaba, [number]);
      graph.addToken(foreignWaba, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [otherWaba] });
      const noGranular = newToken();
      graph.addToken(noGranular, {
        appId: APP_ID,
        scopes: FULL_SCOPES,
        wabaIds: [digits()],
        granular: false,
      });

      const attempt = async (accessToken: string, phone = number, wabaId = waba) =>
        as(h, owner, 'PUT', company.id, { phoneNumberId: phone, wabaId, accessToken });
      const cases: [string, LightMyRequestResponse, number, string][] = [
        ['desconhecido', await attempt(newToken()), 400, 'CHANNEL_TOKEN_REJECTED'],
        ['outro app', await attempt(otherApp), 400, 'CHANNEL_WRONG_APP'],
        ['sem escopo', await attempt(noScope), 400, 'CHANNEL_MISSING_SCOPE'],
        [
          'WABA que o token não enxerga',
          await attempt(foreignWaba),
          400,
          'CHANNEL_NUMBER_NOT_IN_WABA',
        ],
        ['número fora da WABA', await attempt(good, digits()), 400, 'CHANNEL_NUMBER_NOT_IN_WABA'],
        [
          'sem granular, WABA inacessível',
          await attempt(noGranular),
          400,
          'CHANNEL_NUMBER_NOT_IN_WABA',
        ],
      ];
      for (const [label, response, status, code] of cases) {
        assert.equal(response.statusCode, status, `${label}: ${response.body}`);
        assert.equal(errorCode(response), code, label);
        assert.ok(!response.body.includes('eco:'), `${label}: corpo da Meta vazou`);
      }

      // Meta fora do ar, limite de taxa, demora e assinatura que falha: 502, sem gravar.
      graph.failOperation('debug_token', { kind: 'respond', status: 503 });
      const down = await attempt(good);
      graph.failOperation('phone_numbers', graphError(429, 4));
      const limited = await attempt(good);
      graph.failOperation('subscribe', graphError(500, 1));
      const noSubscribe = await attempt(good);
      graph.failOperation('debug_token', { kind: 'hang' });
      const slow = await attempt(good);
      for (const response of [down, limited, noSubscribe, slow]) {
        assert.equal(response.statusCode, 502, response.body);
        assert.equal(errorCode(response), 'EXTERNAL_SERVICE_ERROR');
        assert.ok(!response.body.includes('eco:'));
      }

      // Corpo inválido: 400 sem ecoar o valor.
      const secretValue = 'valor-secreto-do-corpo-12345';
      for (const payload of [
        { phoneNumberId: number, wabaId: waba, accessToken: good, extra: secretValue },
        { phoneNumberId: number, wabaId: waba },
        { phoneNumberId: 'abc', wabaId: waba, accessToken: good },
        { phoneNumberId: number, wabaId: waba, accessToken: `${secretValue} com espaco` },
        { phoneNumberId: number, wabaId: waba, accessToken: 'curto' },
      ]) {
        const response = await as(h, owner, 'PUT', company.id, payload);
        assert.equal(response.statusCode, 400, response.body);
        assert.ok(!response.body.includes(secretValue));
      }

      const stored = await dbState(company.id);
      assert.equal(stored.number, null);
      assert.equal(stored.connection, null);
      assert.deepEqual(stored.events, []);
      assert.ok(!h.logs.raw().includes('eco:'));
      assert.ok(!graph.subscribed.has(otherWaba));
      const metricsBody = await h.metrics.render();
      assert.match(metricsBody, /channel_connections_total{action="connect",result="wrong_app"} 1/);
      assert.match(metricsBody, /result="graph_error"/);
    });
  });

  it('posse do número: B com token de outra WABA não conecta o número de A; B com WABA compartilhada recebe 409 sem revelar A', async () => {
    await withHarness(async (h) => {
      const a = await tenants.createCompany('chan-a');
      const b = await tenants.createCompany('chan-b');
      const ownerA = await enroll(h, a, 'OWNER');
      const ownerB = await enroll(h, b, 'OWNER');
      const number = digits();
      const wabaA = digits();
      const tokenA = givenWaba(wabaA, [number]);
      const wabaB = digits();
      const tokenB = givenWaba(wabaB, [digits()]);
      assert.equal(
        (
          await as(h, ownerA, 'PUT', a.id, {
            phoneNumberId: number,
            wabaId: wabaA,
            accessToken: tokenA,
          })
        ).statusCode,
        200,
      );

      const stolen = await as(h, ownerB, 'PUT', b.id, {
        phoneNumberId: number,
        wabaId: wabaB,
        accessToken: tokenB,
      });
      assert.equal(stolen.statusCode, 400);
      assert.equal(errorCode(stolen), 'CHANNEL_NUMBER_NOT_IN_WABA');

      // Agência: a mesma WABA lista o número (token de B enxerga a WABA de A).
      const sharedToken = newToken();
      graph.addToken(sharedToken, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [wabaA] });
      const conflict = await as(h, ownerB, 'PUT', b.id, {
        phoneNumberId: number,
        wabaId: wabaA,
        accessToken: sharedToken,
      });
      assert.equal(conflict.statusCode, 409, conflict.body);
      assert.equal(errorCode(conflict), 'CHANNEL_NUMBER_IN_USE');
      assert.ok(!conflict.body.includes(a.id) && !conflict.body.includes(a.slug));

      const stateB = await dbState(b.id);
      assert.equal(stateB.number, null);
      assert.equal(stateB.connection, null, 'a transação inteira foi desfeita');
      assert.deepEqual(stateB.events, []);
      const stateA = await dbState(a.id);
      assert.equal(stateA.number, number);
      assert.equal(stateA.events.length, 1);
      assert.match(await h.metrics.render(), /result="number_in_use"/);
      // O GET de A não mostra nada de B e vice-versa.
      assert.equal((await as(h, ownerB, 'GET', b.id)).json<ChannelBody>().state, 'NOT_CONNECTED');
    });
  });

  it('corrida: duas empresas conectam o mesmo número ao mesmo tempo; exatamente um vence', async () => {
    await withHarness(async (h) => {
      for (let round = 0; round < 8; round += 1) {
        const a = await tenants.createCompany('chan-race-a');
        const b = await tenants.createCompany('chan-race-b');
        const ownerA = await enroll(h, a, 'OWNER');
        const ownerB = await enroll(h, b, 'OWNER');
        const number = digits();
        const waba = digits();
        const tokenA = givenWaba(waba, [number]);
        const tokenB = newToken();
        graph.addToken(tokenB, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [waba] });

        const [ra, rb] = await Promise.all([
          as(h, ownerA, 'PUT', a.id, { phoneNumberId: number, wabaId: waba, accessToken: tokenA }),
          as(h, ownerB, 'PUT', b.id, { phoneNumberId: number, wabaId: waba, accessToken: tokenB }),
        ]);

        assert.deepEqual(
          [ra.statusCode, rb.statusCode].sort(),
          [200, 409],
          `rodada ${String(round)}`,
        );
        const [sa, sb] = [await dbState(a.id), await dbState(b.id)];
        const winners = [sa, sb].filter((state) => state.number === number);
        assert.equal(winners.length, 1);
        assert.equal([sa, sb].filter((state) => state.connection !== null).length, 1);
        assert.equal(winners[0]?.events.length, 1);
        assert.equal([sa, sb].filter((state) => state.events.length === 0).length, 1);
      }
    });
  });

  it('trocar o token sobe a versão, volta a CONNECTED e audita; trocar de número libera o antigo', async () => {
    await withHarness(async (h) => {
      const a = await tenants.createCompany('chan-swap-a');
      const b = await tenants.createCompany('chan-swap-b');
      const ownerA = await enroll(h, a, 'ADMIN');
      const ownerB = await enroll(h, b, 'OWNER');
      const n1 = digits();
      const n2 = digits();
      const waba = digits();
      const token1 = givenWaba(waba, [n1, n2]);
      const token2 = newToken();
      graph.addToken(token2, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [waba] });

      await as(h, ownerA, 'PUT', a.id, { phoneNumberId: n1, wabaId: waba, accessToken: token1 });
      const first = (await dbState(a.id)).connection;
      assert.ok(first !== null);
      await h.stack.connections.markTokenInvalid(a.id, first.tokenVersion, new Date());
      assert.equal((await as(h, ownerA, 'GET', a.id)).json<ChannelBody>().state, 'TOKEN_INVALID');
      assert.notEqual((await as(h, ownerA, 'GET', a.id)).json<ChannelBody>().tokenInvalidAt, null);

      const put = await as(h, ownerA, 'PUT', a.id, {
        phoneNumberId: n2,
        wabaId: waba,
        accessToken: token2,
      });
      assert.equal(put.statusCode, 200, put.body);
      assert.equal(put.json<ChannelBody>().state, 'CONNECTED');
      assert.equal(put.json<ChannelBody>().tokenInvalidAt, null);
      const second = await dbState(a.id);
      assert.equal(second.connection?.tokenVersion, 2);
      assert.notEqual(second.connection.tokenCiphertext, first.tokenCiphertext);
      assert.deepEqual(
        second.events.map((event) => event.action),
        ['CHANNEL_CONNECTED', 'CHANNEL_TOKEN_REPLACED'],
      );
      assert.equal(second.number, n2);

      // O número antigo foi liberado: outra empresa consegue conectá-lo.
      const tokenB = newToken();
      graph.addToken(tokenB, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [waba] });
      const taken = await as(h, ownerB, 'PUT', b.id, {
        phoneNumberId: n1,
        wabaId: waba,
        accessToken: tokenB,
      });
      assert.equal(taken.statusCode, 200, taken.body);
    });
  });

  it('DELETE: apaga a conexão, limpa o número, audita, desassina depois do commit e é idempotente', async () => {
    await withHarness(async (h) => {
      const company = await tenants.createCompany('chan-del');
      const owner = await enroll(h, company, 'OWNER');
      const number = digits();
      const waba = digits();
      const token = givenWaba(waba, [number]);
      await as(h, owner, 'PUT', company.id, {
        phoneNumberId: number,
        wabaId: waba,
        accessToken: token,
      });
      const companies = new PrismaCompanyRepository(database.prisma);
      assert.ok((await companies.findByWhatsappPhoneNumberId(number)) !== null);

      const del = await as(h, owner, 'DELETE', company.id);
      assert.equal(del.statusCode, 204);
      const stored = await dbState(company.id);
      assert.equal(stored.connection, null, 'nenhum texto cifrado resta');
      assert.equal(stored.number, null);
      assert.deepEqual(
        stored.events.map((event) => event.action),
        ['CHANNEL_CONNECTED', 'CHANNEL_DISCONNECTED'],
      );
      assert.equal(await companies.findByWhatsappPhoneNumberId(number), null);
      const [unsubscribe] = graph.ofOperation('unsubscribe');
      assert.equal(unsubscribe?.headers.authorization, `Bearer ${token}`);
      assert.ok(!graph.subscribed.has(waba));
      assert.equal(
        (await as(h, owner, 'GET', company.id)).json<ChannelBody>().state,
        'NOT_CONNECTED',
      );

      const again = await as(h, owner, 'DELETE', company.id);
      assert.equal(again.statusCode, 204);
      assert.equal((await dbState(company.id)).events.length, 2, 'sem novo evento');
      assert.equal(graph.ofOperation('unsubscribe').length, 1);
      assert.ok(!h.logs.raw().includes(token));
    });
  });

  it('DELETE com falha no unsubscribe: segue 204, nada é desfeito e só há log warn e métrica', async () => {
    await withHarness(async (h) => {
      const company = await tenants.createCompany('chan-del-fail');
      const owner = await enroll(h, company, 'OWNER');
      const number = digits();
      const waba = digits();
      const token = givenWaba(waba, [number]);
      await as(h, owner, 'PUT', company.id, {
        phoneNumberId: number,
        wabaId: waba,
        accessToken: token,
      });
      graph.failOperation('unsubscribe', graphError(500, 1));

      const del = await as(h, owner, 'DELETE', company.id);

      assert.equal(del.statusCode, 204);
      const stored = await dbState(company.id);
      assert.equal(stored.connection, null);
      assert.equal(stored.number, null);
      assert.match(await h.metrics.render(), /action="disconnect",result="unsubscribe_failed"} 1/);
      assert.ok(!h.logs.raw().includes(token));
      assert.ok(!h.logs.raw().includes('eco:'));
    });
  });

  it('empresa LEGACY (número sem conexão): GET mostra LEGACY e o DELETE só limpa o número', async () => {
    await withHarness(async (h) => {
      const number = digits();
      const company = await tenants.createCompany('chan-legacy', number);
      const owner = await enroll(h, company, 'OWNER');
      const state = (await as(h, owner, 'GET', company.id)).json<ChannelBody>();
      assert.equal(state.state, 'LEGACY');
      assert.equal(state.phoneNumberId, number);
      assert.equal(state.wabaId, null);
      assert.equal((await as(h, owner, 'DELETE', company.id)).statusCode, 204);
      assert.equal((await dbState(company.id)).number, null);
      assert.equal(graph.ofOperation('unsubscribe').length, 0);
    });
  });

  it('remover a empresa apaga a conexão na mesma transação (nenhum texto cifrado permanece)', async () => {
    await withHarness(async (h) => {
      const company = await tenants.createCompany('chan-removed');
      const owner = await enroll(h, company, 'OWNER');
      const number = digits();
      const waba = digits();
      await as(h, owner, 'PUT', company.id, {
        phoneNumberId: number,
        wabaId: waba,
        accessToken: givenWaba(waba, [number]),
      });
      assert.ok((await dbState(company.id)).connection !== null);

      await new PrismaCompanyRepository(database.prisma).delete(company.id);

      const stored = await dbState(company.id);
      assert.equal(stored.connection, null);
      assert.equal(stored.number, null);
    });
  });

  it('permissões: AGENT e VIEWER 403, PlatformAdmin 403, :companyId alheio 404 antes da permissão, sem token 401', async () => {
    await withHarness(async (h) => {
      const a = await tenants.createCompany('chan-perm-a');
      const b = await tenants.createCompany('chan-perm-b');
      const roles: Record<string, Person> = {};
      for (const role of ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'] as const) {
        roles[role] = await enroll(h, a, role);
      }
      const body = { phoneNumberId: digits(), wabaId: digits(), accessToken: 'x'.repeat(30) };
      for (const role of ['AGENT', 'VIEWER']) {
        const who = roles[role] as Person;
        assert.equal((await as(h, who, 'GET', a.id)).statusCode, 403, role);
        assert.equal((await as(h, who, 'PUT', a.id, body)).statusCode, 403, role);
        assert.equal((await as(h, who, 'DELETE', a.id)).statusCode, 403, role);
        // O 404 da empresa alheia vem antes da permissão.
        assert.equal((await as(h, who, 'GET', b.id)).statusCode, 404, role);
      }
      const owner = roles.OWNER as Person;
      const admin = roles.ADMIN as Person;
      assert.equal((await as(h, admin, 'GET', a.id)).statusCode, 200);
      assert.equal((await as(h, owner, 'GET', b.id)).statusCode, 404);
      assert.equal((await as(h, owner, 'PUT', b.id, body)).statusCode, 404);
      assert.equal((await as(h, owner, 'DELETE', b.id)).statusCode, 404);
      const ghost = await as(h, owner, 'GET', randomUUID());
      const alien = await as(h, owner, 'GET', b.id);
      assert.equal(
        ghost.body.replace(/"requestId":"[^"]*"/, ''),
        alien.body.replace(/"requestId":"[^"]*"/, ''),
      );
      const anonymous = await h.app.inject({
        method: 'GET',
        url: `/admin/companies/${a.id}/channel`,
      });
      assert.equal(anonymous.statusCode, 401);
    });
  });

  it('PlatformAdmin recebe 403 nas rotas do canal', async () => {
    await withHarness(async (h) => {
      const company = await tenants.createCompany('chan-platform');
      const email = emailFor('platform');
      await h.auth.platformAdmins.create({
        email,
        passwordHash: await h.auth.hasher.hash(PASSWORD),
      });
      const login = await h.app.inject({
        method: 'POST',
        url: '/auth/platform/login',
        payload: { email, password: PASSWORD },
        remoteAddress: '203.0.113.10',
      });
      assert.equal(login.statusCode, 200, login.body);
      const token = login.json<{ accessToken: string }>().accessToken;
      for (const method of ['GET', 'PUT', 'DELETE'] as const) {
        const response = await h.app.inject({
          method,
          url: `/admin/companies/${company.id}/channel`,
          headers: bearer(token),
          remoteAddress: '203.0.113.10',
          ...(method === 'PUT'
            ? { payload: { phoneNumberId: '1', wabaId: '1', accessToken: 'x'.repeat(30) } }
            : {}),
        });
        assert.equal(response.statusCode, 403, method);
      }
    });
  });

  it('auditoria: GET audit-events lista só os eventos da própria empresa, com targetMembershipId nulo nos de canal', async () => {
    await withHarness(async (h) => {
      const a = await tenants.createCompany('chan-audit-a');
      const b = await tenants.createCompany('chan-audit-b');
      const ownerA = await enroll(h, a, 'OWNER');
      const ownerB = await enroll(h, b, 'OWNER');
      const [numberA, wabaA, numberB, wabaB] = [digits(), digits(), digits(), digits()];
      await as(h, ownerA, 'PUT', a.id, {
        phoneNumberId: numberA,
        wabaId: wabaA,
        accessToken: givenWaba(wabaA, [numberA]),
      });
      await as(h, ownerB, 'PUT', b.id, {
        phoneNumberId: numberB,
        wabaId: wabaB,
        accessToken: givenWaba(wabaB, [numberB]),
      });

      const list = await h.app.inject({
        method: 'GET',
        url: `/admin/companies/${a.id}/audit-events`,
        headers: bearer(ownerA.accessToken),
        remoteAddress: '203.0.113.10',
      });
      assert.equal(list.statusCode, 200, list.body);
      const { items } = list.json<{
        items: { action: string; actorMembershipId: string; targetMembershipId: string | null }[];
      }>();
      assert.ok(
        items.some(
          (item) => item.action === 'CHANNEL_CONNECTED' && item.targetMembershipId === null,
        ),
      );
      assert.ok(items.every((item) => item.actorMembershipId !== ownerB.id));
      assert.ok(!list.body.includes(numberA) && !list.body.includes(wabaA));
    });
  });

  it('sem canal habilitado (sem o serviço) as rotas não existem: 404', async () => {
    await withHarness(
      async (h) => {
        const company = await tenants.createCompany('chan-off');
        const owner = await enroll(h, company, 'OWNER');
        assert.equal((await as(h, owner, 'GET', company.id)).statusCode, 404);
        assert.equal((await as(h, owner, 'PUT', company.id, {})).statusCode, 404);
        assert.equal((await as(h, owner, 'DELETE', company.id)).statusCode, 404);
      },
      { withChannel: false },
    );
  });
});
