import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { CompanyService } from '../../application/companies/company.service.js';
import { Result } from '../../shared/types/index.js';
import { bearer, buildTestAuth } from '../../test-support/in-memory-auth.js';
import { loadIntegrationConfig } from '../../test-support/integration-env.js';
import { TestTenants } from '../../test-support/tenant-fixtures.js';
import { createDatabase, PrismaCompanyRepository, type Database } from '../database/index.js';
import { buildServer } from '../http/server.js';
import { createLogger } from '../logger/logger.js';
import { createMetrics, type Metrics } from './metrics.js';

const config = loadIntegrationConfig();
const logger = createLogger(config);
const TOKEN = `it-${randomUUID()}-${randomUUID()}`;

let metrics: Metrics;
let database: Database;
let tenants: TestTenants;
let app: FastifyInstance;
let adminAuth: { authorization: string };

before(async () => {
  metrics = createMetrics();
  database = createDatabase(config, logger, {
    queryObserver: (sample) => {
      metrics.observeDbQuery(sample);
    },
  });
  metrics.bindPool(() => database.poolMetrics());
  tenants = new TestTenants(database.prisma);
  const testAuth = buildTestAuth({ logger });
  adminAuth = bearer((await testAuth.platformToken()).accessToken);
  app = buildServer({
    logger,
    metrics,
    metricsToken: TOKEN,
    readiness: {
      database: () => database.check(),
      redis: () => Promise.resolve(Result.ok(undefined)),
    },
    auth: testAuth.service,
    admin: {
      companies: new CompanyService(new PrismaCompanyRepository(database.prisma)),
    },
  });
  await app.ready();
});

after(async () => {
  try {
    await app.close();
    await tenants.cleanup();
  } finally {
    await database.close();
  }
});

function count(body: string, model: string, operation: string): number {
  const match = new RegExp(
    `db_query_duration_seconds_count\\{model="${model}",operation="${operation}"\\} (\\d+)`,
  ).exec(body);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

describe('métricas do banco contra o PostgreSQL de testes', () => {
  it('operações reais com o Prisma geram amostras por model e operation', async () => {
    const before = await metrics.render();
    const created = await tenants.createCompany('metrics');
    await database.prisma.conversation.create({ data: { companyId: created.id, contactRef: 'c' } });
    await database.prisma.conversation.findMany({ where: { companyId: created.id } });
    await database.prisma.company.count();

    const after = await metrics.render();
    assert.equal(count(after, 'Company', 'create') - count(before, 'Company', 'create'), 1);
    assert.equal(
      count(after, 'Conversation', 'create') - count(before, 'Conversation', 'create'),
      1,
    );
    assert.equal(
      count(after, 'Conversation', 'findMany') - count(before, 'Conversation', 'findMany'),
      1,
    );
    assert.equal(count(after, 'Company', 'count') - count(before, 'Company', 'count'), 1);
    assert.match(after, /db_query_duration_seconds_bucket\{le="0\.001",model="Company"/);
  });

  it('o gauge do pool reflete poolMetrics() no momento da coleta', async () => {
    await database.prisma.company.count();
    const body = await metrics.render();
    const pool = database.poolMetrics();
    const gauge = (state: string): number =>
      Number(new RegExp(`db_pool_connections\\{state="${state}"\\} (\\d+)`).exec(body)?.[1]);
    assert.equal(gauge('total'), pool.totalCount);
    assert.equal(gauge('idle'), pool.idleCount);
    assert.equal(gauge('waiting'), pool.waitingCount);
    assert.ok(pool.totalCount >= 1);
  });

  it('via HTTP: /metrics expõe as queries e o pool sem companyId nem UUID', async () => {
    const slug = `metrics-${randomBytes(6).toString('hex')}`;
    const created = await app.inject({
      method: 'POST',
      url: '/admin/companies',
      headers: adminAuth,
      payload: { name: 'Empresa Métricas', slug },
    });
    assert.equal(created.statusCode, 201);
    const { id } = created.json<{ id: string }>();
    tenants.track(id);
    await app.inject({
      method: 'GET',
      url: `/admin/companies/${id}`,
      headers: adminAuth,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    assert.match(
      response.body,
      /db_query_duration_seconds_count\{model="Company",operation="create"\}/,
    );
    assert.match(response.body, /db_pool_connections\{state="total"\}/);
    assert.match(
      response.body,
      /http_requests_total\{method="POST",route="\/admin\/companies",status_class="2xx"\} 1/,
    );
    assert.match(
      response.body,
      /http_requests_total\{method="GET",route="\/admin\/companies\/:id",status_class="2xx"\} 1/,
    );
    assert.ok(!response.body.includes(id));
    assert.ok(!response.body.includes(slug));
    assert.doesNotMatch(response.body, /companyId/i);
  });
});
