import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { PlatformAccountService } from '../../application/platform/platform-account.service.js';
import { PlatformAuthService } from '../../application/platform/platform-auth.service.js';
import { AccountId, CompanyId, MembershipId } from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth, TEST_PASSWORD } from '../../test-support/in-memory-auth.js';
import {
  codeAt,
  enrollTestAdmin,
  InMemoryPlatformAccountUnitOfWork,
  InMemoryPlatformAuditRepository,
  InMemoryPlatformSessionStore,
  ManualClock,
  testPlatformCipher,
} from '../../test-support/in-memory-platform.js';
import { captureLogs, logContains } from '../../test-support/log-capture.js';
import { ACCOUNT_COOKIE } from '../auth/account.controller.js';
import { PLATFORM_COOKIE } from './platform-auth.controller.js';

// Spec 045, E2: as ações do admin da plataforma sobre uma conta, de ponta a ponta pelo Fastify (cookie com
// segundo fator, origem, corpo strict, confirmação com código novo, 404 uniforme, privacidade).

const ORIGIN = 'https://soadm.exemplo.test';
const WRITE_HEADERS = { origin: ORIGIN, 'x-soprei-app': 'admin' } as const;
const ALL_UP = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};
const MAX_FAILURES = 3;
/** E-mail da conta: só existe aqui, para provar que nunca sai em resposta, log ou métrica. */
const ACCOUNT_EMAIL = 'lucia.secreta@exemplo.com';

interface World {
  readonly app: FastifyInstance;
  readonly uow: InMemoryPlatformAccountUnitOfWork;
  readonly audit: InMemoryPlatformAuditRepository;
  readonly calls: string[];
  readonly logs: ReturnType<typeof captureLogs>;
  readonly auth: ReturnType<typeof buildTestAuth>;
  readonly cipher: ReturnType<typeof testPlatformCipher>;
  readonly clock: ManualClock;
  readonly cookie: string;
  readonly secret: Buffer;
  readonly accountId: AccountId;
  readonly unverified: AccountId;
  /** Dublê do núcleo da anonimização (o próprio núcleo tem testes em `account-anonymizer.test.ts`). */
  readonly anonymized: Set<string>;
  readonly refuse: Map<string, string>;
}

async function setup(options: { accounts?: boolean } = {}): Promise<World> {
  const logs = captureLogs();
  const clock = new ManualClock();
  const cipher = testPlatformCipher();
  const auth = buildTestAuth({
    logger: logs.logger,
    maxFailures: MAX_FAILURES,
    platformTotp: { cipher, now: clock.now },
  });
  const sessions = new InMemoryPlatformSessionStore(clock.now, 1_800, 43_200);
  const audit = new InMemoryPlatformAuditRepository();
  const uow = new InMemoryPlatformAccountUnitOfWork(audit);
  const accountId = AccountId.parse(randomUUID());
  const unverified = AccountId.parse(randomUUID());
  uow.accounts.set(accountId, { status: 'ACTIVE', verified: true });
  uow.accounts.set(unverified, { status: 'ACTIVE', verified: false });
  uow.memberships.push({
    accountId,
    companyId: CompanyId.parse(randomUUID()),
    membershipId: MembershipId.parse(randomUUID()),
  });
  const calls: string[] = [];
  const anonymized = new Set<string>();
  const refuse = new Map<string, string>();
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
      ...(options.accounts === false
        ? {}
        : {
            accounts: new PlatformAccountService({
              accounts: uow,
              confirmer: auth.service,
              accountSessions: {
                revokeAll: (id) => {
                  calls.push(`revokeAll:${id}`);
                  return Promise.resolve();
                },
              },
              bearerSessions: {
                revokeAllSessions: (scope, subject) => {
                  calls.push(`bearer:${scope}:${subject}`);
                  return Promise.resolve();
                },
              },
              mail: {
                requestPasswordResetFor: (id) => {
                  // O e-mail fica no serviço da conta; o admin não o recebe.
                  calls.push(`reset:${id}:${ACCOUNT_EMAIL}`);
                  return Promise.resolve();
                },
                resendVerificationFor: (id) => {
                  calls.push(`verify:${id}`);
                  return Promise.resolve('sent');
                },
              },
              anonymizer: {
                anonymize: async (id, options) => {
                  if (!uow.accounts.has(id)) throw new NotFoundError('Conta não encontrada');
                  const code = refuse.get(id);
                  if (code !== undefined) throw new ConflictError('recusa', { code });
                  calls.push(`anonymize:${id}`);
                  if (anonymized.has(id)) return false;
                  anonymized.add(id);
                  if (options?.platformAudit !== undefined)
                    await audit.create(options.platformAudit);
                  options?.onCommitted?.();
                  return true;
                },
              },
              logger: logs.logger,
              metrics,
            }),
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
    accountId,
    unverified,
    anonymized,
    refuse,
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

function routes(accountId: string): readonly (readonly [string, Record<string, unknown>])[] {
  return [
    [`/platform/accounts/${accountId}/disable`, { reason: 'ABUSE', code: '123456' }],
    [`/platform/accounts/${accountId}/enable`, { reason: 'OTHER' }],
    [`/platform/accounts/${accountId}/sessions/revoke`, { reason: 'OTHER' }],
    [`/platform/accounts/${accountId}/password-reset`, { reason: 'OTHER' }],
    [`/platform/accounts/${accountId}/verification/resend`, { reason: 'OTHER' }],
    [
      `/platform/accounts/${accountId}/anonymize`,
      { reason: 'OWNER_REQUEST', code: '123456', confirm: 'EXCLUIR' },
    ],
  ];
}

describe('/platform/accounts/:accountId/* ações sobre a conta (spec 045, E2)', () => {
  it('sem as contas ligadas, as rotas não existem (404)', async () => {
    const world = await setup({ accounts: false });
    try {
      for (const [url, payload] of routes(world.accountId)) {
        const response = await world.app.inject({
          method: 'POST',
          url,
          headers: { ...WRITE_HEADERS, cookie: world.cookie },
          payload,
        });
        assert.equal(response.statusCode, 404, url);
      }
    } finally {
      await world.app.close();
    }
  });

  it('sem o cookie do admin, com Bearer de plataforma ou de vínculo ou com o cookie da conta do site: 401 e nada gravado; sem origem ou cabeçalho: 403 e nada gravado', async () => {
    const world = await setup();
    try {
      const other = await enrollTestAdmin(world.auth, world.cipher);
      const issued = await world.auth.service.loginPlatform({
        email: other.email,
        password: TEST_PASSWORD,
        code: codeAt(other.secret, world.clock.ms),
      });
      assert.ok(issued.ok);
      const company = await world.auth.companies.create({
        name: 'X',
        slug: `x-${randomUUID().slice(0, 8)}`,
      });
      const membership = await world.auth.membershipToken(CompanyId.parse(company.id));
      for (const headers of [
        {},
        bearer(issued.value.accessToken),
        bearer(membership.accessToken),
        // O cookie da conta do site (mesmo válido no formato) nunca é lido em /platform/*.
        { cookie: `${ACCOUNT_COOKIE}=${'a'.repeat(43)}` },
      ]) {
        for (const [url, payload] of routes(world.accountId)) {
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
        for (const [url, payload] of routes(world.accountId)) {
          const response = await world.app.inject({ method: 'POST', url, headers, payload });
          assert.equal(response.statusCode, 403, `${url} ${JSON.stringify(headers)}`);
        }
      }
      assert.deepEqual(actions(world), []);
      assert.deepEqual(world.calls, []);
      assert.equal(world.uow.accounts.get(world.accountId)?.status, 'ACTIVE');
    } finally {
      await world.app.close();
    }
  });

  it('corpo strict: motivo fora da lista, campo a mais ou código malformado = 400; id malformado ou inexistente = 404; nada gravado', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      for (const [url] of routes(world.accountId)) {
        for (const payload of [{}, { reason: 'CALOTE' }, { reason: 'OTHER', note: 'x' }]) {
          const response = await world.app.inject({ method: 'POST', url, headers, payload });
          assert.equal(response.statusCode, 400, `${url} ${JSON.stringify(payload)}`);
        }
      }
      for (const code of ['12345', 'abcdef', '1234567']) {
        const response = await world.app.inject({
          method: 'POST',
          url: `/platform/accounts/${world.accountId}/disable`,
          headers,
          payload: { reason: 'OTHER', code },
        });
        assert.equal(response.statusCode, 400, code);
      }
      for (const id of ['nao-uuid', randomUUID()]) {
        for (const [url, payload] of routes(id)) {
          const response = await world.app.inject({
            method: 'POST',
            url,
            headers,
            payload:
              url.endsWith('/disable') || url.endsWith('/anonymize')
                ? { ...payload, code: freshCode(world) }
                : payload,
          });
          assert.equal(response.statusCode, 404, url);
        }
      }
      assert.deepEqual(actions(world), []);
      assert.deepEqual(world.calls, []);
    } finally {
      await world.app.close();
    }
  });

  it('desativar: sem código, com código errado ou já usado no login = 400 CONFIRMATION_INVALID sem efeito; com código novo = 204, trilha e revogação; repetir = 204 sem evento', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      const url = `/platform/accounts/${world.accountId}/disable`;
      const loginCode = codeAt(world.secret, world.clock.ms);
      for (const payload of [
        { reason: 'ABUSE' },
        { reason: 'ABUSE', code: '000000' === loginCode ? '000001' : '000000' },
        { reason: 'ABUSE', code: loginCode },
      ]) {
        const response = await world.app.inject({ method: 'POST', url, headers, payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
        assert.equal(
          response.json<{ error: { code: string } }>().error.code,
          'CONFIRMATION_INVALID',
        );
      }
      assert.equal(world.uow.accounts.get(world.accountId)?.status, 'ACTIVE');
      assert.deepEqual(actions(world), []);

      const ok = await world.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { reason: 'ABUSE', code: freshCode(world) },
      });
      assert.equal(ok.statusCode, 204);
      assert.equal(world.uow.accounts.get(world.accountId)?.status, 'DISABLED');
      assert.deepEqual(actions(world), ['ACCOUNT_DISABLED']);
      assert.equal(world.audit.events.at(-1)?.reason, 'ABUSE');
      assert.equal(world.calls[0], `revokeAll:${world.accountId}`);
      assert.equal(world.calls.length, 2, 'cookie e a Bearer do vínculo');

      const again = await world.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { reason: 'ABUSE', code: freshCode(world) },
      });
      assert.equal(again.statusCode, 204);
      assert.deepEqual(actions(world), ['ACCOUNT_DISABLED']);

      const enable = await world.app.inject({
        method: 'POST',
        url: `/platform/accounts/${world.accountId}/enable`,
        headers,
        payload: { reason: 'OWNER_REQUEST' },
      });
      assert.equal(enable.statusCode, 204);
      assert.equal(world.uow.accounts.get(world.accountId)?.status, 'ACTIVE');
      assert.deepEqual(actions(world), ['ACCOUNT_DISABLED', 'ACCOUNT_ENABLED']);
    } finally {
      await world.app.close();
    }
  });

  it('remover (anonimizar): a palavra EXCLUIR é exigida (400 sem ela ou com outra); sem código, errado ou o do login = 400 CONFIRMATION_INVALID; código novo = 204 e trilha; repetir = 204 sem evento', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      const url = `/platform/accounts/${world.accountId}/anonymize`;
      for (const confirm of [undefined, 'excluir', 'EXCLUIR ', 'SIM']) {
        const response = await world.app.inject({
          method: 'POST',
          url,
          headers,
          payload: { reason: 'OWNER_REQUEST', code: freshCode(world), confirm },
        });
        assert.equal(response.statusCode, 400, String(confirm));
      }
      const loginCode = codeAt(world.secret, world.clock.ms);
      for (const code of [undefined, '000000' === loginCode ? '000001' : '000000']) {
        const response = await world.app.inject({
          method: 'POST',
          url,
          headers,
          payload: { reason: 'OWNER_REQUEST', code, confirm: 'EXCLUIR' },
        });
        assert.equal(response.statusCode, 400);
        assert.equal(
          response.json<{ error: { code: string } }>().error.code,
          'CONFIRMATION_INVALID',
        );
      }
      assert.deepEqual(world.calls, []);
      assert.deepEqual(actions(world), []);

      const payload = () => ({
        reason: 'OWNER_REQUEST',
        code: freshCode(world),
        confirm: 'EXCLUIR',
      });
      const ok = await world.app.inject({ method: 'POST', url, headers, payload: payload() });
      assert.equal(ok.statusCode, 204);
      assert.equal(ok.body, '');
      assert.deepEqual(actions(world), ['ACCOUNT_ANONYMIZED']);
      assert.equal(world.audit.events.at(-1)?.subjectAccountId, world.accountId);
      assert.equal(world.audit.events.at(-1)?.reason, 'OWNER_REQUEST');

      const again = await world.app.inject({ method: 'POST', url, headers, payload: payload() });
      assert.equal(again.statusCode, 204);
      assert.deepEqual(actions(world), ['ACCOUNT_ANONYMIZED']);
    } finally {
      await world.app.close();
    }
  });

  it('remover (anonimizar): as recusas COMPANY_OWNERSHIP e SUBSCRIPTION_ACTIVE chegam como 409 com o código, sem trilha', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      for (const code of ['COMPANY_OWNERSHIP', 'SUBSCRIPTION_ACTIVE']) {
        world.refuse.set(world.accountId, code);
        const response = await world.app.inject({
          method: 'POST',
          url: `/platform/accounts/${world.accountId}/anonymize`,
          headers,
          payload: { reason: 'OTHER', code: freshCode(world), confirm: 'EXCLUIR' },
        });
        assert.equal(response.statusCode, 409);
        assert.equal(response.json<{ error: { code: string } }>().error.code, code);
      }
      assert.deepEqual(actions(world), []);
      assert.equal(world.anonymized.size, 0);
    } finally {
      await world.app.close();
    }
  });

  it('conta única dona ativa de empresa ativa: 409 LAST_OWNER sem efeito', async () => {
    const world = await setup();
    try {
      world.uow.soleOwner.set(world.accountId, 1);
      const response = await world.app.inject({
        method: 'POST',
        url: `/platform/accounts/${world.accountId}/disable`,
        headers: { ...WRITE_HEADERS, cookie: world.cookie },
        payload: { reason: 'OTHER', code: freshCode(world) },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'LAST_OWNER');
      assert.equal(world.uow.accounts.get(world.accountId)?.status, 'ACTIVE');
      assert.deepEqual(actions(world), []);
      assert.deepEqual(world.calls, []);
    } finally {
      await world.app.close();
    }
  });

  it(`depois de ${String(MAX_FAILURES)} códigos errados: 429 com Retry-After antes de conferir, também no login da plataforma`, async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      const url = `/platform/accounts/${world.accountId}/disable`;
      for (let i = 0; i < MAX_FAILURES; i++) {
        const response = await world.app.inject({
          method: 'POST',
          url,
          headers,
          payload: { reason: 'OTHER', code: '999999' },
        });
        assert.equal(response.statusCode, 400);
      }
      const locked = await world.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { reason: 'OTHER', code: freshCode(world) },
      });
      assert.equal(locked.statusCode, 429);
      assert.ok(Number(locked.headers['retry-after']) > 0);
      assert.equal(world.uow.accounts.get(world.accountId)?.status, 'ACTIVE');
      assert.deepEqual(actions(world), []);
    } finally {
      await world.app.close();
    }
  });

  it('encerrar sessões (204), código de recuperação (202) e reenviar confirmação (202; 409 ALREADY_VERIFIED na confirmada), cada um com sua trilha', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      const post = (url: string) =>
        world.app.inject({ method: 'POST', url, headers, payload: { reason: 'OWNER_REQUEST' } });
      assert.equal(
        (await post(`/platform/accounts/${world.accountId}/sessions/revoke`)).statusCode,
        204,
      );
      const reset = await post(`/platform/accounts/${world.accountId}/password-reset`);
      assert.equal(reset.statusCode, 202);
      assert.equal(reset.body, '');
      const verified = await post(`/platform/accounts/${world.accountId}/verification/resend`);
      assert.equal(verified.statusCode, 409);
      assert.equal(verified.json<{ error: { code: string } }>().error.code, 'ALREADY_VERIFIED');
      assert.equal(
        (await post(`/platform/accounts/${world.unverified}/verification/resend`)).statusCode,
        202,
      );
      assert.deepEqual(actions(world), [
        'ACCOUNT_SESSIONS_REVOKED',
        'ACCOUNT_PASSWORD_RESET_SENT',
        'ACCOUNT_VERIFICATION_SENT',
      ]);
      assert.ok(world.audit.events.every((event) => event.subjectCompanyId === null));
    } finally {
      await world.app.close();
    }
  });

  it('privacidade: nenhum e-mail nem código em resposta, log ou /metrics; a métrica conta as ações', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE_HEADERS, cookie: world.cookie };
      const code = freshCode(world);
      const bodies: string[] = [];
      for (const [url, payload] of [
        [`/platform/accounts/${world.accountId}/disable`, { reason: 'ABUSE', code: '999999' }],
        [`/platform/accounts/${world.accountId}/disable`, { reason: 'ABUSE', code }],
        [`/platform/accounts/${world.accountId}/enable`, { reason: 'OTHER' }],
        [`/platform/accounts/${world.accountId}/password-reset`, { reason: 'OTHER' }],
        [`/platform/accounts/${world.accountId}/verification/resend`, { reason: 'OTHER' }],
        [`/platform/accounts/${world.unverified}/verification/resend`, { reason: 'OTHER' }],
        [`/platform/accounts/${world.accountId}/sessions/revoke`, { reason: 'OTHER' }],
      ] as const) {
        bodies.push((await world.app.inject({ method: 'POST', url, headers, payload })).body);
      }
      bodies.push(
        (
          await world.app.inject({
            method: 'POST',
            url: `/platform/accounts/${world.unverified}/anonymize`,
            headers,
            payload: { reason: 'OTHER', code: freshCode(world), confirm: 'EXCLUIR' },
          })
        ).body,
      );
      const metrics = await world.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer token-de-metricas-de-teste-com-32-chars' },
      });
      assert.equal(metrics.statusCode, 200);
      for (const text of [...bodies, world.logs.raw(), metrics.body]) {
        assert.ok(!logContains(text, ACCOUNT_EMAIL), 'e-mail');
        assert.ok(!logContains(text, '999999'), 'código errado');
        assert.ok(!logContains(text, code), 'código');
      }
      for (const action of [
        'account_disabled',
        'account_enabled',
        'account_password_reset_sent',
        'account_verification_sent',
        'account_sessions_revoked',
        'account_anonymized',
      ]) {
        assert.match(metrics.body, new RegExp(`platform_actions_total\\{action="${action}"\\} 1`));
      }
    } finally {
      await world.app.close();
    }
  });
});
