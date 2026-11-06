import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { CompanyService } from '../../application/companies/company.service.js';
import { OnboardingService } from '../../application/onboarding/onboarding.service.js';
import { type Company, MEMBERSHIP_ROLES, type MembershipRole } from '../../domain/index.js';
import { buildServer } from '../../infrastructure/http/server.js';
import { createMetrics, type Metrics } from '../../infrastructure/metrics/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth, type TestAuth } from '../../test-support/in-memory-auth.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { InMemoryOnboardingStore } from '../../test-support/in-memory-onboarding.js';
import { captureLogs, logContains, type LogCapture } from '../../test-support/log-capture.js';

const SENTINEL = `sentinela-${randomUUID()}`;

function errorOf(body: string): { code: string; message: string } {
  const { error } = JSON.parse(body) as { error: { code: string; message: string } };
  return { code: error.code, message: error.message };
}

describe('GET e PUT /admin/companies/:companyId/onboarding (spec 030)', () => {
  let app: FastifyInstance;
  let testAuth: TestAuth;
  let metrics: Metrics;
  let logs: LogCapture;
  let store: InMemoryOnboardingStore;
  let companyA: Company;
  let companyB: Company;
  const tokens = new Map<MembershipRole, { authorization: string }>();
  let ownerB: { authorization: string };
  let platform: { authorization: string };

  before(async () => {
    logs = captureLogs();
    metrics = createMetrics();
    const companies = new InMemoryCompanyRepository();
    testAuth = buildTestAuth({ logger: logs.logger, companies, metrics });
    store = new InMemoryOnboardingStore();
    app = buildServer({
      logger: logs.logger,
      metrics,
      metricsToken: 'm'.repeat(40),
      readiness: {
        database: () => Promise.resolve(Result.ok(undefined)),
        redis: () => Promise.resolve(Result.ok(undefined)),
      },
      auth: testAuth.service,
      admin: {
        companies: new CompanyService(companies),
        onboarding: new OnboardingService(store),
      },
    });
    await app.ready();
    companyA = await companies.create({ name: SENTINEL, slug: 'empresa-a' });
    companyB = await companies.create({ name: 'B', slug: 'empresa-b' });
    store.seed(companyA.id, { persona: true, knowledge: true });
    store.seed(companyB.id);
    for (const role of MEMBERSHIP_ROLES) {
      tokens.set(role, bearer((await testAuth.membershipToken(companyA.id, { role })).accessToken));
    }
    ownerB = bearer((await testAuth.membershipToken(companyB.id, { role: 'OWNER' })).accessToken);
    platform = bearer((await testAuth.platformToken()).accessToken);
  });
  after(async () => {
    await app.close();
  });

  const call = (
    method: 'GET' | 'PUT',
    companyId: string,
    headers?: { authorization: string },
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/admin/companies/${companyId}/onboarding`,
      ...(headers === undefined ? {} : { headers }),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const dismissedOf = (response: { json(): unknown }): unknown =>
    (response.json() as { dismissed: unknown }).dismissed;

  it('OWNER e ADMIN leem os quatro passos; AGENT e VIEWER levam 403 em GET e PUT', async () => {
    for (const role of MEMBERSHIP_ROLES) {
      const allowed = role === 'OWNER' || role === 'ADMIN';
      const get = await call('GET', companyA.id, tokens.get(role));
      const put = await call('PUT', companyA.id, tokens.get(role), { dismissed: false });
      if (allowed) {
        assert.equal(get.statusCode, 200, role);
        assert.deepEqual(get.json(), {
          dismissed: false,
          steps: { persona: true, knowledge: true, schedule: false, inventory: false },
        });
        assert.equal(put.statusCode, 200, role);
      } else {
        assert.equal(get.statusCode, 403, role);
        assert.equal(put.statusCode, 403, role);
        assert.equal(errorOf(put.body).code, 'FORBIDDEN');
      }
    }
  });

  it('401 sem token, 403 para PlatformAdmin', async () => {
    assert.equal((await call('GET', companyA.id)).statusCode, 401);
    assert.equal((await call('GET', companyA.id, platform)).statusCode, 403);
    assert.equal((await call('PUT', companyA.id, platform, { dismissed: true })).statusCode, 403);
  });

  it('empresa alheia, inexistente ou id que não é UUID: o MESMO 404, antes da permissão', async () => {
    const bodies = new Set<string>();
    for (const role of MEMBERSHIP_ROLES) {
      for (const id of [companyB.id, randomUUID(), 'nao-e-uuid']) {
        const get = await call('GET', id, tokens.get(role));
        const put = await call('PUT', id, tokens.get(role), { dismissed: true });
        assert.equal(get.statusCode, 404, `${role} GET ${id}`);
        assert.equal(put.statusCode, 404, `${role} PUT ${id}`);
        bodies.add(JSON.stringify(errorOf(get.body)));
        bodies.add(JSON.stringify(errorOf(put.body)));
      }
    }
    assert.equal(bodies.size, 1);
    assert.equal(store.facts.get(companyB.id)?.dismissed, false);
  });

  it('PUT dispensa e reabre, repetir é idempotente e B não muda; a métrica só conta mudança', async () => {
    const owner = tokens.get('OWNER');
    const put = await call('PUT', companyA.id, owner, { dismissed: true });
    assert.equal(put.statusCode, 200);
    assert.equal(dismissedOf(put), true);
    assert.equal((await call('PUT', companyA.id, owner, { dismissed: true })).statusCode, 200);
    assert.equal(dismissedOf(await call('GET', companyA.id, owner)), true);
    assert.equal(dismissedOf(await call('GET', companyB.id, ownerB)), false);
    await call('PUT', companyA.id, owner, { dismissed: false });
    const text = await metrics.render();
    assert.match(text, /company_onboarding_actions_total\{action="dismissed"\} 1/);
    assert.match(text, /company_onboarding_actions_total\{action="reopened"\} 1/);
    const lines = text.split('\n').filter((l) => l.startsWith('company_onboarding_actions_total{'));
    for (const line of lines) {
      assert.match(line, /^company_onboarding_actions_total\{action="(dismissed|reopened)"\} \d+$/);
    }
  });

  it('corpo inválido, campo extra ou ausente é 400 sem eco do valor', async () => {
    const owner = tokens.get('OWNER');
    for (const payload of [
      {},
      { dismissed: 'sim' },
      { dismissed: true, companyId: companyB.id },
      { dismissed: SENTINEL },
      { dismissed: null },
    ]) {
      const response = await call('PUT', companyA.id, owner, payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(response.body.includes(SENTINEL), false);
    }
  });

  it('privacidade: resposta só com booleanos e log sem conteúdo da empresa', async () => {
    const owner = tokens.get('OWNER');
    const get = await call('GET', companyA.id, owner);
    assert.equal(get.body.includes(SENTINEL), false);
    const body = get.json<{ dismissed: unknown; steps: Record<string, unknown> }>();
    assert.equal(typeof body.dismissed, 'boolean');
    for (const value of Object.values(body.steps)) assert.equal(typeof value, 'boolean');
    await call('PUT', companyA.id, owner, { dismissed: true });
    assert.equal(logContains(logs.raw(), SENTINEL), false);
    assert.ok(logContains(logs.raw(), 'onboarding atualizado'));
  });
});
