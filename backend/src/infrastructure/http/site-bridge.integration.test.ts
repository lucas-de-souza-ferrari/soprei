import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { AccountService } from '../../application/auth/account.service.js';
import { AttendanceService } from '../../application/attendance/attendance.service.js';
import { ChannelConnectionService } from '../../application/channel/channel-connection.service.js';
import { CompanyService } from '../../application/companies/company.service.js';
import type { AccountSessionStore } from '../../application/ports/account-session.js';
import {
  hasPermission,
  MEMBERSHIP_ROLES,
  type MembershipRole,
  type Permission,
  ROLE_PERMISSIONS,
} from '../../domain/index.js';
import { REQUIRED_PERMISSION } from '../../presentation/common/auth.hooks.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { buildChannelCredentials } from '../../test-support/channel-credentials.js';
import { FakeGraphApi, FULL_SCOPES } from '../../test-support/fake-graph-api.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { noResetMail } from '../../test-support/no-reset-mail.js';
import { TestKeyspace } from '../../test-support/test-keyspace.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createAuthRedis } from '../auth/auth-redis.js';
import { versionedAuthPrefix } from '../auth/auth-version.js';
import { createAuthComponents } from '../auth/create-auth.js';
import { RedisAccountSessionStore } from '../auth/redis-account-session-store.js';
import { ScryptPasswordHasher } from '../auth/scrypt-password-hasher.js';
import {
  createDatabase,
  PrismaAccountRepository,
  PrismaAttendanceUnitOfWork,
  PrismaChannelUnitOfWork,
  PrismaCompanyRepository,
  PrismaConversationRepository,
  PrismaMessageRepository,
} from '../database/index.js';
import { MockLlmProvider } from '../external-apis/llm/mock-llm.provider.js';
import { WhatsappGraphAdminClient } from '../external-apis/whatsapp/whatsapp-graph-admin.client.js';
import { createMetrics } from '../metrics/index.js';
import { buildServer } from './server.js';

// Spec 023: a ponte cookie da conta -> rotas de tenant (que já existia) vale para canal, persona e
// simulador. Postgres e Redis reais (soprei_test, Redis /15), Graph falso.
const config = loadIntegrationConfig();
const ORIGIN = 'http://localhost:5174';
const APP_ID = '1234567890123';
const APP_SECRET = `app-secret-${randomUUID()}`;
const CONFIG_ID = '98765432100123';
const SECRET_PERSONA = `Persona secreta ${randomUUID()}`;
const SECRET_MESSAGE = `mensagem secreta ${randomUUID()}`;
const csrf = { origin: ORIGIN, 'x-soprei-app': 'web' };

const logs = captureLogs();
const graph = new FakeGraphApi();
const db = createDatabase(config, logs.logger);
const tenants = new TestTenants(db.prisma);
const keys = new TestKeyspace();
const prefix = keys.scopedPrefix('site-bridge');
const redis = createAuthRedis(config, logs.logger);
const passwords = new ScryptPasswordHasher({ cost: { N: 1024, r: 8, p: 1 } });
const mail = new Map<string, string>();
const emails: string[] = [];
const password = `Secret1-${randomUUID()}`;
let sessionsDown = false;
let app: FastifyInstance;
let service: AccountService;
let llm: MockLlmProvider;
const routes: { url: string; method: string; permission: Permission | undefined }[] = [];

interface Person {
  readonly email: string;
  readonly cookie: string;
  readonly accountId: string;
}

const secretOf = (person: Person): string => person.cookie.slice('soprei_session='.length);

before(async () => {
  assert.ok(await redis.waitUntilReady(5_000));
  await graph.start();
  const auth = createAuthComponents({
    config: { ...config, ACCOUNTS_ENABLED: true, AUTH_REDIS_PREFIX: prefix },
    logger: logs.logger,
    prisma: db.prisma,
    authRedis: redis,
    hasher: passwords,
  });
  const store = new RedisAccountSessionStore(redis.client, versionedAuthPrefix(prefix, true));
  const sessions: AccountSessionStore = {
    create: (id) => store.create(id),
    select: (secret, companyId) => store.select(secret, companyId),
    revoke: (secret) => store.revoke(secret),
    revokeAll: (id) => store.revokeAll(id),
    read: (secret) =>
      sessionsDown
        ? Promise.reject(new ServiceUnavailableError('Sessão indisponível'))
        : store.read(secret),
  };
  const accounts = new PrismaAccountRepository(db.prisma);
  service = new AccountService({
    accounts,
    passwords,
    sessions,
    loginLocks: auth.sessions,
    loginSecret: config.JWT_SECRET,
    mailer: {
      ...noResetMail,
      sendVerification: (email, code) => {
        mail.set(email, code);
        return Promise.resolve();
      },
    },
  });
  const companyRepository = new PrismaCompanyRepository(db.prisma);
  const stack = buildChannelCredentials(db.prisma);
  const metrics = createMetrics();
  llm = new MockLlmProvider({ recordCalls: true });
  app = buildServer({
    logger: logs.logger,
    metrics,
    readiness: { database: () => db.check(), redis: () => Promise.resolve(Result.ok(undefined)) },
    auth: auth.service,
    membershipAdmin: auth.membershipAdmin,
    admin: {
      companies: new CompanyService(companyRepository),
      attendance: new AttendanceService({
        companies: companyRepository,
        conversations: new PrismaConversationRepository(db.prisma),
        messages: new PrismaMessageRepository(db.prisma),
        unitOfWork: new PrismaAttendanceUnitOfWork(db.prisma),
        llm,
        logger: logs.logger,
        metrics,
        options: { llmTimeoutMs: 2_000, inFlightTimeoutMs: 60_000 },
      }),
      channel: new ChannelConnectionService({
        companies: companyRepository,
        connections: stack.connections,
        unitOfWork: new PrismaChannelUnitOfWork(db.prisma),
        cipher: stack.cipher,
        provisioner: new WhatsappGraphAdminClient({
          baseUrl: graph.baseUrl,
          graphApiVersion: 'v26.0',
          appId: APP_ID,
          appSecret: APP_SECRET,
          timeoutMs: 1_000,
        }),
        appId: APP_ID,
        logger: logs.logger,
        metrics,
      }),
      channelSetup: {
        appId: APP_ID,
        embeddedSignupConfigId: CONFIG_ID,
        graphApiVersion: 'v26.0',
        manualConnect: false,
      },
    },
    accounts: { service, origin: ORIGIN, secure: false },
  });
  // As rotas são coletadas do que está de fato registrado: rota de tenant nova entra na varredura
  // sozinha, sem lista manual que envelheça.
  app.addHook('onRoute', (route) => {
    const hooks: unknown = route.onRequest;
    const list: unknown[] = Array.isArray(hooks) ? hooks : hooks === undefined ? [] : [hooks];
    const permission = list
      .map((hook) => (hook as Record<symbol, unknown> | undefined)?.[REQUIRED_PERMISSION])
      .find((value) => value !== undefined) as Permission | undefined;
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') routes.push({ url: route.url, method, permission });
    }
  });
  await app.ready();
});

after(async () => {
  try {
    await app.close();
    await tenants.cleanup();
    await db.prisma.account.deleteMany({ where: { email: { in: emails } } });
    await keys.cleanup(redis.client);
  } finally {
    await redis.close();
    await db.close();
    await graph.stop();
  }
});

beforeEach(() => {
  graph.reset();
  graph.expectedApp = { id: APP_ID, secret: APP_SECRET };
});

const post = (url: string, payload: object, cookie?: string) =>
  app.inject({
    method: 'POST',
    url,
    payload,
    headers: { ...csrf, ...(cookie === undefined ? {} : { cookie }) },
  });

async function signUp(label: string): Promise<Person> {
  const email = `${label}-${randomUUID()}@site-bridge.test`;
  emails.push(email);
  assert.equal((await post('/auth/register', { email, password })).statusCode, 202);
  await service.drain();
  const code = mail.get(email);
  assert.match(code ?? '', /^[0-9]{6}$/);
  assert.equal((await post('/auth/verify-email', { email, password, code })).statusCode, 204);
  const login = await post('/auth/login', { email, password });
  assert.equal(login.statusCode, 204);
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  const account = await new PrismaAccountRepository(db.prisma).findByEmail(email);
  assert.ok(account);
  return { email, cookie, accountId: account.id };
}

async function createCompany(person: Person, name: string): Promise<string> {
  const response = await post('/account/companies', { name }, person.cookie);
  assert.equal(response.statusCode, 201);
  const { companyId } = response.json<{ companyId: string }>();
  tenants.track(companyId);
  return companyId;
}

async function select(person: Person, companyId: string): Promise<void> {
  assert.equal(
    (await post(`/account/companies/${companyId}/select`, {}, person.cookie)).statusCode,
    204,
  );
}

const setRole = (companyId: string, person: Person, role: MembershipRole) =>
  db.prisma.membership.updateMany({
    where: { companyId, accountId: person.accountId },
    data: { role },
  });

const get = (url: string, person: Person | undefined, extra: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url,
    headers: { ...(person === undefined ? {} : { cookie: person.cookie }), ...extra },
  });

const send = (
  method: 'PUT' | 'POST' | 'DELETE' | 'PATCH',
  url: string,
  person: Person,
  payload?: object,
  headers: Record<string, string> = csrf,
) =>
  app.inject({
    method,
    url,
    headers: { cookie: person.cookie, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });

/** Corpo de erro sem o `requestId` (muda a cada resposta). */
function errorOf(response: LightMyRequestResponse): { code: string; message: string } {
  const { error } = response.json<{ error: { code: string; message: string } }>();
  return { code: error.code, message: error.message };
}

const digits = (): string => `9${randomBytes(6).readUIntBE(0, 6).toString().padStart(15, '0')}`;

/** Rotas globais que o servidor recusa com cookie (gestão de senha e criação de conta): ficam fora da varredura. */
const GLOBAL_ONLY = (route: { url: string; method: string }): boolean =>
  (route.url.endsWith('/memberships') && route.method === 'POST') ||
  route.url.endsWith('/memberships/:membershipId/password');

describe('ponte cookie -> rotas de tenant do site (spec 023)', () => {
  let alice: Person;
  let aliceCompany: string;
  let aliceOtherCompany: string;
  let carol: Person;
  let carolCompany: string;

  before(async () => {
    alice = await signUp('alice');
    aliceCompany = await createCompany(alice, 'Empresa A do site');
    aliceOtherCompany = await createCompany(alice, 'Empresa B do site');
    await select(alice, aliceCompany);
    carol = await signUp('carol');
    carolCompany = await createCompany(carol, 'Empresa C do site');
    await select(carol, carolCompany);
  });

  it('GET /account/companies traz permissions coerentes com ROLE_PERMISSIONS, por vínculo', async () => {
    await setRole(aliceOtherCompany, alice, 'VIEWER');
    const response = await get('/account/companies', alice);
    assert.equal(response.statusCode, 200);
    const items = response.json<{
      items: { companyId: string; role: MembershipRole; permissions: Permission[] }[];
    }>().items;
    const byId = new Map(items.map((item) => [item.companyId, item]));
    assert.deepEqual(byId.get(aliceCompany)?.permissions, [...ROLE_PERMISSIONS.OWNER]);
    assert.deepEqual(byId.get(aliceOtherCompany)?.permissions, [...ROLE_PERMISSIONS.VIEWER]);
    assert.notDeepEqual(
      byId.get(aliceCompany)?.permissions,
      byId.get(aliceOtherCompany)?.permissions,
    );
    assert.ok(byId.get(aliceCompany)?.permissions.includes('persona:manage'));
    await setRole(aliceOtherCompany, alice, 'OWNER');
  });

  it('varre toda rota de tenant do inventário com cookie: papel lido do banco agora; 404 antes de 403', async () => {
    const tenantRoutes = routes.filter(
      (route) => route.url.startsWith('/admin/companies/:companyId') && !GLOBAL_ONLY(route),
    );
    // Rotas novas desta spec fazem parte do inventário.
    for (const url of [
      '/admin/companies/:companyId/channel',
      '/admin/companies/:companyId/channel/setup',
      '/admin/companies/:companyId/channel/embedded-signup',
      '/admin/companies/:companyId/persona',
      '/admin/companies/:companyId/messages',
    ]) {
      assert.ok(
        tenantRoutes.some((route) => route.url === url),
        url,
      );
    }
    const resolve = (url: string, companyId: string): string =>
      url
        .replace(':companyId', companyId)
        .replace(':membershipId', randomUUID())
        .replace(':conversationId', randomUUID());
    const request = (route: (typeof tenantRoutes)[number], companyId: string) =>
      route.method === 'GET'
        ? get(resolve(route.url, companyId), alice)
        : send(route.method as 'PUT', resolve(route.url, companyId), alice, {});
    for (const role of MEMBERSHIP_ROLES) {
      await setRole(aliceCompany, alice, role);
      for (const route of tenantRoutes) {
        assert.ok(route.permission, `${route.method} ${route.url} sem permissão`);
        const label = `${role} ${route.method} ${route.url}`;
        const own = await request(route, aliceCompany);
        if (hasPermission(role, route.permission)) {
          assert.ok(![401, 403].includes(own.statusCode), `${label}: ${String(own.statusCode)}`);
        } else {
          assert.equal(own.statusCode, 403, label);
        }
        // Empresa alheia à seleção (Alice é VIEWER/OWNER em B, mas a seleção é A): 404 antes da permissão.
        const alien = await request(route, aliceOtherCompany);
        assert.equal(alien.statusCode, 404, `${label} (alheia)`);
        const ghost = await request(route, randomUUID());
        assert.deepEqual(errorOf(alien), errorOf(ghost), `${label} (alheia = inexistente)`);
      }
    }
    await setRole(aliceCompany, alice, 'OWNER');
  });

  it('rotas de plataforma com cookie de vínculo: 403', async () => {
    assert.equal((await get('/admin/companies', alice)).statusCode, 403);
    assert.equal(
      (await send('PATCH', `/admin/companies/${aliceCompany}`, alice, { persona: 'x' })).statusCode,
      403,
    );
  });

  it('OWNER grava e lê a persona por cookie; ela chega ao LlmProvider pelo simulador; B não muda', async () => {
    const url = `/admin/companies/${aliceCompany}/persona`;
    const put = await send('PUT', url, alice, { persona: SECRET_PERSONA });
    assert.equal(put.statusCode, 200);
    assert.deepEqual((await get(url, alice)).json(), { persona: SECRET_PERSONA });
    const sent = await send('POST', `/admin/companies/${aliceCompany}/messages`, alice, {
      contactRef: 'teste-no-site',
      text: SECRET_MESSAGE,
    });
    assert.equal(sent.statusCode, 201);
    assert.ok(llm.calls.at(-1)?.systemPrompt.includes(SECRET_PERSONA));
    // Tentativas contra a empresa de Carol: caminho dela (404) e corpo adulterado (400).
    const carolUrl = `/admin/companies/${carolCompany}/persona`;
    assert.equal((await send('PUT', carolUrl, alice, { persona: 'invasao' })).statusCode, 404);
    assert.equal(
      (await send('PUT', url, alice, { persona: 'invasao', companyId: carolCompany })).statusCode,
      400,
    );
    assert.deepEqual((await get(carolUrl, carol)).json(), { persona: null });
    assert.deepEqual((await send('PUT', url, alice, { persona: null })).json(), { persona: null });
  });

  it('ADMIN igual a OWNER; AGENT: 403 em canal e persona e 201 no simulador; VIEWER: 403 nos três', async () => {
    const base = `/admin/companies/${aliceCompany}`;
    const probe = async () => ({
      channel: (await get(`${base}/channel`, alice)).statusCode,
      persona: (await get(`${base}/persona`, alice)).statusCode,
      simulator: (
        await send('POST', `${base}/messages`, alice, { contactRef: 'teste-no-site', text: 'oi' })
      ).statusCode,
    });
    await setRole(aliceCompany, alice, 'ADMIN');
    assert.deepEqual(await probe(), { channel: 200, persona: 200, simulator: 201 });
    await setRole(aliceCompany, alice, 'AGENT');
    assert.deepEqual(await probe(), { channel: 403, persona: 403, simulator: 201 });
    await setRole(aliceCompany, alice, 'VIEWER');
    assert.deepEqual(await probe(), { channel: 403, persona: 403, simulator: 403 });
    // Rebaixar no meio da sessão vale na requisição seguinte, sem novo login.
    await setRole(aliceCompany, alice, 'OWNER');
    assert.deepEqual(await probe(), { channel: 200, persona: 200, simulator: 201 });
  });

  it('conta com vínculo só em C chamando A: 404 idêntico ao de empresa inexistente', async () => {
    for (const suffix of ['channel', 'channel/setup', 'persona']) {
      const alien = await get(`/admin/companies/${aliceCompany}/${suffix}`, carol);
      const ghost = await get(`/admin/companies/${randomUUID()}/${suffix}`, carol);
      assert.equal(alien.statusCode, 404, suffix);
      assert.deepEqual(errorOf(alien), errorOf(ghost));
    }
    const alienPost = await send('POST', `/admin/companies/${aliceCompany}/messages`, carol, {
      contactRef: 'x',
      text: 'oi',
    });
    assert.equal(alienPost.statusCode, 404);
  });

  it('GET .../channel/setup devolve só valores públicos', async () => {
    const response = await get(`/admin/companies/${aliceCompany}/channel/setup`, alice);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      embeddedSignup: { appId: APP_ID, configId: CONFIG_ID, graphApiVersion: 'v26.0' },
      manualConnect: false,
    });
    assert.ok(!response.body.includes(APP_SECRET));
  });

  it('sem empresa selecionada: 401; Authorization inválido com cookie válido não cai no cookie', async () => {
    const dave = await signUp('dave');
    const url = `/admin/companies/${aliceCompany}/persona`;
    assert.equal((await get(url, dave)).statusCode, 401);
    assert.equal((await get(url, undefined)).statusCode, 401);
    const invalidBearer = await get(url, alice, { authorization: 'Bearer token.invalido.x' });
    assert.equal(invalidBearer.statusCode, 401);
  });

  it('CSRF: PUT, DELETE e POST sem Origin igual ao APP_ORIGIN ou sem X-Soprei-App dão 403 e nada é gravado', async () => {
    const base = `/admin/companies/${aliceCompany}`;
    const countBefore = await db.prisma.message.count({ where: { companyId: aliceCompany } });
    const wrongHeaders: Record<string, string>[] = [
      {},
      { origin: 'http://evil.test', 'x-soprei-app': 'web' },
      { origin: ORIGIN },
      { origin: ORIGIN, 'x-soprei-app': 'mobile' },
    ];
    for (const headers of wrongHeaders) {
      for (const [method, url, payload] of [
        ['PUT', `${base}/persona`, { persona: 'nao-grava' }],
        [
          'PUT',
          `${base}/channel`,
          { phoneNumberId: '1', wabaId: '2', accessToken: 'x'.repeat(30) },
        ],
        ['DELETE', `${base}/channel`, undefined],
        ['POST', `${base}/messages`, { contactRef: 'teste-no-site', text: 'nao-grava' }],
        ['POST', `${base}/channel/embedded-signup`, { code: 'c', wabaId: '1', phoneNumberId: '2' }],
      ] as const) {
        const response = await send(method, url, alice, payload, headers);
        assert.equal(response.statusCode, 403, `${method} ${url} ${JSON.stringify(headers)}`);
      }
    }
    assert.deepEqual((await get(`${base}/persona`, alice)).json(), { persona: null });
    assert.equal(
      await db.prisma.message.count({ where: { companyId: aliceCompany } }),
      countBefore,
    );
    assert.equal(graph.requests.length, 0);
    // GET com cookie não exige Origin.
    assert.equal((await get(`${base}/persona`, alice)).statusCode, 200);
  });

  it('Embedded Signup por cookie: conecta, lê o estado, AGENT recebe 403 e desconectar é idempotente', async () => {
    const base = `/admin/companies/${aliceCompany}`;
    const number = digits();
    const waba = digits();
    const token = `EAAG-token-${randomUUID()}`;
    const code = `code-${randomUUID()}`;
    graph.addWaba(waba, [number]);
    graph.addToken(token, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [waba] });
    graph.addCode(code, token);

    await setRole(aliceCompany, alice, 'AGENT');
    const denied = await send('POST', `${base}/channel/embedded-signup`, alice, {
      code,
      wabaId: waba,
      phoneNumberId: number,
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(graph.requests.length, 0);

    await setRole(aliceCompany, alice, 'OWNER');
    const connected = await send('POST', `${base}/channel/embedded-signup`, alice, {
      code,
      wabaId: waba,
      phoneNumberId: number,
    });
    assert.equal(connected.statusCode, 200, connected.body);
    assert.equal(connected.json<{ state: string }>().state, 'CONNECTED');
    const state = await get(`${base}/channel`, alice);
    assert.equal(state.json<{ state: string; phoneNumberId: string }>().phoneNumberId, number);
    assert.ok(!state.body.includes(token));

    // O code é de uso único: repetir não reconecta com ele.
    const replay = await send('POST', `${base}/channel/embedded-signup`, alice, {
      code,
      wabaId: waba,
      phoneNumberId: number,
    });
    assert.equal(replay.statusCode, 400);
    assert.equal(errorOf(replay).code, 'CHANNEL_CODE_INVALID');

    assert.equal((await send('DELETE', `${base}/channel`, alice)).statusCode, 204);
    assert.equal((await send('DELETE', `${base}/channel`, alice)).statusCode, 204);
    assert.equal(
      (await get(`${base}/channel`, alice)).json<{ state: string }>().state,
      'NOT_CONNECTED',
    );
    // Nem o code nem o token aparecem no log.
    for (const secret of [code, token, SECRET_PERSONA, SECRET_MESSAGE, CONFIG_ID]) {
      assert.ok(!logContains(logs.raw(), secret));
    }
  });

  it('Redis das sessões fora: 503 (fail-closed) em canal, persona e simulador', async () => {
    sessionsDown = true;
    try {
      for (const suffix of ['channel', 'channel/setup', 'persona']) {
        assert.equal(
          (await get(`/admin/companies/${aliceCompany}/${suffix}`, alice)).statusCode,
          503,
        );
      }
      assert.equal(
        (
          await send('POST', `/admin/companies/${aliceCompany}/messages`, alice, {
            contactRef: 'teste-no-site',
            text: 'oi',
          })
        ).statusCode,
        503,
      );
    } finally {
      sessionsDown = false;
    }
  });

  it('vínculo desativado, empresa suspensa e conta desativada deixam de acessar (401)', async () => {
    const url = (companyId: string) => `/admin/companies/${companyId}/persona`;
    const erin = await signUp('erin');
    const erinCompany = await createCompany(erin, 'Empresa E do site');
    await select(erin, erinCompany);
    assert.equal((await get(url(erinCompany), erin)).statusCode, 200);

    await db.prisma.membership.updateMany({
      where: { companyId: erinCompany, accountId: erin.accountId },
      data: { status: 'DISABLED' },
    });
    assert.equal((await get(url(erinCompany), erin)).statusCode, 401);
    await db.prisma.membership.updateMany({
      where: { companyId: erinCompany, accountId: erin.accountId },
      data: { status: 'ACTIVE' },
    });
    assert.equal((await get(url(erinCompany), erin)).statusCode, 200);

    await db.prisma.company.update({ where: { id: erinCompany }, data: { status: 'SUSPENDED' } });
    assert.equal((await get(url(erinCompany), erin)).statusCode, 401);
    await db.prisma.company.update({ where: { id: erinCompany }, data: { status: 'ACTIVE' } });

    await db.prisma.account.update({ where: { id: erin.accountId }, data: { status: 'DISABLED' } });
    assert.equal((await get(url(erinCompany), erin)).statusCode, 401);
    assert.ok(secretOf(erin).length > 0);
  });
});
