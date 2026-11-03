import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { ChannelConnectionService } from '../../application/channel/channel-connection.service.js';
import { ClientService } from '../../application/clients/client.service.js';
import type { Client, UserRole } from '../../domain/index.js';
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
  PrismaClientRepository,
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

async function createHarness(options: { withChannel?: boolean } = {}): Promise<Harness> {
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
  const clients = new PrismaClientRepository(database.prisma);
  const stack = buildChannelCredentials(database.prisma);
  const channel = new ChannelConnectionService({
    clients,
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
    userAdmin: auth.userAdmin,
    admin: {
      clients: new ClientService(clients),
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

async function enroll(h: Harness, client: Client, role: UserRole): Promise<Person> {
  const email = emailFor(role.toLowerCase());
  const user = await h.auth.users.create(client.id, {
    email,
    passwordHash: await h.auth.hasher.hash(PASSWORD),
    role,
  });
  const response = await h.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { clientSlug: client.slug, email, password: PASSWORD },
    remoteAddress: '203.0.113.10',
  });
  assert.equal(response.statusCode, 200, response.body);
  return { id: user.id, accessToken: response.json<{ accessToken: string }>().accessToken };
}

const signup = (h: Harness, who: Person, clientId: string, payload: object) =>
  h.app.inject({
    method: 'POST',
    url: `/admin/clients/${clientId}/channel/embedded-signup`,
    headers: bearer(who.accessToken),
    remoteAddress: '203.0.113.10',
    payload,
  });

const call = (
  h: Harness,
  who: Person,
  method: 'GET' | 'PUT' | 'DELETE',
  clientId: string,
  payload?: object,
) =>
  h.app.inject({
    method,
    url: `/admin/clients/${clientId}/channel`,
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

async function dbState(clientId: string) {
  const [client, connection, events] = await Promise.all([
    database.prisma.client.findFirst({ where: { id: clientId } }),
    database.prisma.channelConnection.findFirst({ where: { clientId } }),
    database.prisma.auditEvent.findMany({ where: { clientId }, orderBy: { createdAt: 'asc' } }),
  ]);
  return { number: client?.whatsappPhoneNumberId ?? null, connection, events };
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

describe('Embedded Signup (spec 015b, Postgres e Redis reais, Graph falso)', () => {
  it('feliz: troca o code, prova a posse, registra com PIN aleatório, grava tudo cifrado e não vaza nada', async () => {
    await withHarness(async (h) => {
      const client = await tenants.createClient('es-ok');
      const owner = await enroll(h, client, 'OWNER');
      const { number, waba, token, code } = givenSignup();

      const response = await signup(h, owner, client.id, {
        code,
        wabaId: waba,
        phoneNumberId: number,
      });

      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<ChannelBody>();
      assert.equal(body.state, 'CONNECTED');
      assert.equal(body.phoneNumberId, number);
      assert.equal(body.wabaId, waba);
      assert.deepEqual(
        graph.requests.map((request) => request.operation),
        ['oauth_token', 'debug_token', 'phone_numbers', 'subscribe', 'register'],
      );
      const [exchange] = graph.ofOperation('oauth_token');
      assert.equal(exchange?.query.client_id, APP_ID);
      assert.equal(exchange.query.client_secret, APP_SECRET);
      assert.equal(exchange.query.code, code);
      const [register] = graph.ofOperation('register');
      const pin = (register?.body as { pin: string }).pin;
      assert.match(pin, /^[0-9]{6}$/);
      assert.equal(register?.headers.authorization, `Bearer ${token}`);
      assert.ok(graph.subscribed.has(waba));

      const stored = await dbState(client.id);
      assert.equal(stored.number, number);
      assert.ok(stored.connection !== null);
      assert.equal(
        h.stack.cipher.decrypt(client.id, stored.connection.tokenCiphertext).reveal(),
        token,
      );
      const pinCipher = stored.connection.registrationPinCiphertext;
      assert.ok(pinCipher !== null && !pinCipher.includes(pin));
      assert.equal(h.stack.cipher.decrypt(client.id, pinCipher).reveal(), pin);
      assert.deepEqual(
        stored.events.map((event) => event.action),
        ['CHANNEL_CONNECTED'],
      );
      assert.equal(stored.events[0]?.targetUserId, null);
      assert.deepEqual((await call(h, owner, 'GET', client.id)).json<ChannelBody>(), body);

      const metricsBody = await h.metrics.render();
      for (const secret of [
        code,
        token,
        pin,
        pinCipher,
        stored.connection.tokenCiphertext,
        APP_SECRET,
      ]) {
        assert.ok(!response.body.includes(secret));
        assert.ok(!h.logs.raw().includes(secret), 'log');
        assert.ok(!metricsBody.includes(secret), 'métricas');
      }
      assert.ok(!h.logs.raw().includes('eco:'));
      assert.match(
        metricsBody,
        /channel_connections_total{action="embedded_signup",result="ok"} 1/,
      );
    });
  });

  it('recusado: nada é gravado e nenhum segredo nem corpo da Meta vaza', async () => {
    await withHarness(async (h) => {
      const client = await tenants.createClient('es-refused');
      const owner = await enroll(h, client, 'OWNER');
      const { number, waba, token, code } = givenSignup();
      const base = { wabaId: waba, phoneNumberId: number };
      const attempt = (payload: object) => signup(h, owner, client.id, payload);

      const expired = newCode();
      graph.addCode(expired, token, { expired: true });
      const foreignToken = newToken();
      graph.addToken(foreignToken, { appId: '999', scopes: FULL_SCOPES, wabaIds: [waba] });
      const foreignApp = newCode();
      graph.addCode(foreignApp, foreignToken);
      const noScopeToken = newToken();
      graph.addToken(noScopeToken, {
        appId: APP_ID,
        scopes: ['whatsapp_business_messaging'],
        wabaIds: [waba],
      });
      const noScope = newCode();
      graph.addCode(noScope, noScopeToken);
      const otherWaba = digits();
      graph.addWaba(otherWaba, [digits()]);
      const alienToken = newToken();
      graph.addToken(alienToken, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [otherWaba] });
      const alien = newCode();
      graph.addCode(alien, alienToken);

      const refusals: [string, LightMyRequestResponse, string][] = [
        ['desconhecido', await attempt({ ...base, code: newCode() }), 'CHANNEL_CODE_INVALID'],
        ['expirado', await attempt({ ...base, code: expired }), 'CHANNEL_CODE_INVALID'],
        ['outro app', await attempt({ ...base, code: foreignApp }), 'CHANNEL_WRONG_APP'],
        ['sem escopo', await attempt({ ...base, code: noScope }), 'CHANNEL_MISSING_SCOPE'],
        ['WABA alheia', await attempt({ ...base, code: alien }), 'CHANNEL_NUMBER_NOT_IN_WABA'],
        [
          'número fora da WABA',
          await attempt({ ...base, phoneNumberId: digits(), code: freshCode(token) }),
          'CHANNEL_NUMBER_NOT_IN_WABA',
        ],
      ];
      for (const [label, response, expectedCode] of refusals) {
        assert.equal(response.statusCode, 400, `${label}: ${response.body}`);
        assert.equal(errorCode(response), expectedCode, label);
        assert.ok(!response.body.includes('eco:'), label);
      }
      // Mensagem única para qualquer problema do code.
      assert.equal(
        refusals[0]?.[1].json<{ error: { message: string } }>().error.message,
        refusals[1]?.[1].json<{ error: { message: string } }>().error.message,
      );

      // Número já registrado com 2FA e outro PIN: o registro é recusado (mensagem constante).
      graph.setRegistered(number, '999999');
      const locked = await attempt({ ...base, code: freshCode(token) });
      assert.equal(locked.statusCode, 400, locked.body);
      assert.equal(errorCode(locked), 'CHANNEL_REGISTRATION_FAILED');
      assert.ok(!locked.body.includes('eco:') && !locked.body.includes('999999'));
      graph.registeredPins.clear();

      // Meta fora do ar na troca, na assinatura e no registro, limite de taxa e demora: 502.
      graph.failOperation('oauth_token', { kind: 'respond', status: 503 });
      const downExchange = await attempt({ ...base, code: freshCode(token) });
      graph.failOperation('oauth_token', graphError(429, 4));
      const limited = await attempt({ ...base, code: freshCode(token) });
      graph.failOperation('subscribe', graphError(500, 1));
      const downSubscribe = await attempt({ ...base, code: freshCode(token) });
      graph.failOperation('register', graphError(500, 1));
      const downRegister = await attempt({ ...base, code: freshCode(token) });
      graph.failOperation('oauth_token', { kind: 'hang' });
      const slow = await attempt({ ...base, code: freshCode(token) });
      for (const response of [downExchange, limited, downSubscribe, downRegister, slow]) {
        assert.equal(response.statusCode, 502, response.body);
        assert.equal(errorCode(response), 'EXTERNAL_SERVICE_ERROR');
        assert.ok(!response.body.includes('eco:'));
      }

      // Corpo inválido: 400 sem ecoar o valor.
      const secretValue = 'valor-secreto-do-corpo-98765';
      for (const payload of [
        { ...base, code, extra: secretValue },
        { ...base },
        { wabaId: waba, code },
        { ...base, code: `${secretValue} com espaco` },
        { ...base, code: 'x'.repeat(513) },
        { ...base, phoneNumberId: 'abc', code },
      ]) {
        const response = await attempt(payload);
        assert.equal(response.statusCode, 400, response.body);
        assert.ok(!response.body.includes(secretValue));
      }

      const stored = await dbState(client.id);
      assert.equal(stored.number, null);
      assert.equal(stored.connection, null);
      assert.deepEqual(stored.events, []);
      const logs = h.logs.raw();
      assert.ok(!logs.includes('eco:'));
      for (const secret of [code, token, APP_SECRET, '999999']) {
        assert.ok(!logs.includes(secret), 'log');
        // O PIN de 6 dígitos '999999' poderia coincidir com um número das métricas do processo.
        if (secret !== '999999')
          assert.ok(!(await h.metrics.render()).includes(secret), 'métricas');
      }
    });
  });

  it('code de uso único: duas submissões simultâneas (uma vence) e o reuso por outro cliente é recusado', async () => {
    await withHarness(async (h) => {
      const a = await tenants.createClient('es-once-a');
      const b = await tenants.createClient('es-once-b');
      const ownerA = await enroll(h, a, 'OWNER');
      const ownerB = await enroll(h, b, 'OWNER');
      const { number, waba, code } = givenSignup();
      const payload = { code, wabaId: waba, phoneNumberId: number };

      const [first, second] = await Promise.all([
        signup(h, ownerA, a.id, payload),
        signup(h, ownerA, a.id, payload),
      ]);
      assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 400]);
      const loser = first.statusCode === 400 ? first : second;
      assert.equal(errorCode(loser), 'CHANNEL_CODE_INVALID');

      const reuse = await signup(h, ownerB, b.id, payload);
      assert.equal(reuse.statusCode, 400);
      assert.equal(errorCode(reuse), 'CHANNEL_CODE_INVALID');
      assert.equal((await dbState(b.id)).connection, null);
    });
  });

  it('dois clientes: ids de A com o code de B são recusados, o número de A dá 409 sem revelar A e A segue intacto', async () => {
    await withHarness(async (h) => {
      const a = await tenants.createClient('es-two-a');
      const b = await tenants.createClient('es-two-b');
      const ownerA = await enroll(h, a, 'OWNER');
      const ownerB = await enroll(h, b, 'OWNER');
      const sa = givenSignup();
      const connectedA = await signup(h, ownerA, a.id, {
        code: sa.code,
        wabaId: sa.waba,
        phoneNumberId: sa.number,
      });
      assert.equal(connectedA.statusCode, 200, connectedA.body);
      const before = await dbState(a.id);

      // B, com o code de B (token que só enxerga a WABA de B), usa a WABA e o número de A.
      const sb = givenSignup();
      const stolen = await signup(h, ownerB, b.id, {
        code: sb.code,
        wabaId: sa.waba,
        phoneNumberId: sa.number,
      });
      assert.equal(stolen.statusCode, 400);
      assert.equal(errorCode(stolen), 'CHANNEL_NUMBER_NOT_IN_WABA');
      const numberOnly = await signup(h, ownerB, b.id, {
        code: freshCode(sb.token),
        wabaId: sb.waba,
        phoneNumberId: sa.number,
      });
      assert.equal(errorCode(numberOnly), 'CHANNEL_NUMBER_NOT_IN_WABA');

      // WABA compartilhada: o token de B lista o número de A, que já é de A: 409.
      const sharedToken = newToken();
      graph.addToken(sharedToken, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [sa.waba] });
      const conflict = await signup(h, ownerB, b.id, {
        code: freshCode(sharedToken),
        wabaId: sa.waba,
        phoneNumberId: sa.number,
      });
      assert.equal(conflict.statusCode, 409, conflict.body);
      assert.equal(errorCode(conflict), 'CHANNEL_NUMBER_IN_USE');
      assert.ok(!conflict.body.includes(a.id) && !conflict.body.includes(a.slug));
      assert.equal(
        graph.ofOperation('register').length,
        1,
        'o número de A não foi registrado de novo',
      );

      // O code de B nunca conecta A: o clientId vem do token, outro id no caminho é 404.
      const cross = await signup(h, ownerB, a.id, {
        code: freshCode(sb.token),
        wabaId: sa.waba,
        phoneNumberId: sa.number,
      });
      assert.equal(cross.statusCode, 404);

      const stateB = await dbState(b.id);
      assert.equal(stateB.number, null);
      assert.equal(stateB.connection, null);
      assert.deepEqual(stateB.events, []);
      const after = await dbState(a.id);
      assert.equal(after.number, before.number);
      assert.equal(after.connection?.tokenCiphertext, before.connection?.tokenCiphertext);
      assert.equal(
        after.connection?.registrationPinCiphertext,
        before.connection?.registrationPinCiphertext,
      );
      assert.equal(after.events.length, before.events.length);
    });
  });

  it('refazer o Embedded Signup reaproveita o PIN guardado; o PUT manual o preserva; o DELETE o apaga com a conexão', async () => {
    await withHarness(async (h) => {
      const client = await tenants.createClient('es-pin');
      const owner = await enroll(h, client, 'OWNER');
      const s1 = givenSignup();
      await signup(h, owner, client.id, {
        code: s1.code,
        wabaId: s1.waba,
        phoneNumberId: s1.number,
      });
      const first = (await dbState(client.id)).connection;
      assert.ok(first?.registrationPinCiphertext);
      const pin1 = h.stack.cipher.decrypt(client.id, first.registrationPinCiphertext).reveal();

      // Reconexão: o número já está registrado com esse PIN e a Meta só aceita o mesmo.
      const s2 = givenSignup();
      graph.setRegistered(s2.number, pin1);
      const second = await signup(h, owner, client.id, {
        code: s2.code,
        wabaId: s2.waba,
        phoneNumberId: s2.number,
      });
      assert.equal(second.statusCode, 200, second.body);
      const [, registerAgain] = graph.ofOperation('register');
      assert.equal((registerAgain?.body as { pin: string }).pin, pin1);
      const stored2 = (await dbState(client.id)).connection;
      assert.equal(stored2?.tokenVersion, 2);
      assert.notEqual(stored2.registrationPinCiphertext, first.registrationPinCiphertext);
      assert.deepEqual(
        (await dbState(client.id)).events.map((event) => event.action),
        ['CHANNEL_CONNECTED', 'CHANNEL_TOKEN_REPLACED'],
      );

      // PUT manual depois: troca o token e mantém o PIN.
      const manualToken = newToken();
      graph.addToken(manualToken, { appId: APP_ID, scopes: FULL_SCOPES, wabaIds: [s2.waba] });
      const put = await call(h, owner, 'PUT', client.id, {
        phoneNumberId: s2.number,
        wabaId: s2.waba,
        accessToken: manualToken,
      });
      assert.equal(put.statusCode, 200, put.body);
      const stored3 = (await dbState(client.id)).connection;
      assert.equal(
        h.stack.cipher.decrypt(client.id, stored3?.registrationPinCiphertext ?? '').reveal(),
        pin1,
      );

      assert.equal((await call(h, owner, 'DELETE', client.id)).statusCode, 204);
      assert.equal((await dbState(client.id)).connection, null);
    });
  });

  it('PIN guardado que não decifra: gera um PIN novo, avisa só com o clientId e não vaza nenhum PIN', async () => {
    await withHarness(async (h) => {
      const client = await tenants.createClient('es-badpin');
      const owner = await enroll(h, client, 'OWNER');
      const s1 = givenSignup();
      await signup(h, owner, client.id, {
        code: s1.code,
        wabaId: s1.waba,
        phoneNumberId: s1.number,
      });
      const first = (await dbState(client.id)).connection;
      assert.ok(first?.registrationPinCiphertext);
      const oldPin = h.stack.cipher.decrypt(client.id, first.registrationPinCiphertext).reveal();
      // Texto do PIN adulterado (como se a chave tivesse sido removida).
      await database.prisma.channelConnection.updateMany({
        where: { clientId: client.id },
        data: { registrationPinCiphertext: 'v1.teste.AAAA.BBBB.CCCC' },
      });

      const s2 = givenSignup();
      const response = await signup(h, owner, client.id, {
        code: s2.code,
        wabaId: s2.waba,
        phoneNumberId: s2.number,
      });

      assert.equal(response.statusCode, 200, response.body);
      const [, registerAgain] = graph.ofOperation('register');
      const newPin = (registerAgain?.body as { pin: string }).pin;
      assert.match(newPin, /^[0-9]{6}$/);
      const stored = (await dbState(client.id)).connection;
      assert.equal(
        h.stack.cipher.decrypt(client.id, stored?.registrationPinCiphertext ?? '').reveal(),
        newPin,
      );
      const warning = h.logs
        .lines()
        .find((line) => String(line.msg).includes('PIN de registro guardado'));
      assert.equal(warning?.level, 40);
      assert.equal(warning.clientId, client.id);
      const raw = h.logs.raw();
      for (const secret of [oldPin, newPin, 'AAAA.BBBB.CCCC']) {
        assert.ok(!raw.includes(secret), 'log');
      }
    });
  });

  it('permissões: AGENT/VIEWER 403, PlatformAdmin 403, :clientId alheio 404, sem token 401; sem canal habilitado 404', async () => {
    await withHarness(async (h) => {
      const a = await tenants.createClient('es-perm-a');
      const b = await tenants.createClient('es-perm-b');
      const people: Partial<Record<UserRole, Person>> = {};
      for (const role of ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'] as const) {
        people[role] = await enroll(h, a, role);
      }
      const payload = { code: newCode(), wabaId: digits(), phoneNumberId: digits() };
      const who = (role: UserRole): Person => {
        const person = people[role];
        assert.ok(person !== undefined);
        return person;
      };
      for (const role of ['AGENT', 'VIEWER'] as const) {
        assert.equal((await signup(h, who(role), a.id, payload)).statusCode, 403, role);
        assert.equal((await signup(h, who(role), b.id, payload)).statusCode, 404, role);
      }
      assert.equal((await signup(h, who('OWNER'), b.id, payload)).statusCode, 404);
      const anonymous = await h.app.inject({
        method: 'POST',
        url: `/admin/clients/${a.id}/channel/embedded-signup`,
        payload,
      });
      assert.equal(anonymous.statusCode, 401);
      // ADMIN passa da autorização (o code é desconhecido: 400, não 403).
      assert.equal((await signup(h, who('ADMIN'), a.id, payload)).statusCode, 400);

      const email = emailFor('platform-es');
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
      const platform = {
        id: 'platform',
        accessToken: login.json<{ accessToken: string }>().accessToken,
      };
      assert.equal((await signup(h, platform, a.id, payload)).statusCode, 403);
    });
    await withHarness(
      async (h) => {
        const client = await tenants.createClient('es-off');
        const owner = await enroll(h, client, 'OWNER');
        const response = await signup(h, owner, client.id, {
          code: newCode(),
          wabaId: digits(),
          phoneNumberId: digits(),
        });
        assert.equal(response.statusCode, 404);
      },
      { withChannel: false },
    );
  });
});
