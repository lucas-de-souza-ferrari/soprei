import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountService } from '../../application/auth/account.service.js';
import type { BillingOverview } from '../../application/billing/billing.service.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { ForbiddenError, UnauthorizedError } from '../../shared/errors/index.js';
import { Result } from '../../shared/types/index.js';
import { captureLogs } from '../../test-support/log-capture.js';

const ORIGIN = 'http://localhost:5174';
const SECRET = 'a'.repeat(43);
const ACCOUNT_ID = '01900000-0000-7000-8000-0000000000a1';

const OVERVIEW: BillingOverview = {
  subscription: {
    planCode: 'ESSENTIAL',
    planName: 'Essencial',
    cycle: 'MONTHLY',
    agenda: true,
    stock: false,
    status: 'TRIAL',
    access: 'ok',
    currentPeriodStart: new Date('2026-11-10T12:00:00Z'),
    currentPeriodEnd: new Date('2026-11-17T12:00:00Z'),
    graceEndsAt: new Date('2026-11-22T12:00:00Z'),
    trialEndsAt: new Date('2026-11-17T12:00:00Z'),
    cancelAtPeriodEnd: false,
    pendingChange: null,
    maxCompanies: 1,
    companies: 1,
    whatsappBillingMode: 'CUSTOMER_PAYS_META',
    whatsappNotice: 'NOT_INCLUDED',
  },
  usage: {
    windowStart: new Date('2026-11-10T12:00:00Z'),
    windowEnd: new Date('2026-12-10T12:00:00Z'),
    tokens: { used: 10, limit: 300_000 },
    replies: { used: 1, limit: 800 },
    metaEstimate: { isEstimate: true, milliCents: 3_500 },
  },
  orders: [],
  catalog: [],
  trial: { available: false, days: 7 },
};

function setup(billing: boolean) {
  const seen: { overview: string[]; me: string[] } = { overview: [], me: [] };
  const accounts = {
    me: (secret: string) => {
      seen.me.push(secret);
      return secret === SECRET
        ? Promise.resolve({ id: ACCOUNT_ID, email: 'x@exemplo.test', selectedCompanyId: null })
        : Promise.reject(new UnauthorizedError());
    },
    tenantIdentity: () => Promise.resolve(null),
    drain: () => Promise.resolve(),
  } as unknown as AccountService;
  const app = buildServer({
    logger: captureLogs().logger,
    readiness: {
      database: () => Promise.resolve(Result.ok(undefined)),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    accounts: { service: accounts, origin: ORIGIN, secure: false },
    ...(billing
      ? {
          billing: {
            service: {
              overview: (accountId: string) => {
                seen.overview.push(accountId);
                return Promise.resolve(OVERVIEW);
              },
            },
            entitlements: { forCompany: () => Promise.reject(new Error('n/a')) },
          },
        }
      : {}),
  });
  return { app, seen };
}

describe('GET /account/billing (spec 031, E1)', () => {
  it('com BILLING_ENABLED=false a rota não existe (404), mesmo com cookie válido', async () => {
    const { app } = setup(false);
    const response = await app.inject({
      method: 'GET',
      url: '/account/billing',
      headers: { cookie: `soprei_session=${SECRET}` },
    });
    assert.equal(response.statusCode, 404);
    await app.close();
  });

  it('sem cookie é 401; com cookie devolve a cobrança da conta da sessão, sem cache, datas em ISO', async () => {
    const { app, seen } = setup(true);
    assert.equal((await app.inject({ method: 'GET', url: '/account/billing' })).statusCode, 401);
    const response = await app.inject({
      method: 'GET',
      url: '/account/billing?accountId=01900000-0000-7000-8000-0000000000ff',
      headers: { cookie: `soprei_session=${SECRET}` },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    // A conta vem SÓ do cookie: o accountId da query é ignorado.
    assert.deepEqual(seen.overview, [ACCOUNT_ID]);
    const body = JSON.parse(response.body) as {
      checkoutEnabled: boolean;
      checkoutHost: string | null;
      subscription: {
        currentPeriodEnd: string;
        graceEndsAt: string;
        whatsappNotice: string;
        pendingChange: unknown;
      };
      usage: { metaEstimate: { isEstimate: boolean } };
    };
    assert.equal(body.subscription.currentPeriodEnd, '2026-11-17T12:00:00.000Z');
    assert.equal(body.subscription.graceEndsAt, '2026-11-22T12:00:00.000Z');
    assert.equal(body.subscription.whatsappNotice, 'NOT_INCLUDED');
    assert.equal(body.usage.metaEstimate.isEstimate, true);
    // Sem o checkout ligado a tela não oferece pagar; a troca agendada (nenhuma) vem na leitura.
    assert.equal(body.checkoutEnabled, false);
    assert.equal(body.checkoutHost, null);
    assert.equal(body.subscription.pendingChange, null);
    await app.close();
  });

  it('cookie inválido é 401 uniforme e não há outros métodos (nada de escrita nesta etapa)', async () => {
    const { app } = setup(true);
    const bad = await app.inject({
      method: 'GET',
      url: '/account/billing',
      headers: { cookie: `soprei_session=${'b'.repeat(43)}` },
    });
    assert.equal(bad.statusCode, 401);
    const post = await app.inject({
      method: 'POST',
      url: '/account/billing',
      headers: { cookie: `soprei_session=${SECRET}`, origin: ORIGIN, 'x-soprei-app': 'web' },
      payload: { amountCents: 1 },
    });
    assert.equal(post.statusCode, 404);
    await app.close();
  });
});

describe('POST /account/companies com o limite do plano (spec 031, revisão)', () => {
  it('a recusa do plano chega como 403 com o código PLAN_COMPANY_LIMIT', async () => {
    const accounts = {
      me: () =>
        Promise.resolve({ id: ACCOUNT_ID, email: 'x@exemplo.test', selectedCompanyId: null }),
      tenantIdentity: () => Promise.resolve(null),
      drain: () => Promise.resolve(),
      createCompany: () =>
        Promise.reject(new ForbiddenError('Limite', { code: 'PLAN_COMPANY_LIMIT' })),
    } as unknown as AccountService;
    const app = buildServer({
      logger: captureLogs().logger,
      readiness: {
        database: () => Promise.resolve(Result.ok(undefined)),
        redis: () => Promise.resolve(Result.ok(undefined)),
      },
      accounts: { service: accounts, origin: ORIGIN, secure: false },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/account/companies',
      headers: { cookie: `soprei_session=${SECRET}`, origin: ORIGIN, 'x-soprei-app': 'web' },
      payload: { name: 'Quarta' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(
      (JSON.parse(response.body) as { error: { code: string } }).error.code,
      'PLAN_COMPANY_LIMIT',
    );
    await app.close();
  });
});
