import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { CompanyService } from '../../application/companies/company.service.js';
import type { KnowledgeService } from '../../application/knowledge/knowledge.service.js';
import type { SampleDataService } from '../../application/knowledge/sample.service.js';
import type { CompanyEntitlements } from '../../domain/index.js';
import { createMetrics } from '../metrics/index.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth } from '../../test-support/in-memory-auth.js';
import { InMemoryCompanyRepository } from '../../test-support/in-memory-company.repository.js';
import { captureLogs } from '../../test-support/log-capture.js';
import { buildServer } from './server.js';

// Spec 031 (revisão): apagar o próprio documento segue com a assinatura inativa e o exemplo só carrega
// produtos com o módulo Estoque.
describe('conhecimento com a cobrança ligada (spec 031)', () => {
  let app: FastifyInstance;
  let owner: { authorization: string };
  let companyId = '';
  let current: CompanyEntitlements;
  const loads: unknown[] = [];

  before(async () => {
    const logs = captureLogs();
    const companies = new InMemoryCompanyRepository();
    const testAuth = buildTestAuth({ logger: logs.logger, companies, metrics: createMetrics() });
    app = buildServer({
      logger: logs.logger,
      readiness: {
        database: () => Promise.resolve(Result.ok(undefined)),
        redis: () => Promise.resolve(Result.ok(undefined)),
      },
      auth: testAuth.service,
      admin: {
        companies: new CompanyService(companies),
        knowledge: {
          list: () => Promise.resolve({ items: [], nextCursor: null }),
          create: () => Promise.reject(new Error('n/a')),
          delete: () => Promise.resolve(),
        } as unknown as KnowledgeService,
        sample: {
          load: (...args: unknown[]) => {
            loads.push(args[2]);
            return Promise.resolve({ created: true });
          },
          remove: () => Promise.resolve({ documents: 0, products: 0 }),
        } as unknown as SampleDataService,
      },
      billing: {
        service: { overview: () => Promise.reject(new Error('n/a')) },
        entitlements: { forCompany: () => Promise.resolve(current) },
      },
    });
    await app.ready();
    const company = await companies.create({ name: 'A', slug: 'a-kb' });
    companyId = company.id;
    owner = bearer((await testAuth.membershipToken(company.id, { role: 'OWNER' })).accessToken);
  });
  after(async () => {
    await app.close();
  });

  it('com a assinatura bloqueada o DELETE de documento segue 204, mas criar exemplo é 403', async () => {
    current = { access: 'blocked', agenda: true, stock: true, tokens: null, replies: null };
    const del = await app.inject({
      method: 'DELETE',
      url: `/admin/companies/${companyId}/knowledge/documents/01900000-0000-7000-8000-000000000001`,
      headers: owner,
    });
    assert.equal(del.statusCode, 204);
    const sample = await app.inject({
      method: 'POST',
      url: `/admin/companies/${companyId}/knowledge/sample`,
      headers: owner,
    });
    assert.equal(sample.statusCode, 403);
  });

  it('o exemplo só carrega produtos com o módulo Estoque contratado', async () => {
    loads.length = 0;
    current = { access: 'ok', agenda: true, stock: false, tokens: null, replies: null };
    const url = `/admin/companies/${companyId}/knowledge/sample`;
    assert.equal((await app.inject({ method: 'POST', url, headers: owner })).statusCode, 201);
    current = { ...current, stock: true };
    assert.equal((await app.inject({ method: 'POST', url, headers: owner })).statusCode, 201);
    assert.deepEqual(loads, [{ includeProducts: false }, { includeProducts: true }]);
  });
});
