import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Redis } from 'ioredis';
import { AttendanceService } from '../../../application/attendance/attendance.service.js';
import type { AccountService } from '../../../application/auth/account.service.js';
import type { InvitationService } from '../../../application/invitations/invitation.service.js';
import { CompanyService } from '../../../application/companies/company.service.js';
import { Result } from '../../../shared/types/index.js';
import { isRateLimitProfile } from '../../../shared/rate-limit/profiles.js';
import {
  REQUIRED_AUTH_KIND,
  REQUIRED_PERMISSION,
  requirePermission,
  requireMembership,
} from '../../../presentation/common/auth.hooks.js';
import { PERMISSIONS } from '../../../domain/index.js';
import { rateLimitProfile } from '../../../presentation/common/rate-limit.js';
import { buildTestAuth } from '../../../test-support/in-memory-auth.js';
import { captureLogs, type LogLine } from '../../../test-support/log-capture.js';
import { InMemoryAttendanceStore } from '../../../test-support/in-memory-attendance.js';
import { InMemoryCompanyRepository } from '../../../test-support/in-memory-company.repository.js';
import { createLogger } from '../../logger/logger.js';
import { createMetrics } from '../../metrics/index.js';
import { MockLlmProvider } from '../../external-apis/llm/mock-llm.provider.js';
import {
  type RateLimitProfiles,
  rateLimitProfilesFromConfig,
  registerRateLimit,
} from './rate-limit.js';
import { buildServer } from '../server.js';

const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

const ALL_UP = {
  database: () => Promise.resolve(Result.ok(undefined)),
  redis: () => Promise.resolve(Result.ok(undefined)),
};

const PROFILES: RateLimitProfiles = {
  public: { max: 1, windowSeconds: 60 },
  admin: { max: 1, windowSeconds: 60 },
  webhook: { max: 1, windowSeconds: 60 },
  login: { max: 1, windowSeconds: 60 },
  refresh: { max: 1, windowSeconds: 60 },
};

describe('sem o parâmetro rateLimit', () => {
  it('buildServer não limita nada: muito acima de qualquer perfil, tudo responde 200', async () => {
    const app = buildServer({ logger, readiness: ALL_UP });
    void app.register((instance, _options, done) => {
      instance.get('/test/livre', () => ({ ok: true }));
      done();
    });
    await app.ready();
    try {
      for (let i = 0; i < 300; i += 1) {
        const response = await app.inject({ method: 'GET', url: '/test/livre' });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['x-ratelimit-limit'], undefined);
      }
    } finally {
      await app.close();
    }
  });
});

/** Problema da declaração de permissão de uma rota de tenant (spec 008), ou `undefined` se está certa. */
function permissionProblem(permissions: readonly unknown[]): string | undefined {
  const declared = permissions.filter((permission) => permission !== undefined);
  if (declared.length !== 1) return 'deve declarar requirePermission(...)';
  if (!(PERMISSIONS as readonly unknown[]).includes(declared[0])) {
    return 'declara uma permissão desconhecida';
  }
  return undefined;
}

/**
 * Rotas de tenant que seguem funcionando com a assinatura inativa (spec 031): leitura é sempre liberada;
 * entre as escritas, só a gestão de equipe, desconectar o canal e (GET) o próprio `entitlements`.
 */
const EXEMPT_ROUTES: readonly string[] = [
  'GET /admin/companies/:companyId/entitlements',
  'DELETE /admin/companies/:companyId/channel',
  'DELETE /admin/companies/:companyId/knowledge/documents/:documentId',
  'POST /admin/companies/:companyId/invitations',
  'POST /admin/companies/:companyId/invitations/:invitationId/resend',
  'DELETE /admin/companies/:companyId/invitations/:invitationId',
  'POST /admin/companies/:companyId/memberships',
  'PATCH /admin/companies/:companyId/memberships/:membershipId',
  'POST /admin/companies/:companyId/memberships/:membershipId/password',
  'GET /admin/companies/:companyId/invitations',
  'GET /admin/companies/:companyId/memberships',
];

/** Problema da política de assinatura de uma rota de tenant (spec 031), ou `undefined` se está certa. */
function entitlementPolicyProblem(route: {
  readonly url: string;
  readonly method: string | string[];
  readonly config: Record<string, unknown>;
}): string | undefined {
  const tenant = route.url.startsWith('/admin/companies/:companyId/');
  if (!tenant) return undefined;
  const module = route.url.includes('/schedule/')
    ? 'schedule'
    : route.url.includes('/inventory/')
      ? 'inventory'
      : undefined;
  if (module !== undefined && route.config.requiresModule !== module) {
    return `rota ${module}/* deve declarar requireModule("${module}")`;
  }
  if (module === undefined && route.config.requiresModule !== undefined) {
    return 'declara um módulo que a rota não usa';
  }
  return undefined;
}

describe('inventário: o verificador da política de assinatura (spec 031)', () => {
  it('falha para rota schedule/inventory sem módulo e para módulo em rota que não é de módulo', () => {
    const base = { method: 'POST', config: {} };
    assert.match(
      entitlementPolicyProblem({
        ...base,
        url: '/admin/companies/:companyId/inventory/products',
      }) ?? '',
      /deve declarar requireModule/,
    );
    assert.match(
      entitlementPolicyProblem({ ...base, url: '/admin/companies/:companyId/schedule/services' }) ??
        '',
      /deve declarar requireModule/,
    );
    assert.equal(
      entitlementPolicyProblem({
        ...base,
        url: '/admin/companies/:companyId/inventory/products',
        config: { requiresModule: 'inventory' },
      }),
      undefined,
    );
    assert.match(
      entitlementPolicyProblem({
        ...base,
        url: '/admin/companies/:companyId/persona',
        config: { requiresModule: 'schedule' },
      }) ?? '',
      /não usa/,
    );
  });
});

describe('inventário: o verificador de permissão de rota de tenant (spec 008)', () => {
  it('falha para rota que só declara requireMembership, para dois hooks e para permissão desconhecida', async () => {
    const app = buildServer({ logger, readiness: ALL_UP });
    const seen = new Map<string, unknown[]>();
    app.addHook('onRoute', (route) => {
      const hooks: unknown = route.onRequest;
      const list: unknown[] = Array.isArray(hooks) ? hooks : hooks === undefined ? [] : [hooks];
      seen.set(
        route.url,
        list.map((hook) => (hook as Record<symbol, unknown> | undefined)?.[REQUIRED_PERMISSION]),
      );
    });
    app.get(
      '/admin/companies/:companyId/so-requireuser',
      { onRequest: requireMembership({ companyParam: 'companyId' }) },
      () => ({}),
    );
    app.get(
      '/admin/companies/:companyId/com-permissao',
      { onRequest: requirePermission('membership:read', { companyParam: 'companyId' }) },
      () => ({}),
    );
    await app.ready();
    await app.close();
    const onlyMembership = seen.get('/admin/companies/:companyId/so-requireuser') ?? [];
    const withPermission = seen.get('/admin/companies/:companyId/com-permissao') ?? [];
    assert.match(permissionProblem(onlyMembership) ?? '', /deve declarar requirePermission/);
    assert.equal(permissionProblem(withPermission), undefined);
    assert.match(permissionProblem(['a', 'b']) ?? '', /deve declarar/);
    assert.match(permissionProblem(['membership:destroy']) ?? '', /desconhecida/);
  });
});

describe('inventário de rotas: toda rota declara o seu perfil', () => {
  it('toda rota tem perfil declarado; /admin é admin e só /health e /metrics ficam sem limite', async () => {
    const companies = new InMemoryCompanyRepository();
    const store = new InMemoryAttendanceStore();
    const metrics = createMetrics();
    const testAuth = buildTestAuth({ logger, companies });
    const app = buildServer({
      logger,
      readiness: ALL_UP,
      metrics,
      metricsToken: 'm'.repeat(32),
      whatsapp: {
        appSecret: 'a'.repeat(32),
        verifyToken: 'v'.repeat(32),
        intake: { accept: () => Promise.resolve({ enqueued: 0, discarded: 0, failed: 0 }) },
      },
      auth: testAuth.service,
      membershipAdmin: testAuth.membershipAdmin,
      // Contas globais (spec 017/021): as rotas do navegador também declaram o perfil.
      accounts: {
        service: { drain: () => Promise.resolve() } as unknown as AccountService,
        origin: 'http://localhost:5174',
        secure: false,
        // Convites (spec 025): as rotas autenticadas e as três públicas entram no inventário.
        invitations: { drain: () => Promise.resolve() } as unknown as InvitationService,
      },
      admin: {
        companies: new CompanyService(companies),
        onboarding: {
          get: () => Promise.reject(new Error('inventário')),
          setDismissed: () => Promise.reject(new Error('inventário')),
        },
        channel: {
          getState: () => Promise.reject(new Error('inventário')),
          connect: () => Promise.reject(new Error('inventário')),
          disconnect: () => Promise.reject(new Error('inventário')),
          embeddedSignup: () => Promise.reject(new Error('inventário')),
        },
        channelSetup: {
          appId: '1',
          embeddedSignupConfigId: '2',
          graphApiVersion: 'v26.0',
          manualConnect: false,
        },
        sample: {
          load: () => Promise.reject(new Error('inventário')),
          remove: () => Promise.reject(new Error('inventário')),
        },
        inventory: {
          list: () => Promise.reject(new Error('inventário')),
          create: () => Promise.reject(new Error('inventário')),
          update: () => Promise.reject(new Error('inventário')),
          adjust: () => Promise.reject(new Error('inventário')),
          movements: () => Promise.reject(new Error('inventário')),
          importRows: () => Promise.reject(new Error('inventário')),
        },
        scheduleSample: {
          load: () => Promise.reject(new Error('inventário')),
          remove: () => Promise.reject(new Error('inventário')),
        },
        schedule: {
          getSettings: () => Promise.reject(new Error('inventário')),
          updateSettings: () => Promise.reject(new Error('inventário')),
          listResources: () => Promise.reject(new Error('inventário')),
          createResource: () => Promise.reject(new Error('inventário')),
          updateResource: () => Promise.reject(new Error('inventário')),
          setRules: () => Promise.reject(new Error('inventário')),
          listServices: () => Promise.reject(new Error('inventário')),
          createService: () => Promise.reject(new Error('inventário')),
          updateService: () => Promise.reject(new Error('inventário')),
          availability: () => Promise.reject(new Error('inventário')),
          listAppointments: () => Promise.reject(new Error('inventário')),
          createAppointment: () => Promise.reject(new Error('inventário')),
          updateAppointment: () => Promise.reject(new Error('inventário')),
          createBlocks: () => Promise.reject(new Error('inventário')),
          cancelBlock: () => Promise.reject(new Error('inventário')),
          view: () => Promise.reject(new Error('inventário')),
          viewMany: () => Promise.reject(new Error('inventário')),
        },
        knowledge: {
          list: () => Promise.reject(new Error('inventário')),
          create: () => Promise.reject(new Error('inventário')),
          delete: () => Promise.reject(new Error('inventário')),
        },
        notifications: {
          list: () => Promise.reject(new Error('inventário')),
          countOpen: () => Promise.reject(new Error('inventário')),
          resolve: () => Promise.reject(new Error('inventário')),
          openHandoffs: () => Promise.reject(new Error('inventário')),
        },
        attendance: new AttendanceService({
          companies,
          conversations: store.conversations,
          messages: store.messages,
          unitOfWork: store,
          llm: new MockLlmProvider(),
          logger,
          options: { llmTimeoutMs: 1_000, inFlightTimeoutMs: 60_000 },
        }),
      },
    });
    const routes: {
      url: string;
      method: string | string[];
      config: Record<string, unknown>;
      authKinds: unknown[];
      permissions: unknown[];
    }[] = [];
    app.addHook('onRoute', (route) => {
      const hooks: unknown = route.onRequest;
      const list: unknown[] = Array.isArray(hooks) ? hooks : hooks === undefined ? [] : [hooks];
      routes.push({
        url: route.url,
        method: route.method,
        config: { ...(route.config as Record<string, unknown> | undefined) },
        authKinds: list.map(
          (hook) => (hook as Record<symbol, unknown> | undefined)?.[REQUIRED_AUTH_KIND],
        ),
        permissions: list.map(
          (hook) => (hook as Record<symbol, unknown> | undefined)?.[REQUIRED_PERMISSION],
        ),
      });
    });
    await app.ready();
    await app.close();

    assert.ok(routes.length >= 11, `rotas vistas: ${String(routes.length)}`);
    const urls = new Set(routes.map((route) => route.url));
    for (const expected of [
      '/health',
      '/health/ready',
      '/metrics',
      '/admin/companies',
      '/admin/companies/:companyId/memberships',
      '/admin/companies/:companyId/audit-events',
      '/admin/companies/:companyId/channel',
      '/admin/companies/:companyId/channel/embedded-signup',
      '/admin/companies/:companyId/channel/setup',
      '/admin/companies/:companyId/persona',
      '/admin/companies/:companyId/entitlements',
      '/admin/companies/:companyId/onboarding',
      '/admin/companies/:companyId/knowledge/documents',
      '/admin/companies/:companyId/knowledge/documents/:documentId',
      '/admin/companies/:companyId/knowledge/sample',
      '/admin/companies/:companyId/inventory/products',
      '/admin/companies/:companyId/inventory/products/import',
      '/admin/companies/:companyId/inventory/products/:productId',
      '/admin/companies/:companyId/inventory/products/:productId/adjustments',
      '/admin/companies/:companyId/inventory/products/:productId/movements',
      '/admin/companies/:companyId/schedule/settings',
      '/admin/companies/:companyId/schedule/resources',
      '/admin/companies/:companyId/schedule/resources/:resourceId',
      '/admin/companies/:companyId/schedule/resources/:resourceId/rules',
      '/admin/companies/:companyId/schedule/services',
      '/admin/companies/:companyId/schedule/services/:serviceId',
      '/admin/companies/:companyId/schedule/availability',
      '/admin/companies/:companyId/schedule/appointments',
      '/admin/companies/:companyId/schedule/appointments/:appointmentId',
      '/admin/companies/:companyId/schedule/blocks',
      '/admin/companies/:companyId/schedule/blocks/:blockId',
      '/admin/companies/:companyId/schedule/sample',
      '/admin/companies/:companyId/notifications',
      '/admin/companies/:companyId/notifications/summary',
      '/admin/companies/:companyId/notifications/:notificationId/resolve',
      '/admin/companies/:companyId/memberships/:membershipId',
      '/admin/companies/:companyId/memberships/:membershipId/password',
      '/auth/login',
      '/auth/platform/login',
      '/auth/refresh',
      '/auth/logout',
      '/auth/logout-all',
      '/auth/me',
      '/auth/password',
      '/auth/password-reset/request',
      '/auth/password-reset/confirm',
      '/auth/invitations/preview',
      '/auth/invitations/accept',
      '/auth/invitations/accept-new',
      '/admin/companies/:companyId/invitations',
      '/admin/companies/:companyId/invitations/:invitationId/resend',
      '/admin/companies/:companyId/invitations/:invitationId',
      '/webhooks/whatsapp',
    ]) {
      assert.ok(
        [...urls].some((url) => url.startsWith(expected)),
        `rota ${expected} registrada`,
      );
    }

    // Spec 015: as três rotas do canal existem e exigem a permissão certa (leitura x gestão).
    const channelRoutes = routes.filter(
      (route) => route.url === '/admin/companies/:companyId/channel',
    );
    assert.deepEqual(
      channelRoutes
        .map((route) => `${String(route.method)}:${String(route.permissions.find(Boolean))}`)
        .sort(),
      ['DELETE:channel:manage', 'GET:channel:read', 'HEAD:channel:read', 'PUT:channel:manage']
        .filter((entry) => channelRoutes.some((route) => entry.startsWith(String(route.method))))
        .sort(),
    );

    const signup = routes.filter(
      (route) => route.url === '/admin/companies/:companyId/channel/embedded-signup',
    );
    assert.deepEqual(
      signup.map((route) => `${String(route.method)}:${String(route.permissions.find(Boolean))}`),
      ['POST:channel:manage'],
    );

    // Spec 023: setup do Embedded Signup e persona têm a permissão certa, por método.
    const declared = (url: string): string[] =>
      routes
        .filter((route) => route.url === url)
        .flatMap((route) =>
          [route.method]
            .flat()
            .map((method) => method + ':' + String(route.permissions.find(Boolean))),
        )
        .filter((entry) => !entry.startsWith('HEAD'))
        .sort();
    assert.deepEqual(declared('/admin/companies/:companyId/channel/setup'), ['GET:channel:manage']);
    // Spec 025: convites reaproveitam as permissões da gestão de membros (nenhuma permissão nova).
    assert.deepEqual(declared('/admin/companies/:companyId/invitations'), [
      'GET:membership:read',
      'POST:membership:manage',
    ]);
    assert.deepEqual(declared('/admin/companies/:companyId/invitations/:invitationId/resend'), [
      'POST:membership:manage',
    ]);
    assert.deepEqual(declared('/admin/companies/:companyId/invitations/:invitationId'), [
      'DELETE:membership:manage',
    ]);
    // Spec 026: a base de conhecimento tem a permissão própria.
    assert.deepEqual(declared('/admin/companies/:companyId/knowledge/documents'), [
      'GET:knowledge:manage',
      'POST:knowledge:manage',
    ]);
    assert.deepEqual(declared('/admin/companies/:companyId/knowledge/documents/:documentId'), [
      'DELETE:knowledge:manage',
    ]);
    assert.deepEqual(declared('/admin/companies/:companyId/knowledge/sample'), [
      'DELETE:knowledge:manage',
      'POST:knowledge:manage',
    ]);
    assert.deepEqual(declared('/admin/companies/:companyId/inventory/products'), [
      'GET:inventory:manage',
      'POST:inventory:manage',
    ]);
    assert.deepEqual(declared('/admin/companies/:companyId/inventory/products/import'), [
      'POST:inventory:manage',
    ]);
    assert.deepEqual(declared('/admin/companies/:companyId/inventory/products/:productId'), [
      'PATCH:inventory:manage',
    ]);
    assert.deepEqual(
      declared('/admin/companies/:companyId/inventory/products/:productId/adjustments'),
      ['POST:inventory:manage'],
    );
    assert.deepEqual(
      declared('/admin/companies/:companyId/inventory/products/:productId/movements'),
      ['GET:inventory:manage'],
    );
    // Spec 039: reativar a IA numa conversa pausada (OWNER, ADMIN e AGENT).
    assert.deepEqual(
      declared('/admin/companies/:companyId/conversations/:conversationId/ai/resume'),
      ['POST:conversation:takeover'],
    );
    // Spec 038: notificações; todos leem, a resolução é de OWNER, ADMIN e AGENT.
    assert.deepEqual(declared('/admin/companies/:companyId/notifications'), [
      'GET:notification:read',
    ]);
    assert.deepEqual(declared('/admin/companies/:companyId/notifications/summary'), [
      'GET:notification:read',
    ]);
    assert.deepEqual(
      declared('/admin/companies/:companyId/notifications/:notificationId/resolve'),
      ['POST:notification:resolve'],
    );
    // Spec 027: a agenda tem três permissões (ler, gerenciar agendamentos, configurar).
    const schedule = '/admin/companies/:companyId/schedule';
    assert.deepEqual(declared(schedule + '/settings'), [
      'GET:schedule:read',
      'PUT:schedule:configure',
    ]);
    assert.deepEqual(declared(schedule + '/resources'), [
      'GET:schedule:read',
      'POST:schedule:configure',
    ]);
    assert.deepEqual(declared(schedule + '/resources/:resourceId'), ['PATCH:schedule:configure']);
    assert.deepEqual(declared(schedule + '/resources/:resourceId/rules'), [
      'PUT:schedule:configure',
    ]);
    assert.deepEqual(declared(schedule + '/services'), [
      'GET:schedule:read',
      'POST:schedule:configure',
    ]);
    assert.deepEqual(declared(schedule + '/services/:serviceId'), ['PATCH:schedule:configure']);
    assert.deepEqual(declared(schedule + '/availability'), ['GET:schedule:read']);
    assert.deepEqual(declared(schedule + '/appointments'), [
      'GET:schedule:read',
      'POST:schedule:manage',
    ]);
    assert.deepEqual(declared(schedule + '/appointments/:appointmentId'), [
      'PATCH:schedule:manage',
    ]);
    assert.deepEqual(declared(schedule + '/blocks'), ['POST:schedule:manage']);
    assert.deepEqual(declared(schedule + '/blocks/:blockId'), ['DELETE:schedule:manage']);
    assert.deepEqual(declared(schedule + '/sample'), [
      'DELETE:schedule:configure',
      'POST:schedule:configure',
    ]);
    assert.deepEqual(declared('/admin/companies/:companyId/onboarding'), [
      'GET:onboarding:manage',
      'PUT:onboarding:manage',
    ]);
    assert.deepEqual(declared('/admin/companies/:companyId/persona'), [
      'GET:persona:manage',
      'PUT:persona:manage',
    ]);

    // Spec 031: `entitlements` é lido por qualquer papel (conversation:read) e é isento da política de assinatura.
    assert.deepEqual(declared('/admin/companies/:companyId/entitlements'), [
      'GET:conversation:read',
    ]);
    // Política de assinatura (spec 031): toda rota `schedule/*` e `inventory/*` declara o módulo; toda escrita de
    // tenant é barrada por assinatura inativa, salvo a lista curta e declarada de exceções.
    for (const route of routes) {
      const problem = entitlementPolicyProblem(route);
      assert.equal(problem, undefined, `${String(route.method)} ${route.url}: ${String(problem)}`);
    }
    const exempt = routes
      .filter((route) => route.config.subscriptionExempt === true)
      .flatMap((route) => [route.method].flat().map((method) => method + ' ' + route.url))
      .filter((entry) => !entry.startsWith('HEAD'))
      .sort();
    assert.deepEqual(exempt, [...EXEMPT_ROUTES].sort());

    // Regra do projeto: rota nova declara o perfil (cair em `public` por omissão é só a rede de
    // segurança). Só a infraestrutura fica sem limite, com opt-out explícito.
    const infrastructure = new Set(['/health', '/health/ready', '/metrics']);
    for (const route of routes) {
      const label = `${String(route.method)} ${route.url}`;
      // `config.rateLimit` só pode ser `false` (opt-out) ou ausente: o limite por rota (objeto) é
      // ignorado pelo hook da raiz, então declarar um daria falsa sensação de proteção.
      assert.ok(
        route.config.rateLimit === undefined || route.config.rateLimit === false,
        `${label} declara config.rateLimit como objeto (só false ou ausente; use rateLimitProfile)`,
      );
      if (infrastructure.has(route.url)) {
        assert.equal(route.config.rateLimit, false, `${label} deve ser opt-out explícito`);
      } else if (route.url.startsWith('/webhooks/')) {
        // O primeiro endpoint público (spec 011): perfil `webhook`, nunca o `public` por omissão.
        assert.equal(
          route.config.rateLimitProfile,
          'webhook',
          `${label} deve ser do perfil webhook`,
        );
      } else if (route.url.startsWith('/admin/')) {
        assert.equal(route.config.rateLimitProfile, 'admin', `${label} deve ser do perfil admin`);
        // Spec 007: toda rota /admin declara a espécie de identidade que exige. CRUD de empresas
        // é do administrador da plataforma; as rotas de uma empresa (`:companyId`) são do usuário.
        const expected = route.url.startsWith('/admin/companies/:companyId')
          ? 'membership'
          : 'platform';
        assert.ok(
          route.authKinds.includes(expected),
          `${label} deve declarar ${expected === 'membership' ? 'requireMembership()' : 'requirePlatform()'}`,
        );
        if (expected === 'membership') {
          // Spec 008: nenhuma rota de tenant sem permissão explícita (e a permissão existe).
          assert.equal(permissionProblem(route.permissions), undefined, label);
        }
      } else if (route.url.startsWith('/auth/')) {
        const expected: Record<string, string> = {
          '/auth/login': 'login',
          '/auth/platform/login': 'login',
          '/auth/refresh': 'refresh',
          '/auth/logout': 'refresh',
          '/auth/logout-all': 'admin',
          '/auth/me': 'admin',
          '/auth/password': 'login',
          '/auth/register': 'login',
          '/auth/resend-verification': 'login',
          '/auth/verify-email': 'login',
          '/auth/session': 'admin',
          '/auth/password-reset/request': 'login',
          '/auth/password-reset/confirm': 'login',
          // Spec 025: rotas públicas de convite, todas no perfil `login` (fail-closed).
          '/auth/invitations/preview': 'login',
          '/auth/invitations/accept': 'login',
          '/auth/invitations/accept-new': 'login',
        };
        assert.equal(route.config.rateLimitProfile, expected[route.url], `${label} perfil`);
      } else {
        assert.ok(
          isRateLimitProfile(route.config.rateLimitProfile),
          `${label} sem perfil declarado`,
        );
      }
    }
  });
});

describe('registerRateLimit', () => {
  it('recusa perfil com max ou janela inválidos (nunca registra limite sem sentido)', () => {
    const app = buildServer({ logger, readiness: ALL_UP });
    const redis = {} as Redis;
    for (const profiles of [
      { ...PROFILES, admin: { max: 0, windowSeconds: 60 } },
      { ...PROFILES, webhook: { max: 1, windowSeconds: 0 } },
      { ...PROFILES, public: { max: 1.5, windowSeconds: 60 } },
    ]) {
      assert.throws(() => {
        registerRateLimit(app, { redis, profiles });
      }, RangeError);
    }
  });

  it('rateLimitProfilesFromConfig lê os números de cada perfil da config', () => {
    assert.deepEqual(
      rateLimitProfilesFromConfig({
        RATE_LIMIT_PUBLIC_MAX: 1,
        RATE_LIMIT_PUBLIC_WINDOW_SECONDS: 2,
        RATE_LIMIT_ADMIN_MAX: 3,
        RATE_LIMIT_ADMIN_WINDOW_SECONDS: 4,
        RATE_LIMIT_WEBHOOK_MAX: 5,
        RATE_LIMIT_WEBHOOK_WINDOW_SECONDS: 6,
        RATE_LIMIT_LOGIN_MAX: 7,
        RATE_LIMIT_LOGIN_WINDOW_SECONDS: 8,
        RATE_LIMIT_REFRESH_MAX: 9,
        RATE_LIMIT_REFRESH_WINDOW_SECONDS: 10,
      }),
      {
        public: { max: 1, windowSeconds: 2 },
        admin: { max: 3, windowSeconds: 4 },
        webhook: { max: 5, windowSeconds: 6 },
        login: { max: 7, windowSeconds: 8 },
        refresh: { max: 9, windowSeconds: 10 },
      },
    );
  });
});

describe('falha ao registrar o plugin', () => {
  it('app.ready() rejeita: o servidor nunca sobe sem o limiter', async () => {
    const app = buildServer({
      logger,
      readiness: ALL_UP,
      rateLimit: {
        // O plugin chama `defineCommand` ao montar o store: aqui ele lança.
        redis: {
          defineCommand(): void {
            throw new Error('falha de teste no registro');
          },
        } as unknown as Redis,
        profiles: PROFILES,
      },
    });
    await assert.rejects(async () => {
      await app.ready();
    }, /falha de teste no registro/);
    await app.close().catch(() => undefined);
  });
});

describe('log do fail-open não vaza o IP', () => {
  const IP = '203.0.113.9';
  const PREFIX = 'soprei:ratelimit:';

  /** Client de mentira cujo script sempre falha com um erro no formato do ioredis (`command.args`). */
  function failingCompany(makeError: () => Error): Redis {
    const client = {
      defineCommand(name: string): void {
        (client as unknown as Record<string, unknown>)[name] = (...args: unknown[]): void => {
          const callback = args.at(-1) as (error: Error) => void;
          const error = makeError();
          (error as Error & { command?: unknown }).command = {
            name: 'rateLimit',
            args: [`${PREFIX}webhook:${IP}`, 60_000],
          };
          callback(error);
        };
      },
    };
    return client as unknown as Redis;
  }

  async function requestWith(makeError: () => Error): Promise<{ raw: string; lines: LogLine[] }> {
    const logs = captureLogs();
    const app = buildServer({
      logger: logs.logger,
      readiness: ALL_UP,
      rateLimit: { redis: failingCompany(makeError), profiles: PROFILES, keyPrefix: PREFIX },
    });
    void app.register((instance, _options, done) => {
      instance.get('/test/webhook', { config: rateLimitProfile('webhook') }, () => ({ ok: true }));
      done();
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/test/webhook',
        remoteAddress: IP,
      });
      assert.equal(response.statusCode, 200, 'fail-open');
    } finally {
      await app.close();
    }
    return { raw: logs.raw(), lines: logs.lines() };
  }

  it('erro com command.args (AbortError do ioredis): nem o IP nem o prefixo aparecem em log', async () => {
    const { raw, lines } = await requestWith(() => {
      const error = new Error('Command aborted due to connection close');
      error.name = 'AbortError';
      return error;
    });
    assert.ok(!raw.includes(IP), 'IP no log');
    assert.ok(!raw.includes(PREFIX), 'prefixo no log');
    assert.ok(!raw.includes('args'), 'command.args no log');
    const line = lines.find((entry) => String(entry.msg).includes('fail-open'));
    assert.ok(line);
    assert.equal(line.level, 50);
    assert.equal(line.errName, 'AbortError');
    assert.equal(line.errMessage, 'Command aborted due to connection close');
    assert.equal(line.err, undefined);
  });

  it('mensagem que cita a chave (ReplyError do servidor) não é logada; sobra o nome e o code', async () => {
    const { raw, lines } = await requestWith(() => {
      const error = new Error(`ERR falha em ${PREFIX}webhook:${IP}`);
      error.name = 'ReplyError';
      (error as Error & { code?: string }).code = 'ERR';
      return error;
    });
    assert.ok(!raw.includes(IP), 'IP no log');
    assert.ok(!raw.includes(PREFIX), 'prefixo no log');
    const line = lines.find((entry) => String(entry.msg).includes('fail-open'));
    assert.ok(line);
    assert.equal(line.errName, 'ReplyError');
    assert.equal(line.errCode, 'ERR');
    assert.equal(line.errMessage, undefined);
  });
});
