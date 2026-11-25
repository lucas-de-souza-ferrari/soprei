import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { PlatformInvitationView } from '../../application/invitations/invitation.service.js';
import { PlatformAuthService } from '../../application/platform/platform-auth.service.js';
import { CompanyId } from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics } from '../../infrastructure/metrics/index.js';
import { ConflictError, NotFoundError } from '../../shared/errors/index.js';
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
import type { PlatformInvitationRoutes } from './platform-invitation.controller.js';

// Spec 045, E3b: as rotas de convite da plataforma e "Nova empresa" pelo Fastify (cookie com segundo fator,
// origem, corpo strict, 404 uniforme, resposta só com o e-mail mascarado). O serviço é um dublê que registra
// as chamadas; a regra de negócio está em `platform-invitations.integration.test.ts`.

const ORIGIN = 'https://soadm.exemplo.test';
const WRITE = { origin: ORIGIN, 'x-soprei-app': 'admin' } as const;
const COMPANY = randomUUID();
const INVITATION = randomUUID();
const EMAIL = 'convidada.secreta@exemplo.com';

const VIEW: PlatformInvitationView = {
  id: INVITATION,
  emailMasked: 'c***@exemplo.com',
  role: 'OWNER',
  state: 'PENDING',
  invitedBy: 'platform',
  createdAt: new Date('2026-11-25T12:00:00.000Z'),
  expiresAt: new Date('2026-12-02T12:00:00.000Z'),
  lastSentAt: new Date('2026-11-25T12:00:00.000Z'),
  sendCount: 1,
};

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
  const known = (companyId: string): void => {
    if (world.failWith !== undefined) throw world.failWith;
    if (companyId !== COMPANY) throw new NotFoundError('Empresa não encontrada');
  };
  const invitations: PlatformInvitationRoutes = {
    listForCompany: (...args) => {
      calls.push({ method: 'list', args });
      known(args[0]);
      return Promise.resolve({ items: [VIEW], nextCursor: null });
    },
    createByPlatform: (...args) => {
      calls.push({ method: 'create', args });
      known(args[1]);
      return Promise.resolve(VIEW);
    },
    resendByPlatform: (...args) => {
      calls.push({ method: 'resend', args });
      known(args[1]);
      return Promise.resolve({ ...VIEW, sendCount: 2 });
    },
    revokeByPlatform: (...args) => {
      calls.push({ method: 'revoke', args });
      known(args[1]);
      return Promise.resolve();
    },
    createCompanyWithOwner: (...args) => {
      calls.push({ method: 'company', args });
      if (world.failWith !== undefined) return Promise.reject(world.failWith);
      return Promise.resolve({ companyId: CompanyId.parse(COMPANY), invitation: VIEW });
    },
  };
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
      invitations,
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

function writes(companyId: string): readonly (readonly [string, Record<string, unknown>])[] {
  return [
    ['/platform/companies', { name: 'Nova', slug: 'nova-e3b', ownerEmail: EMAIL, reason: 'OTHER' }],
    [
      `/platform/companies/${companyId}/invitations`,
      { email: EMAIL, role: 'OWNER', reason: 'OTHER' },
    ],
    [`/platform/companies/${companyId}/invitations/${INVITATION}/resend`, { reason: 'OTHER' }],
    [`/platform/companies/${companyId}/invitations/${INVITATION}/revoke`, { reason: 'OTHER' }],
  ];
}

describe('/platform convites e "Nova empresa" (spec 045, E3b)', () => {
  it('sem o cookie, com Bearer de plataforma ou de vínculo ou com o cookie da conta: 401; sem origem: 403; o serviço não é chamado', async () => {
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
        for (const [url, payload] of writes(COMPANY)) {
          const response = await world.app.inject({
            method: 'POST',
            url,
            headers: { ...WRITE, ...headers },
            payload,
          });
          assert.equal(response.statusCode, 401, url);
        }
        const list = await world.app.inject({
          url: `/platform/companies/${COMPANY}/invitations`,
          headers,
        });
        assert.equal(list.statusCode, 401);
      }
      for (const [url, payload] of writes(COMPANY)) {
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

  it('corpo strict: papel, e-mail, slug ou motivo inválidos e campo a mais = 400 sem chamar o serviço', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE, cookie: world.cookie };
      const base = `/platform/companies/${COMPANY}/invitations`;
      for (const [url, payload] of [
        [base, { email: EMAIL, role: 'DONO', reason: 'OTHER' }],
        [base, { email: 'nao-e-email', role: 'AGENT', reason: 'OTHER' }],
        [base, { email: EMAIL, role: 'AGENT', reason: 'CALOTE' }],
        [base, { email: EMAIL, role: 'AGENT', reason: 'OTHER', nota: 'x' }],
        [
          '/platform/companies',
          { name: 'X', slug: 'Slug Errado', ownerEmail: EMAIL, reason: 'OTHER' },
        ],
        [
          '/platform/companies',
          { name: '   ', slug: 'certo-e3b', ownerEmail: EMAIL, reason: 'OTHER' },
        ],
        ['/platform/companies', { name: 'X', slug: 'certo-e3b', reason: 'OTHER' }],
        [`${base}/${INVITATION}/revoke`, {}],
      ] as const) {
        const response = await world.app.inject({ method: 'POST', url, headers, payload });
        assert.equal(response.statusCode, 400, `${url} ${JSON.stringify(payload)}`);
      }
      const badLimit = await world.app.inject({
        url: `${base}?limit=51`,
        headers: { cookie: world.cookie },
      });
      assert.equal(badLimit.statusCode, 400);
      assert.deepEqual(world.calls, []);
    } finally {
      await world.app.close();
    }
  });

  it('caminho feliz: 201 com o e-mail só mascarado; 200 no reenvio; 204 na revogação; o corpo chega ao serviço; 404 e 409 passam como vieram', async () => {
    const world = await setup();
    try {
      const headers = { ...WRITE, cookie: world.cookie };
      const bodies: string[] = [];
      const created = await world.app.inject({
        method: 'POST',
        url: '/platform/companies',
        headers,
        payload: {
          name: ' Padaria ',
          slug: 'padaria-e3b',
          ownerEmail: EMAIL,
          reason: 'OWNER_REQUEST',
        },
      });
      bodies.push(created.body);
      assert.equal(created.statusCode, 201);
      assert.equal(created.json<{ companyId: string }>().companyId, COMPANY);
      const invite = await world.app.inject({
        method: 'POST',
        url: `/platform/companies/${COMPANY}/invitations`,
        headers,
        payload: { email: EMAIL, role: 'OWNER', reason: 'OTHER' },
      });
      bodies.push(invite.body);
      assert.equal(invite.statusCode, 201);
      assert.equal(invite.json<{ emailMasked: string }>().emailMasked, 'c***@exemplo.com');
      const list = await world.app.inject({
        url: `/platform/companies/${COMPANY}/invitations`,
        headers: { cookie: world.cookie },
      });
      bodies.push(list.body);
      assert.equal(list.statusCode, 200);
      assert.equal(list.headers['cache-control'], 'no-store');
      const resend = await world.app.inject({
        method: 'POST',
        url: `/platform/companies/${COMPANY}/invitations/${INVITATION}/resend`,
        headers,
        payload: { reason: 'OTHER' },
      });
      bodies.push(resend.body);
      assert.equal(resend.statusCode, 200);
      const revoke = await world.app.inject({
        method: 'POST',
        url: `/platform/companies/${COMPANY}/invitations/${INVITATION}/revoke`,
        headers,
        payload: { reason: 'ABUSE' },
      });
      assert.equal(revoke.statusCode, 204);
      for (const body of bodies) assert.ok(!body.includes(EMAIL), 'e-mail inteiro na resposta');

      const company = world.calls.find((call) => call.method === 'company');
      assert.deepEqual(company?.args.slice(1), [
        { name: 'Padaria', slug: 'padaria-e3b', ownerEmail: EMAIL },
        'OWNER_REQUEST',
      ]);
      const create = world.calls.find((call) => call.method === 'create');
      assert.deepEqual(create?.args.slice(1), [COMPANY, { email: EMAIL, role: 'OWNER' }, 'OTHER']);

      const missing = await world.app.inject({
        method: 'POST',
        url: `/platform/companies/${randomUUID()}/invitations/${INVITATION}/revoke`,
        headers,
        payload: { reason: 'OTHER' },
      });
      assert.equal(missing.statusCode, 404);
      world.failWith = new ConflictError('x', { code: 'SLUG_TAKEN' });
      const taken = await world.app.inject({
        method: 'POST',
        url: '/platform/companies',
        headers,
        payload: { name: 'X', slug: 'padaria-e3b', ownerEmail: EMAIL, reason: 'OTHER' },
      });
      assert.equal(taken.statusCode, 409);
      assert.equal(taken.json<{ error: { code: string } }>().error.code, 'SLUG_TAKEN');
    } finally {
      await world.app.close();
    }
  });
});
